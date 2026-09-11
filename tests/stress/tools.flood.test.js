'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { executeToolCall } = require('../../src/core/tools');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilotx-flood-'));
const workspace = { workspaceFolders: [{ name: 'w', path: tmpRoot }] };

// Build a moderately large tree once for the whole file.
const bigDir = path.join(tmpRoot, 'flood');
fs.mkdirSync(bigDir, { recursive: true });
for (let i = 0; i < 220; i += 1) {
  fs.writeFileSync(
    path.join(bigDir, `file-${i}.txt`),
    `payload ${i}\nneedle-${i % 7}\n` + 'filler\n'.repeat(30),
    'utf8'
  );
}

test('F10: search across 220 files completes within the time budget', async () => {
  const started = Date.now();
  const result = await executeToolCall(
    { name: 'search_files', input: { pattern: 'needle-3', path: 'flood', max_results: 50 } },
    workspace
  );
  const elapsed = Date.now() - started;
  // The 200-file scan cap (alphabetical readdir) may hide a few needle files.
  assert.ok(result.total_matches >= 15, `expected >=15 matches, got ${result.total_matches}`);
  assert.ok(elapsed < 5000, `search took ${elapsed}ms — extension host would jank`);
});

test('ReDoS-style regex is rejected or bounded, never catastrophic', async () => {
  const evil = path.join(bigDir, 'evil.txt');
  fs.writeFileSync(evil, `aaaaaaaaaaaaaaaaaaaX\n${'a'.repeat(20)}\n`, 'utf8');
  const started = Date.now();
  // 20-char evil line keeps pre-patch backtracking ~1M steps (fast red);
  // post-patch the complexity guard rejects the pattern outright.
  let result = null;
  let threw = null;
  try {
    result = await executeToolCall(
      { name: 'search_files', input: { pattern: '(a+)+$', is_regex: true, path: 'flood', max_results: 10 } },
      workspace
    );
  } catch (err) {
    threw = err;
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `pathological regex took ${elapsed}ms`);
  if (threw) {
    assert.match(threw.message, /too complex|nested quantifier/i);
  } else {
    assert.ok(result.total_matches <= 10);
  }
  fs.rmSync(evil, { force: true });
});

test('read_file handles a single line with no newline and large content', async () => {
  const huge = path.join(tmpRoot, 'one-line.txt');
  fs.writeFileSync(huge, 'z'.repeat(300 * 1024), 'utf8'); // 300 KB, one line
  const result = await executeToolCall(
    { name: 'read_file', input: { path: 'one-line.txt' } },
    workspace
  );
  assert.strictEqual(result.truncated, true);
  assert.ok(result.content.length <= 100 * 1024 + 4096);
  assert.strictEqual(result.total_lines, 1);
  fs.rmSync(huge, { force: true });
});

test('list_dir truncates a 5k-entry directory at the cap', async () => {
  const many = path.join(tmpRoot, 'many');
  fs.mkdirSync(many, { recursive: true });
  for (let i = 0; i < 5000; i += 1) fs.writeFileSync(path.join(many, `f${i}.txt`), 'x', 'utf8');
  const result = await executeToolCall(
    { name: 'list_dir', input: { path: 'many', depth: 1 } },
    workspace
  );
  assert.strictEqual(result.total, 400);
  assert.strictEqual(result.truncated, true);
  fs.rmSync(many, { recursive: true, force: true });
});

test('unicode, spaces, and deep nesting survive list + search', async () => {
  const uni = path.join(tmpRoot, 'uni deep dir');
  fs.mkdirSync(uni, { recursive: true });
  fs.writeFileSync(path.join(uni, '文件 🚀.txt'), 'unique-unicode-needle\n', 'utf8');
  const list = await executeToolCall(
    { name: 'list_dir', input: { path: '.', depth: 2 } },
    workspace
  );
  assert.ok(list.entries.some((e) => e.includes('文件 🚀.txt')));
  const found = await executeToolCall(
    { name: 'search_files', input: { pattern: 'unique-unicode-needle', path: 'uni deep dir', max_results: 5 } },
    workspace
  );
  assert.ok(found.matches.some((m) => m.file.includes('文件 🚀.txt')));
  fs.rmSync(uni, { recursive: true, force: true });
});
