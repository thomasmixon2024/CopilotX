# Session Memory (v0.4.0)

CopilotX keeps a lightweight, file-backed multi-turn memory under Logs/.

## Behavior
- Default session id: "default" (VS Code uses "vscode")
- Stores the last N turns (default 6): input, agent, mode, short summary
- Prior context is injected into both live (Claude) and deterministic responses
- Fully offline; no external store

## API
```js
const { runCopilotX } = require('./src/api');

// multi-turn
await runCopilotX('explain routing', { sessionId: 'demo' });
await runCopilotX('expand on that', { sessionId: 'demo' });

// start fresh
await runCopilotX('new topic', { sessionId: 'demo', clearSession: true });

// disable memory for a one-shot
await runCopilotX('stateless ask', { useSession: false });
```

## Files
- Logs/session-<id>.json

## PowerShell
Session memory is currently Node-primary (API + VS Code extension).
PowerShell remains single-shot per invocation; parity can be added later
by reading/writing the same session-*.json files.
