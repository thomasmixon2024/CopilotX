'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { getHeadlessSettings } = require('../container/settings');
const { buildWorkspaceSnapshot, buildProjectTree } = require('../container/snapshot');
const {
  parseArgs,
  claimCovers,
  scanClaims,
  makeUnifiedDiff,
  writeDryArtifacts,
  applyAll,
  composeReport,
} = require('../container/runtime');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'copilotx-container-'));
}

function gitInit(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
}

test('getHeadlessSettings mirrors env conventions and locks allowWrites', () => {
  const settings = getHeadlessSettings({
    env: {
      COPILOTX_PROVIDER: 'nim',
      NVIDIA_NIM_API_KEY: 'nvk-123',
      COPILOTX_MODEL: 'm-1',
      COPILOTX_PIPELINE_MAX_WORKERS: '9',
      COPILOTX_PIPELINE_MAX_QC_ROUNDS: '0',
      COPILOTX_WORKER_MODEL: 'worker-m',
    },
    maxQcRounds: 3,
  });
  assert.strictEqual(settings.provider, 'nim');
  assert.strictEqual(settings.apiKey, 'nvk-123');
  assert.strictEqual(settings.model, 'm-1');
  assert.strictEqual(settings.workerModel, 'worker-m');
  assert.strictEqual(settings.pipelineMaxWorkers, 4); // clamped from 9
  assert.strictEqual(settings.pipelineMaxQcRounds, 3); // override wins over env 0
  assert.strictEqual(settings.allowWrites, 'approval');
});

test('getHeadlessSettings falls back through generic key env vars', () => {
  const settings = getHeadlessSettings({ env: { COPILOTX_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-x' } });
  assert.strictEqual(settings.apiKey, 'sk-x');
});

test('parseArgs splits flags and positionals', () => {
  const args = parseArgs(['do', 'the', 'thing', '--mode', 'dry', '--strict-claims', '--max-workers', '3']);
  assert.strictEqual(args.mode, 'dry');
  assert.strictEqual(args.strictClaims, true);
  assert.strictEqual(args.maxWorkers, 3);
  assert.deepStrictEqual(args._positional, ['do', 'the', 'thing']);
});

test('claimCovers matches exact paths and directory prefixes only', () => {
  const claims = ['src/core', 'README.md'];
  assert.strictEqual(claimCovers(claims, 'src/core/engine.js'), true);
  assert.strictEqual(claimCovers(claims, 'src/core'), true);
  assert.strictEqual(claimCovers(claims, 'README.md'), true);
  assert.strictEqual(claimCovers(claims, 'src/corex/other.js'), false); // no prefix bleed
  assert.strictEqual(claimCovers(claims, 'tests/router.test.js'), false);
  assert.strictEqual(claimCovers(claims, 'SRC\\CORE\\a.js'), true); // normalized
});

test('scanClaims flags violations only when claims exist', () => {
  const plan = { tasks: [{ id: 't1', fileClaims: ['src/a.js'] }] };
  const proposals = [{ relPath: 'src/a.js' }, { relPath: 'src/b.js' }];
  const scan = scanClaims(proposals, plan);
  assert.strictEqual(scan.guarded, true);
  assert.deepStrictEqual(scan.violations, ['src/b.js']);

  const unclaimed = scanClaims(proposals, { tasks: [{ id: 't1', fileClaims: [] }] });
  assert.strictEqual(unclaimed.guarded, false);
  assert.deepStrictEqual(unclaimed.violations, []);
});

test('makeUnifiedDiff produces headers and +/- body', () => {
  const diff = makeUnifiedDiff('a\nb\n', 'a\nc\n', 'x/y.js');
  assert.ok(diff.startsWith('--- a/x/y.js'));
  assert.ok(diff.includes('+++ b/x/y.js'));
  assert.ok(diff.includes('-b'));
  assert.ok(diff.includes('+c'));

  const created = makeUnifiedDiff('', 'new\n', 'fresh.js');
  assert.ok(created.startsWith('--- /dev/null'));
});

test('writeDryArtifacts writes patches and manifest without touching sources', () => {
  const dir = tempDir();
  const proposals = [
    {
      id: 'p1',
      tool: 'write_file',
      relPath: 'src/new.js',
      created: true,
      original: '',
      proposed: 'hello\n',
      diff: { added: 1, removed: 0 },
    },
  ];
  const manifest = writeDryArtifacts(proposals, dir);
  assert.strictEqual(manifest.length, 1);
  assert.ok(fs.existsSync(path.join(dir, 'patches', '1-src__new.js.patch')));
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'proposals.json'), 'utf8'));
  assert.strictEqual(parsed[0].relPath, 'src/new.js');
  assert.strictEqual(parsed[0].patch, 'patches/1-src__new.js.patch');
});

