'use strict';

const fs = require('fs');
const path = require('path');

function loadRouterConfig() {
  const p = path.join(__dirname, '..', '..', 'config', 'router.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function tokenize(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9@\s_-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function resolveAgent(input, config) {
  const cfg = config || loadRouterConfig();
  const tokens = new Set(tokenize(input));
  const scores = {};
  const matched = {};

  for (const [agent, spec] of Object.entries(cfg.routing || {})) {
    const hits = (spec.intent || []).filter((kw) => tokens.has(kw.toLowerCase()));
    scores[agent] = hits.length;
    matched[agent] = hits;
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const best = ranked[0];
  const second = ranked[1];

  if (!best || best[1] === 0) {
    return {
      agent: cfg.defaultAgent || 'ask',
      matchedKeywords: [],
      reason: 'missing-intent → default',
    };
  }

  if (second && second[1] === best[1]) {
    return {
      agent: 'explore',
      matchedKeywords: matched[best[0]],
      reason: 'ambiguous-intent → explore',
    };
  }

  return {
    agent: best[0],
    matchedKeywords: matched[best[0]],
    reason: `keyword:${matched[best[0]].join(',')}`,
  };
}

module.exports = { loadRouterConfig, resolveAgent, tokenize };
