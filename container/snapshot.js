'use strict';

// Headless workspace snapshot builder. Produces the same shape that
// src/workspaceCollector.js collects in VS Code, using plain fs.

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'Logs',
]);

function buildProjectTree(rootPath, maxEntries = 60, maxDepth = 3) {
  if (!rootPath || !fs.existsSync(rootPath)) return [];
  const results = [];
  function walk(dir, depth, prefix) {
    if (results.length >= maxEntries || depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (results.length >= maxEntries) break;
      if (ent.name.startsWith('.') && ent.name !== '.gitignore') continue;
      if (SKIP_DIRS.has(ent.name)) continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        results.push(rel + '/');
        walk(path.join(dir, ent.name), depth + 1, rel);
      } else {
        results.push(rel);
      }
    }
  }
  walk(rootPath, 0, '');
  return results;
}

function readActiveFile(repoPath, relPath) {
  if (!relPath) return null;
  const absolute = path.resolve(repoPath, relPath);
  const root = path.resolve(repoPath) + path.sep;
  if (absolute !== path.resolve(repoPath) && !absolute.startsWith(root)) return null;
  let content;
  try {
    content = fs.readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
  const lines = content.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return {
    path: relPath.split(path.sep).join('/'),
    languageId: path.extname(absolute).replace('.', '') || 'plaintext',
    content,
    lineCount: lines.length,
  };
}

function buildWorkspaceSnapshot(repoPath, activeFileRel) {
  const resolved = path.resolve(repoPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Repository path is not a directory: ${repoPath}`);
  }
  return {
    workspaceFolders: [{ name: path.basename(resolved), path: resolved }],
    activeFile: readActiveFile(resolved, activeFileRel),
    selection: null,
    openTabs: [],
    cursor: null,
    projectTree: buildProjectTree(resolved),
  };
}

module.exports = { buildWorkspaceSnapshot, buildProjectTree };
