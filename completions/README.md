# CopilotX - Multi-Agent Cognitive Runtime

CopilotX is a modular multi-agent runtime that routes user input to one of
four specialized agents (Ask, Explore, Plan, Custom) using a keyword-driven
intent router with optional LLM classification fallback, then produces a
structured response grounded in that agent's persona definition. It ships
in two parallel implementations that share the same config and persona files:

- A PowerShell runtime (`Runtime/`) for Windows/terminal use
- A Node.js core (`src/core/`) for the VS Code extension and automated tests

## Key Features
- Multi-agent architecture (Ask, Explore, Plan, Custom), each with a
  persona file in `Agents/` and a matching config entry in `Config/`
- JSON-driven configuration for routing, tasks, actions, skills, and tools
- Keyword-based intent router with expanded vocabulary and configurable
  fallback chains
- Lightweight file-backed session memory for multi-turn context (Logs/session-*.json)
- @workspace context injector: active file, selection, open tabs, project tree grounded into responses
- Tool execution engine: FILE_CREATE, FILE_PATCH (unified diff), guarded TERMINAL_EXEC
- Inline ghost-text completions (local fast-path patterns + VS Code InlineCompletionItemProvider)
- Optional LLM router (Claude) that activates on missing or ambiguous
  keyword matches when `ANTHROPIC_API_KEY` is present - configurable via
  `Config/router.json` (`llmRouter.mode`: "fallback" | "always" | "off")
- PowerShell runtime for interactive lifecycle and execution control
- Node.js core implementing the identical routing/response logic, used by
  the VS Code extension and covered by an automated test suite
- Optional live-model mode: if `ANTHROPIC_API_KEY` is set, both runtimes
  will call the Claude API using the matched agent's persona as the system
  prompt. Without a key, both runtimes fall back to a deterministic,
  persona-grounded response template - the system is fully functional
  either way.
- VS Code extension that actually invokes the Node core (not a stub)

## Repository Structure
```
CopilotX/
  Agents/              Persona definitions (Ask, Explore, Plan, Custom)
  Config/               JSON config: routing, tasks, actions, skills, tools
  Runtime/              PowerShell runtime, startup, and verification scripts
  Installer/            Windows installer script
  src/core/              Node.js routing and response engine
  src/api/               Minimal programmatic entry point (runCopilotX)
  src/utils/             Shared path/logging helpers
  tests/                 Automated tests for the Node core
  docs/diagrams/         Architecture diagram (text form)
  examples/              Example session transcript
  scripts/               Helper scripts
  benchmarks/            Performance notes
  CopilotX_Extension/    VS Code extension
  Logs/                  Runtime logs (created at run time, not shipped)
  README.md
```

## How It Works
CopilotX uses a phase-based reasoning model:

1. User input is tokenized and matched against keyword intents defined in
   `Config/router.json`.
2. If a clear keyword match is found, that agent is selected immediately
   (fast path).
3. If no keywords match or the match is ambiguous, and the LLM router is
   enabled (`llmRouter.mode = "fallback"` or `"always"`), the Node core
   optionally asks Claude to classify the intent (requires
   `ANTHROPIC_API_KEY`).
4. The selected agent's persona file in `Agents/` is loaded and used to
   ground the response - either passed to the Claude API as a system
   prompt (live mode) or used to construct a deterministic structured
   response locally.
5. Every run is logged to `Logs/`.

The public entry point `runCopilotX(input)` returns
`{ agent, matchedKeywords, mode, text, reason, llmUsed }`.

## Getting Started

### PowerShell runtime (Windows)
```powershell
cd Runtime
./CopilotX_Startup.ps1      # validates the install
./CopilotX_Runtime.ps1      # starts the interactive loop
./CopilotX_Verify.ps1       # re-run any time to check integrity
```
The runtime auto-detects its own root directory from its own script
location, so it works from any path you clone or copy it to - no hardcoded
paths.

### Node core (cross-platform, used by the extension and tests)
```bash
node tests/router.test.js       # run the test suite (12 tests)
node -e "require('./src/api').runCopilotX('explain how routing works').then(console.log)"
```

### VS Code extension
1. Open `CopilotX_Extension/` in VS Code and press F5 to launch the
   extension dev host, or package it with `vsce package`.
2. Run the command "Start CopilotX Runtime" - it invokes the Node core
   directly and shows the routed agent's response.

## Optional: live model mode and LLM router
Set an API key before running either runtime to enable:
- Live Claude-generated agent responses (instead of the deterministic
  template)
- LLM-based intent classification for inputs that the keyword router
  cannot resolve confidently

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # macOS/Linux
setx ANTHROPIC_API_KEY "sk-ant-..."   # Windows (new terminal required after)
```

No key is bundled with this project. Without one, CopilotX still runs
correctly using the keyword router + deterministic engine.

To force LLM classification even on clear keyword hits:
```js
const { runCopilotX } = require('./src/api');
runCopilotX('some input', { forceLlmRouter: true }).then(console.log);
```

Configure behavior in `Config/router.json` under the `llmRouter` key
(`enabled`, `mode`, `model`, `maxTokens`, `systemPrompt`).

## Contributing
Contributions are welcome. Please follow the guidelines in CONTRIBUTING.md.

## License
See LICENSE for details (MIT).
