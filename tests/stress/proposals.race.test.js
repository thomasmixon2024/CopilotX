'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { buildProposal, applyProposal, checkDrift, diffStats } = require('../../src/core/proposals');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilotx-race-'));
const workspace = { workspaceFolders: [{ name: 'w', path: tmpRoot }] };

function write(rel, content) {
  const abs = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

test('F3a: edit_file matches LF find against CRLF file and preserves CRLF', () => {
  const file = write('crlf.js', 'function a() {\r\n  return 1;\r\n}\r\n');
  const proposal = buildProposal(
    { name: 'edit_file', input: { path: 'crlf.js', find: 'return 1;', replace: 'return 2;' } },
    workspace
  );
  assert.strictEqual(
    proposal.proposed,
    'function a() {\r\n  return 2;\r\n}\r\n',
    'line endings must be preserved'
  );
  applyProposal(proposal);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'function a() {\r\n  return 2;\r\n}\r\n');
});

test('F3b: replacement containing $& $` and $\' is applied literally', () => {
  write('dollars.txt', 'value = [HERE];\n');
  const proposal = buildProposal(
    { name: 'edit_file', input: { path: 'dollars.txt', find: '[HERE]', replace: '$& $` $\' $$' } },
    workspace
  );
  assert.strictEqual(proposal.proposed, "value = $& $` $' $$;\n");
});

test('F7: write_file can propose files in not-yet-existing subdirectories', () => {
  const proposal = buildProposal(
    { name: 'write_file', input: { path: 'deep/nested/dir/new.txt', content: 'created\n' } },
    workspace
  );
  assert.strictEqual(proposal.created, true);
  applyProposal(proposal);
  assert.strictEqual(
    fs.readFileSync(path.join(tmpRoot, 'deep', 'nested', 'dir', 'new.txt'), 'utf8'),
    'created\n'
  );
});

test('F7: traversal guard still holds for new files pointing outside', () => {
  assert.throws(
    () => buildProposal(
      { name: 'write_file', input: { path: 'newdir/../../escape.txt', content: 'x' } },
      workspace
    ),
    /outside the current workspace/
  );
});

test('conflict: double-apply race — second apply is rejected, file written once', () => {
  write('race.txt', 'original\n');
  const proposal = buildProposal(
    { name: 'edit_file', input: { path: 'race.txt', find: 'original', replace: 'updated' } },
    workspace
  );
  applyProposal(proposal);
  // Simulate a second accept clicking through with a stale copy of the same proposal.
  assert.throws(() => applyProposal(proposal), /File changed since/);
  assert.strictEqual(fs.readFileSync(path.join(tmpRoot, 'race.txt'), 'utf8'), 'updated\n');
});

test('F12: 100 build+discard cycles leave no residue in proposal storage', () => {
  write('cycle.txt', 'x\n');
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 100; i += 1) {
    buildProposal(
      { name: 'edit_file', input: { path: 'cycle.txt', find: 'x', replace: `x${i}` } },
      workspace
    );
  }
  const growth = process.memoryUsage().heapUsed - before;
  assert.ok(growth < 32 * 1024 * 1024, 'heap growth should stay bounded');
});

test('F13: diffStats insertion counts only the inserted lines', () => {
  assert.deepStrictEqual(diffStats('a\nb\nc\n', 'NEW1\nNEW2\na\nb\nc\n'), { added: 2, removed: 0 });
  assert.deepStrictEqual(diffStats('a\nb\nc\n', 'a\nb\nc\n'), { added: 0, removed: 0 });
  assert.deepStrictEqual(diffStats('a\nX\nc\n', 'a\nY\nc\n'), { added: 1, removed: 1 });
});

test('F5: checkDrift flags changed content, missing files, and clears unchanged ones', () => {
  write('drift.txt', 'base\n');
  const proposal = buildProposal(
    { name: 'edit_file', input: { path: 'drift.txt', find: 'base', replace: 'next' } },
    workspace
  );
  assert.strictEqual(checkDrift(proposal, 'base\n'), null, 'unchanged disk content is safe');
  assert.match(
    checkDrift(proposal, 'someone edited this\n'),
    /File changed since/
  );
  assert.match(checkDrift(proposal, null), /File no longer exists/);
  assert.match(checkDrift(null, 'anything'), /Invalid proposal/);

  const created = buildProposal(
    { name: 'write_file', input: { path: 'missing.txt', content: 'x' } },
    workspace
  );
  assert.strictEqual(created.created, true);
  assert.strictEqual(checkDrift(created, null), null, 'created proposals may apply to a missing file');
});
