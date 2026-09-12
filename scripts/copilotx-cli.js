'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { runTurn } = require('../src/core/engine');
const { createSession, appendTurn } = require('../src/core/session');

function parseArgs(argv) {
  const options = {
    workspace: process.cwd(),
    provider: process.env.COPILOTX_PROVIDER || 'local',
    model: process.env.COPILOTX_MODEL || 'open_router/anthropic/claude-sonnet-5',
    baseUrl: process.env.COPILOTX_BASE_URL || 'http://127.0.0.1:8082/v1',
    allowWrites: 'approval',
    prompt: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--workspace' || arg === '-w') options.workspace = argv[++i];
    else if (arg === '--provider') options.provider = argv[++i];
    else if (arg === '--model') options.model = argv[++i];
    else if (arg === '--base-url') options.baseUrl = argv[++i];
    else if (arg === '--allow-writes') options.allowWrites = argv[++i];
    else if (arg === '--prompt' || arg === '-p') options.prompt = argv[++i];
    else if (!options.prompt) options.prompt = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    'CopilotX CLI',
    '',
    'Interactive:',
    '  .\\scripts\\copilotx.ps1 -Workspace .',
    '',
    'One prompt:',
    '  .\\scripts\\copilotx.ps1 -Prompt "Explain this repository"',
    '',
    'Options:',
    '  -Workspace <path>       Workspace root (default: current directory)',
    '  -Provider <name>        local, none, anthropic, openai, or nim',
    '  -Model <id>             Model id (defaults to the configured local model)',
    '  -BaseUrl <url>          OpenAI-compatible base URL',
    '  -AllowWrites <mode>     off, approval (default), or auto',
    '  -Prompt <text>          Run one prompt and exit',
  ].join('\n');
}

function projectTree(root, maxEntries = 80) {
  const skipped = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage']);
  const entries = [];
  function walk(dir, prefix, depth) {
    if (depth > 3 || entries.length >= maxEntries) return;
    let children;
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (entries.length >= maxEntries || child.name.startsWith('.') || skipped.has(child.name)) continue;
      const rel = prefix ? `${prefix}/${child.name}` : child.name;
      entries.push(child.isDirectory() ? `${rel}/` : rel);
      if (child.isDirectory()) walk(path.join(dir, child.name), rel, depth + 1);
    }
  }
  walk(root, '', 0);
  return entries;
}

function workspaceSnapshot(root) {
  return {
    workspaceFolders: [{ name: path.basename(root), path: root }],
    projectTree: projectTree(root),
  };
}

function settings(options) {
  return {
    provider: options.provider,
    apiKey: process.env.COPILOTX_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '',
    model: options.model,
    openaiBaseUrl: options.baseUrl,
    includeWorkspace: true,
    allowWrites: options.allowWrites,
    streamResponses: true,
  };
}

async function ask(input, state, options) {
  const result = await runTurn({
    input,
    session: state.session,
    workspace: state.workspace,
    settings: settings(options),
    onDelta: (chunk) => process.stdout.write(chunk),
  });
  if (result.mode === 'live') process.stdout.write('\n');
  else process.stdout.write(`${result.text}\n`);
  for (const proposal of result.proposals || []) {
    process.stdout.write(
      `\n[proposed ${proposal.relPath}: +${proposal.stats.added}/-${proposal.stats.removed}; ` +
        'rerun with -AllowWrites auto to apply automatically]\n'
    );
  }
  state.session = appendTurn(state.session, {
    input,
    agent: result.agent,
    text: result.text,
    summary: result.summary,
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const root = path.resolve(options.workspace || process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Workspace is not a directory: ${root}`);
  }
  options.workspace = root;
  const state = {
    workspace: workspaceSnapshot(root),
    session: createSession('copilotx-cli'),
  };

  if (options.prompt) {
    await ask(options.prompt, state, options);
    return;
  }

  console.log(`CopilotX CLI · ${root}`);
  console.log('Type /help for commands, /exit to quit.\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '› ' });
  rl.prompt();
  for await (const line of rl) {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      continue;
    }
    if (input === '/exit' || input === '/quit') break;
    if (input === '/help') {
      console.log('Commands: /help, /exit, /quit');
      rl.prompt();
      continue;
    }
    try {
      await ask(input, state, options);
    } catch (err) {
      console.error(`\nError: ${err.message}`);
    }
    rl.prompt();
  }
  rl.close();
}

main().catch((err) => {
  console.error(`CopilotX CLI error: ${err.message}`);
  process.exitCode = 1;
});
