'use strict';

const vscode = require('vscode');
const { CopilotXChatViewProvider } = require('./chatView');
const { runTurn } = require('./core/engine');
const { createSession, appendTurn } = require('./core/session');
const { collectWorkspaceSnapshot, getSettings, initSecrets } = require('./workspaceCollector');

function activate(context) {
  initSecrets(context.secrets);

  const provider = new CopilotXChatViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('copilotx.chatView', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  let chatSession = createSession('vscode-chat-api');
  let participantBusy = false;

  if (vscode.chat && typeof vscode.chat.createChatParticipant === 'function') {
    const participant = vscode.chat.createChatParticipant(
      'copilotx.agent',
      async (request, _ctx, stream, token) => {
        if (token && token.isCancellationRequested) return;
        if (participantBusy) {
          stream.markdown('CopilotX is still answering the previous message — please wait.');
          return;
        }
        participantBusy = true;
        stream.progress('Routing CopilotX agents…');
        try {
          const result = await runTurn({
            input: request.prompt,
            session: chatSession,
            workspace: collectWorkspaceSnapshot(),
            settings: getSettings(),
          });
          if (token && token.isCancellationRequested) return;
          chatSession = appendTurn(chatSession, {
            input: request.prompt,
            agent: result.agent,
            text: result.text,
            summary: result.summary,
          });
          stream.markdown(`_${result.agentName} · ${result.mode} · ${result.reason}_\n\n`);
          stream.markdown(result.text);
        } catch (err) {
          stream.markdown(`CopilotX error: ${err.message}`);
        } finally {
          participantBusy = false;
        }
      }
    );
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
    context.subscriptions.push(participant);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('copilotx.openChat', async () => {
      await vscode.commands.executeCommand('copilotx.chatView.focus');
    }),
    vscode.commands.registerCommand('copilotx.clearSession', () => {
      provider.clear();
      chatSession = createSession('vscode-chat-api');
      vscode.window.showInformationMessage('CopilotX session cleared.');
    }),
    vscode.commands.registerCommand('copilotx.storeApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Paste the API key for the selected provider (stored in VS Code SecretStorage, not settings).',
        password: true,
      });
      if (!key) return;
      await context.secrets.store('copilotx.apiKey', key);
      await initSecrets(context.secrets);
      vscode.window.showInformationMessage('CopilotX API key stored securely.');
    }),
    vscode.commands.registerCommand('copilotx.explainSelection', async () => {
      await vscode.commands.executeCommand('copilotx.chatView.focus');
      const editor = vscode.window.activeTextEditor;
      const hasSel = editor && editor.selection && !editor.selection.isEmpty;
      const prompt = hasSel
        ? 'Explain the selected code and suggest improvements.'
        : 'Explain the active file and its structure.';
      await provider.handleUserMessage(prompt, '@workspace ');
    }),
    vscode.commands.registerCommand('copilotx.fixSelection', async () => {
      await vscode.commands.executeCommand('copilotx.chatView.focus');
      await provider.handleUserMessage(
        'Fix or refactor the selected code. Show a drop-in replacement.',
        '@workspace '
      );
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
