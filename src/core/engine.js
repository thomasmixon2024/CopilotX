'use strict';

const fs = require('fs');
const path = require('path');
const { resolveAgent, loadRouterConfig } = require('./router');
const { formatContextBlock, summarize } = require('./session');
const { formatWorkspaceBlock } = require('./workspace');
const { complete, streamComplete, localResponse } = require('./llm');
const { checkLocalProviderHealth } = require('./providerHealth');
const { getToolDefinitions, executeToolCall } = require('./tools');
const { buildProposal, applyProposal } = require('./proposals');

const MAX_TOOL_ROUNDS = 8;

function loadPersonas() {
  const p = path.join(__dirname, '..', '..', 'config', 'personas.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function runTurn({ input, session, workspace, settings, onDelta, onEvent, signal }) {
  const emit = (event) => {
    if (typeof onEvent !== 'function') return;
    try {
      onEvent(event);
    } catch {
      // UI telemetry must never change engine behavior.
    }
  };
  const routerCfg = loadRouterConfig();
  const personas = loadPersonas();
  const routed = resolveAgent(input, routerCfg);
  const persona = personas[routed.agent] || personas.ask;
  emit({ type: 'turn:start', agent: routed.agent, agentName: persona.name });

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
  const proposals = [];
  const writeMode = ['off', 'approval', 'auto'].includes(settings.allowWrites)
    ? settings.allowWrites
    : 'approval';
  const tools = getToolDefinitions({ includeWrites: writeMode !== 'off' });
  const messages = settings.provider === 'anthropic'
    ? [{ role: 'user', content: userParts.join('\n\n') }]
    : [
        { role: 'system', content: persona.system },
        { role: 'user', content: userParts.join('\n\n') },
      ];
  try {
    if (settings.provider === 'local') {
      await checkLocalProviderHealth(settings.openaiBaseUrl);
    }
    let completed = false;
    for (let round = 0; round < MAX_TOOL_ROUNDS && !completed; round += 1) {
      const requestArgs = {
        provider: settings.provider,
        apiKey,
        model: settings.model,
        openaiBaseUrl: settings.openaiBaseUrl,
        system: persona.system,
        user: userParts.join('\n\n'),
        messages,
        tools,
      };
      const useStream = settings.streamResponses !== false;
      const live = useStream
        ? await streamComplete({ ...requestArgs, onDelta, signal })
        : await complete(requestArgs);
      mode = live.mode;
      if (!live.toolCalls || !live.toolCalls.length) {
        if (live.mode === 'live' && !(live.text && live.text.trim())) {
          text = `**${persona.name}** returned an empty response from the model. Try again or adjust the prompt.`;
        } else {
          text = live.text;
        }
        completed = true;
        break;
      }

      messages.push(live.assistantMessage);
      for (const call of live.toolCalls) {
        emit({ type: 'tool:start', name: call.name, input: call.input });
        let result;
        let proposal = null;
        if (call.name === 'write_file' || call.name === 'edit_file' || call.name === 'delete_file') {
          try {
            proposal = buildProposal(call, workspace);
            if (writeMode === 'auto') {
              applyProposal(proposal);
              proposal.applied = true;
              result = {
                status: 'applied',
                path: proposal.relPath,
                diff: proposal.diff,
                message: 'Change applied automatically (allowWrites=auto).',
              };
            } else {
              result = {
                status: 'proposed',
                path: proposal.relPath,
                diff: proposal.diff,
                message:
                  'Change proposed to the user and awaiting approval. Do not assume it was applied.',
              };
            }
            proposals.push(proposal);
            emit({
              type: 'proposal',
              name: call.name,
              path: proposal.relPath,
              applied: Boolean(proposal.applied),
              stats: proposal.stats,
            });
          } catch (err) {
            result = { error: err.message };
          }
        } else {
          try {
            result = await executeToolCall(call, workspace);
          } catch (err) {
            result = { error: err.message };
          }
          emit({ type: 'tool:done', name: call.name, ok: !result?.error });
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
    }
    if (!completed) {
      mode = 'live';
      text =
        `**${persona.name}** reached the tool-call limit (${MAX_TOOL_ROUNDS} rounds) without a final answer. ` +
        'The tools kept returning results; ask me to continue and I will pick up where this turn stopped.';
    }
  } catch (err) {
    const isAbort = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    const isTimeout = err && err.name === 'TimeoutError';
    if (isAbort) {
      mode = 'stopped';
      if (!text) {
        text = `**${persona.name}** was stopped before producing a final answer.`;
      }
    } else if (isTimeout) {
      mode = 'timeout';
      text = [
        `**${persona.name}** timed out waiting for the model.`,
        '',
        `Error: \`${err.message}\``,
        '',
        'Increase the timeout or check the provider status, then retry.',
      ].join('\n');
    } else {
      mode = 'fallback';
      const category = err && err.name === 'ProviderHealthError' ? ` (${err.category})` : '';
      text = [
        `**${persona.name}** could not reach the configured model${category}.`,
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

  const response = {
    agent: routed.agent,
    agentName: persona.name,
    reason: routed.reason,
    matchedKeywords: routed.matchedKeywords,
    mode,
    text,
    proposals,
    summary: summarize(text),
  };
  emit({ type: 'turn:done', mode, proposals: proposals.length });
  return response;
}

module.exports = { runTurn };
