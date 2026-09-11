'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { runTurn } = require('../src/core/engine');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilotx-engine-'));
const workspace = { workspaceFolders: [{ name: 'w', path: tmpRoot }] };
const baseSettings = { model: '', openaiBaseUrl: 'https://api.openai.com/v1', includeWorkspace: false, streamResponses: false };

const realFetch = globalThis.fetch;

test('provider none returns the deterministic local template', async () => {
  const result = await runTurn({
    input: 'explain how routing works',
    session: { sessionId: 't', turns: [] },
    workspace,
    settings: { ...baseSettings, provider: 'none', apiKey: '' },
  });
  assert.strictEqual(result.mode, 'local');
  assert.strictEqual(result.agent, 'ask');
  assert.ok(result.text.includes('routed via'));
  assert.ok(result.text.includes('Live model is off'));
});

test('live tool-call loop executes read_file and returns the final answer', async () => {
  const responses = [
    {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: '',
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"note.txt"}' },
            }],
          },
        }],
      }),
    },
    {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'The note says hello.', tool_calls: [] } }],
      }),
    },
  ];
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options ? JSON.parse(options.body) : null });
    return responses[Math.min(calls.length - 1, responses.length - 1)];
  };
  try {
    fs.writeFileSync(path.join(tmpRoot, 'note.txt'), 'hello\n', 'utf8');
    const result = await runTurn({
      input: 'read note.txt and tell me what it says',
      session: { sessionId: 't', turns: [] },
      workspace,
      settings: { ...baseSettings, provider: 'openai', apiKey: 'test-key' },
    });
    assert.strictEqual(result.mode, 'live');
    assert.strictEqual(result.text, 'The note says hello.');
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[1].body.messages.at(-1).role, 'tool');
    assert.ok(calls[1].body.messages.at(-1).content.includes('hello'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('empty live response produces an explicit message instead of the local template', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '', tool_calls: [] } }] }),
  });
  try {
    const result = await runTurn({
      input: 'explain routing',
      session: { sessionId: 't', turns: [] },
      workspace,
      settings: { ...baseSettings, provider: 'openai', apiKey: 'test-key' },
    });
    assert.strictEqual(result.mode, 'live');
    assert.ok(result.text.includes('returned an empty response'));
    assert.ok(!result.text.includes('Live model is off'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('live provider failure falls back with the error surfaced', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    text: async () => 'boom',
  });
  try {
    const result = await runTurn({
      input: 'explain routing',
      session: { sessionId: 't', turns: [] },
      workspace,
      settings: { ...baseSettings, provider: 'openai', apiKey: 'test-key' },
    });
    assert.strictEqual(result.mode, 'fallback');
    assert.ok(result.text.includes('could not reach the configured model'));
    assert.ok(result.text.includes('OpenAI 500'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('streaming mode forwards deltas through runTurn', async () => {
  const encoder = new TextEncoder();
  globalThis.fetch = async () => ({
    ok: true,
    body: {
      getReader() {
        const chunks = [
          encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'),
          encoder.encode('data: {"choices":[{"delta":{"content":" from stream"}}]}\n\ndata: [DONE]\n\n'),
        ];
        let i = 0;
        return {
          read: () =>
            i < chunks.length
              ? Promise.resolve({ done: false, value: chunks[i++] })
              : Promise.resolve({ done: true, value: undefined }),
        };
      },
    },
  });
  const deltas = [];
  try {
    const result = await runTurn({
      input: 'say hi',
      session: { sessionId: 't', turns: [] },
      workspace,
      settings: { ...baseSettings, provider: 'openai', apiKey: 'test-key', streamResponses: true },
      onDelta: (t) => deltas.push(t),
    });
    assert.strictEqual(result.mode, 'live');
    assert.strictEqual(result.text, 'Hello from stream');
    assert.deepStrictEqual(deltas, ['Hello', ' from stream']);
  } finally {
    globalThis.fetch = realFetch;
  }
});
