'use strict';

const vscode = require('vscode');
const { runTurn } = require('./core/engine');
const { runPipeline } = require('./core/pipeline');
const { resolveAgent, loadRouterConfig } = require('./core/router');
const { createSession, appendTurn } = require('./core/session');
const { collectWorkspaceSnapshot, getSettings, ensureSecretsReady } = require('./workspaceCollector');
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
      } else if (msg.type === 'webviewReady') {
        this._replayState();
      }
    });
  }

  // The webview may be destroyed (and its DOM wiped) whenever the sidebar is
  // hidden; on reload it sends webviewReady and the host replays the thread.
  _replayState() {
    if (!this.view) return;
    for (const entry of this.history) {
      if (entry.role === 'user') {
        this.view.webview.postMessage({ type: 'user', text: entry.text });
      } else {
        this.view.webview.postMessage({
          type: 'assistant',
          agent: entry.agentName,
          mode: entry.mode,
          reason: entry.reason,
          text: entry.text,
        });
      }
    }
    const pendingProposals = proposalReview.listPendingProposals();
    if (pendingProposals.length) {
      this.view.webview.postMessage({
        type: 'proposals',
        items: pendingProposals.map((p) => ({
          id: p.id,
          path: p.relPath,
          added: p.diff.added,
          removed: p.diff.removed,
          created: p.created,
        })),
      });
    }
  }

  clear() {
    this.session = createSession('vscode-sidebar');
    this.history = [];
    this.view?.webview.postMessage({ type: 'cleared' });
  }

  async handleUserMessage(text, extraPrefix = '') {
    const input = `${extraPrefix}${text}`.trim();
    if (!input) return;

    // Make sure SecretStorage has been read before the first turn so the
    // stored API key is never missed by a fast first message.
    await ensureSecretsReady();

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
      const settings = getSettings();
      const routed = resolveAgent(input, loadRouterConfig());
      const result = await (
        routed.agent === 'pipeline' && settings.pipelineEnabled !== false
          ? runPipeline({
              input,
              session: this.session,
              workspace: collectWorkspaceSnapshot(),
              settings,
              onDelta: (chunk) => {
                this.view?.webview.postMessage({ type: 'delta', text: chunk });
              },
              signal: abortController.signal,
            })
          : runTurn({
              input,
              session: this.session,
              workspace: collectWorkspaceSnapshot(),
              settings,
              onDelta: (chunk) => {
                this.view?.webview.postMessage({ type: 'delta', text: chunk });
              },
              signal: abortController.signal,
            })
      );
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
      if (result.plan || result.pipeline) {
        const p = result.pipeline || {};
        this.view?.webview.postMessage({
          type: 'pipeline',
          plan: result.plan || p.plan || { tasks: [], sharedDecisions: [] },
          taskResults: result.taskResults || p.taskResults || [],
          qcFindings: result.qcFindings || p.qcFindings || [],
        });
      }
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
      min-width: 72px;
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
    .pipeline-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 10px;
      background: var(--bubble);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .pipeline-head {
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    }
    .pipeline-head:hover { color: var(--fg); }
    .pipeline-body { display: none; font-size: 12px; }
    .pipeline-card.open .pipeline-body { display: block; }
    .pipeline-body .task-line { line-height: 1.5; word-break: break-word; }
    .pipeline-body .task-line .st-done { color: var(--green); }
    .pipeline-body .task-line .st-escalated { color: var(--red); }
    .pipeline-body .task-line .st-skipped, .pipeline-body .qc-line { color: var(--muted); }
    .pipeline-body .qc-line { word-break: break-all; }
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
    <p>Ask · Explore · Plan · Custom — workspace-aware · Pipeline</p>
  </header>
  <div id="thread"></div>
  <div id="status"></div>
  <footer>
    <textarea id="q" placeholder="Ask about the current file…  (@workspace is attached)"></textarea>
    <button id="send">Send</button>
    <button id="stop" class="ghost" style="display:none">Stop</button>
    <button id="speakLatest" class="icon-btn" type="button" title="Speak the latest response" aria-label="Speak the latest response">Speak</button>
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
        .trim()
        // Very long utterances silently fail on some TTS engines; cap at 30k chars.
        .slice(0, 30000);
    }

    function stopSpeech() {
      if (!('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      if (currentSpeechButton) {
        if (currentSpeechButton.id === 'speakLatest') setSpeaking(false);
        else currentSpeechButton.textContent = 'Speak';
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
      button.textContent = 'Stop speaking';
      utterance.onend = utterance.onerror = () => {
        if (currentSpeech === utterance) currentSpeech = null;
        if (currentSpeechButton === button) currentSpeechButton = null;
        button.textContent = 'Speak';
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
        button.textContent = 'Speak';
        button.title = 'Speak this response locally';
        button.setAttribute('aria-label', 'Speak this response locally');
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

    function addPipeline(data) {
      const taskResults = data.taskResults || [];
      const qcFindings = data.qcFindings || [];

      const card = document.createElement('div');
      card.className = 'pipeline-card';

      const head = document.createElement('div');
      head.className = 'pipeline-head';
      head.textContent =
        'Pipeline — ' + taskResults.length + ' tasks · ' + qcFindings.length + ' findings' +
        ' (click to expand)';
      head.addEventListener('click', () => card.classList.toggle('open'));
      card.appendChild(head);

      const body = document.createElement('div');
      body.className = 'pipeline-body';
      for (const t of taskResults) {
        const line = document.createElement('div');
        line.className = 'task-line';
        const glyph = document.createElement('span');
        const st = String(t.status || '');
        if (st === 'done') {
          glyph.className = 'st-done';
          glyph.textContent = '✔';
        } else if (st === 'escalated') {
          glyph.className = 'st-escalated';
          glyph.textContent = '⚠';
        } else if (st === 'skipped-offline') {
          glyph.className = 'st-skipped';
          glyph.textContent = '○';
        } else {
          glyph.className = 'st-skipped';
          glyph.textContent = '○';
        }
        line.appendChild(glyph);
        line.appendChild(
          document.createTextNode(' ' + (t.id || '?') + ' — ' + st + ' (' + (t.rounds || 0) + ' rounds)')
        );
        body.appendChild(line);
      }
      for (const f of qcFindings) {
        const line = document.createElement('div');
        line.className = 'qc-line';
        line.textContent = String(f.severity || '') + ' ' + String(f.file || '') + ' — ' + String(f.issue || '');
        body.appendChild(line);
      }
      card.appendChild(body);

      thread.appendChild(card);
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
    function setSpeaking(on) {
      speakLatestBtn.textContent = on ? 'Stop speaking' : 'Speak';
      speakLatestBtn.title = on ? 'Stop speaking' : 'Speak the latest response locally';
      speakLatestBtn.setAttribute('aria-label', speakLatestBtn.title);
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
      if (m.type === 'pipeline') {
        addPipeline(m);
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

    // Ask the host to replay history and pending proposals after a reload;
    // covers sidebar panels whose webview is destroyed when hidden.
    vscode.postMessage({ type: 'webviewReady' });
  </script>
</body>
</html>`;
  }
}

module.exports = { CopilotXChatViewProvider };
