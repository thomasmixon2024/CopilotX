'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { resolveAgent, loadRouterConfig, tokenize } = require('../src/core/router');

const cfg = loadRouterConfig();

test('router.json loads with a routing object and default agent', () => {
  assert.ok(cfg.routing && typeof cfg.routing === 'object');
  assert.strictEqual(cfg.defaultAgent, 'ask');
  assert.deepStrictEqual(
    Object.keys(cfg.routing).sort(),
    ['ask', 'custom', 'explore', 'plan']
  );
});

test('clear keyword hit routes to that agent', () => {
  assert.strictEqual(resolveAgent('explain how this works', cfg).agent, 'ask');
  assert.strictEqual(resolveAgent('brainstorm some ideas', cfg).agent, 'explore');
  assert.strictEqual(resolveAgent('plan the release steps', cfg).agent, 'plan');
  assert.strictEqual(resolveAgent('fix this bug and patch it', cfg).agent, 'custom');
});

test('tie between agents routes to explore', () => {
  // "how" (ask) vs "implement" is plan+custom; use a custom tie:
  // "why" (ask) + "plan" (plan) both hit once.
  const result = resolveAgent('why should we plan this', cfg);
  assert.strictEqual(result.agent, 'explore');
  assert.strictEqual(result.reason, 'ambiguous-intent → explore');
});

test('no keyword match falls back to ask', () => {
  const result = resolveAgent('asdfghjkl qwerty', cfg);
  assert.strictEqual(result.agent, 'ask');
  assert.strictEqual(result.reason, 'missing-intent → default');
  assert.deepStrictEqual(result.matchedKeywords, []);
});

test('tokenize strips punctuation and lowercases', () => {
  assert.deepStrictEqual(tokenize('Explain, HOW? this!'), ['explain', 'how', 'this']);
});

test('matched keywords are reported on a clear hit', () => {
  const result = resolveAgent('please explain the routing', cfg);
  assert.ok(result.matchedKeywords.includes('explain'));
});
