'use strict';

/**
 * Preflight credential/health check for the 'local' provider (fcc-server).
 *
 * Ports the pattern from the FCC Proxy Agent integration blueprint: before
 * sending a real request, confirm (a) the proxy is actually up and (b) the
 * upstream provider it routes to is configured — so a bad setup surfaces as
 * a clear, categorized error instead of a silent non-response.
 */

const HEALTH_TIMEOUT_MS = 3000;
const CONFIG_TIMEOUT_MS = 3000;

class ProviderHealthError extends Error {
  constructor(category, message) {
    super(message);
    this.name = 'ProviderHealthError';
    // 'unreachable' | 'unconfigured'
    this.category = category;
  }
}

function proxyRootFromBase(openaiBaseUrl) {
  const base = openaiBaseUrl || 'http://127.0.0.1:8082/v1';
  return base.replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

async function checkLocalProviderHealth(openaiBaseUrl) {
  const root = proxyRootFromBase(openaiBaseUrl);

  // 1. Is fcc-server actually up?
  try {
    const res = await fetch(`${root}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!res.ok) {
      throw new ProviderHealthError(
        'unreachable',
        `fcc-server health check returned HTTP ${res.status} at ${root}/health.`
      );
    }
  } catch (err) {
    if (err instanceof ProviderHealthError) throw err;
    throw new ProviderHealthError(
      'unreachable',
      `fcc-server is not reachable at ${root}/health (${err.message}). ` +
        `Start it with: fcc-server`
    );
  }

  // 2. Is the upstream provider actually configured? Best-effort: some
  //    fcc-server builds may not expose this admin path, so treat a failed
  //    or malformed response here as "unknown", not fatal.
  try {
    const res = await fetch(`${root}/admin/api/config`, {
      signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
    });
    if (!res.ok) return { checked: false, reason: `config endpoint HTTP ${res.status}` };

    const data = await res.json();
    const checks = Array.isArray(data.credential_checks) ? data.credential_checks : [];
    const entry = checks.find((c) => /open.?router/i.test(c.key || c.provider || ''));
    const status = entry && (entry.status || entry.state);

    if (status && status !== 'configured' && status !== 'verified') {
      throw new ProviderHealthError(
        'unconfigured',
        `Upstream provider status is '${status}' (expected 'configured'/'verified'). ` +
          `Check openrouter.ai/settings/privacy (Allowed Providers) and the fcc-server credential store.`
      );
    }
    return { checked: true, status: status || 'unknown' };
  } catch (err) {
    if (err instanceof ProviderHealthError) throw err;
    return { checked: false, reason: err.message };
  }
}

module.exports = { checkLocalProviderHealth, ProviderHealthError };
