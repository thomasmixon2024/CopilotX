'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Router } = require('../src/core/router');
const { buildDeterministicResponse } = require('../src/core/agents');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, 'Config');
const AGENTS_DIR = path.join(ROOT, 'Agents');

function loadPersona(name) {
  return fs.readFileSync(path.join(AGENTS_DIR, name), 'utf8');
}
function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, name), 'utf8'));
}

function run() {
  const results = [];

  function test(name, fn) {
    try {
      fn();
      results.push({ name, pass: true });
    } catch (err) {
      results.push({ name, pass: false, error: err.message });
    }
  }

  function asyncTest(name, fn) {
    return fn()
      .then(() => results.push({ name, pass: true }))
      .catch((err) => results.push({ name, pass: false, error: err.message }));
  }

  // --- Synchronous keyword tests ---

  test('router.json loads and has a routing object', () => {
    const router = new Router(CONFIG_DIR);
    assert.ok(router.router.routing, 'routing object should exist');
  });

  test('all four agents are present in the routing table', () => {
    const router = new Router(CONFIG_DIR);
    const keys = Object.keys(router.router.routing).sort();
    assert.deepStrictEqual(keys, ['ask', 'custom', 'explore', 'plan']);
  });

  test('"explain how this works" routes to ask', () => {
    const router = new Router(CONFIG_DIR);
    const { agent } = router.resolveAgent('explain how this works');
    assert.strictEqual(agent, 'ask');
  });

  test('"brainstorm some ideas for me" routes to explore', () => {
    const router = new Router(CONFIG_DIR);
    const { agent } = router.resolveAgent('brainstorm some ideas for me');
    assert.strictEqual(agent, 'explore');
  });

  test('"sequence the steps for this workflow" routes to plan', () => {
    const router = new Router(CONFIG_DIR);
    const { agent } = router.resolveAgent('sequence the steps for this workflow');
    assert.strictEqual(agent, 'plan');
  });

  test('"run this custom domain task" routes to custom', () => {
    const router = new Router(CONFIG_DIR);
    const { agent } = router.resolveAgent('run this custom domain task');
    assert.strictEqual(agent, 'custom');
  });

  test('unmatched input falls back to defaultAgent/missingIntent rule', () => {
    const router = new Router(CONFIG_DIR);
    const { agent, reason } = router.resolveAgent('asdfghjkl qwerty');
    assert.strictEqual(reason, 'fallback-missing-intent');
    assert.ok(['ask', 'explore', 'plan', 'custom'].includes(agent));
  });

  test('resolveTask returns a matching task for each agent', () => {
    const router = new Router(CONFIG_DIR);
    for (const agentKey of ['ask', 'explore', 'plan', 'custom']) {
      const task = router.resolveTask(agentKey);
      assert.ok(task, `expected a task for agent ${agentKey}`);
      assert.strictEqual(task.agent, agentKey);
    }
  });

  test('expanded keywords still route correctly (what/why/how)', () => {
    const router = new Router(CONFIG_DIR);
    assert.strictEqual(router.resolveAgent('what is the purpose of this').agent, 'ask');
    assert.strictEqual(router.resolveAgent('why does routing work this way').agent, 'ask');
  });

  test('llmRouter config section is present and sensible', () => {
    const router = new Router(CONFIG_DIR);
    assert.ok(router.llmConfig, 'llmConfig should be loaded');
    assert.ok(
      ['fallback', 'always', 'off'].includes(router.llmConfig.mode) ||
        router.llmConfig.enabled === false
    );
  });

  // --- Richer deterministic response tests (v0.3.0) ---

  const actionsRegistry = loadJson('actions.json');
  const tasks = loadJson('tasks.json');
  const agentCfg = loadJson('agent.json');

  test('deterministic ask response contains structured sections', () => {
    const task = Object.values(tasks.tasks).find((t) => t.agent === 'ask');
    const text = buildDeterministicResponse({
      agentKey: 'ask',
      persona: loadPersona('Ask.agent.md'),
      input: 'explain how routing works',
      matchedKeywords: ['explain'],
      task,
      agentConfig: agentCfg.agents.ask,
      actionsRegistry,
    });
    assert.ok(text.includes('[ASK AGENT]'));
    assert.ok(text.includes('Interpret intent'));
    assert.ok(text.includes('Mode: deterministic'));
    assert.ok(text.includes('interpretIntent') || text.includes('Structured reasoning'));
  });

  test('deterministic explore response lists candidate angles', () => {
    const task = Object.values(tasks.tasks).find((t) => t.agent === 'explore');
    const text = buildDeterministicResponse({
      agentKey: 'explore',
      persona: loadPersona('Explore.agent.md'),
      input: 'brainstorm product ideas',
      matchedKeywords: ['brainstorm'],
      task,
      agentConfig: agentCfg.agents.explore,
      actionsRegistry,
    });
    assert.ok(text.includes('[EXPLORE AGENT]'));
    assert.ok(text.includes('Candidate angles') || text.includes('Generate alternative'));
    assert.ok(text.includes('Mode: deterministic'));
  });

  test('deterministic plan response includes draft sequence', () => {
    const task = Object.values(tasks.tasks).find((t) => t.agent === 'plan');
    const text = buildDeterministicResponse({
      agentKey: 'plan',
      persona: loadPersona('Plan.agent.md'),
      input: 'sequence the release steps',
      matchedKeywords: ['sequence'],
      task,
      agentConfig: agentCfg.agents.plan,
      actionsRegistry,
    });
    assert.ok(text.includes('[PLAN AGENT]'));
    assert.ok(text.includes('Draft sequence') || text.includes('Step 1'));
    assert.ok(text.includes('Mode: deterministic'));
  });

  test('deterministic custom response references domain actions', () => {
    const task = Object.values(tasks.tasks).find((t) => t.agent === 'custom');
    const text = buildDeterministicResponse({
      agentKey: 'custom',
      persona: loadPersona('Custom.agent.md'),
      input: 'run custom domain task',
      matchedKeywords: ['custom', 'domain'],
      task,
      agentConfig: agentCfg.agents.custom,
      actionsRegistry,
    });
    assert.ok(text.includes('[CUSTOM AGENT]'));
    assert.ok(text.includes('runCustomLogic') || text.includes('domain'));
    assert.ok(text.includes('Mode: deterministic'));
  });

  // --- Async path tests (no API key required) ---

  const asyncPromises = [
    asyncTest('resolveAgentAsync returns keyword result when no API key (clear match)', async () => {
      const router = new Router(CONFIG_DIR);
      const prev = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      try {
        const result = await router.resolveAgentAsync('explain the routing logic');
        assert.strictEqual(result.agent, 'ask');
        assert.strictEqual(result.llmUsed, false);
      } finally {
        if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
      }
    }),

    asyncTest('resolveAgentAsync falls back to keyword on missing intent without key', async () => {
      const router = new Router(CONFIG_DIR);
      const prev = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      try {
        const result = await router.resolveAgentAsync('xyzzy plugh foobar');
        assert.ok(['ask', 'explore', 'plan', 'custom'].includes(result.agent));
        assert.strictEqual(result.llmUsed, false);
        assert.strictEqual(result.reason, 'fallback-missing-intent');
      } finally {
        if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
      }
    }),
  ];

  return Promise.all(asyncPromises).then(() => {
    const failed = results.filter((r) => !r.pass);
    for (const r of results) {
      console.log(`${r.pass ? 'PASS' : 'FAIL'} - ${r.name}${r.pass ? '' : ' :: ' + r.error}`);
    }
    console.log('');
    if (failed.length === 0) {
      console.log(`SUCCESS: ${results.length}/${results.length} tests passed.`);
      process.exit(0);
    } else {
      console.log(`FAILURE: ${failed.length}/${results.length} tests failed.`);
      process.exit(1);
    }
  });
}

run();
