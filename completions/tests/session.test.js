'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  loadSession,
  saveSession,
  clearSession,
  appendTurn,
  formatContextBlock,
  summarizeResponse,
} = require('../src/core/session');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'copilotx-session-'));

function test(name, fn) {
  try {
    fn();
    console.log(`PASS - ${name}`);
    return true;
  } catch (err) {
    console.log(`FAIL - ${name} :: ${err.message}`);
    return false;
  }
}

let passed = 0;
let total = 0;

function run(name, fn) {
  total++;
  if (test(name, fn)) passed++;
}

run('loadSession returns empty structure for missing file', () => {
  const s = loadSession(tmp, 'fresh');
  assert.strictEqual(s.sessionId, 'fresh');
  assert.deepStrictEqual(s.turns, []);
});

run('appendTurn + saveSession + loadSession round-trip', () => {
  let s = loadSession(tmp, 'round');
  s = appendTurn(s, { input: 'hello', agent: 'ask', mode: 'deterministic', summary: 'hi back' }, 6);
  saveSession(tmp, s);
  const loaded = loadSession(tmp, 'round');
  assert.strictEqual(loaded.turns.length, 1);
  assert.strictEqual(loaded.turns[0].input, 'hello');
  assert.strictEqual(loaded.turns[0].agent, 'ask');
});

run('appendTurn trims to maxTurns', () => {
  let s = { sessionId: 'trim', turns: [] };
  for (let i = 0; i < 10; i++) {
    s = appendTurn(s, { input: `m${i}`, agent: 'ask', mode: 'deterministic', summary: `s${i}` }, 3);
  }
  assert.strictEqual(s.turns.length, 3);
  assert.strictEqual(s.turns[0].input, 'm7');
  assert.strictEqual(s.turns[2].input, 'm9');
});

run('formatContextBlock is empty when no turns', () => {
  assert.strictEqual(formatContextBlock({ turns: [] }), '');
});

run('formatContextBlock includes prior turns', () => {
  const s = {
    turns: [
      { input: 'first', agent: 'ask', mode: 'deterministic', summary: 'ans1' },
      { input: 'second', agent: 'plan', mode: 'deterministic', summary: 'ans2' },
    ],
  };
  const block = formatContextBlock(s);
  assert.ok(block.includes('first'));
  assert.ok(block.includes('second'));
  assert.ok(block.includes('ASK'));
  assert.ok(block.includes('PLAN'));
});

run('summarizeResponse skips headers and picks substance', () => {
  const text = `[ASK AGENT]
Routed on keyword match: explain

Input: hello

1. Interpret intent
   Core question detected: "hello"

Mode: deterministic.`;
  const summary = summarizeResponse(text);
  assert.ok(summary.includes('Interpret') || summary.includes('Core question'));
  assert.ok(!summary.startsWith('['));
});

run('clearSession removes the file', () => {
  let s = loadSession(tmp, 'clearme');
  s = appendTurn(s, { input: 'x', agent: 'ask', mode: 'deterministic', summary: 'y' });
  saveSession(tmp, s);
  clearSession(tmp, 'clearme');
  const again = loadSession(tmp, 'clearme');
  assert.deepStrictEqual(again.turns, []);
});

// cleanup
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (_) {}

console.log('');
if (passed === total) {
  console.log(`SUCCESS: ${passed}/${total} session tests passed.`);
  process.exit(0);
} else {
  console.log(`FAILURE: ${total - passed}/${total} session tests failed.`);
  process.exit(1);
}
