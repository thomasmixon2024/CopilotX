'use strict';

const fs = require('fs');
const path = require('path');
const { complete, streamComplete } = require('./llm');
const { getToolDefinitions, executeToolCall } = require('./tools');
const { buildProposal, applyProposal } = require('./proposals');
const { createSession, formatContextBlock, summarize } = require('./session');
const { formatWorkspaceBlock } = require('./workspace');

const MAX_TASKS = 6;
const MAX_TASK_ROUNDS = 8;

function loadPersonas() {
  const p = path.join(__dirname, '..', '..', 'config', 'personas.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function isAbortError(err) {
  return Boolean(err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'));
}

async function runAgentTurn({ personaKey, personas, input, session, workspace, settings, signal, onDelta }) {
  const persona = (personas || {})[personaKey] || { name: personaKey, system: '' };

  const contextBlock = formatContextBlock(session);
  const workspaceBlock = settings.includeWorkspace ? formatWorkspaceBlock(workspace) : '';

  const userParts = [];
  if (contextBlock) userParts.push(contextBlock);
  if (workspaceBlock) userParts.push(workspaceBlock);
  userParts.push(input);

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
    for (let round = 0; round < MAX_TASK_ROUNDS; round += 1) {
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
        break;
      }

      messages.push(live.assistantMessage);
      for (const call of live.toolCalls) {
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
          } catch (err) {
            result = { error: err.message };
          }
        } else {
          try {
            result = executeToolCall(call, workspace);
          } catch (err) {
            result = { error: err.message };
          }
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
      if (round === MAX_TASK_ROUNDS - 1) {
        throw new Error('Tool-call limit reached before the model produced a final answer.');
      }
    }
  } catch (err) {
    if (isAbortError(err) && text) {
      mode = 'stopped';
    } else {
      mode = 'fallback';
      text = `**${persona.name}** could not reach the configured model.\n\nError: \`${err.message}\`\n\nCheck the provider, model, endpoint, and credentials before retrying.`;
    }
  }

  if (!text) {
    text = `**${persona.name}** produced no response for this turn.`;
  }

  return {
    personaKey,
    personaName: persona.name,
    mode,
    text,
    proposals,
  };
}

