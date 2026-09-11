'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { formatWorkspaceBlock, mentionsWorkspace } = require('../src/core/workspace');

const sample = {
  workspaceFolders: [{ name: 'CopilotX', path: '/proj/CopilotX' }],
  activeFile: {
    path: '/proj/CopilotX/src/core/router.js',
    languageId: 'javascript',
    content: 'function resolveAgent() {}\n',
    lineCount: 1,
  },
  selection: { startLine: 1, endLine: 1, text: 'function resolveAgent() {}' },
  openTabs: [{ path: '/proj/CopilotX/README.md', languageId: 'markdown' }],
  cursor: { line: 1, character: 4 },
  projectTree: ['src/', 'src/core/', 'src/core/router.js', 'README.md'],
};

test('formatWorkspaceBlock includes the key context sections', () => {
  const block = formatWorkspaceBlock(sample);
  assert.ok(block.includes('WORKSPACE CONTEXT'));
  assert.ok(block.includes('router.js'));
  assert.ok(block.includes('Selection L1-L1'));
  assert.ok(block.includes('Project tree:'));
  assert.ok(block.includes('Cursor: L1:4'));
});

test('formatWorkspaceBlock truncates oversized active file content', () => {
  const big = {
    activeFile: {
      path: '/x.js',
      languageId: 'javascript',
      content: 'a'.repeat(20000),
      lineCount: 1,
    },
  };
  const block = formatWorkspaceBlock(big);
  assert.ok(block.includes('[truncated]'));
  assert.ok(block.length < 12000);
});

test('formatWorkspaceBlock returns empty for null/empty snapshots', () => {
  assert.strictEqual(formatWorkspaceBlock(null), '');
  assert.strictEqual(formatWorkspaceBlock({}), '');
});

test('mentionsWorkspace detects the @workspace token', () => {
  assert.strictEqual(mentionsWorkspace('look at @workspace please'), true);
  assert.strictEqual(mentionsWorkspace('no token here'), false);
});
