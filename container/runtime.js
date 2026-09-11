#!/usr/bin/env node
'use strict';

// Headless runner for the CopilotX supervisor/worker/QC pipeline.
// Zero dependencies. Git is the approval mechanism: proposals are applied
// to a dedicated run branch (default) or written as patches (dry mode).

const fs = require('fs');
const path = require('path');
const { runPipeline } = require('../src/core/pipeline');
const { createSession } = require('../src/core/session');
const { buildProposal, applyProposal } = require('../src/core/proposals');
const { getHeadlessSettings } = require('./settings');
const { buildWorkspaceSnapshot } = require('./snapshot');
const git = require('./git');

const MODES = ['branch', 'dry', 'auto'];

function parseArgs(argv) {
  const args = { mode: 'branch', repo: process.cwd(), _positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--goal-file') args.goalFile = argv[++i];
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--mode') args.mode = argv[++i];
    else if (a === '--provider') args.provider = argv[++i];
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--max-workers') args.maxWorkers = Number(argv[++i]);
    else if (a === '--max-qc-rounds') args.maxQcRounds = Number(argv[++i]);
    else if (a === '--report') args.report = argv[++i];
    else if (a === '--active-file') args.activeFile = argv[++i];
    else if (a === '--strict-claims') args.strictClaims = true;
    else if (a === '--allow-dirty') args.allowDirty = true;
    else if (a === '--push') args.push = true;
    else if (a === '--stream') args.stream = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else args._positional.push(a);
  }
  return args;
}

function usage() {
  return [
    'Usage: node container/runtime.js "<goal>" [options]',
    '',
    'Options:',
    '  --goal-file <path>    Read the goal from a file instead of the argument',
    '  --repo <path>         Target repository (default: cwd)',
    '  --mode <mode>         branch (default) | dry | auto',
    '  --provider <p>        openai | anthropic | nim | local | none',
    '  --model <m>           Model id for all roles (role overrides via COPILOTX_*_MODEL env)',
    '  --max-workers <1-4>   Concurrent worker tasks (default 2)',
    '  --max-qc-rounds <1-3> QC fix-loop rounds per task (default 2)',
    '  --report <path>       Report file (default: container/runs/<id>/REPORT.md in the repo)',
    '  --active-file <rel>   Include one file as active-file context',
    '  --strict-claims       Drop proposals outside claimed files instead of warning',
    '  --allow-dirty         Permit a dirty working tree (branch/auto modes)',
    '  --push                Push the run branch to origin after committing',
    '  --stream              Forward model deltas to stderr',
    '',
    'Modes:',
    '  branch  Apply proposals to a new pipeline/run-<id> branch and commit them.',
    '  dry     Write patch files + proposals.json; change nothing.',
    '  auto    Apply proposals to the current working tree.',
  ].join('\n');
}

function normalizeClaim(claim) {
  return String(claim || '').trim().toLowerCase().replace(/\\/g, '/');
}

function claimCovers(claims, relPath) {
  const rel = normalizeClaim(relPath);
  return claims.some((claim) => {
    const key = normalizeClaim(claim);
    if (!key) return false;
    const prefix = key.endsWith('/') ? key : `${key}/`;
    return rel === key || rel.startsWith(prefix);
  });
}

function scanClaims(proposals, plan) {
  const claimed = [];
  for (const task of (plan && plan.tasks) || []) {
    for (const claim of task.fileClaims || []) claimed.push(claim);
  }
  if (!claimed.length) return { violations: [], guarded: false };
  const violations = [];
  for (const proposal of proposals) {
    if (!claimCovers(claimed, proposal.relPath)) violations.push(proposal.relPath);
  }
  return { violations, guarded: true };
}

function linesOf(text) {
  const arr = text ? text.split(/\r?\n/) : [];
  if (arr.length && arr[arr.length - 1] === '') arr.pop();
  return arr;
}

