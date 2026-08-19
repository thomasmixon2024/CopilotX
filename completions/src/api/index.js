'use strict';

const { Router, loadJson } = require('../core/router');
const { invokeAgent } = require('../core/agents');
const { createLogger } = require('../core/logger');
const {
  loadSession,
  saveSession,
  clearSession,
  appendTurn,
  formatContextBlock,
  summarizeResponse,
  DEFAULT_MAX_TURNS,
} = require('../core/session');
const {
  formatWorkspaceBlock,
  mentionsWorkspace,
  normalizeSnapshot,
} = require('../core/workspace');
const { getConfigDir, getAgentsDir, getLogsDir } = require('../utils/paths');

/**
 * runCopilotX(input, options)
 *
 * options:
 *   forceLlmRouter  - force LLM classification
 *   useSession      - boolean (default true)
 *   sessionId       - string (default "default")
 *   maxTurns        - number (default 6)
 *   clearSession    - wipe session before this turn
 *   workspace       - IDE/workspace snapshot (see src/core/workspace.js)
 *   includeWorkspace- force workspace injection (default: true when snapshot
 *                     provided, or when input contains @workspace)
 *
 * Returns: {
 *   agent, matchedKeywords, mode, text, reason, llmUsed,
 *   sessionId, turnCount, workspaceIncluded
 * }
 */
async function runCopilotX(input, options = {}) {
  const configDir = getConfigDir();
  const agentsDir = getAgentsDir();
  const logsDir = getLogsDir();
  const log = createLogger(logsDir, 'Runtime.node.log');

  const useSession = options.useSession !== false;
  const sessionId = options.sessionId || 'default';
  const maxTurns = options.maxTurns || DEFAULT_MAX_TURNS;

  log(`=== CopilotX (Node core) run started ===`);
  log(`Input: ${input}`);

  // --- Session ---
  let session = { sessionId, turns: [] };
  let contextBlock = '';
  if (useSession) {
    if (options.clearSession) {
      session = clearSession(logsDir, sessionId);
      log(`Session cleared: ${sessionId}`);
    } else {
      session = loadSession(logsDir, sessionId);
    }
    contextBlock = formatContextBlock(session, maxTurns);
    if (contextBlock) {
      log(`Session context loaded (${session.turns.length} prior turn(s))`);
    }
  }

  // --- Workspace ---
  let workspaceBlock = '';
  let workspaceIncluded = false;
  const hasSnapshot = options.workspace && typeof options.workspace === 'object';
  const shouldIncludeWorkspace =
    options.includeWorkspace === true ||
    (options.includeWorkspace !== false && (hasSnapshot || mentionsWorkspace(input)));

  if (shouldIncludeWorkspace && hasSnapshot) {
    workspaceBlock = formatWorkspaceBlock(options.workspace);
    if (workspaceBlock) {
      workspaceIncluded = true;
      const norm = normalizeSnapshot(options.workspace);
      log(
        `Workspace context included (active: ${
          norm.activeFile ? norm.activeFile.path : 'none'
        }, tabs: ${norm.openTabs.length}, tree: ${norm.projectTree.length})`
      );
    }
  } else if (mentionsWorkspace(input) && !hasSnapshot) {
    log('Input mentions @workspace but no workspace snapshot was provided');
  }

  // --- Route ---
  const router = new Router(configDir);
  const resolution = await router.resolveAgentAsync(input, {
    forceLlm: !!options.forceLlmRouter,
    log,
  });

  const { agent, matchedKeywords, reason, llmUsed } = resolution;
  log(`Resolved agent: ${agent} (${reason}${llmUsed ? ', via LLM' : ''})`);

  const task = router.resolveTask(agent);
  const agentConfig = loadJson(configDir, 'agent.json').agents[agent];

  const result = await invokeAgent({
    agentsDir,
    agentKey: agent,
    input,
    matchedKeywords,
    task,
    agentConfig,
    log,
    configDir,
    contextBlock: useSession ? contextBlock : '',
    workspaceBlock: workspaceIncluded ? workspaceBlock : '',
  });

  if (useSession) {
    session = appendTurn(
      session,
      {
        input,
        agent,
        mode: result.mode,
        summary: summarizeResponse(result.text),
      },
      maxTurns
    );
    saveSession(logsDir, session);
    log(`Session updated: ${sessionId} (${session.turns.length} turn(s))`);
  }

  log(`Response mode: ${result.mode}`);
  log(`=== CopilotX (Node core) run completed ===`);

  return {
    agent,
    matchedKeywords,
    mode: result.mode,
    text: result.text,
    reason,
    llmUsed: !!llmUsed,
    sessionId: useSession ? sessionId : null,
    turnCount: useSession ? session.turns.length : 0,
    workspaceIncluded,
  };
}

const { applyToolPayload, applyToolBatch } = require('../core/tools');

/**
 * applyWorkspaceTools(workspaceRoot, payloads, options)
 * Apply one or more structured tool payloads with safety defaults.
 * Terminal is OFF unless options.allowTerminal === true.
 */
function applyWorkspaceTools(workspaceRoot, payloads, options = {}) {
  const list = Array.isArray(payloads) ? payloads : [payloads];
  return applyToolBatch(workspaceRoot, list, {
    allowTerminal: !!options.allowTerminal,
    allowedCommands: options.allowedCommands,
    continueOnError: !!options.continueOnError,
    timeoutMs: options.timeoutMs,
  });
}

const completions = require('../core/completions');
module.exports = { runCopilotX, applyWorkspaceTools, applyToolPayload, getCompletion: completions.getCompletion, extractPrefixSuffix: completions.extractPrefixSuffix };

