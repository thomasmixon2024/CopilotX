'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { runTurn } = require('../../src/core/engine');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilotx-conflict-'));
const workspace = { workspaceFolders: [{ name: 'w', path: tmpRoot }] };
const realFetch = globalThis.fetch;

const baseSettings = {
  model: '',
  openaiBaseUrl: 'https://api.openai.com/v1',
  includeWorkspace: false,
  streamResponses: false,
  allowWrites: 'approval',
};

test('F9: tool-round exhaustion produces a truthful message, not a network excuse', async () => {
  let round = 0;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: '',
          tool_calls: [{
            id: `call-${round++}`,
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
          }],
        },
      }],
    }),
  });
  try {
    const result = await runTurn({
      input: 'loop forever',
      session: { sessionId: 't', turns: [] },
      workspace,
      settings: { ...baseSettings, provider: 'openai', apiKey: 'k' },
    });
    assert.strictEqual(result.mode, 'live');
    assert.match(result.text, /tool-call limit/i);
    assert.doesNotMatch(result.text, /could not reach the configured model/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('conflict: every tool call failing in every round still terminates gracefully', async () => {
  let round = 0;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: '',
          tool_calls: [{
            id: `c-${round++}`,
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"missing-' + round + '.txt"}' },
          }],
        },
      }],
    }),
  });
  try {
    const result = await runTurn({
      input: 'failing tools',
      session: { sessionId: 't', turns: [] },
      workspace,
      settings: { ...baseSettings, provider: 'openai', apiKey: 'k' },
    });
    // Exhausts rounds; final message must exist and reference the limit, mode live.
    assert.strictEqual(result.mode, 'live');
    assert.ok(result.text && result.text.length > 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('conflict: 10 concurrent runTurns keep proposals and text independent', async () => {
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const userMsg = body.messages.find((m) => m.role === 'user');
    const match = userMsg ? userMsg.content.match(/(\d+)\s*$/) : null;
    const asked = match ? match[1] : '0';
    const firstModelRound = !body.messages.some((m) => m.role === 'assistant');
    if (firstModelRound) {
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'w1',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({ path: `out-${asked}.txt`, content: `content-${asked}` }),
                },
              }],
            },
          }],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: `done ${asked}`, tool_calls: [] } }],
      }),
    };
  };
  try {
    const turns = [];
    for (let i = 0; i < 10; i += 1) {
      turns.push(
        runTurn({
          input: String(i),
          session: { sessionId: `t${i}`, turns: [] },
          workspace,
          settings: { ...baseSettings, provider: 'openai', apiKey: 'k' },
        })
      );
    }
    const results = await Promise.all(turns);
    const seen = new Set();
    results.forEach((r, i) => {
      assert.strictEqual(r.proposals.length, 1, `turn ${i} made one proposal`);
      const rel = r.proposals[0].relPath;
      assert.strictEqual(rel, `out-${i}.txt`, `turn ${i} got its own path`);
      assert.strictEqual(r.text, `done ${i}`, `turn ${i} got its own answer`);
      seen.add(rel);
    });
    assert.strictEqual(seen.size, 10);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('F8: TimeoutError from request timeout is classified distinctly', async () => {
  globalThis.fetch = async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  };
  try {
    const result = await runTurn({
      input: 'explain routing',
      session: { sessionId: 't', turns: [] },
      workspace,
      settings: { ...baseSettings, provider: 'openai', apiKey: 'k' },
    });
    assert.strictEqual(result.mode, 'timeout');
    assert.match(result.text, /timed out/i);
    assert.doesNotMatch(result.text, /could not reach the configured model/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('conflict: abort mid-turn with no final text yet still reports stopped', async () => {
  const controller = new AbortController();
  globalThis.fetch = async () => {
    controller.abort();
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    throw err;
  };
  try {
    const result = await runTurn({
      input: 'explain routing',
      session: { sessionId: 't', turns: [] },
      workspace,
      settings: { ...baseSettings, provider: 'openai', apiKey: 'k' },
      signal: controller.signal,
    });
    assert.strictEqual(result.mode, 'stopped');
    assert.ok(result.text && result.text.length > 0);
    assert.doesNotMatch(result.text, /could not reach the configured model/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
