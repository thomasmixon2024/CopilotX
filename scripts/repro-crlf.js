'use strict';
// Minimal repro: CRLF SSE against current streamComplete — print lifecycle to find the stall.
const { streamComplete } = require('../src/core/llm');

const encoder = new TextEncoder();
const chunks = [
  'data: {"choices":[{"delta":{"content":"one"}}]}\r\n\r\n',
  'data: {"choices":[{"delta":{"content":"two"}}]}\r\n\r\n',
  'data: [DONE]\r\n\r\n',
];
let index = 0;

globalThis.fetch = async () => ({
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
          console.log('READ: exhausted, returning done');
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  },
});

const started = Date.now();
console.log('starting streamComplete...');
(async () => {
  try {
    const result = await streamComplete({ provider: 'openai', apiKey: 'k' });
    console.log(`DONE in ${Date.now() - started}ms text=${JSON.stringify(result.text)}`);
  } catch (err) {
    console.log(`THREW in ${Date.now() - started}ms: ${err.message}`);
  }
  process.exit(0);
})();
