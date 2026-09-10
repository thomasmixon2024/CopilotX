# Tool Execution - Phase 2 (v0.6.0)

Autonomous tool runner for workspace file edits and guarded terminal commands.

## Payload types

```js
{ type: 'FILE_CREATE', path: 'src/new.js', content: '...', overwrite?: false }
{ type: 'FILE_PATCH',  path: 'src/old.js', diff: '<unified diff>' }
{ type: 'TERMINAL_EXEC', command: 'echo hello' }  // requires allowTerminal
```

## Safety
- Paths must resolve inside workspace root (traversal blocked)
- Terminal OFF by default; allowlist required when enabled
- VS Code shows modal approval before any disk or shell action

## API
```js
const { applyWorkspaceTools } = require('./src/api');
const results = applyWorkspaceTools('/path/to/workspace', [
  { type: 'FILE_CREATE', path: 'notes.txt', content: 'hi\n' },
], { allowTerminal: false });
```

## PowerShell
```powershell
Invoke-CopilotXTool -WorkspaceRoot $Root -Payload @{
  type = 'FILE_CREATE'; path = 'notes.txt'; content = "hi`n"
}
# FILE_PATCH in PS uses replaceOld/replaceNew; full unified diffs via Node tools.js
```

## VS Code
Command: **CopilotX: Apply Tool (with approval)** — paste JSON payload, confirm modals.
