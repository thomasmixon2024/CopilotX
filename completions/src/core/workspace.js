'use strict';

/**
 * workspace.js
 * Phase 1: Workspace Context Injector (@workspace)
 *
 * Accepts a plain snapshot of the IDE/workspace state and produces a
 * bounded, token-conscious context block for injection into agent prompts
 * (live and deterministic). Designed so VS Code, CLI, tests, and later
 * PowerShell can all feed the same shape without importing vscode APIs
 * into the core.
 *
 * Snapshot shape (all fields optional):
 * {
 *   workspaceFolders: [{ name, path }],
 *   activeFile: { path, languageId, content, lineCount },
 *   selection: { startLine, endLine, text },   // 1-based lines
 *   openTabs: [{ path, languageId }],
 *   cursor: { line, character },               // 1-based line
 *   projectTree: string[]                      // relative paths, limited
 * }
 */

const DEFAULT_MAX_FILE_CHARS = 8000;
const DEFAULT_MAX_SELECTION_CHARS = 4000;
const DEFAULT_MAX_TREE_ENTRIES = 80;
const DEFAULT_MAX_TABS = 12;
const DEFAULT_MAX_BLOCK_CHARS = 14000;

function truncate(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 20)) + '\n...[truncated]...';
}

/**
 * Normalize and bound a raw snapshot so downstream consumers never see
 * unbounded payloads.
 */
function normalizeSnapshot(raw, options = {}) {
  const maxFile = options.maxFileChars || DEFAULT_MAX_FILE_CHARS;
  const maxSel = options.maxSelectionChars || DEFAULT_MAX_SELECTION_CHARS;
  const maxTree = options.maxTreeEntries || DEFAULT_MAX_TREE_ENTRIES;
  const maxTabs = options.maxTabs || DEFAULT_MAX_TABS;

  const snap = raw && typeof raw === 'object' ? raw : {};

  const folders = Array.isArray(snap.workspaceFolders)
    ? snap.workspaceFolders
        .slice(0, 5)
        .map((f) => ({
          name: String(f.name || '').slice(0, 128),
          path: String(f.path || '').slice(0, 512),
        }))
        .filter((f) => f.path)
    : [];

  let activeFile = null;
  if (snap.activeFile && snap.activeFile.path) {
    const content = truncate(snap.activeFile.content || '', maxFile);
    activeFile = {
      path: String(snap.activeFile.path).slice(0, 512),
      languageId: String(snap.activeFile.languageId || 'plaintext').slice(0, 64),
      lineCount: Number(snap.activeFile.lineCount) || content.split('\n').length,
      content,
    };
  }

  let selection = null;
  if (snap.selection && (snap.selection.text || snap.selection.startLine)) {
    selection = {
      startLine: Number(snap.selection.startLine) || 1,
      endLine: Number(snap.selection.endLine) || Number(snap.selection.startLine) || 1,
      text: truncate(snap.selection.text || '', maxSel),
    };
  }

  const openTabs = Array.isArray(snap.openTabs)
    ? snap.openTabs
        .slice(0, maxTabs)
        .map((t) => ({
          path: String(t.path || '').slice(0, 512),
          languageId: String(t.languageId || '').slice(0, 64),
        }))
        .filter((t) => t.path)
    : [];

  let cursor = null;
  if (snap.cursor && (snap.cursor.line || snap.cursor.line === 0)) {
    cursor = {
      line: Number(snap.cursor.line) || 1,
      character: Number(snap.cursor.character) || 0,
    };
  }

  const projectTree = Array.isArray(snap.projectTree)
    ? snap.projectTree
        .slice(0, maxTree)
        .map((p) => String(p).slice(0, 256))
        .filter(Boolean)
    : [];

  return {
    workspaceFolders: folders,
    activeFile,
    selection,
    openTabs,
    cursor,
    projectTree,
  };
}

/**
 * Build a plain-text @workspace context block for prompt injection.
 * Returns empty string when there is nothing useful to inject.
 */
function formatWorkspaceBlock(rawSnapshot, options = {}) {
  const snap = normalizeSnapshot(rawSnapshot, options);
  const maxBlock = options.maxBlockChars || DEFAULT_MAX_BLOCK_CHARS;
  const lines = [];

  lines.push('@workspace context:');

  if (snap.workspaceFolders.length) {
    lines.push(
      'Workspace folders: ' +
        snap.workspaceFolders.map((f) => `${f.name || 'root'} (${f.path})`).join('; ')
    );
  }

  if (snap.openTabs.length) {
    lines.push('Open tabs:');
    snap.openTabs.forEach((t) => {
      lines.push(`  - ${t.path}${t.languageId ? ` [${t.languageId}]` : ''}`);
    });
  }

  if (snap.activeFile) {
    lines.push(
      `Active file: ${snap.activeFile.path} [${snap.activeFile.languageId}] (${snap.activeFile.lineCount} lines)`
    );
    if (snap.cursor) {
      lines.push(`Cursor: line ${snap.cursor.line}, col ${snap.cursor.character}`);
    }
    if (snap.selection && snap.selection.text && snap.selection.text.trim()) {
      lines.push(
        `Selection (lines ${snap.selection.startLine}-${snap.selection.endLine}):`
      );
      lines.push('```');
      lines.push(snap.selection.text);
      lines.push('```');
    } else if (snap.activeFile.content && snap.activeFile.content.trim()) {
      lines.push('Active file content (truncated if large):');
      lines.push('```' + (snap.activeFile.languageId || ''));
      lines.push(snap.activeFile.content);
      lines.push('```');
    }
  }

  if (snap.projectTree.length) {
    lines.push('Project tree (limited):');
    snap.projectTree.forEach((p) => lines.push(`  ${p}`));
  }

  // If we only have the header, treat as empty
  if (lines.length <= 1) return '';

  const block = lines.join('\n');
  return truncate(block, maxBlock);
}

/**
 * Detect @workspace mentions in user input so callers can decide whether
 * to force-include context even when the snapshot is partial.
 */
function mentionsWorkspace(input) {
  return /@workspace\b/i.test(String(input || ''));
}

module.exports = {
  normalizeSnapshot,
  formatWorkspaceBlock,
  mentionsWorkspace,
  DEFAULT_MAX_FILE_CHARS,
  DEFAULT_MAX_SELECTION_CHARS,
  DEFAULT_MAX_TREE_ENTRIES,
  DEFAULT_MAX_TABS,
  DEFAULT_MAX_BLOCK_CHARS,
};
