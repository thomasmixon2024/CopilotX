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

test('getToolDefinitions exposes read/list/search with schemas', () => {
  const tools = getToolDefinitions();
  assert.strictEqual(tools.length, 3);
  assert.deepStrictEqual(
    tools.map((t) => t.name).sort(),
    ['list_dir', 'read_file', 'search_files']
  );
  assert.strictEqual(tools.find((t) => t.name === 'read_file').input_schema.required[0], 'path');
});

test('read_file reads a workspace-relative file with line ranges', async () => {
  const result = await executeToolCall({ name: 'read_file', input: { path: 'hello.txt', start_line: 2, end_line: 3 } }, workspace);
  assert.strictEqual(result.content, 'line2\nline3');
  assert.strictEqual(result.total_lines, 4);
  assert.strictEqual(result.truncated, false);
});

test('read_file rejects paths outside the workspace', async () => {
  fs.writeFileSync(path.join(path.dirname(tmpRoot), 'outside.txt'), 'secret', 'utf8');
  try {
    await assert.rejects(
      executeToolCall({ name: 'read_file', input: { path: '../outside.txt' } }, workspace),
      /outside|ENOENT|no such/i
    );
  } finally {
    fs.rmSync(path.join(path.dirname(tmpRoot), 'outside.txt'), { force: true });
  }
});

test('read_file rejects absolute paths outside the workspace', async () => {
  const outside = path.join(os.tmpdir(), 'copilotx-abs-outside.txt');
  fs.writeFileSync(outside, 'secret', 'utf8');
  try {
    await assert.rejects(
      executeToolCall({ name: 'read_file', input: { path: outside } }, workspace),
      /outside the current workspace/i
    );
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test('read_file rejects unknown tools and missing paths', async () => {
  await assert.rejects(
    executeToolCall({ name: 'write_file', input: {} }, workspace),
    /Unknown tool/
  );
  await assert.rejects(
    executeToolCall({ name: 'read_file', input: { path: '' } }, workspace),
    /non-empty path/
  );
});

test('list_dir lists entries with depth limits and skips hidden/node_modules', async () => {
  fs.mkdirSync(path.join(tmpRoot, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'sub', 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'sub', 'deep', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'sub', 'a.js'), 'x', 'utf8');
  fs.writeFileSync(path.join(tmpRoot, 'sub', 'node_modules', 'dep.js'), 'x', 'utf8');
  fs.writeFileSync(path.join(tmpRoot, 'sub', 'deep', 'deeper', 'z.js'), 'x', 'utf8');
  try {
    const result = await executeToolCall({ name: 'list_dir', input: { path: 'sub', depth: 2 } }, workspace);
    assert.ok(result.entries.includes('sub/a.js'));
    assert.ok(result.entries.includes('sub/deep/'));
    assert.ok(result.entries.includes('sub/deep/deeper/')); // dir entry itself still listed
    assert.ok(!result.entries.includes('sub/node_modules/'));
    assert.ok(!result.entries.includes('sub/deep/deeper/z.js')); // deeper contents beyond depth
  } finally {
    fs.rmSync(path.join(tmpRoot, 'sub'), { recursive: true, force: true });
  }
});

test('list_dir rejects paths outside the workspace and non-directories', async () => {
  await assert.rejects(
    executeToolCall({ name: 'list_dir', input: { path: '..' } }, workspace),
    /outside the current workspace|Path is not a directory/
  );
  await assert.rejects(
    executeToolCall({ name: 'list_dir', input: { path: 'hello.txt' } }, workspace),
    /Path is not a directory/
  );
});

test('search_files finds literal and regex matches with caps', async () => {
  fs.mkdirSync(path.join(tmpRoot, 'scan'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'scan', 'one.js'), 'const alpha = 1;\nconst beta = alpha;\n', 'utf8');
  fs.writeFileSync(path.join(tmpRoot, 'scan', 'two.js'), 'gamma();\n', 'utf8');
  fs.writeFileSync(path.join(tmpRoot, 'scan', 'bin.dat'), 'ok\x00binary\n', 'utf8');
  try {
    const literal = await executeToolCall({ name: 'search_files', input: { pattern: 'ALPHA' } }, workspace);
    assert.strictEqual(literal.total_matches, 2);
    assert.ok(literal.matches.every((m) => m.file.startsWith('scan/')));

    const regex = await executeToolCall({
      name: 'search_files',
      input: { pattern: 'const \\w+ = ', is_regex: true, max_results: 1 },
    }, workspace);
    assert.strictEqual(regex.total_matches, 1);
    assert.strictEqual(regex.truncated, true);

    await assert.rejects(
      executeToolCall({ name: 'search_files', input: { pattern: '   ' } }, workspace),
      /non-empty pattern/
    );
    await assert.rejects(
      executeToolCall({ name: 'search_files', input: { pattern: 'x(', is_regex: true } }, workspace),
      /Invalid regular expression/
    );
  } finally {
    fs.rmSync(path.join(tmpRoot, 'scan'), { recursive: true, force: true });
  }
});

test('read_file caps very large files and reports truncation', async () => {
  const bigPath = path.join(tmpRoot, 'big.txt');
  const oneLine = 'x'.repeat(120) + '\n';
  fs.writeFileSync(bigPath, oneLine.repeat(1500), 'utf8'); // ~180 KB, > 100 KB cap
  const result = await executeToolCall({ name: 'read_file', input: { path: 'big.txt' } }, workspace);
  assert.strictEqual(result.truncated, true);
  assert.ok(result.content.length <= 100 * 1024 + 4096);
  fs.rmSync(bigPath, { force: true });
});

test('read_file follows an in-workspace symlink but blocks symlink escapes', async () => {
  const target = path.join(tmpRoot, 'real.txt');
  const link = path.join(tmpRoot, 'link.txt');
  fs.writeFileSync(target, 'symlink content\n', 'utf8');
  try {
    fs.symlinkSync(target, link, 'file');
  } catch {
    return; // Windows without symlink privilege: skip this test
  }

  const inside = await executeToolCall({ name: 'read_file', input: { path: 'link.txt' } }, workspace);
  assert.ok(inside.content.includes('symlink content'));
  fs.rmSync(link, { force: true });

  const outsideTarget = path.join(path.dirname(tmpRoot), 'escape-target.txt');
  fs.writeFileSync(outsideTarget, 'outside', 'utf8');
  try {
    fs.symlinkSync(outsideTarget, link, 'file');
    await assert.rejects(
      executeToolCall({ name: 'read_file', input: { path: 'link.txt' } }, workspace),
      /outside the current workspace/
    );
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(outsideTarget, { force: true });
  }
});
