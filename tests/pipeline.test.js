'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  runPipeline,
  parseTaskGraph,
  validateTaskGraph,
  buildSupervisorInput,
  buildWorkerTaskInput,
  buildQcInput,
  parseQcVerdict,
  MAX_TASKS,
} = require('../src/core/pipeline');
const { createSession } = require('../src/core/session');

const workspace = { workspaceFolders: [{ name: 't', path: process.cwd() }] };

test('MAX_TASKS equals 6', () => {
  assert.strictEqual(MAX_TASKS, 6);
});

// --- parseTaskGraph ---

test('parseTaskGraph parses a pure JSON string', () => {
  const g = parseTaskGraph(JSON.stringify({
    tasks: [{ id: 't1', goal: 'do a thing' }],
    sharedDecisions: { style: 'tabs' },
  }));
  assert.ok(g);
  assert.strictEqual(g.tasks.length, 1);
  assert.strictEqual(g.tasks[0].id, 't1');
  assert.strictEqual(g.tasks[0].goal, 'do a thing');
  assert.deepStrictEqual(g.tasks[0].fileClaims, []);
  assert.deepStrictEqual(g.tasks[0].dependsOn, []);
  assert.deepStrictEqual(g.sharedDecisions, { style: 'tabs' });
});

test('parseTaskGraph extracts JSON embedded in prose', () => {
  const text = 'Here is my plan, as promised:\n{"tasks":[{"id":"a","goal":"first"}]}\nLet me know if that works.';
  const g = parseTaskGraph(text);
  assert.ok(g);
  assert.strictEqual(g.tasks[0].id, 'a');
});

test('parseTaskGraph extracts JSON from a markdown fenced code block', () => {
  const text = [
    'Plan below:',
    '```json',
    '{"tasks":[{"id":"t1","goal":"wire router"},{"id":"t2","goal":"wire engine","dependsOn":["t1"]}]}',
    '```',
  ].join('\n');
  const g = parseTaskGraph(text);
  assert.ok(g);
  assert.strictEqual(g.tasks.length, 2);
  assert.deepStrictEqual(g.tasks[1].dependsOn, ['t1']);
});

test('parseTaskGraph applies defaults for extra and missing optional fields', () => {
  const text = JSON.stringify({
    notes: 'extra top-level field is fine',
    tasks: [{ id: 't1', goal: 'g', priority: 'high', fileClaims: ['src/a.js'] }],
  });
  const g = parseTaskGraph(text);
  assert.ok(g);
  assert.strictEqual(g.tasks[0].id, 't1');
  assert.deepStrictEqual(g.tasks[0].fileClaims, ['src/a.js']);
  assert.deepStrictEqual(g.tasks[0].dependsOn, []);
  assert.deepStrictEqual(g.sharedDecisions, {});
});

test('parseTaskGraph returns null on invalid JSON', () => {
  assert.strictEqual(parseTaskGraph('{"tasks": ['), null);
});

test('parseTaskGraph returns null when there is no JSON at all', () => {
  assert.strictEqual(parseTaskGraph('just some plain prose, nothing structured'), null);
});

test('parseTaskGraph returns null when tasks is missing or not an array', () => {
  assert.strictEqual(parseTaskGraph('{"plan": []}'), null);
  assert.strictEqual(parseTaskGraph('{"tasks": "not an array"}'), null);
});

test('parseTaskGraph returns null when a task lacks a string id or goal', () => {
  assert.strictEqual(parseTaskGraph(JSON.stringify({ tasks: [{ goal: 'no id' }] })), null);
  assert.strictEqual(parseTaskGraph(JSON.stringify({ tasks: [{ id: 't1' }] })), null);
  assert.strictEqual(parseTaskGraph(JSON.stringify({ tasks: [{ id: 3, goal: 'g' }] })), null);
});

// --- validateTaskGraph ---

function chainGraph() {
  return {
    tasks: [
      { id: 't1', goal: 'one', fileClaims: [], dependsOn: [] },
      { id: 't2', goal: 'two', fileClaims: [], dependsOn: [] },
      { id: 't3', goal: 'three', fileClaims: [], dependsOn: ['t1', 't2'] },
    ],
    sharedDecisions: {},
  };
}

