'use strict';

/**
 * Phase 2 TDD: Tool execution tests (written first - expected to fail until
 * src/core/tools.js is implemented).
 * Zero-dependency, offline-only.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

let tools;
try {
  tools = require('../src/core/tools');
} catch (err) {
  tools = null;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilotx-tools-'));

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

run('tools module loads', () => {
  assert.ok(tools, 'src/core/tools.js must export a module');
  assert.ok(typeof tools.applyToolPayload === 'function');
  assert.ok(typeof tools.parseUnifiedDiff === 'function');
  assert.ok(typeof tools.isPathSafe === 'function');
});

run('isPathSafe blocks path traversal', () => {
  assert.ok(tools);
  assert.strictEqual(tools.isPathSafe(tmpRoot, path.join(tmpRoot, 'ok.js')), true);
  assert.strictEqual(tools.isPathSafe(tmpRoot, path.join(tmpRoot, '..', 'escape.js')), false);
  assert.strictEqual(tools.isPathSafe(tmpRoot, '/etc/passwd'), false);
});

run('FILE_CREATE creates a new file inside workspace root', () => {
  assert.ok(tools);
  const target = path.join(tmpRoot, 'created.txt');
  const result = tools.applyToolPayload(tmpRoot, {
    type: 'FILE_CREATE',
    path: 'created.txt',
    content: 'hello tools\n',
  });
  assert.strictEqual(result.ok, true);
  assert.ok(fs.existsSync(target));
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'hello tools\n');
});

run('FILE_CREATE refuses path outside workspace', () => {
  assert.ok(tools);
  const result = tools.applyToolPayload(tmpRoot, {
    type: 'FILE_CREATE',
    path: '../outside.txt',
    content: 'nope',
  });
  assert.strictEqual(result.ok, false);
  assert.ok(/path|safe|traversal/i.test(result.error || ''));
});

run('FILE_PATCH applies a unified diff to an existing file', () => {
  assert.ok(tools);
  const rel = 'patchme.js';
  const abs = path.join(tmpRoot, rel);
  fs.writeFileSync(abs, 'function hi() {\n  return 1;\n}\n', 'utf8');

  const diff = [
    `--- a/${rel}`,
    `+++ b/${rel}`,
    '@@ -1,3 +1,3 @@',
    ' function hi() {',
    '-  return 1;',
    '+  return 2;',
    ' }',
    '',
  ].join('\n');

  const result = tools.applyToolPayload(tmpRoot, {
    type: 'FILE_PATCH',
    path: rel,
    diff,
  });
  assert.strictEqual(result.ok, true, result.error || 'patch failed');
  const updated = fs.readFileSync(abs, 'utf8');
  assert.ok(updated.includes('return 2;'));
  assert.ok(!updated.includes('return 1;'));
});

run('parseUnifiedDiff extracts file hunks', () => {
  assert.ok(tools);
  const diff = [
    '--- a/foo.txt',
    '+++ b/foo.txt',
    '@@ -1,2 +1,2 @@',
    '-old',
    '+new',
    ' keep',
    '',
  ].join('\n');
  const parsed = tools.parseUnifiedDiff(diff);
  assert.ok(parsed);
  assert.ok(parsed.hunks && parsed.hunks.length >= 1);
});

run('FILE_PATCH fails cleanly on invalid diff', () => {
  assert.ok(tools);
  const rel = 'badpatch.txt';
  fs.writeFileSync(path.join(tmpRoot, rel), 'abc\n', 'utf8');
  const result = tools.applyToolPayload(tmpRoot, {
    type: 'FILE_PATCH',
    path: rel,
    diff: 'this is not a valid unified diff',
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error);
});

run('TERMINAL_EXEC is blocked by default (safety)', () => {
  assert.ok(tools);
  const result = tools.applyToolPayload(tmpRoot, {
    type: 'TERMINAL_EXEC',
    command: 'echo hello',
  });
  // Default: require explicit allowTerminal flag
  assert.strictEqual(result.ok, false);
  assert.ok(/terminal|disabled|allow/i.test(result.error || ''));
});

run('TERMINAL_EXEC runs allowlisted command when enabled', () => {
  assert.ok(tools);
  const result = tools.applyToolPayload(
    tmpRoot,
    { type: 'TERMINAL_EXEC', command: 'echo copilotx-tools-ok' },
    { allowTerminal: true, allowedCommands: ['echo'] }
  );
  assert.strictEqual(result.ok, true, result.error || 'exec failed');
  assert.ok(String(result.stdout || '').includes('copilotx-tools-ok'));
});

run('TERMINAL_EXEC rejects non-allowlisted commands', () => {
  assert.ok(tools);
  const result = tools.applyToolPayload(
    tmpRoot,
    { type: 'TERMINAL_EXEC', command: 'rm -rf /' },
    { allowTerminal: true, allowedCommands: ['echo', 'node'] }
  );
  assert.strictEqual(result.ok, false);
  assert.ok(/allow|denied|reject/i.test(result.error || ''));
});

run('unknown tool type fails safely', () => {
  assert.ok(tools);
  const result = tools.applyToolPayload(tmpRoot, { type: 'NUKE_EVERYTHING' });
  assert.strictEqual(result.ok, false);
});

// cleanup
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch (_) {}

console.log('');
if (passed === total) {
  console.log(`SUCCESS: ${passed}/${total} tool tests passed.`);
  process.exit(0);
} else {
  console.log(`FAILURE: ${total - passed}/${total} tool tests failed.`);
  process.exit(1);
}
