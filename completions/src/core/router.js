'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

/**
 * router.js
 * Loads Config/router.json and Config/tasks.json and resolves a user
 * input string to an agent key ("ask" | "explore" | "plan" | "custom").
 *
 * Primary path: fast keyword matching against intent lists.
 * Optional secondary path: LLM classification (Claude) when keywords
 * are missing, ambiguous, or when llmRouter.mode === "always".
 *
 * All agent keys are lowercase and match Config/*.json exactly.
 */

function loadJson(configDir, fileName) {
  const filePath = path.join(configDir, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing config file: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.trim().length < 20) {
    throw new Error(`Config file too small (likely empty/corrupt): ${filePath}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath}: ${err.message}`);
  }
}

class Router {
  constructor(configDir) {
    this.configDir = configDir;
    this.router = loadJson(configDir, 'router.json');
    this.tasks = loadJson(configDir, 'tasks.json');

    if (!this.router.routing || typeof this.router.routing !== 'object') {
      throw new Error('router.json is missing the required "routing" object');
    }

    this.llmConfig = this.router.llmRouter || { enabled: false, mode: 'off' };
  }

  /**
   * Tokenizes input into lowercase words with punctuation stripped.
   */
  tokenize(input) {
    return String(input || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  /**
   * Synchronous keyword-based resolution.
   * Returns { agent, matchedKeywords, reason, candidates? }.
   */
  resolveAgent(input) {
    const tokens = new Set(this.tokenize(input));
    const routing = this.router.routing;

    const candidates = [];

    for (const agentKey of Object.keys(routing)) {
      const entry = routing[agentKey];
      const intents = Array.isArray(entry.intent) ? entry.intent : [];
      const matched = intents.filter((kw) => tokens.has(kw.toLowerCase()));

      if (matched.length > 0) {
        candidates.push({
          agent: agentKey,
          matchedKeywords: matched,
          score: matched.length,
        });
      }
    }

    // Sort by number of matched keywords (descending)
    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length === 1) {
      return {
        agent: candidates[0].agent,
        matchedKeywords: candidates[0].matchedKeywords,
        reason: 'keyword-match',
        candidates,
      };
    }

    if (candidates.length > 1) {
      // Ambiguous: multiple agents matched. Prefer highest score;
      // if tied, use rules.ambiguousIntent or first.
      const topScore = candidates[0].score;
      const top = candidates.filter((c) => c.score === topScore);
      if (top.length === 1) {
        return {
          agent: top[0].agent,
          matchedKeywords: top[0].matchedKeywords,
          reason: 'keyword-match',
          candidates,
        };
      }
      const ambiguousAgent =
        (this.router.rules && this.router.rules.ambiguousIntent) ||
        top[0].agent;
      return {
        agent: ambiguousAgent,
        matchedKeywords: top[0].matchedKeywords,
        reason: 'keyword-ambiguous',
        candidates,
      };
    }

    // No keyword matched
    const fallbackAgent =
      (this.router.rules && this.router.rules.missingIntent) ||
      this.router.defaultAgent ||
      'ask';

    return {
      agent: fallbackAgent,
      matchedKeywords: [],
      reason: 'fallback-missing-intent',
      candidates: [],
    };
  }

  /**
   * Async resolution that can escalate to an LLM classifier when
   * the keyword path is weak or when configured to always use LLM.
   *
   * Options:
   *   forceLlm: boolean  - skip keywords and go straight to LLM
   *   log: function      - optional logger
   *
   * Returns the same shape as resolveAgent plus optional llmUsed flag.
   */
  async resolveAgentAsync(input, options = {}) {
    const { forceLlm = false, log = null } = options;
    const keywordResult = this.resolveAgent(input);

    const shouldTryLlm =
      this.llmConfig.enabled !== false &&
      (forceLlm ||
        this.llmConfig.mode === 'always' ||
        (this.llmConfig.mode === 'fallback' &&
          (keywordResult.reason === 'fallback-missing-intent' ||
            keywordResult.reason === 'keyword-ambiguous')));

    if (!shouldTryLlm) {
      return { ...keywordResult, llmUsed: false };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      if (log) log('LLM router requested but ANTHROPIC_API_KEY not set; using keyword result');
      return { ...keywordResult, llmUsed: false };
    }

    try {
      if (log) log(`Escalating to LLM router (reason: ${keywordResult.reason})`);
      const llmAgent = await this._classifyWithLlm(input, apiKey);
      if (['ask', 'explore', 'plan', 'custom'].includes(llmAgent)) {
        return {
          agent: llmAgent,
          matchedKeywords: keywordResult.matchedKeywords,
          reason: 'llm-classification',
          candidates: keywordResult.candidates,
          llmUsed: true,
        };
      }
      if (log) log(`LLM returned unexpected agent "${llmAgent}"; falling back to keyword result`);
    } catch (err) {
      if (log) log(`LLM router failed (${err.message}); falling back to keyword result`);
    }

    return { ...keywordResult, llmUsed: false };
  }

  /**
   * Calls Claude with a short classification prompt and extracts a single agent key.
   */
  _classifyWithLlm(input, apiKey) {
    const model = this.llmConfig.model || 'claude-sonnet-4-6';
    const maxTokens = this.llmConfig.maxTokens || 32;
    const system =
      this.llmConfig.systemPrompt ||
      'You are an intent classifier. Reply with only one word: ask, explore, plan, or custom.';

    const body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: String(input).slice(0, 2000) }],
    });

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 15000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.content && parsed.content[0] && parsed.content[0].text) {
                const text = parsed.content[0].text.trim().toLowerCase();
                // Extract first valid agent token
                const match = text.match(/\b(ask|explore|plan|custom)\b/);
                resolve(match ? match[1] : text.split(/\s+/)[0]);
              } else {
                reject(new Error(`Unexpected API response: ${data.slice(0, 200)}`));
              }
            } catch (err) {
              reject(err);
            }
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('LLM router request timed out'));
      });
      req.write(body);
      req.end();
    });
  }

  /**
   * Resolves the task definition (agent + actions) for a given agent key.
   */
  resolveTask(agentKey) {
    const tasks = this.tasks.tasks || {};
    const match = Object.values(tasks).find((t) => t.agent === agentKey);
    return match || null;
  }
}

module.exports = { Router, loadJson };