test('validateTaskGraph accepts a valid 3-task chain', () => {
  assert.deepStrictEqual(validateTaskGraph(chainGraph()), { ok: true });
});

test('validateTaskGraph rejects overlapping normalized file claims and names both task ids', () => {
  const g = {
    tasks: [
      { id: 't1', goal: 'one', fileClaims: ['src/a.js'], dependsOn: [] },
      { id: 't2', goal: 'two', fileClaims: ['SRC\\a.js'], dependsOn: [] },
    ],
    sharedDecisions: {},
  };
  const r = validateTaskGraph(g);
  assert.strictEqual(r.ok, false);
  assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
  assert.ok(r.errors.some((e) => e.includes('t1') && e.includes('t2')));
});

test('validateTaskGraph rejects duplicate ids', () => {
  const g = chainGraph();
  g.tasks[1].id = 't1';
  const r = validateTaskGraph(g);
  assert.strictEqual(r.ok, false);
});

test('validateTaskGraph rejects empty ids', () => {
  const g = chainGraph();
  g.tasks[0].id = '';
  assert.strictEqual(validateTaskGraph(g).ok, false);
});

test('validateTaskGraph rejects unknown dependencies', () => {
  const g = chainGraph();
  g.tasks[0].dependsOn = ['ghost'];
  assert.strictEqual(validateTaskGraph(g).ok, false);
});

test('validateTaskGraph rejects a direct cycle between two tasks', () => {
  const g = chainGraph();
  g.tasks[0].dependsOn = ['t2'];
  g.tasks[1].dependsOn = ['t1'];
  assert.strictEqual(validateTaskGraph(g).ok, false);
});

test('validateTaskGraph rejects self-dependency', () => {
  const g = chainGraph();
  g.tasks[0].dependsOn = ['t1'];
  assert.strictEqual(validateTaskGraph(g).ok, false);
});

test('validateTaskGraph rejects an empty task list', () => {
  assert.strictEqual(validateTaskGraph({ tasks: [], sharedDecisions: {} }).ok, false);
});

test('validateTaskGraph rejects null graph', () => {
  assert.strictEqual(validateTaskGraph(null).ok, false);
});

test('validateTaskGraph rejects more than MAX_TASKS tasks', () => {
  const tasks = [];
  for (let i = 0; i < MAX_TASKS + 1; i++) {
    tasks.push({ id: `t${i}`, goal: `g${i}`, fileClaims: [], dependsOn: [] });
  }
  assert.strictEqual(validateTaskGraph({ tasks, sharedDecisions: {} }).ok, false);
});

test('validateTaskGraph allows empty fileClaims on multiple tasks without false overlap', () => {
  const g = chainGraph(); // all tasks have empty fileClaims
  assert.deepStrictEqual(validateTaskGraph(g), { ok: true });
});

// --- builders ---

test('buildSupervisorInput includes the goal and the context/workspace blocks when non-empty', () => {
  const out = buildSupervisorInput('Refactor the router', 'CONTEXT: repo is plain node', 'WORKSPACE: one folder');
  assert.ok(out.includes('Goal:'));
  assert.ok(out.includes('Refactor the router'));
  assert.ok(out.includes('CONTEXT: repo is plain node'));
  assert.ok(out.includes('WORKSPACE: one folder'));
});

test('buildWorkerTaskInput first line is exactly x-worker and includes id, attempt, goal, claims, decisions', () => {
  const graph = {
    tasks: [{ id: 't1', goal: 'patch the engine', fileClaims: ['src/core/engine.js'], dependsOn: [] }],
    sharedDecisions: { style: 'tabs' },
  };
  const out = buildWorkerTaskInput(graph.tasks[0], graph, 2);
  assert.strictEqual(out.split(/\r?\n/)[0], 'x-worker');
  assert.ok(out.includes('t1'));
  assert.ok(out.includes('2'));
  assert.ok(out.includes('patch the engine'));
  assert.ok(out.includes('src/core/engine.js'));
  assert.ok(out.includes('style'));
  assert.ok(out.includes('tabs'));
});

