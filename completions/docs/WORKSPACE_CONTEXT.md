# Workspace Context Injector - Phase 1 (v0.5.0)

Goal: ground CopilotX responses in the user's actual IDE state, the first
major step toward local GitHub Copilot parity inside VS Code.

## What is collected
- Workspace folders
- Active file path, language, content (truncated)
- Current selection (preferred over full file when present)
- Cursor position
- Open editor tabs
- Shallow project tree (depth-limited, skips node_modules/.git/etc.)

## Architecture
- `src/core/workspace.js` - pure Node module; no vscode dependency
- VS Code extension gathers a snapshot and passes it as `options.workspace`
- `runCopilotX` formats a bounded `@workspace context:` block and injects
  it into both live (Claude) and deterministic agent paths
- Same snapshot shape can be supplied from CLI/tests/PowerShell later

## API
```js
await runCopilotX('@workspace explain this function', {
  workspace: {
    workspaceFolders: [{ name: 'app', path: '/proj/app' }],
    activeFile: { path: '...', languageId: 'typescript', content: '...', lineCount: 120 },
    selection: { startLine: 10, endLine: 25, text: '...' },
    openTabs: [{ path: '...', languageId: 'typescript' }],
    cursor: { line: 12, character: 4 },
    projectTree: ['src/', 'src/index.ts', 'package.json'],
  },
  includeWorkspace: true,
});
```

## VS Code commands
- **Start CopilotX Runtime** - prompt + full workspace snapshot
- **CopilotX: Explain Selection / Active File** - one-click with @workspace
- **CopilotX: Clear Session** - reset multi-turn memory

## Limits (token hygiene)
- Active file content capped (default 8k chars)
- Selection capped (default 4k)
- Project tree capped (default 80 entries, depth 3)
- Whole block capped (default 14k chars)

## Next phases (roadmap)
- Phase 2: Real tool execution / file edits / terminal
- Phase 3: Inline ghost-text completions
- Phase 4: Deeper dual-runtime parity for workspace tools
