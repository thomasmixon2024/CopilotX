'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * tools.js — Phase 2: Autonomous Tool Execution & Workspace Diffs
 *
 * Structured payloads:
 *   { type: 'FILE_CREATE', path, content }
 *   { type: 'FILE_PATCH',  path, diff }     // unified diff
 *   { type: 'TERMINAL_EXEC', command }      // requires allowTerminal
 *
 * Safety:
 *   - All file paths must resolve inside workspaceRoot (no traversal)
 *   - Terminal disabled by default; allowlist required when enabled
 *   - Offline, zero network; pure local FS + optional local process
 */

function resolveSafe(workspaceRoot, relPath) {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, relPath || '');
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return target;
}

function isPathSafe(workspaceRoot, candidatePath) {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(candidatePath);
  const rel = path.relative(root, target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
    ? true
    : target === root;
}

/**
 * Minimal unified-diff parser for single-file patches.
 * Supports the common ---/+++/@@ form produced by agents.
 */
function parseUnifiedDiff(diffText) {
  const text = String(diffText || '');
  const lines = text.split(/\r?\n/);
  const hunks = [];
  let i = 0;
  let oldFile = null;
  let newFile = null;

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('--- ')) {
      oldFile = line.slice(4).replace(/^[ab]\//, '').trim();
    } else if (line.startsWith('+++ ')) {
      newFile = line.slice(4).replace(/^[ab]\//, '').trim();
    } else if (line.startsWith('@@')) {
      const m = line.match(/@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
      if (!m) {
        i++;
        continue;
      }
      const oldStart = parseInt(m[1], 10);
      const oldCount = m[2] !== undefined ? parseInt(m[2], 10) : 1;
      const newStart = parseInt(m[3], 10);
      const newCount = m[4] !== undefined ? parseInt(m[4], 10) : 1;
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('--- ')) {
        body.push(lines[i]);
        i++;
      }
      hunks.push({ oldStart, oldCount, newStart, newCount, body });
      continue;
    }
    i++;
  }

  if (hunks.length === 0) {
    return null;
  }
  return { oldFile, newFile, hunks };
}

/**
 * Apply parsed hunks to original file content. Returns new content or throws.
 */
function applyHunks(original, hunks) {
  const origLines = String(original).split(/\r?\n/);
  // Drop trailing empty line from split if file ended with newline-only handling
  const out = [];
  let origIdx = 0; // 0-based

  for (const hunk of hunks) {
    const start = Math.max(0, hunk.oldStart - 1);
    // copy unchanged lines before this hunk
    while (origIdx < start && origIdx < origLines.length) {
      out.push(origLines[origIdx]);
      origIdx++;
    }

    for (const raw of hunk.body) {
      if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
      const tag = raw[0];
      const content = raw.slice(1);
      if (tag === ' ') {
        // context — should match
        if (origIdx < origLines.length) {
          out.push(origLines[origIdx]);
          origIdx++;
        } else {
          out.push(content);
        }
      } else if (tag === '-') {
        // remove from original
        if (origIdx < origLines.length) {
          origIdx++;
        }
      } else if (tag === '+') {
        out.push(content);
      } else {
        // treat as context if missing tag (lenient)
        out.push(raw);
      }
    }
  }

  // remainder
  while (origIdx < origLines.length) {
    out.push(origLines[origIdx]);
    origIdx++;
  }

  // Preserve trailing newline convention: if original ended with \n, keep it
  let result = out.join('\n');
  if (String(original).endsWith('\n') && !result.endsWith('\n')) {
    result += '\n';
  }
  return result;
}

function applyFileCreate(workspaceRoot, payload) {
  const rel = payload.path;
  if (!rel || typeof rel !== 'string') {
    return { ok: false, error: 'FILE_CREATE requires path' };
  }
  const abs = resolveSafe(workspaceRoot, rel);
  if (!abs) {
    return { ok: false, error: 'path traversal blocked or path not safe' };
  }
  try {
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(abs) && !payload.overwrite) {
      return { ok: false, error: 'file already exists (set overwrite:true to replace)' };
    }
    fs.writeFileSync(abs, payload.content != null ? String(payload.content) : '', 'utf8');
    return { ok: true, path: abs, action: 'FILE_CREATE' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function applyFilePatch(workspaceRoot, payload) {
  const rel = payload.path;
  if (!rel || typeof rel !== 'string') {
    return { ok: false, error: 'FILE_PATCH requires path' };
  }
  const abs = resolveSafe(workspaceRoot, rel);
  if (!abs) {
    return { ok: false, error: 'path traversal blocked or path not safe' };
  }
  if (!fs.existsSync(abs)) {
    return { ok: false, error: `target file does not exist: ${rel}` };
  }
  const parsed = parseUnifiedDiff(payload.diff);
  if (!parsed) {
    return { ok: false, error: 'invalid or empty unified diff' };
  }
  try {
    const original = fs.readFileSync(abs, 'utf8');
    const updated = applyHunks(original, parsed.hunks);
    fs.writeFileSync(abs, updated, 'utf8');
    return { ok: true, path: abs, action: 'FILE_PATCH' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function tokenizeCommand(command) {
  // Simple split — sufficient for allowlist check of the base binary
  const parts = String(command || '').trim().split(/\s+/);
  return parts[0] || '';
}

function applyTerminalExec(workspaceRoot, payload, options = {}) {
  if (!options.allowTerminal) {
    return {
      ok: false,
      error: 'TERMINAL_EXEC disabled (pass allowTerminal:true to enable)',
    };
  }
  const command = String(payload.command || '').trim();
  if (!command) {
    return { ok: false, error: 'TERMINAL_EXEC requires command' };
  }
  const base = tokenizeCommand(command);
  const allowed = Array.isArray(options.allowedCommands)
    ? options.allowedCommands
    : ['echo', 'node', 'npm', 'dir', 'ls', 'type', 'cat'];
  if (!allowed.includes(base)) {
    return {
      ok: false,
      error: `command "${base}" not in allowlist: ${allowed.join(', ')}`,
    };
  }

  try {
    const result = spawnSync(command, {
      cwd: path.resolve(workspaceRoot),
      shell: true,
      encoding: 'utf8',
      timeout: options.timeoutMs || 15000,
      env: process.env,
    });
    if (result.error) {
      return { ok: false, error: result.error.message, stdout: result.stdout, stderr: result.stderr };
    }
    if (result.status !== 0) {
      return {
        ok: false,
        error: `exit code ${result.status}`,
        stdout: result.stdout,
        stderr: result.stderr,
        status: result.status,
      };
    }
    return {
      ok: true,
      action: 'TERMINAL_EXEC',
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Main entry: apply a single structured tool payload.
 * options: { allowTerminal, allowedCommands, timeoutMs }
 */
function applyToolPayload(workspaceRoot, payload, options = {}) {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    return { ok: false, error: 'workspaceRoot is required' };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'payload must be an object' };
  }
  const type = String(payload.type || '').toUpperCase();

  switch (type) {
    case 'FILE_CREATE':
      return applyFileCreate(workspaceRoot, payload);
    case 'FILE_PATCH':
      return applyFilePatch(workspaceRoot, payload);
    case 'TERMINAL_EXEC':
      return applyTerminalExec(workspaceRoot, payload, options);
    default:
      return { ok: false, error: `unknown tool type: ${payload.type}` };
  }
}

/**
 * Apply multiple payloads sequentially; stop on first hard failure unless
 * options.continueOnError is set.
 */
function applyToolBatch(workspaceRoot, payloads, options = {}) {
  const results = [];
  for (const p of payloads || []) {
    const r = applyToolPayload(workspaceRoot, p, options);
    results.push({ payload: p, result: r });
    if (!r.ok && !options.continueOnError) break;
  }
  return results;
}

module.exports = {
  applyToolPayload,
  applyToolBatch,
  parseUnifiedDiff,
  isPathSafe,
  resolveSafe,
};
