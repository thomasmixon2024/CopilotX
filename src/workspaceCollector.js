'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

let secretApiKey = '';
let secretsReadyPromise = Promise.resolve();

async function initSecrets(secrets) {
  if (!secrets) return;
  const load = (async () => {
    try {
      return (await secrets.get('copilotx.apiKey')) || '';
    } catch {
      return '';
    }
  })();
  secretsReadyPromise = load.then((value) => {
    secretApiKey = value;
  });
  await secretsReadyPromise;
}

// Resolves once SecretStorage has been read (or immediately if never used),
// so the first turn never runs with an unloaded key.
function ensureSecretsReady() {
  return secretsReadyPromise;
}

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

const PROVIDER_ENV_KEYS = {
  nim: 'NVIDIA_NIM_API_KEY',
  local: 'ANTHROPIC_AUTH_TOKEN',
};

function clampInt(value, defaultValue, min, max) {
  const n = Number(value);
  if (Number.isNaN(n)) return defaultValue;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function getSettings() {
  const cfg = vscode.workspace.getConfiguration('copilotx');
  const provider = process.env.COPILOTX_PROVIDER || cfg.get('provider') || 'none';
  const providerEnvKey = PROVIDER_ENV_KEYS[provider] || '';
  return {
    provider,
    apiKey: process.env[providerEnvKey] || secretApiKey || cfg.get('apiKey') || '',
    model: process.env.COPILOTX_MODEL || cfg.get('model') || '',
    openaiBaseUrl:
      process.env.COPILOTX_BASE_URL ||
      (provider === 'local'
        ? 'http://127.0.0.1:8082/v1'
        : cfg.get('openaiBaseUrl') || 'https://api.openai.com/v1'),
    includeWorkspace: cfg.get('includeWorkspace') !== false,
    allowWrites: ['off', 'approval', 'auto'].includes(cfg.get('allowWrites'))
      ? cfg.get('allowWrites')
      : 'approval',
    streamResponses: cfg.get('streamResponses') !== false,
    inlineCompletions: cfg.get('inlineCompletions') === true,
    pipelineEnabled: cfg.get('pipeline.enabled') !== false,
    pipelineMaxWorkers: clampInt(cfg.get('pipeline.maxWorkers'), 2, 1, 4),
    pipelineMaxQcRounds: clampInt(cfg.get('pipeline.maxQcRounds'), 2, 1, 3),
    supervisorModel:
      process.env.COPILOTX_SUPERVISOR_MODEL || cfg.get('pipeline.supervisorModel') || '',
    workerModel: process.env.COPILOTX_WORKER_MODEL || cfg.get('pipeline.workerModel') || '',
    qcModel: process.env.COPILOTX_QC_MODEL || cfg.get('pipeline.qcModel') || '',
  };
}

module.exports = { collectWorkspaceSnapshot, getSettings, initSecrets, ensureSecretsReady };
