'use strict';

const assert = require('assert');
const {
  normalizeSnapshot,
  formatWorkspaceBlock,
  mentionsWorkspace,
} = require('../src/core/workspace');
const { runCopilotX } = require('../src/api');

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

async function asyncTest(name, fn) {
  try {
    await fn();
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

const sample = {
  workspaceFolders: [{ name: 'CopilotX', path: '/proj/CopilotX' }],
  activeFile: {
    path: '/proj/CopilotX/src/core/router.js',
    languageId: 'javascript',
    content: "function resolveAgent(input) {\n  return 'ask';\n}\n",
    lineCount: 3,
  },
  selection: {
    startLine: 1,
    endLine: 2,
    text: "function resolveAgent(input) {\n  return 'ask';",
  },
  openTabs: [
    { path: '/proj/CopilotX/src/core/router.js', languageId: 'javascript' },
    { path: '/proj/CopilotX/README.md', languageId: 'markdown' },
  ],
  cursor: { line: 2, character: 4 },
  projectTree: ['src/', 'src/core/', 'src/core/router.js', 'README.md', 'package.json'],
};

run('normalizeSnapshot bounds and keeps required fields', () => {
  const n = normalizeSnapshot(sample);
  assert.strictEqual(n.activeFile.path, sample.activeFile.path);
  assert.strictEqual(n.selection.startLine, 1);
  assert.ok(n.openTabs.length === 2);
  assert.ok(n.projectTree.length >= 3);
});

run('normalizeSnapshot handles empty/null input', () => {
  const n = normalizeSnapshot(null);
  assert.deepStrictEqual(n.workspaceFolders, []);
  assert.strictEqual(n.activeFile, null);
  assert.strictEqual(n.selection, null);
});

run('normalizeSnapshot truncates oversized file content', () => {
  const big = {
    activeFile: {
      path: '/x.js',
      languageId: 'javascript',
      content: 'a'.repeat(20000),
      lineCount: 1,
    },
  };
  const n = normalizeSnapshot(big, { maxFileChars: 100 });
  assert.ok(n.activeFile.content.length <= 120);
  assert.ok(n.activeFile.content.includes('[truncated]'));
});

run('formatWorkspaceBlock includes active file and selection', () => {
  const block = formatWorkspaceBlock(sample);
  assert.ok(block.includes('@workspace context:'));
  assert.ok(block.includes('router.js'));
  assert.ok(block.includes('Selection'));
  assert.ok(block.includes('resolveAgent'));
  assert.ok(block.includes('Project tree'));
});

run('formatWorkspaceBlock returns empty for empty snapshot', () => {
  assert.strictEqual(formatWorkspaceBlock({}), '');
  assert.strictEqual(formatWorkspaceBlock(null), '');
});

run('mentionsWorkspace detects @workspace token', () => {
  assert.strictEqual(mentionsWorkspace('look at @workspace please'), true);
  assert.strictEqual(mentionsWorkspace('no special token'), false);
});

(async () => {
  total++;
  if (
    await asyncTest(
      'runCopilotX injects workspace into deterministic response',
      async () => {
        const result = await runCopilotX(
          '@workspace explain the selected function',
          {
            workspace: sample,
            includeWorkspace: true,
            useSession: false,
          }
        );
        assert.strictEqual(result.workspaceIncluded, true);
        assert.ok(
          result.text.includes('Workspace context') ||
            result.text.includes('@workspace') ||
            result.text.includes('router.js')
        );
      }
    )
  )
    passed++;

  total++;
  if (
    await asyncTest(
      'runCopilotX without snapshot does not claim workspace included',
      async () => {
        const result = await runCopilotX('explain routing', {
          useSession: false,
        });
        assert.strictEqual(result.workspaceIncluded, false);
      }
    )
  )
    passed++;

  console.log('');
  if (passed === total) {
    console.log(`SUCCESS: ${passed}/${total} workspace tests passed.`);
    process.exit(0);
  } else {
    console.log(`FAILURE: ${total - passed}/${total} workspace tests failed.`);
    process.exit(1);
  }
})();