test('applyAll applies valid proposals and records drift skips', () => {
  const dir = tempDir();
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'one\n', 'utf8');
  const good = {
    path: file,
    relPath: 'a.txt',
    original: 'one\n',
    proposed: 'two\n',
    diff: { added: 1, removed: 1 },
  };
  const results = applyAll([good, good]); // second is now stale
  assert.strictEqual(results[0].applied, true);
  assert.strictEqual(results[1].applied, false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'two\n');
});

test('buildWorkspaceSnapshot walks a temp tree and includes active file', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'x\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'junk.js'), 'y\n', 'utf8');
  const snap = buildWorkspaceSnapshot(dir, 'src/a.js');
  assert.strictEqual(snap.workspaceFolders.length, 1);
  assert.strictEqual(snap.workspaceFolders[0].path, dir);
  assert.ok(snap.projectTree.includes('src/'));
  assert.ok(snap.projectTree.includes('src/a.js'));
  assert.ok(!snap.projectTree.some((e) => e.includes('node_modules')));
  assert.strictEqual(snap.activeFile.content, 'x\n');
  assert.strictEqual(snap.activeFile.lineCount, 1);
});

test('buildProjectTree caps entries', () => {
  const dir = tempDir();
  for (let i = 0; i < 30; i += 1) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x', 'utf8');
  const tree = buildProjectTree(dir, 10);
  assert.strictEqual(tree.length, 10);
});

test('composeReport includes plan status, findings, and proposal rows', () => {
  const result = {
    mode: 'live',
    text: '**Pipeline** run complete.\n### Plan\n- **t1**: do it',
    taskResults: [{ id: 't1', status: 'done', rounds: 1 }],
    proposals: [],
  };
  const report = composeReport(result, {
    runId: 'r1',
    mode: 'branch',
    branch: 'pipeline/run-r1',
    claimWarnings: ['1 proposal(s) outside claimed files: stray.js'],
    proposalRows: [{ relPath: 'stray.js', outcome: 'applied', added: 2, removed: 1 }],
  });
  assert.ok(report.includes('# Pipeline run r1'));
  assert.ok(report.includes('pipeline/run-r1'));
  assert.ok(report.includes('stray.js'));
  assert.ok(report.includes('+2/-1'));
  assert.ok(report.includes('## Task results (raw)'));
});

test('offline dry run end-to-end: report written, zero changes, exit 0', () => {
  const dir = tempDir();
  gitInit(dir);
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });

  const env = { ...process.env, COPILOTX_PROVIDER: 'none' };
  const out = execFileSync(
    process.execPath,
    ['container/runtime.js', 'Add JSDoc to seed.txt', '--repo', dir, '--mode', 'dry'],
    { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8' }
  );
  assert.ok(out.includes('mode=local'), 'offline run should report local mode');

  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' });
  assert.ok(status.includes('container/runs/'), 'dry run should leave run artifacts only');
  assert.ok(!status.includes('seed.txt'), 'dry run must not modify sources');

  // cleanup branch artifacts for the assertion above: status lists untracked files
  assert.ok(out.includes('report:'), 'should print the report path');
});

test('branch mode with no proposals commits only the report on the run branch', () => {
  const dir = tempDir();
  gitInit(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });

  const env = { ...process.env, COPILOTX_PROVIDER: 'none' };
  const out = execFileSync(
    process.execPath,
    ['container/runtime.js', 'Do nothing useful', '--repo', dir],
    { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8' }
  );
  assert.ok(out.includes('created branch pipeline/run-'));
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  assert.ok(branch.startsWith('pipeline/run-'));
  const log = execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' });
  assert.ok(log.includes('run report'));
});

test('git.js refuses a dirty tree without --allow-dirty', () => {
  const dir = tempDir();
  gitInit(dir);
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'y.txt'), 'dirty\n', 'utf8');

  const env = { ...process.env, COPILOTX_PROVIDER: 'none' };
  let failed = false;
  try {
    execFileSync(
      process.execPath,
      ['container/runtime.js', 'goal', '--repo', dir],
      { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8' }
    );
  } catch (err) {
    failed = true;
    assert.ok(String(err.stderr).includes('not clean'));
  }
  assert.strictEqual(failed, true);
});
