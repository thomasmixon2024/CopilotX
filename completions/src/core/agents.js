'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

/**
 * agents.js
 * Loads agent persona markdown files and produces a real response for a
 * routed input - either via the Claude API (if ANTHROPIC_API_KEY is set)
 * or via a richer deterministic, persona- and action-grounded template.
 *
 * Deterministic mode (v0.3.0) produces structured output that follows each
 * agent's Interaction Model and exercises the actions defined in
 * Config/tasks.json + Config/actions.json. It remains fully offline and
 * zero-dependency.
 */

const AGENT_FILE_MAP = {
  ask: 'Ask.agent.md',
  explore: 'Explore.agent.md',
  plan: 'Plan.agent.md',
  custom: 'Custom.agent.md',
};

function loadPersona(agentsDir, agentKey) {
  const fileName = AGENT_FILE_MAP[agentKey];
  if (!fileName) {
    throw new Error(`Unknown agent key: ${agentKey}`);
  }
  const filePath = path.join(agentsDir, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing persona file: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  if (content.trim().length < 20) {
    throw new Error(`Persona file too short (likely empty): ${filePath}`);
  }
  return content;
}

function safeLoadJson(configDir, fileName) {
  try {
    const filePath = path.join(configDir, fileName);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (raw.trim().length < 20) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Extract a named markdown section body from a persona file.
 */
function extractSection(persona, heading) {
  const re = new RegExp(
    `##\\s*${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`,
    'i'
  );
  const m = persona.match(re);
  return m ? m[1].trim() : '';
}

/**
 * Simple offline intent summary derived from the input text.
 */
function summarizeIntent(input) {
  const cleaned = String(input || '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return 'Empty or missing input.';
  if (cleaned.length <= 120) return cleaned;
  return cleaned.slice(0, 117) + '...';
}

/**
 * Build action guidance lines from the actions registry + task action list.
 */
function buildActionGuidance(actionNames, actionsRegistry) {
  const lines = [];
  for (const name of actionNames || []) {
    const meta =
      actionsRegistry &&
      actionsRegistry.actions &&
      actionsRegistry.actions[name]
        ? actionsRegistry.actions[name]
        : null;
    const desc = meta && meta.description ? meta.description : 'Execute this action against the input.';
    lines.push(`  - ${name}: ${desc}`);
  }
  if (lines.length === 0) {
    lines.push('  - (no actions registered for this agent)');
  }
  return lines;
}

/**
 * Agent-specific structured body. Each follows the Interaction Model
 * described in the corresponding persona file.
 */
function buildAgentBody(agentKey, input, actionNames, actionsRegistry) {
  const intent = summarizeIntent(input);
  const actionLines = buildActionGuidance(actionNames, actionsRegistry);
  const lines = [];

  switch (agentKey) {
    case 'ask': {
      lines.push('1. Interpret intent');
      lines.push(`   Core question detected: "${intent}"`);
      lines.push('');
      lines.push('2. Identify missing context');
      lines.push('   - What is the desired outcome or success criteria?');
      lines.push('   - Are there constraints (time, tools, scope) not stated?');
      lines.push('   - Is any domain background required?');
      lines.push('');
      lines.push('3. Structured reasoning');
      lines.push('   Applying registered actions:');
      lines.push(...actionLines);
      lines.push('');
      lines.push('   Reasoning sketch:');
      lines.push(`   - Restate the request in precise terms: ${intent}`);
      lines.push('   - Separate known facts from assumptions.');
      lines.push('   - Break the problem into the smallest useful parts.');
      lines.push('   - Prefer the simplest path that satisfies the stated need.');
      lines.push('');
      lines.push('4. Actionable next steps');
      lines.push('   - Confirm or supply any missing context listed above.');
      lines.push('   - Choose one part of the breakdown to resolve first.');
      lines.push('   - Re-run with more detail if the answer needs more depth.');
      break;
    }
    case 'explore': {
      lines.push('1. Expand the prompt');
      lines.push(`   Seed idea: "${intent}"`);
      lines.push('');
      lines.push('2. Generate alternative directions');
      lines.push('   Applying registered actions:');
      lines.push(...actionLines);
      lines.push('');
      lines.push('   Candidate angles:');
      lines.push('   A. Literal / direct interpretation of the request.');
      lines.push('   B. Adjacent or related problem that might be more valuable.');
      lines.push('   C. Inversion: what if the opposite goal were true?');
      lines.push('   D. Constraint-free version: ignore limits and list ideal outcomes.');
      lines.push('   E. Minimal version: the smallest useful variant of the idea.');
      lines.push('');
      lines.push('3. Variations and combinations');
      lines.push('   - Mix A+E for a practical quick win.');
      lines.push('   - Mix B+D for a longer-term exploration track.');
      lines.push('   - Surface any angle that feels surprising relative to the seed.');
      lines.push('');
      lines.push('4. Suggested exploration next steps');
      lines.push('   - Pick 1-2 angles to develop further.');
      lines.push('   - Ask the Plan agent to sequence the chosen direction.');
      lines.push('   - Or refine the seed and re-run Explore for a tighter set.');
      break;
    }
    case 'plan': {
      lines.push('1. Sequence the work');
      lines.push(`   Goal under planning: "${intent}"`);
      lines.push('');
      lines.push('2. Identify dependencies');
      lines.push('   Applying registered actions:');
      lines.push(...actionLines);
      lines.push('');
      lines.push('   Draft sequence:');
      lines.push('   Step 1  Clarify success criteria and constraints.');
      lines.push('   Step 2  List required inputs, tools, and prior decisions.');
      lines.push('   Step 3  Order remaining work by dependency (blockers first).');
      lines.push('   Step 4  Assign rough effort or risk to each step.');
      lines.push('   Step 5  Define a minimal first milestone that proves value.');
      lines.push('');
      lines.push('3. Workflow sketch');
      lines.push('   [Clarify] -> [Gather inputs] -> [Execute ordered steps] -> [Review milestone]');
      lines.push('   Feedback loops: any failed step returns to Clarify or Gather.');
      lines.push('');
      lines.push('4. Next planning actions');
      lines.push('   - Confirm or edit the draft sequence.');
      lines.push('   - Hand the first milestone to the Custom or Ask agent for execution detail.');
      lines.push('   - Re-run Plan after major scope changes.');
      break;
    }
    case 'custom': {
      lines.push('1. Interpret custom / domain intent');
      lines.push(`   Request: "${intent}"`);
      lines.push('');
      lines.push('2. Apply domain-oriented actions');
      lines.push('   Applying registered actions:');
      lines.push(...actionLines);
      lines.push('');
      lines.push('   Execution outline:');
      lines.push('   - Map the request onto the nearest registered custom action.');
      lines.push('   - Apply any explicit rules or constraints stated in the input.');
      lines.push('   - Produce structured output suitable for downstream agents.');
      lines.push('   - Flag any part of the request that has no matching rule yet.');
      lines.push('');
      lines.push('3. Integration notes');
      lines.push('   - Results can be passed to Ask (for explanation) or Plan (for sequencing).');
      lines.push('   - Extend Config/actions.json and this persona when new domain rules appear.');
      lines.push('');
      lines.push('4. Next steps');
      lines.push('   - Supply explicit rules or domain data if the outline above is too generic.');
      lines.push('   - Re-run Custom after updating actions or persona for tighter behavior.');
      break;
    }
    default: {
      lines.push(`Structured pass for agent "${agentKey}".`);
      lines.push(...actionLines);
    }
  }

  return lines;
}

/**
 * Builds a richer deterministic response grounded in the agent's persona,
 * task actions, and actions registry. Used when no API key is configured
 * or when the live API call fails.
 */
function buildDeterministicResponse({
  agentKey,
  persona,
  input,
  matchedKeywords,
  task,
  agentConfig,
  actionsRegistry,
  contextBlock,
  workspaceBlock,
}) {
  const purpose = extractSection(persona, 'Purpose');
  const behaviors = extractSection(persona, 'Core Behaviors');
  const actionNames =
    (task && Array.isArray(task.actions) && task.actions.length
      ? task.actions
      : agentConfig && Array.isArray(agentConfig.capabilities)
        ? agentConfig.capabilities
        : []) || [];

  const lines = [];

  // Header
  lines.push(`[${String(agentKey).toUpperCase()} AGENT]`);
  lines.push(
    matchedKeywords && matchedKeywords.length
      ? `Routed on keyword match: ${matchedKeywords.join(', ')}`
      : 'Routed via fallback (no keyword matched; using default agent).'
  );
  lines.push('');
  lines.push(`Input: ${input}`);
  lines.push('');

  if (workspaceBlock && String(workspaceBlock).trim()) {
    lines.push('Workspace context:');
    String(workspaceBlock)
      .split('\n')
      .forEach((ln) => lines.push(`  ${ln}`));
    lines.push('');
  }

  if (contextBlock && String(contextBlock).trim()) {
    lines.push('Session context:');
    String(contextBlock)
      .split('\n')
      .forEach((ln) => lines.push(`  ${ln}`));
    lines.push('');
  }

  // Persona grounding
  if (purpose) {
    lines.push('Persona purpose:');
    purpose.split('\n').forEach((ln) => lines.push(`  ${ln.trim()}`));
    lines.push('');
  }
  if (behaviors) {
    lines.push('Core behaviors:');
    behaviors
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 6)
      .forEach((ln) => lines.push(`  ${ln}`));
    lines.push('');
  }

  // Agent-specific structured body
  lines.push('Structured response (deterministic engine):');
  lines.push(...buildAgentBody(agentKey, input, actionNames, actionsRegistry));
  lines.push('');

  // Footer - honest about mode
  lines.push('---');
  lines.push(
    'Mode: deterministic. This response is built from the agent persona, ' +
      'Config/tasks.json, and Config/actions.json without calling an external model. ' +
      'Set ANTHROPIC_API_KEY to obtain a live model-generated response grounded in the same persona.'
  );

  return lines.join('\n');
}

/**
 * Calls the Claude API with the persona as system prompt. Returns a
 * Promise<string>. Falls back gracefully by throwing - caller should
 * catch and use buildDeterministicResponse on failure.
 */
function callClaudeApi({ persona, input, apiKey, contextBlock, workspaceBlock }) {
  return new Promise((resolve, reject) => {
    const parts = [];
    if (workspaceBlock && String(workspaceBlock).trim()) {
      parts.push(String(workspaceBlock).trim());
    }
    if (contextBlock && String(contextBlock).trim()) {
      parts.push(String(contextBlock).trim());
    }
    let userContent = input;
    if (parts.length) {
      userContent = parts.join('\n\n') + '\n\n---\nCurrent user message:\n' + input;
    }
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: persona,
      messages: [{ role: 'user', content: userContent }],
    });

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
        timeout: 30000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.content && parsed.content[0] && parsed.content[0].text) {
              resolve(parsed.content[0].text);
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
      reject(new Error('Claude API request timed out'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Main entry point: resolves and returns an agent response.
 * Optionally accepts configDir so actions.json can be loaded for richer
 * deterministic output.
 */
async function invokeAgent({
  agentsDir,
  agentKey,
  input,
  matchedKeywords,
  task,
  agentConfig,
  log,
  configDir,
  contextBlock,
  workspaceBlock,
}) {
  const persona = loadPersona(agentsDir, agentKey);
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (apiKey) {
    try {
      log && log(`Agent ${agentKey}: calling Claude API (live mode)`);
      const text = await callClaudeApi({
        persona,
        input,
        apiKey,
        contextBlock,
        workspaceBlock,
      });
      return { mode: 'live', text };
    } catch (err) {
      log &&
        log(
          `Agent ${agentKey}: live API call failed (${err.message}), falling back to deterministic engine`
        );
      // fall through
    }
  }

  log && log(`Agent ${agentKey}: using deterministic engine`);
  const actionsRegistry = configDir ? safeLoadJson(configDir, 'actions.json') : null;
  const text = buildDeterministicResponse({
    agentKey,
    persona,
    input,
    matchedKeywords,
    task,
    agentConfig,
    actionsRegistry,
    contextBlock,
    workspaceBlock,
  });
  return { mode: 'deterministic', text };
}

module.exports = {
  invokeAgent,
  loadPersona,
  AGENT_FILE_MAP,
  buildDeterministicResponse,
};
