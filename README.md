# CopilotX Chat for VS Code

A Copilot-style coding chatbot that runs **inside VS Code**, inspired by
[thomasmixon2024/CopilotX](https://github.com/thomasmixon2024/CopilotX).

The reference repo already has a Node multi-agent core (Ask / Explore / Plan / Custom)
plus a thin extension that uses an input box and an output channel. This project
turns that idea into a real sidebar chat + official Chat participant.

## What you get

- Activity-bar **CopilotX** icon and persistent **Chat** sidebar
- Intent router: keyword match → Ask, Explore, Plan, or Custom
- `@workspace` context: active file, selection, cursor, open tabs, project tree
- Multi-turn session memory in the sidebar
- Optional live models: Anthropic or any OpenAI-compatible API
- Live tool-calling loop with a workspace-safe, read-only `read_file` tool
- Optional local text-to-speech for every sidebar assistant response
- Works offline with a local deterministic engine if no key is set
- Commands: Explain Selection, Fix / Improve Selection
- Also registers `@copilotx` in the VS Code Chat view (1.90+)

## Run it (Extension Development Host)

1. Open this folder (`copilotx-vscode`) in VS Code.
2. Press **F5**. A new “Extension Development Host” window opens.
3. Click the CopilotX icon in the activity bar (left).
4. Ask a question about the file you have open.

Shortcut: `Ctrl+Shift+I` / `Cmd+Shift+I`.

## Hear responses aloud

Each assistant response in the CopilotX sidebar has a **Hear aloud** button.
It uses the VS Code webview's built-in browser speech synthesis support, so the
response stays local and no speech service or additional API key is required.
Click **Stop** to interrupt playback. The control is available when the host
environment exposes `speechSynthesis`; otherwise the sidebar reports that
text-to-speech is unavailable.

## Live model (optional)

Settings (`Ctrl+,` → CopilotX):

| Setting | Example |
|---|---|
| `copilotx.provider` | `anthropic`, `openai`, or `nim` |
| `copilotx.apiKey` | your key |
| `copilotx.model` | `claude-sonnet-4-5` or `gpt-4o` |
| `copilotx.openaiBaseUrl` | `https://api.openai.com/v1` (or a proxy) |

For NVIDIA NIM, set `copilotx.provider` to `nim`, use an NVIDIA API key, set
`copilotx.openaiBaseUrl` to `https://integrate.api.nvidia.com/v1` (or your
local NIM URL), and choose the model deployed by NIM, such as
`meta/llama-3.1-8b-instruct`. NIM uses the OpenAI-compatible chat API.

You can also export `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in the environment
that launches VS Code.

For NIM, set `NVIDIA_NIM_API_KEY` in the environment before launching the
Extension Development Host. The included launch profile reads that variable
without storing the key in the workspace.

Without a key the router still works; replies are a structured local template.

## Package as a `.vsix`

```bash
npm install -g @vscode/vsce
cd copilotx-vscode
vsce package --allow-missing-repository
```

Then in VS Code: **Extensions → … → Install from VSIX**.

## How routing works

User text is tokenized and scored against `config/router.json` intents.

- Clear keyword hit → that agent
- Tie / ambiguous → Explore
- No keywords → Ask (default)

Each agent’s system prompt lives in `config/personas.json`. Edit those files to
change personality without touching the extension host.

## Tool architecture

When a live provider returns a tool request, the engine executes the requested
tool and sends its result back to the provider until a final text response is
available. Anthropic tool calls use the native `tool_use` / `tool_result`
message format; OpenAI-compatible providers use function tools and tool
messages.

The initial tool is `read_file`. It is read-only, accepts workspace-relative
or in-workspace absolute paths, and rejects paths that resolve outside an open
workspace (including symlink escapes). New Claude Code-style capabilities can
be added in `src/core/tools.js` without changing the provider adapters.

## Layout

```
copilotx-vscode/
  package.json          # contribution points, chat participant, view
  config/               # router + personas
  src/extension.js      # activate, commands, Chat API
  src/chatView.js       # sidebar webview
  src/workspaceCollector.js
  src/core/             # router, session, workspace, llm, engine
  media/icon.svg
```

## Difference from the GitHub reference

| Reference CopilotX | This extension |
|---|---|
| Input box + Output Channel | Sidebar chat thread |
| Incomplete shipped tree (missing Agents/, logger, paths) | Self-contained, runs from F5 |
| Claude-only live path | Anthropic **or** OpenAI-compatible |
| PowerShell + Node dual runtime | VS Code first |