function extractBalancedJson(text) {
  const raw = String(text || '');
  const results = [];
  for (let start = raw.indexOf('{'); start !== -1; start = raw.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < raw.length; i += 1) {
      const ch = raw[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          results.push(raw.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return results;
}

function tryParseJsonObjects(text) {
  const candidates = extractBalancedJson(text);
  if (!candidates.length) {
    const trimmed = String(text || '').trim();
    if (trimmed) candidates.push(trimmed);
  }
  const parsed = [];
  for (const candidate of candidates) {
    try {
      parsed.push(JSON.parse(candidate));
    } catch {
      continue;
    }
  }
  return parsed;
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string' && entry.trim());
}

function parseTaskGraph(text) {
  const objects = tryParseJsonObjects(text);
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    if (!Array.isArray(obj.tasks)) continue;
    const tasks = [];
    let ok = true;
    for (const raw of obj.tasks) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { ok = false; break; }
      if (typeof raw.id !== 'string' || !raw.id.trim()) { ok = false; break; }
      if (typeof raw.goal !== 'string' || !raw.goal.trim()) { ok = false; break; }
      tasks.push({
        id: raw.id.trim(),
        goal: raw.goal.trim(),
        fileClaims: toStringArray(raw.fileClaims),
        dependsOn: toStringArray(raw.dependsOn),
      });
    }
    if (!ok) continue;
    const sharedDecisions =
      obj.sharedDecisions && typeof obj.sharedDecisions === 'object' && !Array.isArray(obj.sharedDecisions)
        ? obj.sharedDecisions
        : {};
    return { tasks, sharedDecisions };
  }
  return null;
}

function normalizeClaim(claim) {
  return String(claim || '').trim().toLowerCase().replace(/\\/g, '/');
}

function validateTaskGraph(graph) {
  const errors = [];
  if (!graph || typeof graph !== 'object') {
    return { ok: false, errors: ['Task graph is missing or invalid.'] };
  }
  const tasks = Array.isArray(graph.tasks) ? graph.tasks : [];
  if (!tasks.length) errors.push('Task graph contains no tasks.');
  if (tasks.length > MAX_TASKS) {
    errors.push(`Task graph has ${tasks.length} tasks; at most ${MAX_TASKS} are allowed.`);
  }

  const seenIds = new Set();
  for (const task of tasks) {
    if (!task || typeof task.id !== 'string' || !task.id.trim()) {
      errors.push('Every task needs a non-empty string id.');
      continue;
    }
    if (seenIds.has(task.id)) errors.push(`Duplicate task id: ${task.id}`);
    seenIds.add(task.id);
  }

  for (const task of tasks) {
    for (const dep of toStringArray(task.dependsOn)) {
      if (!seenIds.has(dep)) {
        errors.push(`Task ${task.id} depends on unknown task: ${dep}`);
      }
    }
  }

  // Cycle detection (Kahn).
  const ids = tasks.map((t) => t.id);
  const inDegree = new Map(ids.map((id) => [id, 0]));
  const edges = new Map(ids.map((id) => [id, []]));
  for (const task of tasks) {
    for (const dep of toStringArray(task.dependsOn)) {
      if (seenIds.has(dep)) {
        edges.get(dep).push(task.id);
        inDegree.set(task.id, inDegree.get(task.id) + 1);
      }
    }
  }
  const queue = ids.filter((id) => inDegree.get(id) === 0);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift();
    visited += 1;
    for (const next of edges.get(id)) {
      inDegree.set(next, inDegree.get(next) - 1);
      if (inDegree.get(next) === 0) queue.push(next);
    }
  }
  if (visited !== ids.length) {
    errors.push('Task graph contains a dependency cycle.');
  }

  // Exclusive file claims.
  const claimOwner = new Map();
  for (const task of tasks) {
    for (const claim of toStringArray(task.fileClaims)) {
      const key = normalizeClaim(claim);
      if (!key) continue;
      if (claimOwner.has(key) && claimOwner.get(key) !== task.id) {
        errors.push(
          `File claim "${claim}" is claimed by both ${claimOwner.get(key)} and ${task.id}.`
        );
      } else {
        claimOwner.set(key, task.id);
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

function buildSupervisorInput(input, contextBlock, workspaceBlock) {
  const parts = [];
  if (contextBlock) parts.push(contextBlock);
  if (workspaceBlock) parts.push(workspaceBlock);
  parts.push(`Goal:\n${input}`);
  parts.push(
    'Remember: reply with STRICT JSON only, no prose, no markdown fences, matching the supervisor contract shape.'
  );
  return parts.join('\n\n');
}

function buildWorkerTaskInput(task, graph, attempt) {
  const lines = [];
  lines.push('x-worker');
  lines.push(`Task ${task.id} (attempt ${attempt})`);
  lines.push(`Goal: ${task.goal}`);
  const claims = toStringArray(task.fileClaims);
  lines.push(`Claimed files: ${claims.length ? claims.join(', ') : 'none specified'}`);
  const decisions = graph && graph.sharedDecisions ? graph.sharedDecisions : {};
  const decisionKeys = Object.keys(decisions).filter(
    (key) => decisions[key] !== null && decisions[key] !== undefined && String(decisions[key]).trim()
  );
  if (decisionKeys.length) {
    lines.push('Shared decisions:');
    for (const key of decisionKeys) {
      lines.push(`- ${key}: ${String(decisions[key]).trim()}`);
    }
  }
  lines.push(
    'Propose your changes with the write_file/edit_file tools and stay strictly inside the claimed files.'
  );
  return lines.join('\n');
}

function buildQcInput(task, workerResult, attempt) {
  const workerText = typeof workerResult === 'string' ? workerResult : workerResult.text;
  const workerProposals = typeof workerResult === 'string' ? [] : workerResult.proposals || [];
  const lines = [];
  lines.push('x-qc');
  lines.push(`Task ${task.id} review (attempt ${attempt})`);
  lines.push(`Goal: ${task.goal}`);
  lines.push('Worker result summary:');
  lines.push(String(workerText || '').trim().slice(0, 1500));
  const proposals = workerProposals;
  if (proposals.length) {
    lines.push('Files the worker proposed changes to:');
    for (const proposal of proposals) {
      const diff = proposal.diff || {};
      lines.push(`- ${proposal.relPath} (+${diff.added || 0}/-${diff.removed || 0})`);
    }
  } else {
    lines.push('The worker proposed no file changes.');
  }
  return lines.join('\n');
}

function parseQcVerdict(text) {
  const objects = tryParseJsonObjects(text);
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    if (obj.verdict !== 'pass' && obj.verdict !== 'needs-fix') continue;
    const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
    const findings = rawFindings
      .filter((f) => f && typeof f === 'object' && !Array.isArray(f))
      .map((f) => ({
        file: typeof f.file === 'string' ? f.file : '',
        issue: typeof f.issue === 'string' ? f.issue : '',
        severity: typeof f.severity === 'string' ? f.severity : '',
        suggestedFix: typeof f.suggestedFix === 'string' ? f.suggestedFix : '',
      }));
    return { verdict: obj.verdict, findings };
  }
  return null;
}

function topologicalWaves(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const remaining = new Map(tasks.map((t) => [t.id, new Set(toStringArray(t.dependsOn))]));
  const waves = [];
  while (remaining.size) {
    const wave = [];
    for (const [id, deps] of remaining) {
      const unmet = [...deps].filter((dep) => remaining.has(dep));
      if (!unmet.length) wave.push(byId.get(id));
    }
    if (!wave.length) break;
    for (const task of wave) remaining.delete(task.id);
    waves.push(wave);
  }
  return waves;
}

async function runPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }
  const lanes = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) lanes.push(worker());
  await Promise.all(lanes);
  return results;
}

