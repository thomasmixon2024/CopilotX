'use strict';

// Headless settings loader for the container runtime. Mirrors the env-var
// conventions of src/workspaceCollector.js without importing vscode.

function clampInt(value, defaultValue, min, max) {
  const n = Number(value);
  if (Number.isNaN(n)) return defaultValue;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

const PROVIDER_ENV_KEYS = {
  nim: 'NVIDIA_NIM_API_KEY',
  local: 'ANTHROPIC_AUTH_TOKEN',
};

function getHeadlessSettings(overrides = {}) {
  const env = overrides.env || process.env;
  const provider = overrides.provider || env.COPILOTX_PROVIDER || 'none';
  const providerEnvKey = PROVIDER_ENV_KEYS[provider] || '';
  const model = overrides.model || env.COPILOTX_MODEL || '';
  const openaiBaseUrl =
    overrides.openaiBaseUrl ||
    env.COPILOTX_BASE_URL ||
    (provider === 'local' ? 'http://127.0.0.1:8082/v1' : 'https://api.openai.com/v1');

  return {
    provider,
    apiKey:
      overrides.apiKey ||
      env[providerEnvKey] ||
      env.COPILOTX_API_KEY ||
      env.ANTHROPIC_API_KEY ||
      env.OPENAI_API_KEY ||
      '',
    model,
    openaiBaseUrl,
    includeWorkspace: overrides.includeWorkspace !== false,
    // The runtime is the approval mechanism: proposals always come back
    // unapplied and are applied by the runtime itself (branch/dry/auto modes).
    allowWrites: 'approval',
    streamResponses: overrides.streamResponses !== false,
    pipelineMaxWorkers: clampInt(
      overrides.maxWorkers !== undefined ? overrides.maxWorkers : env.COPILOTX_PIPELINE_MAX_WORKERS,
      2, 1, 4
    ),
    pipelineMaxQcRounds: clampInt(
      overrides.maxQcRounds !== undefined ? overrides.maxQcRounds : env.COPILOTX_PIPELINE_MAX_QC_ROUNDS,
      2, 1, 3
    ),
    supervisorModel: firstNonEmpty(
      env.COPILOTX_SUPERVISOR_MODEL,
      overrides.supervisorModel || ''
    ),
    workerModel: firstNonEmpty(env.COPILOTX_WORKER_MODEL, overrides.workerModel || ''),
    qcModel: firstNonEmpty(env.COPILOTX_QC_MODEL, overrides.qcModel || ''),
  };
}

module.exports = { getHeadlessSettings, clampInt };
