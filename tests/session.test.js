'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  createSession,
  appendTurn,
  formatContextBlock,
  summarize,
  MAX_TURNS,
} = require('../src/core/session');

test('createSession returns an empty session', () => {
  const s = createSession('test-id');
  assert.strictEqual(s.sessionId, 'test-id');
  assert.deepStrictEqual(s.turns, []);
});

test('appendTurn adds timestamped turns and trims to MAX_TURNS', () => {
  let s = createSession('trim');
  for (let i = 0; i < MAX_TURNS + 5; i += 1) {
    s = appendTurn(s, { input: `m${i}`, agent: 'ask', text: 't', summary: 's' });
  }
  assert.strictEqual(s.turns.length, MAX_TURNS);
  assert.strictEqual(s.turns[s.turns.length - 1].input, `m${MAX_TURNS + 4}`);
  assert.ok(typeof s.turns[0].at === 'number');
});

test('formatContextBlock is empty with no turns', () => {
  assert.strictEqual(formatContextBlock(createSession('x')), '');
  assert.strictEqual(formatContextBlock(null), '');
});

test('formatContextBlock includes recent turns', () => {
  let s = createSession('ctx');
  s = appendTurn(s, { input: 'first question', agent: 'ask', text: 'answer one', summary: 'answer one' });
  s = appendTurn(s, { input: 'second question', agent: 'plan', text: 'answer two', summary: 'answer two' });
  const block = formatContextBlock(s);
  assert.ok(block.includes('first question'));
  assert.ok(block.includes('answer two'));
  assert.ok(block.includes('ask'));
});

test('summarize collapses whitespace and caps length', () => {
  const out = summarize('  a\n\n  b   c  '.repeat(100));
  assert.ok(out.length <= 280);
  assert.ok(!out.includes('\n'));
});