function formatPlanSection(graph) {
  const lines = ['### Plan'];
  for (const task of graph.tasks) {
    const claims = toStringArray(task.fileClaims);
    const deps = toStringArray(task.dependsOn);
    lines.push(`- **${task.id}**: ${task.goal}`);
    if (claims.length) lines.push(`  - Claims: ${claims.join(', ')}`);
    if (deps.length) lines.push(`  - Depends on: ${deps.join(', ')}`);
  }
  const decisions = graph.sharedDecisions || {};
  const decisionKeys = Object.keys(decisions).filter((key) => String(decisions[key] || '').trim());
  if (decisionKeys.length) {
    lines.push('- Shared decisions:');
    for (const key of decisionKeys) {
      lines.push(`  - ${key}: ${String(decisions[key]).trim()}`);
    }
  }
  return lines.join('\n');
}

async function runPipeline({ input, session, workspace, settings, signal, onDelta }) {
  const apiKey =
    settings.apiKey ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    '';

  // 'local' is a valid live provider without an API key (matches llm.js), so only
  // short-circuit to the offline template when no live provider is usable at all.
  const offline =
    settings.provider === 'none' ||
    !settings.provider ||
    (!apiKey && settings.provider !== 'local');
  if (offline) {
    const goal = String(input || '').trim().slice(0, 300);
    const text = [
      '**Pipeline** is offline (no model provider configured).',
      '',
      '### Plan',
      '- **t1**: ' + goal,
      '',
      'Worker and QC stages were skipped. Live supervisor/worker/QC runs need a configured provider (`copilotx.provider` + API key).',
    ].join('\n');
    return {
      agent: 'pipeline',
      agentName: 'Pipeline',
      mode: 'local',
      text,
      proposals: [],
      summary: summarize(text),
      plan: { tasks: [{ id: 't1', goal, fileClaims: [], dependsOn: [] }], sharedDecisions: {} },
      taskResults: [{ id: 't1', status: 'skipped-offline', rounds: 0, workerText: '', qc: null }],
      qcFindings: [],
    };
  }

  const personas = loadPersonas();
  const contextBlock = formatContextBlock(session);
  const workspaceBlock = settings.includeWorkspace ? formatWorkspaceBlock(workspace) : '';

  const turnModes = [];
  const proposals = [];
  const taskResults = [];
  const qcFindings = [];
  let stopped = false;
  let degraded = null;

  // 1. Supervisor plans.
  const supervisorTurn = await runAgentTurn({
    personaKey: 'supervisor',
    personas,
    input: buildSupervisorInput(input, contextBlock, workspaceBlock),
    session,
    workspace,
    settings,
    signal,
    onDelta,
  });
  turnModes.push(supervisorTurn.mode);
  if (supervisorTurn.mode === 'stopped') {
    return {
      agent: 'pipeline',
      agentName: 'Pipeline',
      mode: 'stopped',
      text: supervisorTurn.text,
      proposals: [],
      summary: summarize(supervisorTurn.text),
      plan: null,
      taskResults: [],
      qcFindings: [],
    };
  }

  let graph = parseTaskGraph(supervisorTurn.text);
  if (graph) {
    const validation = validateTaskGraph(graph);
    if (!validation.ok) {
      degraded = `Supervisor plan rejected (${validation.errors.join(' ')}); using a single fallback task.`;
      graph = null;
    }
  } else {
    degraded = 'Supervisor reply could not be parsed as a task graph; using a single fallback task.';
  }
  if (!graph) {
    graph = {
      tasks: [{ id: 't1', goal: String(input || '').trim(), fileClaims: [], dependsOn: [] }],
      sharedDecisions: {},
    };
  }

  // 2. Execute in dependency waves with a bounded worker pool.
  const maxWorkers = Math.max(1, Math.min(4, Number(settings.pipelineMaxWorkers) || 2));
  const maxAttempts = 1 + (Number(settings.pipelineMaxQcRounds) || 2);

  async function executeTask(task) {
    const result = {
      id: task.id,
      status: 'done',
      rounds: 0,
      workerText: '',
      qc: null,
    };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let workerInput = buildWorkerTaskInput(task, graph, attempt);
      const lastQc = result.qc;
      if (attempt > 1 && lastQc && Array.isArray(lastQc.findings) && lastQc.findings.length) {
        const findingLines = lastQc.findings
          .map((f) => `- [${f.severity || 'medium'}] ${f.file || '(file)'}: ${f.issue}${f.suggestedFix ? ` Suggested fix: ${f.suggestedFix}` : ''}`)
          .join('\n');
        workerInput += `\n\nQC findings to address:\n${findingLines}`;
      }
      const workerTurn = await runAgentTurn({
        personaKey: 'worker',
        personas,
        input: workerInput,
        session: createSession(`pipeline-worker-${task.id}`),
        workspace,
        settings: { ...settings, model: settings.workerModel || settings.model },
        signal,
      });
      turnModes.push(workerTurn.mode);
      result.rounds = attempt;
      result.workerText = workerTurn.text;
      proposals.push(...workerTurn.proposals);
      if (workerTurn.mode === 'stopped') {
        stopped = true;
        result.status = 'stopped';
        return result;
      }
      if (workerTurn.mode === 'fallback') result.status = 'fallback';

      const qcTurn = await runAgentTurn({
        personaKey: 'qc',
        personas,
        input: buildQcInput(task, workerTurn, attempt),
        session: createSession(`pipeline-qc-${task.id}`),
        workspace,
        settings: { ...settings, model: settings.qcModel || settings.model },
        signal,
      });
      turnModes.push(qcTurn.mode);
      const verdict = parseQcVerdict(qcTurn.text);
      if (!verdict) {
        result.qc = { verdict: 'pass', findings: [], warning: 'QC reply could not be parsed; treated as pass.' };
        result.qcText = qcTurn.text;
        result.status = result.status === 'done' ? 'done' : result.status;
        return result;
      }
      result.qc = verdict;
      result.qcText = qcTurn.text;
      if (qcTurn.mode === 'stopped') {
        stopped = true;
        result.status = 'stopped';
        return result;
      }
      if (verdict.verdict === 'pass') return result;
      if (attempt === maxAttempts) {
        result.status = 'escalated';
        return result;
      }
    }
    return result;
  }

  const waves = topologicalWaves(graph.tasks);
  for (const wave of waves) {
    if (stopped) break;
    const waveResults = await runPool(wave, maxWorkers, executeTask);
    taskResults.push(...waveResults);
    if (waveResults.some((r) => r.status === 'stopped')) stopped = true;
  }

  // 3. Collect QC findings from the final QC round of each task.
  for (const result of taskResults) {
    const findings = (result.qc && Array.isArray(result.qc.findings)) ? result.qc.findings : [];
    for (const finding of findings) {
      qcFindings.push({ ...finding, taskId: result.id });
    }
  }

  // 4. Compose the overall mode.
  let mode = 'live';
  if (stopped || turnModes.includes('stopped')) mode = 'stopped';
  else if (turnModes.includes('fallback')) mode = 'fallback';

  // 5. Compose the report.
  const lines = [];
  lines.push('**Pipeline** run complete.' + (degraded ? ` _${degraded}_` : ''));
  lines.push('');
  lines.push(formatPlanSection(graph));
  lines.push('');
  lines.push('### Execution');
  for (const result of taskResults) {
    const note = result.qc && result.qc.warning ? ` (QC: ${result.qc.warning})` : '';
    lines.push(`- **${result.id}**: ${result.status} after ${result.rounds} attempt(s)${note}`);
  }
  if (qcFindings.length) {
    lines.push('');
    lines.push('### QC findings');
    const byTask = new Map();
    for (const finding of qcFindings) {
      if (!byTask.has(finding.taskId)) byTask.set(finding.taskId, []);
      byTask.get(finding.taskId).push(finding);
    }
    for (const [taskId, findings] of byTask) {
      lines.push(`- **${taskId}**`);
      for (const finding of findings) {
        lines.push(
          `  - [${finding.severity || 'medium'}] ${finding.file || '(file)'}: ${finding.issue}` +
            (finding.suggestedFix ? ` _Suggested fix: ${finding.suggestedFix}_` : '')
        );
      }
    }
  }
  lines.push('');
  lines.push('All file changes are proposal cards awaiting user approval. Nothing is written until you accept a diff.');

  const text = lines.join('\n');
  return {
    agent: 'pipeline',
    agentName: 'Pipeline',
    mode,
    text,
    proposals,
    summary: summarize(text),
    plan: graph,
    taskResults,
    qcFindings,
  };
}

module.exports = {
  runPipeline,
  runAgentTurn,
  parseTaskGraph,
  validateTaskGraph,
  buildSupervisorInput,
  buildWorkerTaskInput,
  buildQcInput,
  parseQcVerdict,
  MAX_TASKS,
};
