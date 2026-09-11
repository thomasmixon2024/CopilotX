'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { streamComplete } = require('../src/core/llm');
const {
  buildInlinePrompt,
  extractWindow,
  cleanCompletion,
  INLINE_SYSTEM,
} = require('../src/core/inlinePrompt');

const realFetch = globalThis.fetch;

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    body: {
      getReader() {
        return {
          read() {
            if (index < chunks.length) {
              const value = encoder.encode(chunks[index]);
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

test('OpenAI SSE stream accumulates text deltas and calls onDelta', async () => {
  const deltas = [];
  globalThis.fetch = async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
  try {
    const result = await streamComplete({
      provider: 'openai',
      apiKey: 'k',
      onDelta: (t) => deltas.push(t),
    });
    assert.strictEqual(result.mode, 'live');
    assert.strictEqual(result.text, 'Hello world');
    assert.deepStrictEqual(deltas, ['Hello', ' world']);
    assert.deepStrictEqual(result.toolCalls, []);
    assert.strictEqual(result.assistantMessage.role, 'assistant');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OpenAI SSE stream accumulates chunked tool calls', async () => {
  globalThis.fetch = async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"path"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\":\\"a.txt\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
  try {
    const result = await streamComplete({ provider: 'openai', apiKey: 'k' });
    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(result.toolCalls[0].id, 'c1');
    assert.strictEqual(result.toolCalls[0].name, 'read_file');
    assert.deepStrictEqual(result.toolCalls[0].input, { path: 'a.txt' });
    assert.strictEqual(result.assistantMessage.tool_calls[0].function.arguments, '{"path":"a.txt"}');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Anthropic SSE stream handles text and tool_use blocks', async () => {
  const deltas = [];
  const events = [
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"edit_file"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"x.js\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  globalThis.fetch = async (url, options) => {
    assert.strictEqual(JSON.parse(options.body).stream, true);
    return sseResponse(events);
  };
  try {
    const result = await streamComplete({
      provider: 'anthropic',
      apiKey: 'k',
      onDelta: (t) => deltas.push(t),
    });
    assert.strictEqual(result.mode, 'live');
    assert.strictEqual(result.text, 'Hi');
    assert.deepStrictEqual(deltas, ['Hi']);
    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(result.toolCalls[0].name, 'edit_file');
    assert.deepStrictEqual(result.toolCalls[0].input, { path: 'x.js' });
    assert.strictEqual(result.assistantMessage.content.length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('SSE split across network chunks is parsed correctly', async () => {
  globalThis.fetch = async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel',
      'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":"!"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
  try {
    const result = await streamComplete({ provider: 'openai', apiKey: 'k' });
    assert.strictEqual(result.text, 'Hello!');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('provider none falls back without network access', async () => {
  globalThis.fetch = async () => {
    throw new Error('network must not be touched');
  };
  try {
    const result = await streamComplete({ provider: 'none', apiKey: '' });
    assert.strictEqual(result.mode, 'local');
    assert.strictEqual(result.text, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('extractWindow caps prefix and suffix lines around the cursor', () => {
  const lines = [];
  for (let i = 0; i < 500; i += 1) lines.push(`line${i}`);
  const text = lines.join('\n');
  const offset = text.indexOf('line300');
  const { prefix, suffix } = extractWindow(text, offset);
  assert.ok(prefix.split('\n').length <= 200);
  assert.ok(suffix.split('\n').length <= 40);
  assert.ok(suffix.startsWith('line300'));
});

test('buildInlinePrompt embeds cursor marker and system prompt', () => {
  const prompt = buildInlinePrompt({ prefix: 'const a = ', suffix: ';\n', languageId: 'javascript' });
  assert.strictEqual(prompt.system, INLINE_SYSTEM);
  assert.ok(prompt.user.includes('const a = <CURSOR>;\n'));
  assert.ok(prompt.user.includes('Language: javascript'));
});

test('cleanCompletion strips fences and repeated prefix tails', () => {
  assert.strictEqual(cleanCompletion('```js\nfoo();\n```', ''), 'foo();\n');
  // Model repeated "a = " (the prefix tail "const a = " ends with it): dedup keeps "1;\nb = 2;"
  assert.strictEqual(cleanCompletion('a = 1;\nb = 2;', 'const a = '), '1;\nb = 2;');
  assert.strictEqual(cleanCompletion('const a = 1;', 'const a = '), '1;');
  assert.strictEqual(cleanCompletion('', 'prefix'), '');
});
