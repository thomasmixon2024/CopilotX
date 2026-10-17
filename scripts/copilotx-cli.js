'use strict';

// A dependency-free, Codex-inspired terminal shell. The engine remains the
// source of truth; this file only renders its activity for humans.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { runTurn } = require('../src/core/engine');
const { createSession, appendTurn } = require('../src/core/session');
const { refreshLocalProvider } = require('../src/core/providerHealth');

const ANSI = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', cyan: '\x1b[36m',
  blue: '\x1b[94m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  magenta: '\x1b[35m', gray: '\x1b[90m',
};

function parseArgs(argv) {
  const options = {
    workspace: process.cwd(),
    provider: process.env.COPILOTX_PROVIDER || 'local',
    model: process.env.COPILOTX_MODEL || 'open_router/anthropic/claude-sonnet-5',
    baseUrl: process.env.COPILOTX_BASE_URL || 'http://127.0.0.1:8082/v1',
    allowWrites: 'approval',
    prompt: '',
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    speak: false,
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
    else if (arg === '--no-color' || arg === '--plain') options.color = false;
    else if (arg === '--speak') options.speak = true;
    else if (!options.prompt) options.prompt = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    'CopilotX terminal UI',
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
    '  --no-color              Disable terminal colors',
    '  --speak                 Read responses aloud on Windows',
  ].join('\n');
}

function projectTree(root, maxEntries = 80) {
  const skipped = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage']);
  const entries = [];
  function walk(dir, prefix, depth) {
    if (depth > 3 || entries.length >= maxEntries) return;
    let children;
    try { children = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
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
  return { workspaceFolders: [{ name: path.basename(root), path: root }], projectTree: projectTree(root) };
}

function settings(options) {
  return {
    provider: options.provider,
    apiKey: process.env.COPILOTX_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '',
    model: options.model, openaiBaseUrl: options.baseUrl, includeWorkspace: true,
    allowWrites: options.allowWrites, streamResponses: true,
  };
}

function paint(options, color, text) {
  return options.color ? `${ANSI[color]}${text}${ANSI.reset}` : text;
}

function splash(options) {
  const lines = [
    '  ██████╗ ██████╗ ██████╗ ██╗██╗      ██████╗ ████████╗██╗  ██╗',
    ' ██╔════╝██╔═══██╗██╔══██╗██║██║     ██╔═══██╗╚══██╔══╝╚██╗██╔╝',
    ' ██║     ██║   ██║██████╔╝██║██║     ██║   ██║   ██║    ╚███╔╝ ',
    ' ██║     ██║   ██║██╔═══╝ ██║██║     ██║   ██║   ██║    ██╔██╗ ',
    ' ╚██████╗╚██████╔╝██║     ██║███████╗╚██████╔╝   ██║   ██╔╝ ██╗',
    '  ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝ ╚═════╝    ╚═╝   ╚═╝  ╚═╝',
  ];
  console.log(paint(options, 'cyan', lines.join('\n')));
  console.log(paint(options, 'dim', '  terminal workspace agent  ·  /help for commands\n'));
}

function header(options, root) {
  const workspace = path.basename(root) || root;
  console.log(`${paint(options, 'bold', ' CopilotX')} ${paint(options, 'gray', '│')} ` +
    `${paint(options, 'blue', workspace)} ${paint(options, 'gray', '│')} ` +
    `${paint(options, 'magenta', options.provider)} ${paint(options, 'gray', '│')} ` +
    `${paint(options, 'yellow', options.model)}`);
  console.log(paint(options, 'gray', ` writes: ${options.allowWrites}  ·  Ctrl+C to stop  ·  /help for commands`));
  console.log(paint(options, 'gray', '─'.repeat(Math.min(100, process.stdout.columns || 80))));
}

function activity(options, message, color = 'gray') {
  console.log(`${paint(options, color, '  •')} ${paint(options, 'dim', message)}`);
}

let speechProcess = null;

function stopSpeaking() {
  if (speechProcess && !speechProcess.killed) speechProcess.kill();
  speechProcess = null;
}

function speak(options, text) {
  if (!options.speak || process.platform !== 'win32' || !text) return;
  stopSpeaking();
  const clean = String(text).replace(/```[\s\S]*?```/g, ' code block omitted ')
    .replace(/[*_`>#]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return;
  const encoded = Buffer.from(clean, 'utf8').toString('base64');
  const command = `Add-Type -AssemblyName System.Speech; ` +
    `$s=New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
    `$s.Speak([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')));`;
  speechProcess = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, stdio: 'ignore',
  });
  speechProcess.on('exit', () => { speechProcess = null; });
}

async function ask(input, state, options) {
  let responseStarted = false;
  const result = await runTurn({
    input, session: state.session, workspace: state.workspace, settings: settings(options),
    onEvent: (event) => {
      if (event.type === 'turn:start') activity(options, `routing to ${event.agentName}…`, 'cyan');
      if (event.type === 'tool:start') activity(options, `using ${event.name}`, 'blue');
      if (event.type === 'tool:done' && !event.ok) activity(options, 'tool reported an error', 'red');
      if (event.type === 'proposal') {
        const stateText = event.applied ? 'applied' : 'awaiting approval';
        activity(options, `proposal ${event.path} (${stateText})`, event.applied ? 'green' : 'yellow');
      }
    },
    onDelta: (chunk) => {
      if (!responseStarted) {
        process.stdout.write(`\n${paint(options, 'green', '  copilotx ›')} `);
        responseStarted = true;
      }
      process.stdout.write(chunk);
    },
  });
  if (result.mode !== 'live' || !responseStarted) {
    process.stdout.write(`\n${paint(options, result.mode === 'fallback' ? 'yellow' : 'green', '  copilotx ›')} ${result.text}`);
  }
  process.stdout.write('\n');
  speak(options, result.text);
  for (const proposal of result.proposals || []) {
    const suffix = options.allowWrites === 'auto' ? 'applied automatically' : 'review before applying';
    activity(options, `${proposal.relPath} +${proposal.stats.added}/-${proposal.stats.removed} · ${suffix}`, 'yellow');
  }
  state.session = appendTurn(state.session, { input, agent: result.agent, text: result.text, summary: result.summary });
}

function printHelp(options) {
  console.log([
    paint(options, 'bold', 'Commands'),
    `  ${paint(options, 'cyan', '/help')}     Show this help`,
    `  ${paint(options, 'cyan', '/status')}   Show workspace, provider, model, and write mode`,
    `  ${paint(options, 'cyan', '/refresh')}  Refresh local provider health and credit state`,
    `  ${paint(options, 'cyan', '/tools')}    Show available workspace tools`,
    `  ${paint(options, 'cyan', '/clear')}    Clear the visible terminal`,
    `  ${paint(options, 'cyan', '/speak')}    Toggle local speech`,
    `  ${paint(options, 'cyan', '/stop')}     Stop speaking`,
    `  ${paint(options, 'cyan', '/exit')}     Quit CopilotX`,
    '',
    'Ask anything about the current workspace. File changes remain approval-first by default.',
  ].join('\n'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  const root = path.resolve(options.workspace || process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Workspace is not a directory: ${root}`);
  options.workspace = root;
  const state = { workspace: workspaceSnapshot(root), session: createSession('copilotx-cli') };

  if (options.prompt) {
    await ask(options.prompt, state, options);
    return;
  }
  splash(options);
  header(options, root);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: paint(options, 'cyan', '› ') });
  rl.prompt();
  for await (const line of rl) {
    const input = line.trim();
    if (!input) { rl.prompt(); continue; }
    if (input === '/exit' || input === '/quit') break;
    if (input === '/help') printHelp(options);
    else if (input === '/status') header(options, root);
    else if (input === '/refresh') {
      try {
        const result = await refreshLocalProvider(options.baseUrl);
        activity(options, `provider refreshed (${result.status || 'healthy'})`, 'green');
      } catch (err) {
        activity(options, `provider refresh failed: ${err.message}`, 'red');
      }
    }
    else if (input === '/tools') console.log('  read_file  ·  list_dir  ·  search_files  ·  write_file  ·  edit_file  ·  delete_file');
    else if (input === '/clear') { console.clear(); header(options, root); }
    else if (input === '/speak') { options.speak = !options.speak; if (!options.speak) stopSpeaking(); console.log(`Speech: ${options.speak ? 'on' : 'off'}`); }
    else if (input === '/stop') { stopSpeaking(); console.log('Speech stopped.'); }
    else {
      try { await ask(input, state, options); } catch (err) { console.error(`\n${paint(options, 'red', `Error: ${err.message}`)}`); }
    }
    rl.prompt();
  }
  rl.close();
  stopSpeaking();
}

main().catch((err) => {
  console.error(`CopilotX CLI error: ${err.message}`);
  process.exitCode = 1;
});
