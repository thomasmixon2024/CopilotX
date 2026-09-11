'use strict';

const vscode = require('vscode');
const { runTurn } = require('./core/engine');
const { createSession, appendTurn } = require('./core/session');
const { collectWorkspaceSnapshot, getSettings } = require('./workspaceCollector');

class CopilotXChatViewProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.view = undefined;
    this.session = createSession('vscode-sidebar');
    this.history = [];
    this.pending = false;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this._html(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ask') {
        await this.handleUserMessage(msg.text);
      } else if (msg.type === 'clear') {
        this.clear();
      }
    });
  }

  clear() {
    this.session = createSession('vscode-sidebar');
    this.history = [];
    this.view?.webview.postMessage({ type: 'cleared' });
  }

  async handleUserMessage(text, extraPrefix = '') {
    const input = `${extraPrefix}${text}`.trim();
    if (!input) return;

    if (this.pending) {
      this.view?.webview.postMessage({
        type: 'status',
        text: 'Still answering the previous message — please wait.',
      });
      return;
    }
    this.pending = true;

    this.history.push({ role: 'user', text: input });
    this.view?.webview.postMessage({ type: 'user', text: input });
    this.view?.webview.postMessage({ type: 'status', text: 'Routing…' });

    try {
      const result = await runTurn({
        input,
        session: this.session,
        workspace: collectWorkspaceSnapshot(),
        settings: getSettings(),
      });
      this.session = appendTurn(this.session, {
        input,
        agent: result.agent,
        text: result.text,
        summary: result.summary,
      });
      this.history.push({ role: 'assistant', ...result });
      this.view?.webview.postMessage({
        type: 'assistant',
        agent: result.agentName,
        mode: result.mode,
        reason: result.reason,
        text: result.text,
      });
    } catch (err) {
      this.view?.webview.postMessage({
        type: 'assistant',
        agent: 'Error',
        mode: 'error',
        reason: '',
        text: String(err.message || err),
      });
    } finally {
      this.pending = false;
    }
  }

  _html(webview) {
    const nonce = String(Date.now());
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>
    :root {
      --bg: var(--vscode-sideBar-background);
      --fg: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
      --input: var(--vscode-input-background);
      --border: var(--vscode-widget-border, #444);
      --accent: var(--vscode-button-background);
      --accent-fg: var(--vscode-button-foreground);
      --bubble: var(--vscode-editor-background);
    }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--fg);
      background: var(--bg);
      display: flex;
      flex-direction: column;
    }
    header {
      padding: 10px 12px 8px;
      border-bottom: 1px solid var(--border);
    }
    header h1 { font-size: 13px; margin: 0 0 2px; font-weight: 600; }
    header p { margin: 0; color: var(--muted); font-size: 11px; }
    #thread {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .msg { max-width: 100%; }
    .msg .meta { font-size: 10px; color: var(--muted); margin-bottom: 4px; text-transform: uppercase; letter-spacing: .04em; }
    .msg .bubble {
      background: var(--bubble);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 10px;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.45;
    }
    .msg .actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 4px;
    }
    .speak {
      background: transparent;
      color: var(--muted);
      border: 1px solid var(--border);
      padding: 3px 7px;
      font-size: 11px;
    }
    .speak:hover { color: var(--fg); }
    .msg.user .bubble { border-left: 3px solid var(--accent); }
    .msg.assistant .bubble { border-left: 3px solid #6c8cff; }
    footer {
      display: flex;
      gap: 6px;
      padding: 8px;
      border-top: 1px solid var(--border);
    }
    textarea {
      flex: 1;
      resize: none;
      min-height: 56px;
      max-height: 140px;
      background: var(--input);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px;
      font: inherit;
    }
    button {
      background: var(--accent);
      color: var(--accent-fg);
      border: 0;
      border-radius: 6px;
      padding: 0 12px;
      cursor: pointer;
    }
    button.ghost {
      background: transparent;
      color: var(--fg);
      border: 1px solid var(--border);
    }
    #status { padding: 0 12px 8px; color: var(--muted); font-size: 11px; min-height: 16px; }
  </style>
</head>
<body>
  <header>
    <h1>CopilotX Chat</h1>
    <p>Ask · Explore · Plan · Custom — workspace-aware</p>
  </header>
  <div id="thread"></div>
  <div id="status"></div>
  <footer>
    <textarea id="q" placeholder="Ask about the current file…  (@workspace is attached)"></textarea>
    <button id="send">Send</button>
    <button id="clear" class="ghost" title="Clear session">Clear</button>
  </footer>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const thread = document.getElementById('thread');
    const status = document.getElementById('status');
    const q = document.getElementById('q');

    let currentSpeech = null;
    let currentSpeechButton = null;

    function speechText(text) {
      return String(text || '')
        .replace(/\`\`\`[\s\S]*?\`\`\`/g, ' code block omitted. ')
        .replace(/\`([^\`]*)\`/g, '$1')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[*_>#~-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function stopSpeech() {
      if (!('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      if (currentSpeechButton) currentSpeechButton.textContent = 'Hear aloud';
      currentSpeech = null;
      currentSpeechButton = null;
    }

    function speak(text, button) {
      if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
        status.textContent = 'Text-to-speech is not available in this VS Code host.';
        return;
      }
      if (currentSpeech) stopSpeech();
      const spoken = speechText(text);
      if (!spoken) return;
      const utterance = new SpeechSynthesisUtterance(spoken);
      currentSpeech = utterance;
      currentSpeechButton = button;
      button.textContent = 'Stop';
      utterance.onend = utterance.onerror = () => {
        if (currentSpeech === utterance) currentSpeech = null;
        if (currentSpeechButton === button) currentSpeechButton = null;
        button.textContent = 'Hear aloud';
      };
      window.speechSynthesis.speak(utterance);
    }

    function add(role, title, text) {
      const wrap = document.createElement('div');
      wrap.className = 'msg ' + role;
      wrap.innerHTML = '<div class="meta"></div><div class="bubble"></div>';
      wrap.querySelector('.meta').textContent = title;
      wrap.querySelector('.bubble').textContent = text;
      if (role === 'assistant') {
        const actions = document.createElement('div');
        actions.className = 'actions';
        const button = document.createElement('button');
        button.className = 'speak';
        button.type = 'button';
        button.textContent = 'Hear aloud';
        button.title = 'Read this response aloud';
        button.addEventListener('click', () => {
          if (currentSpeech && currentSpeechButton === button) stopSpeech();
          else if (currentSpeech) {
            stopSpeech();
            speak(text, button);
          }
          else speak(text, button);
        });
        actions.appendChild(button);
        wrap.appendChild(actions);
      }
      thread.appendChild(wrap);
      thread.scrollTop = thread.scrollHeight;
    }

    document.getElementById('send').addEventListener('click', send);
    document.getElementById('clear').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
    window.addEventListener('beforeunload', stopSpeech);
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });

    function send() {
      const text = q.value.trim();
      if (!text) return;
      q.value = '';
      vscode.postMessage({ type: 'ask', text });
    }

    window.addEventListener('message', (e) => {
      const m = e.data;
      if (m.type === 'user') add('user', 'You', m.text);
      if (m.type === 'assistant') {
        status.textContent = '';
        add('assistant', (m.agent || 'CopilotX') + (m.mode ? ' · ' + m.mode : ''), m.text);
      }
      if (m.type === 'status') status.textContent = m.text;
      if (m.type === 'cleared') {
        stopSpeech();
        thread.innerHTML = '';
        status.textContent = 'Session cleared';
      }
    });
  </script>
</body>
</html>`;
  }
}

module.exports = { CopilotXChatViewProvider };
