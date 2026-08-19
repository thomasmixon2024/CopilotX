const vscode = require("vscode");
const path = require("path");
const fs = require("fs");

/**
 * CopilotX VS Code extension
 * Phase 1: @workspace context collection
 * Phase 2: staged tool apply with explicit user approval
 */

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
      if (input && input.uri && input.uri.scheme === "file") {
        const p = input.uri.fsPath;
        if (seen.has(p)) continue;
        seen.add(p);
        let languageId = "";
        const openDoc = vscode.workspace.textDocuments.find(
          (d) => d.uri.fsPath === p
        );
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
    "node_modules", ".git", "dist", "build", "out", ".next",
    "coverage", "__pycache__", ".venv", "venv", "Logs",
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
      if (ent.name.startsWith(".") && ent.name !== ".gitignore") continue;
      if (skip.has(ent.name)) continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        results.push(rel + "/");
        walk(path.join(dir, ent.name), depth + 1, rel);
      } else {
        results.push(rel);
      }
    }
  }
  walk(rootPath, 0, "");
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

function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length) return folders[0].uri.fsPath;
  return null;
}

function activate(context) {
  console.log("CopilotX Agent Runtime activated.");

  const startCommand = vscode.commands.registerCommand(
    "copilotx.start",
    async () => {
      const input = await vscode.window.showInputBox({
        prompt: "What would you like CopilotX to help with?",
        placeHolder:
          "e.g. @workspace explain this function  |  refactor the selection",
      });
      if (!input) return;

      try {
        const { runCopilotX } = require(path.join(__dirname, "..", "src", "api"));
        const workspace = collectWorkspaceSnapshot();
        vscode.window.showInformationMessage(
          "CopilotX: routing with workspace context..."
        );
        const result = await runCopilotX(input, {
          sessionId: "vscode",
          workspace,
          includeWorkspace: true,
        });
        const panel = vscode.window.createOutputChannel("CopilotX");
        panel.appendLine(`Agent: ${result.agent} (mode: ${result.mode})`);
        panel.appendLine(
          `Reason: ${result.reason}${result.llmUsed ? " [LLM]" : ""}`
        );
        panel.appendLine(
          `Session: ${result.sessionId} (turn ${result.turnCount})`
        );
        panel.appendLine(
          `Workspace included: ${result.workspaceIncluded ? "yes" : "no"}`
        );
        panel.appendLine("");
        panel.appendLine(result.text);
        panel.appendLine("\n---");
        panel.show();
      } catch (err) {
        vscode.window.showErrorMessage(`CopilotX failed: ${err.message}`);
      }
    }
  );

  const clearCommand = vscode.commands.registerCommand(
    "copilotx.clearSession",
    async () => {
      try {
        const { runCopilotX } = require(path.join(__dirname, "..", "src", "api"));
        await runCopilotX("(session reset)", {
          sessionId: "vscode",
          clearSession: true,
        });
        vscode.window.showInformationMessage("CopilotX session cleared.");
      } catch (err) {
        vscode.window.showErrorMessage(`CopilotX clear failed: ${err.message}`);
      }
    }
  );

  const explainSelection = vscode.commands.registerCommand(
    "copilotx.explainSelection",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active editor.");
        return;
      }
      const hasSel = editor.selection && !editor.selection.isEmpty;
      const prompt = hasSel
        ? "@workspace Explain the selected code and suggest improvements."
        : "@workspace Explain the active file and its structure.";
      try {
        const { runCopilotX } = require(path.join(__dirname, "..", "src", "api"));
        const workspace = collectWorkspaceSnapshot();
        const result = await runCopilotX(prompt, {
          sessionId: "vscode",
          workspace,
          includeWorkspace: true,
        });
        const panel = vscode.window.createOutputChannel("CopilotX");
        panel.appendLine(`Agent: ${result.agent} (mode: ${result.mode})`);
        panel.appendLine(`Workspace included: ${result.workspaceIncluded}`);
        panel.appendLine("");
        panel.appendLine(result.text);
        panel.show();
      } catch (err) {
        vscode.window.showErrorMessage(`CopilotX failed: ${err.message}`);
      }
    }
  );

  /**
   * Phase 2: Apply a staged FILE_CREATE or FILE_PATCH after explicit approval.
   * Expects a JSON payload in the input box for safety/explicitness.
   */
  const applyToolCommand = vscode.commands.registerCommand(
    "copilotx.applyTool",
    async () => {
      const root = getWorkspaceRoot();
      if (!root) {
        vscode.window.showErrorMessage("Open a workspace folder first.");
        return;
      }

      const raw = await vscode.window.showInputBox({
        prompt:
          'Tool payload JSON (e.g. {"type":"FILE_CREATE","path":"notes.txt","content":"hi"})',
        placeHolder: '{"type":"FILE_CREATE","path":"hello.txt","content":"Hello"}',
      });
      if (!raw) return;

      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        vscode.window.showErrorMessage("Invalid JSON payload.");
        return;
      }

      const summary = `${payload.type} → ${payload.path || payload.command || "(no path)"}`;
      const confirm = await vscode.window.showWarningMessage(
        `Apply tool to workspace?\n${summary}\n\nRoot: ${root}`,
        { modal: true },
        "Apply",
        "Cancel"
      );
      if (confirm !== "Apply") {
        vscode.window.showInformationMessage("Tool apply cancelled.");
        return;
      }

      // Extra confirm for terminal
      let allowTerminal = false;
      if (String(payload.type || "").toUpperCase() === "TERMINAL_EXEC") {
        const termConfirm = await vscode.window.showWarningMessage(
          `TERMINAL_EXEC requested: ${payload.command}\nThis runs a local shell command.`,
          { modal: true },
          "Run command",
          "Cancel"
        );
        if (termConfirm !== "Run command") {
          vscode.window.showInformationMessage("Terminal exec cancelled.");
          return;
        }
        allowTerminal = true;
      }

      try {
        const { applyWorkspaceTools } = require(path.join(
          __dirname,
          "..",
          "src",
          "api"
        ));
        const results = applyWorkspaceTools(root, [payload], {
          allowTerminal,
        });
        const r = results[0] && results[0].result;
        const panel = vscode.window.createOutputChannel("CopilotX");
        if (r && r.ok) {
          panel.appendLine(`[SUCCESS] ${r.action || payload.type}`);
          if (r.path) panel.appendLine(`Path: ${r.path}`);
          if (r.stdout) panel.appendLine(r.stdout);
          vscode.window.showInformationMessage("CopilotX tool applied.");
        } else {
          panel.appendLine(`[FAIL] ${(r && r.error) || "unknown error"}`);
          vscode.window.showErrorMessage(
            `Tool failed: ${(r && r.error) || "unknown error"}`
          );
        }
        panel.show();
      } catch (err) {
        vscode.window.showErrorMessage(`Tool apply error: ${err.message}`);
      }
    }
  );

  // Phase 3: Inline ghost-text completions (local fast path)
  let lastTriggerAt = 0;
  const inlineProvider = {
    async provideInlineCompletionItems(document, position, context, token) {
      try {
        const { getCompletion, extractPrefixSuffix, shouldTrigger } = require(path.join(
          __dirname,
          "..",
          "src",
          "core",
          "completions"
        ));
        const offset = document.offsetAt(position);
        const { prefix, suffix } = extractPrefixSuffix(document.getText(), offset);
        const now = Date.now();
        if (
          !shouldTrigger({
            prefix,
            suffix,
            debounceMs: 120,
            lastTriggerAt,
            now,
          })
        ) {
          return { items: [] };
        }
        lastTriggerAt = now;
        const result = getCompletion({
          prefix,
          suffix,
          languageId: document.languageId,
        });
        if (!result || !result.insertText) {
          return { items: [] };
        }
        const item = new vscode.InlineCompletionItem(result.insertText);
        item.range = new vscode.Range(position, position);
        return { items: [item] };
      } catch (err) {
        console.error("CopilotX inline completion error:", err);
        return { items: [] };
      }
    },
  };

  const inlineDisposable = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: "**" },
    inlineProvider
  );

  context.subscriptions.push(
    startCommand,
    clearCommand,
    explainSelection,
    applyToolCommand,
    inlineDisposable
  );
}

function deactivate() {
  console.log("CopilotX Agent Runtime deactivated.");
}

module.exports = {
  activate,
  deactivate,
  collectWorkspaceSnapshot,
};
