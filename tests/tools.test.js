'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { executeToolCall, getToolDefinitions } = require('../src/core/tools');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilotx-tools-'));
const workspace = { workspaceFolders: [{ name: 'w', path: tmpRoot }] };

fs.writeFileSync(path.join(tmpRoot, 'hello.txt'), 'line1\nline2\nline3\n', 'utf8');

test('getToolDefinitions exposes read_file with a schema', () => {
  const tools = getToolDefinitions();
  assert.strictEqual(tools.length, 1);
  assert.strictEqual(tools[0].name, 'read_file');
  assert.strictEqual(tools[0].input_schema.required[0], 'path');
});

test('read_file reads a workspace-relative file with line ranges', () => {
  const result = executeToolCall({ name: 'read_file', input: { path: 'hello.txt', start_line: 2, end_line: 3 } }, workspace);
  assert.strictEqual(result.content, 'line2\nline3');
  assert.strictEqual(result.total_lines, 4);
  assert.strictEqual(result.truncated, false);
});

test('read_file rejects paths outside the workspace', () => {
  fs.writeFileSync(path.join(path.dirname(tmpRoot), 'outside.txt'), 'secret', 'utf8');
  try {
    executeToolCall({ name: 'read_file', input: { path: '../outside.txt' } }, workspace);
    assert.fail('expected an error');
  } catch (err) {
    assert.ok(/outside|ENOENT|no such/i.test(err.message));
  } finally {
    fs.rmSync(path.join(path.dirname(tmpRoot), 'outside.txt'), { force: true });
  }
});

test('read_file rejects absolute paths outside the workspace', () => {
  const outside = path.join(os.tmpdir(), 'copilotx-abs-outside.txt');
  fs.writeFileSync(outside, 'secret', 'utf8');
  try {
    executeToolCall({ name: 'read_file', input: { path: outside } }, workspace);
    assert.fail('expected an error');
  } catch (err) {
    assert.ok(/outside the current workspace/i.test(err.message));
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test('read_file rejects unknown tools and missing paths', () => {
  assert.throws(() => executeToolCall({ name: 'write_file', input: {} }, workspace), /Unknown tool/);
  assert.throws(() => executeToolCall({ name: 'read_file', input: { path: '' } }, workspace), /non-empty path/);
});

test('read_file caps very large files and reports truncation', () => {
  const bigPath = path.join(tmpRoot, 'big.txt');
  const oneLine = 'x'.repeat(120) + '\n';
  fs.writeFileSync(bigPath, oneLine.repeat(1500), 'utf8'); // ~180 KB, > 100 KB cap
  const result = executeToolCall({ name: 'read_file', input: { path: 'big.txt' } }, workspace);
  assert.strictEqual(result.truncated, true);
  assert.ok(result.content.length <= 100 * 1024 + 4096);
  fs.rmSync(bigPath, { force: true });
});

test('read_file follows an in-workspace symlink but blocks symlink escapes', () => {
  const target = path.join(tmpRoot, 'real.txt');
  const link = path.join(tmpRoot, 'link.txt');
  fs.writeFileSync(target, 'symlink content\n', 'utf8');
  let created = false;
  try {
    fs.symlinkSync(target, link, 'file');
    created = true;
  } catch {
    return; // Windows without symlink privilege: skip this test
  }
  if (created) {
    const inside = executeToolCall({ name: 'read_file', input: { path: 'link.txt' } }, workspace);
    assert.ok(inside.content.includes('symlink content'));
    fs.rmSync(link, { force: true });

    const outsideTarget = path.join(path.dirname(tmpRoot), 'escape-target.txt');
    fs.writeFileSync(outsideTarget, 'outside', 'utf8');
    try {
      fs.symlinkSync(outsideTarget, link, 'file');
      assert.throws(
        () => executeToolCall({ name: 'read_file', input: { path: 'link.txt' } }, workspace),
        /outside the current workspace/
      );
    } catch {
      // symlink creation failed (privilege); nothing more to assert
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(outsideTarget, { force: true });
    }
  }
});