function makeUnifiedDiff(original, proposed, relPath) {
  const before = linesOf(original);
  const after = linesOf(proposed);
  const out = [];
  out.push(original ? `--- a/${relPath}` : '--- /dev/null');
  out.push(`+++ b/${relPath}`);
  out.push(`@@ -${before.length ? 1 : 0},${before.length} +${after.length ? 1 : 0},${after.length} @@`);
  for (const line of before) out.push(`-${line}`);
  for (const line of after) out.push(`+${line}`);
  return out.join('\n');
}

function safeFileName(relPath) {
  return String(relPath).replace(/[^a-zA-Z0-9._-]+/g, '__');
}

function writeDryArtifacts(proposals, runDir) {
  const patchesDir = path.join(runDir, 'patches');
  fs.mkdirSync(patchesDir, { recursive: true });
  const manifest = proposals.map((proposal, index) => {
    const patchName = `${index + 1}-${safeFileName(proposal.relPath)}.patch`;
    fs.writeFileSync(
      path.join(patchesDir, patchName),
      makeUnifiedDiff(proposal.original, proposal.proposed, proposal.relPath),
      'utf8'
    );
    return {
      id: proposal.id,
      tool: proposal.tool,
      relPath: proposal.relPath,
      created: proposal.created,
      diff: proposal.diff,
      patch: `patches/${patchName}`,
    };
  });
  fs.writeFileSync(
    path.join(runDir, 'proposals.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );
  return manifest;
}

function applyAll(proposals) {
  const results = [];
  for (const proposal of proposals) {
    try {
      applyProposal(proposal);
      results.push({ relPath: proposal.relPath, applied: true });
    } catch (err) {
      results.push({ relPath: proposal.relPath, applied: false, error: err.message });
    }
  }
  return results;
}

function composeReport(result, extras) {
  const lines = [];
  lines.push(`# Pipeline run ${extras.runId}`);
  lines.push('');
  lines.push(`- Mode: ${extras.mode}`);
  lines.push(`- Branch: ${extras.branch || '(n/a)'}`);
  lines.push(`- Pipeline mode: ${result.mode}`);
  if (extras.claimWarnings.length) {
    lines.push(`- Claim-guard warnings: ${extras.claimWarnings.join(', ')}`);
  }
  lines.push('');
  lines.push(result.text);
  lines.push('');
  lines.push('## Proposals');
  if (!extras.proposalRows.length) {
    lines.push('No file changes were proposed.');
  } else {
    for (const row of extras.proposalRows) {
      lines.push(
        `- ${row.relPath}: ${row.outcome}` +
          (row.error ? ` (${row.error})` : '') +
          ` (+${row.added}/-${row.removed})`
      );
    }
  }
  lines.push('');
  lines.push('## Task results (raw)');
  lines.push('```json');
  lines.push(JSON.stringify(result.taskResults, null, 2));
  lines.push('```');
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }
  let goal = args._positional.join(' ').trim();
  if (args.goalFile) goal = fs.readFileSync(args.goalFile, 'utf8').trim();
  if (!goal) {
    console.error('Error: a goal is required (positional argument or --goal-file).');
    console.error(usage());
    return 2;
  }
  if (!MODES.includes(args.mode)) {
    console.error(`Error: unknown mode "${args.mode}". Choose one of: ${MODES.join(', ')}.`);
    return 2;
  }

  const repoPath = path.resolve(args.repo);
  if (!fs.existsSync(repoPath)) {
    console.error(`Error: repo path does not exist: ${repoPath}`);
    return 2;
  }

  let baseBranch = null;
  let runBranch = null;
  if (args.mode !== 'dry') {
    if (!(await git.isRepo(repoPath))) {
      console.error(`Error: ${repoPath} is not a git repository (mode "${args.mode}" needs git).`);
      return 2;
    }
    if (!args.allowDirty) await git.assertCleanTree(repoPath);
    baseBranch = await git.currentBranch(repoPath);
    if (baseBranch === 'HEAD') {
      console.error('Error: detached HEAD; checkout a branch before running in branch mode.');
      return 2;
    }
  }

  const runId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6);
  const runDir = args.report
    ? path.dirname(path.resolve(args.report))
    : path.join(repoPath, 'container', 'runs', runId);
  const reportPath = args.report ? path.resolve(args.report) : path.join(runDir, 'REPORT.md');

  if (args.mode === 'branch') {
    runBranch = `pipeline/run-${runId}`;
    await git.createBranch(runBranch, repoPath);
    console.log(`[pipeline] created branch ${runBranch} (from ${baseBranch})`);
  }

  const settings = getHeadlessSettings({
    provider: args.provider,
    model: args.model,
    maxWorkers: args.maxWorkers,
    maxQcRounds: args.maxQcRounds,
    includeWorkspace: true,
    streamResponses: Boolean(args.stream),
  });
  const workspace = buildWorkspaceSnapshot(repoPath, args.activeFile);
  const onDelta = args.stream ? (delta) => process.stderr.write(String(delta)) : undefined;

  console.log(`[pipeline] goal: ${goal.slice(0, 120)}${goal.length > 120 ? '…' : ''}`);
  const result = await runPipeline({
    input: goal,
    session: createSession('container'),
    workspace,
    settings,
    onDelta,
  });
  console.log(`[pipeline] finished with mode=${result.mode}`);

  // Claim guardrail: flag (or drop) proposals outside all claimed files.
  const scan = scanClaims(result.proposals, result.plan);
  const claimWarnings = [];
  let effective = result.proposals;
  if (scan.guarded && scan.violations.length) {
    if (args.strictClaims) {
      effective = result.proposals.filter(
        (proposal) => !scan.violations.includes(proposal.relPath)
      );
      claimWarnings.push(`dropped ${scan.violations.length} proposal(s) outside claimed files`);
    } else {
      claimWarnings.push(`${scan.violations.length} proposal(s) outside claimed files: ${scan.violations.join(', ')}`);
    }
  }

  let proposalRows = [];
  let appliedCount = 0;
  if (args.mode === 'dry') {
    const manifest = writeDryArtifacts(effective, runDir);
    proposalRows = manifest.map((entry) => ({
      relPath: entry.relPath,
      outcome: 'patch written (dry mode)',
      added: entry.diff.added,
      removed: entry.diff.removed,
    }));
  } else if (args.mode === 'auto' || args.mode === 'branch') {
    const results = applyAll(effective);
    appliedCount = results.filter((r) => r.applied).length;
    proposalRows = results.map((row, index) => ({
      relPath: row.relPath,
      outcome: row.applied ? 'applied' : 'SKIPPED',
      error: row.error,
      added: effective[index] ? effective[index].diff.added : 0,
      removed: effective[index] ? effective[index].diff.removed : 0,
    }));
    if (args.mode === 'branch' && appliedCount) {
      const committed = await git.commitAll(
        `pipeline(${runId}): apply ${appliedCount} proposal(s)\n\nGoal: ${goal.slice(0, 200)}`,
        repoPath
      );
      console.log(committed ? '[pipeline] changes committed on run branch' : '[pipeline] nothing to commit');
    }
  }

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const report = composeReport(result, {
    runId,
    mode: args.mode,
    branch: runBranch,
    claimWarnings,
    proposalRows,
  });
  fs.writeFileSync(reportPath, report, 'utf8');

  if (args.mode === 'branch') {
    const reportCommitted = await git.commitAll(`pipeline(${runId}): run report`, repoPath);
    if (args.push && runBranch) {
      await git.push(runBranch, repoPath);
      console.log(`[pipeline] pushed ${runBranch} to origin`);
    }
    if (!reportCommitted && !appliedCount) {
      console.log('[pipeline] no changes and no proposals; run branch has only the report');
    }
  }

  console.log(`[pipeline] report: ${reportPath}`);
  if (appliedCount || proposalRows.length) {
    console.log(`[pipeline] proposals: ${appliedCount} applied, ${proposalRows.length - appliedCount} skipped`);
  }

  if (result.mode === 'fallback' || result.mode === 'stopped') {
    console.error(`[pipeline] run did not complete cleanly (mode=${result.mode}); see report.`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[pipeline] fatal: ${err.message}`);
      process.exit(2);
    });
}

module.exports = {
  parseArgs,
  normalizeClaim,
  claimCovers,
  scanClaims,
  makeUnifiedDiff,
  writeDryArtifacts,
  applyAll,
  composeReport,
  safeFileName,
};
