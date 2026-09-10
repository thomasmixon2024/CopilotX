'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

function getActiveFileSnapshot(editor) {
  if (!editor || !editor.document) return null;
  const doc = editor.document;
  return {
    path: doc.uri.fsPath,
    languageId: doc.languageId,
    content: doc.getText(),
    lineCount: doc.lineCount,
  };
}

function getSelectionSnapshot(editor) {
  if (!editor || !editor.selection || editor.selection.isEmpty) return null;
  const sel = editor.selection;
  return {
    startLine: sel.start.line + 1,
    endLine: sel.end.line + 1,
    text: editor.document.getText(sel),
  };
}

function getCursorSnapshot(editor) {
  if (!editor) return null;
  const pos = editor.selection.active;
  return { line: pos.line + 1, character: pos.character };
}

function getOpenTabsSnapshot() {
  const tabs = [];
  const seen = new Set();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input && input.uri && input.uri.scheme === 'file') {
        const p = input.uri.fsPath;
        if (seen.has(p)) continue;
        seen.add(p);
        let languageId = '';
        const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === p);
        if (openDoc) languageId = openDoc.languageId;
        tabs.push({ path: p, languageId });
      }
    }
  }
  return tabs;
}

function getWorkspaceFoldersSnapshot() {
  const folders = vscode.workspace.workspaceFolders || [];
  return folders.map((f) => ({ name: f.name, path: f.uri.fsPath }));
}

function buildProjectTree(rootPath, maxEntries = 60, maxDepth = 3) {
  if (!rootPath || !fs.existsSync(rootPath)) return [];
  const skip = new Set([
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
      if (skip.has(ent.name)) continue;
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

function collectWorkspaceSnapshot() {
  const editor = vscode.window.activeTextEditor;
  const folders = getWorkspaceFoldersSnapshot();
  const rootPath = folders.length ? folders[0].path : null;
  return {
    workspaceFolders: folders,
    activeFile: getActiveFileSnapshot(editor),
    selection: getSelectionSnapshot(editor),
    openTabs: getOpenTabsSnapshot(),
    cursor: getCursorSnapshot(editor),
    projectTree: rootPath ? buildProjectTree(rootPath) : [],
  };
}

function getSettings() {
  const cfg = vscode.workspace.getConfiguration('copilotx');
  const provider = process.env.COPILOTX_PROVIDER || cfg.get('provider') || 'none';
  return {
    provider,
    apiKey:
      cfg.get('apiKey') ||
      (provider === 'nim' ? process.env.NVIDIA_NIM_API_KEY : '') ||
      '',
    model: process.env.COPILOTX_MODEL || cfg.get('model') || '',
    openaiBaseUrl:
      process.env.COPILOTX_BASE_URL ||
      cfg.get('openaiBaseUrl') ||
      'https://api.openai.com/v1',
    includeWorkspace: cfg.get('includeWorkspace') !== false,
  };
}

module.exports = { collectWorkspaceSnapshot, getSettings };
