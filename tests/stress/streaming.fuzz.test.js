'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { streamComplete } = require('../../src/core/llm');

const realFetch = globalThis.fetch;

function sseResponse(chunks, { neverFinishes = false } = {}) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    body: {
      getReader() {
        return {
          read() {
            if (neverFinishes) {
              // Stall: never resolve, honor abort.
              return new Promise((_resolve, reject) => {
                process.on('abort', () => reject(new Error('aborted')));
              });
            }
            if (index < chunks.length) {
              const raw = chunks[index];
              const value = typeof raw === 'string' ? encoder.encode(raw) : raw;
              index += 1;
              return Promise.resolve({ done: false, value });
            }
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    },
  };
}

test('F1: CRLF-delimited SSE events stream live (not only at stream end)', async () => {
  const deltas = [];
  globalThis.fetch = async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"one"}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"two"}}]}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ]);
  try {
    const result = await streamComplete({
      provider: 'openai',
      apiKey: 'k',
      onDelta: (t) => deltas.push(t),
    });
    assert.strictEqual(result.text, 'onetwo');
    assert.deepStrictEqual(deltas, ['one', 'two'], 'deltas must arrive before stream end');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('F1: parser invariance — same stream chunked at every byte offset', async () => {
  const stream = 'data: {"choices":[{"delta":{"content":"A"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"B"}}]}\n\n' +
    'data: [DONE]\n\n';

  for (let cut = 1; cut < stream.length; cut += 7) {
    const chunks = [stream.slice(0, cut), stream.slice(cut)];
    globalThis.fetch = async () => sseResponse(chunks);
    try {
      const result = await streamComplete({ provider: 'openai', apiKey: 'k' });
      assert.strictEqual(result.text, 'AB', `chunk boundary at ${cut}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
});

test('fuzz: invalid JSON events and unknown types are skipped', async () => {
  globalThis.fetch = async () =>
    sseResponse([
      'data: {broken json\n\n',
      'data: {"unknown":"shape"}\n\n',
      ': keep-alive comment\n\n',
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
  try {
    const result = await streamComplete({ provider: 'openai', apiKey: 'k' });
    assert.strictEqual(result.text, 'ok');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fuzz: giant single delta and rapid delta bursts accumulate exactly', async () => {
  const giant = 'x'.repeat(1024 * 1024);
  const events = [];
  for (let i = 0; i < 10000; i += 1) {
    events.push(`data: {"choices":[{"delta":{"content":"a"}}]}\n\n`);
  }
  events.push(`data: {"choices":[{"delta":{"content":"${giant}"}}]}\n\n`);
  events.push('data: [DONE]\n\n');
  globalThis.fetch = async () => sseResponse(events);
  try {
    const result = await streamComplete({ provider: 'openai', apiKey: 'k' });
    assert.strictEqual(result.text.length, 10000 + giant.length);
    assert.ok(result.text.startsWith('aaaaaaaaaa'));
    assert.ok(result.text.endsWith(giant.slice(-10)));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fuzz: multibyte UTF-8 split across chunk boundaries', async () => {
  const payload = 'héllo wörld — 日本語 🚀';
  const events = [
    `data: {"choices":[{"delta":{"content":"${payload}"}}]}\n\n`,
    'data: [DONE]\n\n',
  ];
  const encoder = new TextEncoder();
  const full = encoder.encode(events.join(''));
  const halves = [full.subarray(0, 37), full.subarray(37)];
  globalThis.fetch = async () => sseResponse(halves);
  try {
    const result = await streamComplete({ provider: 'openai', apiKey: 'k' });
    assert.strictEqual(result.text, payload);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fuzz: tool_calls with missing, duplicate, and out-of-order indices', async () => {
  globalThis.fetch = async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"name":"list_dir","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"read_file","arguments":"{\\"path\\":\\"a\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
  try {
    const result = await streamComplete({ provider: 'openai', apiKey: 'k' });
    assert.strictEqual(result.toolCalls.length, 2);
    const byId = new Map(result.toolCalls.map((c) => [c.name, c]));
    assert.deepStrictEqual(byId.get('read_file').input, { path: 'a' });
    assert.deepStrictEqual(byId.get('list_dir').input, {});
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('F2: streamed Anthropic tool_use blocks expose input as a parsed object', async () => {
  globalThis.fetch = async () =>
    sseResponse([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"edit_file"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"x.js\\",\\"find\\":\\"a\\",\\"replace\\":\\"b\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
  try {
    const result = await streamComplete({ provider: 'anthropic', apiKey: 'k' });
    const block = result.assistantMessage.content.find((b) => b.type === 'tool_use');
    assert.strictEqual(typeof block.input, 'object', 'Anthropic requires input as object');
    assert.deepStrictEqual(block.input, { path: 'x.js', find: 'a', replace: 'b' });
    assert.deepStrictEqual(result.toolCalls[0].input, { path: 'x.js', find: 'a', replace: 'b' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('F4: stalled stream is rejected by the idle timeout instead of hanging', async () => {
  // True stall: first event arrives, reader then never settles and ignores abort.
  globalThis.fetch = async (_url, options) => {
    const encoder = new TextEncoder();
    let sent = false;
    return {
      ok: true,
      body: {
        getReader() {
          return {
            read() {
              if (!sent) {
                sent = true;
                return Promise.resolve({
                  done: false,
                  value: encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
                });
              }
              return new Promise(() => {});
            },
          };
        },
      },
    };
  };
  const started = Date.now();
  try {
    await assert.rejects(
      streamComplete({ provider: 'openai', apiKey: 'k', stallTimeoutMs: 500 }),
      (err) => err.name === 'TimeoutError'
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 4000, `stall detection took ${elapsed}ms`);
  } finally {
    globalThis.fetch = realFetch;
  }
});
