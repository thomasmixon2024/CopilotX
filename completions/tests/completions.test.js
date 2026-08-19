'use strict';

/**
 * Phase 3 TDD: Inline completion tests (red first, then green).
 * Offline, zero-dependency.
 */

const assert = require('assert');

let completions;
try {
  completions = require('../src/core/completions');
} catch {
  completions = null;
}

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

run('completions module loads', () => {
  assert.ok(completions, 'src/core/completions.js must exist');
  assert.ok(typeof completions.getCompletion === 'function');
  assert.ok(typeof completions.extractPrefixSuffix === 'function');
  assert.ok(typeof completions.shouldTrigger === 'function');
});

run('extractPrefixSuffix splits at cursor', () => {
  assert.ok(completions);
  const doc = 'function hello() {\n  return 1;\n}\n';
  // cursor after "return "
  const offset = doc.indexOf('return ') + 'return '.length;
  const { prefix, suffix } = completions.extractPrefixSuffix(doc, offset);
  assert.ok(prefix.endsWith('return '));
  assert.ok(suffix.startsWith('1;'));
});

run('shouldTrigger is false for empty / whitespace-only typing idle', () => {
  assert.ok(completions);
  assert.strictEqual(completions.shouldTrigger({ prefix: '', suffix: '' }), false);
  assert.strictEqual(
    completions.shouldTrigger({ prefix: '   ', suffix: '', debounceMs: 0, lastTriggerAt: 0 }),
    false
  );
});

run('shouldTrigger respects debounce window', () => {
  assert.ok(completions);
  const now = Date.now();
  const r = completions.shouldTrigger({
    prefix: 'const x = ',
    suffix: '',
    debounceMs: 200,
    lastTriggerAt: now,
    now: now + 50,
  });
  assert.strictEqual(r, false);
  const r2 = completions.shouldTrigger({
    prefix: 'const x = ',
    suffix: '',
    debounceMs: 200,
    lastTriggerAt: now,
    now: now + 250,
  });
  assert.strictEqual(r2, true);
});

run('getCompletion returns local deterministic suggestion for common patterns', () => {
  assert.ok(completions);
  const result = completions.getCompletion({
    prefix: 'function add(a, b) {\n  ',
    suffix: '\n}\n',
    languageId: 'javascript',
  });
  assert.ok(result);
  assert.ok(typeof result.insertText === 'string');
  assert.ok(result.insertText.length > 0);
  assert.ok(result.source === 'local' || result.source === 'deterministic');
});

run('getCompletion returns empty-safe result when no good suggestion', () => {
  assert.ok(completions);
  const result = completions.getCompletion({
    prefix: '',
    suffix: '',
    languageId: 'plaintext',
  });
  assert.ok(result);
  assert.ok(result.insertText === '' || typeof result.insertText === 'string');
});

run('getCompletion is fast-path (no network, sync)', () => {
  assert.ok(completions);
  const start = Date.now();
  for (let i = 0; i < 50; i++) {
    completions.getCompletion({
      prefix: 'const name = ',
      suffix: ';',
      languageId: 'javascript',
    });
  }
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `50 completions took ${elapsed}ms (expected <500ms)`);
});

console.log('');
if (passed === total) {
  console.log(`SUCCESS: ${passed}/${total} completion tests passed.`);
  process.exit(0);
} else {
  console.log(`FAILURE: ${total - passed}/${total} completion tests failed.`);
  process.exit(1);
}