test('buildWorkerTaskInput says none specified when no files claimed and omits decisions when absent', () => {
  const graph = {
    tasks: [{ id: 't2', goal: 'tidy docs', fileClaims: [], dependsOn: [] }],
    sharedDecisions: {},
  };
  const out = buildWorkerTaskInput(graph.tasks[0], graph, 1);
  assert.strictEqual(out.split(/\r?\n/)[0], 'x-worker');
  assert.ok(out.includes('none specified'));
  assert.ok(out.includes('t2'));
  assert.ok(out.includes('tidy docs'));
});

test('buildQcInput first line is exactly x-qc and includes id, attempt, goal, worker result', () => {
  const task = { id: 't1', goal: 'patch the engine', fileClaims: [], dependsOn: [] };
  const out = buildQcInput(task, 'Worker diff follows: changed lines 1-9', 3);
  assert.strictEqual(out.split(/\r?\n/)[0], 'x-qc');
  assert.ok(out.includes('t1'));
  assert.ok(out.includes('3'));
  assert.ok(out.includes('patch the engine'));
  assert.ok(out.includes('Worker diff follows: changed lines 1-9'));
});

// --- parseQcVerdict ---

test('parseQcVerdict parses a pass verdict with findings', () => {
  const v = parseQcVerdict(JSON.stringify({
    verdict: 'pass',
    findings: [{ file: 'src/a.js', issue: 'minor naming', severity: 'low', suggestedFix: 'rename' }],
  }));
  assert.ok(v);
  assert.strictEqual(v.verdict, 'pass');
  assert.strictEqual(v.findings.length, 1);
  assert.strictEqual(v.findings[0].file, 'src/a.js');
  assert.strictEqual(v.findings[0].severity, 'low');
});

test('parseQcVerdict parses a needs-fix verdict', () => {
  const v = parseQcVerdict('{"verdict":"needs-fix","findings":[]}');
  assert.ok(v);
  assert.strictEqual(v.verdict, 'needs-fix');
});

test('parseQcVerdict defaults missing finding fields to empty strings', () => {
  const v = parseQcVerdict(JSON.stringify({ verdict: 'needs-fix', findings: [{ file: 'x.js' }] }));
  assert.ok(v);
  assert.strictEqual(v.findings[0].file, 'x.js');
  assert.strictEqual(v.findings[0].issue, '');
  assert.strictEqual(v.findings[0].severity, '');
  assert.strictEqual(v.findings[0].suggestedFix, '');
});

test('parseQcVerdict extracts JSON wrapped in prose', () => {
  const v = parseQcVerdict('QC review complete.\n{"verdict":"pass","findings":[]}\nEnd of report.');
  assert.ok(v);
  assert.strictEqual(v.verdict, 'pass');
});

test('parseQcVerdict returns null on garbage input', () => {
  assert.strictEqual(parseQcVerdict('no structured data here'), null);
  assert.strictEqual(parseQcVerdict('{"verdict":'), null);
});

test('parseQcVerdict returns null for a verdict other than pass or needs-fix', () => {
  assert.strictEqual(parseQcVerdict('{"verdict":"maybe","findings":[]}'), null);
});

// --- runPipeline (offline) ---

test('runPipeline short-circuits offline without network', async () => {
  const result = await runPipeline({
    input: 'Refactor the router',
    session: createSession('test'),
    workspace,
    settings: { provider: 'none', apiKey: '' },
  });
  assert.strictEqual(result.agent, 'pipeline');
  assert.strictEqual(result.mode, 'local');
  assert.strictEqual(result.plan.tasks.length, 1);
  assert.strictEqual(result.taskResults[0].status, 'skipped-offline');
  assert.deepStrictEqual(result.proposals, []);
  assert.deepStrictEqual(result.qcFindings, []);
  assert.ok(typeof result.text === 'string' && result.text.length > 0);
  assert.ok(result.text.includes('offline'));
  assert.ok(typeof result.summary === 'string');
});

test('runPipeline is offline even with an API key absent from settings and environment', async () => {
  const result = await runPipeline({
    input: 'Refactor the router',
    session: createSession('test'),
    workspace,
    settings: {},
  });
  assert.strictEqual(result.mode, 'local');
  assert.strictEqual(result.taskResults[0].status, 'skipped-offline');
});
