'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildProposal, applyProposal, diffStats } = require('../src/core/proposals');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilotx-proposals-'));
const workspace = { workspaceFolders: [{ name: 'w', path: tmpRoot }] };

fs.writeFileSync(path.join(tmpRoot, 'code.js'), 'function a() {}\nfunction b() {}\n', 'utf8');

test('diffStats counts changed lines', () => {
  assert.deepStrictEqual(diffStats('a\nb\n', 'a\nc\n'), { added: 1, removed: 1 });
  assert.deepStrictEqual(diffStats('', 'x\n'), { added: 1, removed: 0 });
  assert.deepStrictEqual(diffStats('x\n', ''), { added: 0, removed: 1 });
});

test('write_file proposal captures new and existing files', () => {
  const fresh = buildProposal(
    { name: 'write_file', input: { path: 'new.txt', content: 'hello\n' } },
    workspace
  );
  assert.strictEqual(fresh.created, true);
  assert.strictEqual(fresh.original, '');
  assert.strictEqual(fresh.proposed, 'hello\n');

  const overwrite = buildProposal(
    { name: 'write_file', input: { path: 'code.js', content: '/* new */\n' } },
    workspace
  );
  assert.strictEqual(overwrite.created, false);
  assert.ok(overwrite.original.includes('function a()'));

  assert.throws(
    () => buildProposal({ name: 'write_file', input: { path: 'x.js' } }, workspace),
    /content argument/
  );
});

test('edit_file proposal enforces unique exact matches', () => {
  const proposal = buildProposal(
    { name: 'edit_file', input: { path: 'code.js', find: 'function b() {}', replace: 'function c() {}' } },
    workspace
  );
  assert.strictEqual(proposal.proposed, 'function a() {}\nfunction c() {}\n');

  assert.throws(
    () => buildProposal({ name: 'edit_file', input: { path: 'code.js', find: 'function ', replace: 'x' } }, workspace),
    /appears 2 times/
  );
  assert.throws(
    () => buildProposal({ name: 'edit_file', input: { path: 'code.js', find: 'missing', replace: 'x' } }, workspace),
    /does not appear/
  );
});

test('proposals reject paths outside the workspace', () => {
  assert.throws(
    () => buildProposal({ name: 'write_file', input: { path: '../escape.txt', content: 'x' } }, workspace),
    /outside the current workspace/
  );
});

test('applyProposal writes the file and detects concurrent changes', () => {
  const proposal = buildProposal(
    { name: 'edit_file', input: { path: 'code.js', find: 'function a() {}', replace: 'function z() {}' } },
    workspace
  );

  fs.writeFileSync(proposal.path, 'CHANGED', 'utf8');
  assert.throws(() => applyProposal(proposal), /File changed since/);

  fs.writeFileSync(proposal.path, proposal.original, 'utf8');
  const result = applyProposal(proposal);
  assert.strictEqual(result.applied, true);
  assert.strictEqual(fs.readFileSync(proposal.path, 'utf8'), 'function z() {}\nfunction b() {}\n');

  const fresh = buildProposal(
    { name: 'write_file', input: { path: 'brand-new.txt', content: 'v1\n' } },
    workspace
  );
  applyProposal(fresh);
  assert.strictEqual(fs.readFileSync(path.join(tmpRoot, 'brand-new.txt'), 'utf8'), 'v1\n');
});

test('applyProposal refuses to apply after the file was deleted', () => {
  fs.writeFileSync(path.join(tmpRoot, 'gone.js'), 'x', 'utf8');
  const proposal = buildProposal(
    { name: 'edit_file', input: { path: 'gone.js', find: 'x', replace: 'y' } },
    workspace
  );
  fs.rmSync(path.join(tmpRoot, 'gone.js'), { force: true });
  assert.throws(() => applyProposal(proposal), /no longer exists/);
});
