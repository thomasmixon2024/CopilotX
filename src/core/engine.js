'use strict';

const fs = require('fs');
const path = require('path');
const { resolveAgent, loadRouterConfig } = require('./router');
const { formatContextBlock, summarize } = require('./session');
const { formatWorkspaceBlock } = require('./workspace');
const { complete, localResponse } = require('./llm');
const { getToolDefinitions, executeToolCall } = require('./tools');

const MAX_TOOL_ROUNDS = 8;

function loadPersonas() {
  const p = path.join(__dirname, '..', '..', 'config', 'personas.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function runTurn({ input, session, workspace, settings }) {
  const routerCfg = loadRouterConfig();
  const personas = loadPersonas();
  const routed = resolveAgent(input, routerCfg);
  const persona = personas[routed.agent] || personas.ask;

  const contextBlock = formatContextBlock(session);
  const workspaceBlock = settings.includeWorkspace ? formatWorkspaceBlock(workspace) : '';

  const userParts = [];
  if (contextBlock) userParts.push(contextBlock);
  if (workspaceBlock) userParts.push(workspaceBlock);
  userParts.push(`User message:\n${input}`);

  const apiKey =
    settings.apiKey ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    '';

  let mode = 'local';
  let text;
  const tools = getToolDefinitions();
  const messages = settings.provider === 'anthropic'
    ? [{ role: 'user', content: userParts.join('\n\n') }]
    : [
        { role: 'system', content: persona.system },
        { role: 'user', content: userParts.join('\n\n') },
      ];
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const live = await complete({
        provider: settings.provider,
        apiKey,
        model: settings.model,
        openaiBaseUrl: settings.openaiBaseUrl,
        system: persona.system,
        user: userParts.join('\n\n'),
        messages,
        tools,
      });
      mode = live.mode;
      if (!live.toolCalls || !live.toolCalls.length) {
        text = live.text;
        break;
      }

      messages.push(live.assistantMessage);
      for (const call of live.toolCalls) {
        let result;
        try {
          result = executeToolCall(call, workspace);
        } catch (err) {
          result = { error: err.message };
        }
        if (settings.provider === 'anthropic') {
          messages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: call.id,
              content: JSON.stringify(result),
            }],
          });
        } else {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
        }
      }
      if (round === MAX_TOOL_ROUNDS - 1) {
        throw new Error('Tool-call limit reached before the model produced a final answer.');
      }
    }
  } catch (err) {
    mode = 'fallback';
    text = [
      `**${persona.name}** could not reach the configured model.`,
      '',
      `Error: \`${err.message}\``,
      '',
      'A deterministic local response follows. Check the provider, model, endpoint, and credentials before retrying.',
      '',
      localResponse({
        agent: routed.agent,
        personaName: persona.name,
        input,
        reason: routed.reason,
        keywords: routed.matchedKeywords,
      }),
    ].join('\n');
  }

  if (!text) {
    text = localResponse({
      agent: routed.agent,
      personaName: persona.name,
      input,
      reason: routed.reason,
      keywords: routed.matchedKeywords,
    });
  }

  return {
    agent: routed.agent,
    agentName: persona.name,
    reason: routed.reason,
    matchedKeywords: routed.matchedKeywords,
    mode,
    text,
    summary: summarize(text),
  };
}

module.exports = { runTurn };
