'use strict';

const vscode = require('vscode');
const { runTurn } = require('./core/engine');
const { createSession, appendTurn } = require('./core/session');
const { collectWorkspaceSnapshot, getSettings } = require('./workspaceCollector');
const proposalReview = require('./proposalReview');

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
      } else if (msg.type === 'reviewProposal') {
        await proposalReview.reviewProposal(msg.id);
      } else if (msg.type === 'acceptProposal') {
        const applied = await proposalReview.acceptProposal(msg.id);
        this.view?.webview.postMessage({
          type: 'proposalResolved',
          id: msg.id,
          applied: Boolean(applied),
        });
      } else if (msg.type === 'discardProposal') {
        proposalReview.discardProposal(msg.id);
        this.view?.webview.postMessage({
          type: 'proposalResolved',
          id: msg.id,
          applied: false,
        });
      } else if (msg.type === 'stop') {
        if (this.abortController) {
          this.abortController.abort();
          this.view?.webview.postMessage({ type: 'status', text: 'Stopping…' });
        }
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
    this.view?.webview.postMessage({ type: 'streamStart' });

    const abortController = new AbortController();
    this.abortController = abortController;

    try {
      const result = await runTurn({
        input,
        session: this.session,
        workspace: collectWorkspaceSnapshot(),
        settings: getSettings(),
        onDelta: (chunk) => {
          this.view?.webview.postMessage({ type: 'delta', text: chunk });
        },
        signal: abortController.signal,
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
      const pending = (result.proposals || []).filter((p) => !p.applied);
      for (const proposal of pending) {
        proposalReview.storeProposal(proposal);
      }
      if (pending.length) {
        this.view?.webview.postMessage({
          type: 'proposals',
          items: pending.map((p) => ({
            id: p.id,
            path: p.relPath,
            added: p.diff.added,
            removed: p.diff.removed,
            created: p.created,
          })),
        });
      }
    } catch (err) {
      this.view?.webview.postMessage({
        type: 'assistant',
        agent: 'Error',
        mode: 'error',
        reason: '',
        text: String(err.message || err),
      });
    } finally {
      if (this.abortController === abortController) this.abortController = undefined;
      this.pending = false;
      this.view?.webview.postMessage({ type: 'streamEnd' });
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
      /* Fixed VS Code Dark Modern-style palette */
      --bg: #181818;
      --fg: #cccccc;
      --muted: #9d9d9d;
      --input: #313131;
      --input-border: #3c3c3c;
      --border: #2b2b2b;
      --border-strong: #454545;
      --accent: #0078d4;
      --accent-hover: #026ec1;
      --accent-fg: #ffffff;
      --bubble: #1f1f1f;
      --green: #3fb950;
      --red: #f85149;
      --selection: #264f78;
      --hover-overlay: rgba(255, 255, 255, 0.08);
      --scrollbar-thumb: rgba(121, 121, 121, 0.4);
      --scrollbar-thumb-hover: rgba(100, 100, 100, 0.7);
    }
    ::selection { background: var(--selection); color: #ffffff; }
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 5px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--scrollbar-thumb-hover); }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: var(--vscode-font-family, -apple-system, 'Segoe UI', Ubuntu, sans-serif);
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
    .speak:hover { color: var(--fg); background: var(--hover-overlay); }
    .icon-btn {
      background: transparent;
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 5px 9px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .icon-btn:hover { border-color: var(--accent); }
    .icon-btn.speaking { color: var(--accent-fg); border-color: var(--accent); background: var(--accent); }
    .msg.user .bubble { border-left: 3px solid var(--accent); }
    .msg.assistant .bubble { border-left: 3px solid #6c8cff; }
    .proposal {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 10px;
      background: var(--bubble);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .proposal .path { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; word-break: break-all; }
    .proposal .stats { font-size: 11px; }
    .proposal .stats .add { color: var(--green); }
    .proposal .stats .del { color: var(--red); }
    .proposal .row { display: flex; gap: 6px; }
    .proposal button { padding: 4px 10px; font-size: 11px; border-radius: 5px; cursor: pointer; }
    .proposal .accept { background: var(--accent); color: var(--accent-fg); border: 0; }
    .proposal .review, .proposal .discard {
      background: transparent; color: var(--fg); border: 1px solid var(--border);
    }
    .proposal .review:hover, .proposal .discard:hover { background: var(--hover-overlay); }
    .proposal .done { font-size: 11px; color: var(--muted); }
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
      border: 1px solid var(--input-border);
      border-radius: 6px;
      padding: 8px;
      font: inherit;
      outline: none;
      transition: border-color 0.1s ease;
    }
    textarea::placeholder { color: var(--muted); }
    textarea:focus { border-color: var(--accent); }
    button {
      background: var(--accent);
      color: var(--accent-fg);
      border: 0;
      border-radius: 6px;
      padding: 0 12px;
      cursor: pointer;
      transition: background 0.1s ease;
    }
    button:hover { background: var(--accent-hover); }
    button.ghost {
      background: transparent;
      color: var(--fg);
      border: 1px solid var(--border);
    }
    button.ghost:hover { background: var(--hover-overlay); }
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
    <button id="stop" class="ghost" style="display:none">Stop</button>
    <button id="speakLatest" class="icon-btn" title="Listen to the latest response"></button>
    <button id="clear" class="ghost" title="Clear session">Clear</button>
  </footer>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const thread = document.getElementById('thread');
    const status = document.getElementById('status');
    const q = document.getElementById('q');

    let currentSpeech = null;
    let currentSpeechButton = null;
    let lastAssistantText = '';

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
      if (currentSpeechButton) {
        if (currentSpeechButton.id === 'speakLatest') setSpeaking(false);
        else currentSpeechButton.textContent = 'Hear aloud';
      }
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
      if (role === 'assistant') lastAssistantText = text;
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

    function addProposal(item) {
      const wrap = document.createElement('div');
      wrap.className = 'proposal';
      wrap.dataset.proposalId = item.id;

      const pathDiv = document.createElement('div');
      pathDiv.className = 'path';
      pathDiv.textContent = (item.created ? '[new] ' : '') + item.path;

      const stats = document.createElement('div');
      stats.className = 'stats';
      const add = document.createElement('span');
      add.className = 'add';
      add.textContent = '+' + item.added;
      const del = document.createElement('span');
      del.className = 'del';
      del.textContent = ' -' + item.removed;
      stats.append(add, del);

      const row = document.createElement('div');
      row.className = 'row';
      const reviewBtn = document.createElement('button');
      reviewBtn.className = 'review';
      reviewBtn.textContent = 'Review';
      reviewBtn.addEventListener('click', () => vscode.postMessage({ type: 'reviewProposal', id: item.id }));
      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'accept';
      acceptBtn.textContent = 'Accept';
      acceptBtn.addEventListener('click', () => vscode.postMessage({ type: 'acceptProposal', id: item.id }));
      const discardBtn = document.createElement('button');
      discardBtn.className = 'discard';
      discardBtn.textContent = 'Discard';
      discardBtn.addEventListener('click', () => vscode.postMessage({ type: 'discardProposal', id: item.id }));
      row.append(reviewBtn, acceptBtn, discardBtn);

      wrap.append(pathDiv, stats, row);
      thread.appendChild(wrap);
      thread.scrollTop = thread.scrollHeight;
    }

    function resolveProposal(id, applied) {
      const card = thread.querySelector('.proposal[data-proposal-id="' + id + '"]');
      if (!card) return;
      card.querySelectorAll('button').forEach((b) => b.remove());
      const done = document.createElement('div');
      done.className = 'done';
      done.textContent = applied ? 'Applied.' : 'Discarded.';
      card.appendChild(done);
    }

    const stopBtn = document.getElementById('stop');
    let streamBubble = null;
    let streamText = '';

    function endStream() {
      stopBtn.style.display = 'none';
      if (streamBubble) {
        streamBubble.remove();
        streamBubble = null;
      }
      streamText = '';
    }

    function appendStream(chunk) {
      if (!streamBubble) {
        streamBubble = document.createElement('div');
        streamBubble.className = 'msg assistant';
        streamBubble.innerHTML = '<div class="meta">CopilotX · streaming</div><div class="bubble"></div>';
        thread.appendChild(streamBubble);
      }
      streamText += chunk;
      streamBubble.querySelector('.bubble').textContent = streamText;
      thread.scrollTop = thread.scrollHeight;
    }

    stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));

    const speakLatestBtn = document.getElementById('speakLatest');
    const SPEAKER_ICON =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M8 1.8v12.4L4.6 10.8H2.2A1.2 1.2 0 0 1 1 9.6V6.4a1.2 1.2 0 0 1 1.2-1.2h2.4L8 1.8z" fill="currentColor"/>' +
      '<path d="M10.6 5.4a3.4 3.4 0 0 1 0 5.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
      '<path d="M12.7 3.3a6.4 6.4 0 0 1 0 9.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
      '</svg>';
    const STOP_ICON =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor"/>' +
      '</svg>';

    function setSpeaking(on) {
      speakLatestBtn.innerHTML = on ? STOP_ICON : SPEAKER_ICON;
      speakLatestBtn.title = on ? 'Stop playback' : 'Listen to the latest response';
      speakLatestBtn.classList.toggle('speaking', on);
    }

    setSpeaking(false);

    speakLatestBtn.addEventListener('click', () => {
      if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
        status.textContent = 'Text-to-speech is not available in this VS Code host.';
        return;
      }
      if (currentSpeech) {
        stopSpeech();
        return;
      }
      const spoken = speechText(lastAssistantText);
      if (!spoken) {
        status.textContent = 'No assistant response to read yet.';
        return;
      }
      const utterance = new SpeechSynthesisUtterance(spoken);
      currentSpeech = utterance;
      currentSpeechButton = speakLatestBtn;
      setSpeaking(true);
      utterance.onend = utterance.onerror = () => {
        if (currentSpeech === utterance) currentSpeech = null;
        if (currentSpeechButton === speakLatestBtn) {
          currentSpeechButton = null;
          setSpeaking(false);
        }
      };
      window.speechSynthesis.speak(utterance);
    });

    window.addEventListener('message', (e) => {
      const m = e.data;
      if (m.type === 'user') add('user', 'You', m.text);
      if (m.type === 'assistant') {
        status.textContent = '';
        endStream();
        add('assistant', (m.agent || 'CopilotX') + (m.mode ? ' · ' + m.mode : ''), m.text);
      }
      if (m.type === 'delta') appendStream(m.text);
      if (m.type === 'streamStart') {
        stopBtn.style.display = '';
      }
      if (m.type === 'streamEnd') endStream();
      if (m.type === 'proposals') {
        (m.items || []).forEach(addProposal);
      }
      if (m.type === 'proposalResolved') resolveProposal(m.id, m.applied);
      if (m.type === 'status') status.textContent = m.text;
      if (m.type === 'cleared') {
        stopSpeech();
        thread.innerHTML = '';
        lastAssistantText = '';
        status.textContent = 'Session cleared';
      }
    });
  </script>
</body>
</html>`;
  }
}

module.exports = { CopilotXChatViewProvider };
