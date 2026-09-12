'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// chatView.js and proposalReview.js require('vscode'); provide an inert stub
// so the provider logic can be exercised in plain Node.
const vscodeStub = {
  window: {
    setStatusBarMessage: () => ({ dispose() {} }),
    showWarningMessage: async () => {},
    showErrorMessage: async () => {},
    showInformationMessage: async () => {},
  },
  workspace: { textDocuments: [] },
  Uri: { file: (p) => ({ fsPath: p }) },
  commands: { executeCommand: async () => {} },
};
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, ...args);
};

const { CopilotXChatViewProvider } = require('../src/chatView');
const proposalReview = require('../src/proposalReview');

test('F6: _replayState re-sends history and pending proposal cards to a fresh webview', () => {
  const provider = new CopilotXChatViewProvider('/fake/extension');
  provider.history = [
    { role: 'user', text: 'explain routing' },
    { role: 'assistant', agentName: 'Explore', mode: 'live', reason: 'keyword', text: 'routing answer' },
  ];
  const posted = [];
  provider.view = { webview: { postMessage: (m) => posted.push(m) } };

  const proposal = proposalReview.storeProposal({
    id: 'replay-1',
    tool: 'write_file',
    relPath: 'notes.txt',
    path: '/fake/notes.txt',
    diff: { added: 2, removed: 0 },
    created: true,
  });
  try {
    provider._replayState();
    assert.deepStrictEqual(posted[0], { type: 'user', text: 'explain routing' });
    assert.deepStrictEqual(posted[1], {
      type: 'assistant',
      agent: 'Explore',
      mode: 'live',
      reason: 'keyword',
      text: 'routing answer',
    });
    assert.deepStrictEqual(posted[2], {
      type: 'proposals',
      items: [{ id: 'replay-1', path: 'notes.txt', added: 2, removed: 0, created: true }],
    });
  } finally {
    proposalReview.discardProposal('replay-1');
  }
});

test('F6: webviewReady message triggers replay via the message handler', async () => {
  const provider = new CopilotXChatViewProvider('/fake/extension');
  provider.history = [{ role: 'user', text: 'ping' }];
  const posted = [];
  const fakeWebview = {
    options: undefined,
    html: '',
    onDidReceiveMessage(handler) {
      fakeWebview.handler = handler;
    },
    postMessage: (m) => posted.push(m),
  };
  const fakeView = { webview: fakeWebview };
  provider.resolveWebviewView(fakeView);
  assert.ok(fakeWebview.handler, 'message handler registered');

  await fakeWebview.handler({ type: 'webviewReady' });
  assert.deepStrictEqual(posted[posted.length - 1], { type: 'user', text: 'ping' });
});

test('chat webview exposes local Speak and Stop speaking controls', () => {
  const provider = new CopilotXChatViewProvider('/fake/extension');
  const html = provider._html({ cspSource: 'vscode-resource:' });
  assert.match(html, /id="speakLatest"[^>]*>Speak<\/button>/);
  assert.match(html, /Stop speaking/);
  assert.match(html, /speechSynthesis/);
  assert.match(html, /SpeechSynthesisUtterance/);
  assert.doesNotMatch(html, /https?:\/\/[^"']+speech/i);
});

test('F12: -empty sentinel is derived, not stored', () => {
  const proposal = proposalReview.storeProposal({
    id: 'sentinel-1',
    relPath: 'a.txt',
    path: '/fake/a.txt',
    diff: { added: 0, removed: 0 },
    created: true,
  });
  try {
    assert.ok(!proposalReview.getProposal('sentinel-1-empty'), 'no sentinel entry stored');
  } finally {
    proposalReview.discardProposal('sentinel-1');
  }
});
