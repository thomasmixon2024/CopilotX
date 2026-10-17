'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { complete } = require('../src/core/llm');
const { checkLocalProviderHealth, ProviderHealthError } = require('../src/core/providerHealth');

const realFetch = globalThis.fetch;

function restoreFetch() {
  globalThis.fetch = realFetch;
}

// --- llm.js: local-provider discovery failure must not be swallowed ---

test('local provider throws (not silently returns null text) when discovery finds no model', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/models')) {
      return { ok: false, status: 404, text: async () => 'not found' };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    await assert.rejects(
      () => complete({ provider: 'local', model: '', openaiBaseUrl: 'http://127.0.0.1:8082/v1' }),
      /No model available from local provider/
    );
  } finally {
    restoreFetch();
  }
});

test('local provider skips discovery entirely when copilotx.model is set explicitly', async () => {
  let calledModelsEndpoint = false;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/models')) {
      calledModelsEndpoint = true;
      return { ok: false, status: 404, text: async () => 'not found' };
    }
    if (String(url).endsWith('/messages')) {
      return {
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const result = await complete({
      provider: 'local',
      model: 'open_router/anthropic/claude-sonnet-5',
      openaiBaseUrl: 'http://127.0.0.1:8082/v1',
    });
    assert.strictEqual(calledModelsEndpoint, false);
    assert.strictEqual(result.mode, 'live');
    assert.strictEqual(result.text, 'ok');
  } finally {
    restoreFetch();
  }
});

// --- providerHealth.js: credential-check preflight ---

test('checkLocalProviderHealth throws "unreachable" when fcc-server refuses the connection', async () => {
  globalThis.fetch = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:8082');
  };
  try {
    await assert.rejects(
      () => checkLocalProviderHealth('http://127.0.0.1:8082/v1'),
      (err) => err instanceof ProviderHealthError && err.category === 'unreachable'
    );
  } finally {
    restoreFetch();
  }
});

test('checkLocalProviderHealth throws "unreachable" when health endpoint returns non-2xx', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/health')) return { ok: false, status: 503 };
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    await assert.rejects(
      () => checkLocalProviderHealth('http://127.0.0.1:8082/v1'),
      (err) => err instanceof ProviderHealthError && err.category === 'unreachable'
    );
  } finally {
    restoreFetch();
  }
});

test('checkLocalProviderHealth throws "unconfigured" when the upstream provider is not configured', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/health')) return { ok: true };
    if (String(url).endsWith('/admin/api/config')) {
      return {
        ok: true,
        json: async () => ({
          credential_checks: [{ key: 'OPENROUTER_API_KEY', status: 'missing' }],
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    await assert.rejects(
      () => checkLocalProviderHealth('http://127.0.0.1:8082/v1'),
      (err) => err instanceof ProviderHealthError && err.category === 'unconfigured'
    );
  } finally {
    restoreFetch();
  }
});

test('checkLocalProviderHealth resolves when healthy and provider is configured', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/health')) return { ok: true };
    if (String(url).endsWith('/admin/api/config')) {
      return {
        ok: true,
        json: async () => ({
          credential_checks: [{ key: 'OPENROUTER_API_KEY', status: 'verified' }],
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const result = await checkLocalProviderHealth('http://127.0.0.1:8082/v1');
    assert.strictEqual(result.checked, true);
    assert.strictEqual(result.status, 'verified');
  } finally {
    restoreFetch();
  }
});

test('checkLocalProviderHealth does not block on a missing/unsupported config endpoint', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/health')) return { ok: true };
    if (String(url).endsWith('/admin/api/config')) return { ok: false, status: 404 };
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const result = await checkLocalProviderHealth('http://127.0.0.1:8082/v1');
    assert.strictEqual(result.checked, false);
  } finally {
    restoreFetch();
  }
});
