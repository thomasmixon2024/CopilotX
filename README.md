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

## Installation and first run

### Prerequisites

- Windows, macOS, or Linux
- [VS Code 1.90 or later](https://code.visualstudio.com/)
- [Node.js 18 or later](https://nodejs.org/) (needed for packaging and local checks)
- An API key from one of the supported providers if you want live model responses

### 1. Download the project

Clone the repository, or download it as a ZIP from
[GitHub](https://github.com/thomasmixon2024/CopilotX), then open the project
folder in VS Code:

```powershell
git clone https://github.com/thomasmixon2024/CopilotX.git
cd CopilotX
code .
```

No `npm install` is required to run the extension because it uses VS Code's
built-in APIs and Node.js APIs.

### 2. Get an API key

Choose one provider:

- **Anthropic (recommended):** create an account at
  [console.anthropic.com](https://console.anthropic.com/), open **Settings →
  API Keys**, select **Create Key**, and copy the key once.
- **OpenAI:** create an account at
  [platform.openai.com](https://platform.openai.com/), open **API keys**, select
  **Create new secret key**, and copy the key once.
- **NVIDIA NIM:** create an account at
  [build.nvidia.com](https://build.nvidia.com/), sign in, select a model, and
  choose **Get API Key**.

API providers may require billing or credits. Keep the key private. Do not
commit it to Git, put it in `package.json`, or paste it into a source file.

### 3. Configure CopilotX

In VS Code, open **Settings** (`Ctrl+,` / `Cmd+,`), search for `CopilotX`, and
set the following values:

| Provider | `copilotx.provider` | `copilotx.apiKey` | `copilotx.model` | `copilotx.openaiBaseUrl` |
|---|---|---|---|---|
| Anthropic | `anthropic` | Anthropic key | `claude-sonnet-4-5` | leave the default |
| OpenAI | `openai` | OpenAI key | `gpt-4o` | `https://api.openai.com/v1` |
| NVIDIA NIM | `nim` | NVIDIA key | model selected in NIM | `https://integrate.api.nvidia.com/v1` |

For better key safety, environment variables are supported. Set the variable
before launching VS Code, then leave `copilotx.apiKey` empty:

```powershell
# Anthropic
$env:ANTHROPIC_API_KEY = "your-key-here"

# OpenAI
$env:OPENAI_API_KEY = "your-key-here"

# NVIDIA NIM
$env:NVIDIA_NIM_API_KEY = "your-key-here"
```

Restart VS Code after changing an environment variable. Never share the key
in screenshots, chat messages, or source control.

### 4. Start the extension

1. Open the CopilotX project folder in VS Code.
2. Press **F5** (or select **Run → Start Debugging**).
3. A new **Extension Development Host** window opens.
4. Select the **CopilotX** icon in the activity bar.

### 5. Run your first command

In the CopilotX sidebar, type:

```text
Read package.json and explain how this extension is configured.
```

Press **Enter** or click **Send**. With a live provider configured, CopilotX
can call its workspace-safe `read_file` tool and then explain the result. Try
these next:

```text
Explain the active file.
@workspace summarize the project structure.
Plan how to add a file-search tool.
```

You can also use the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run
**CopilotX: Explain Selection** or **CopilotX: Fix / Improve Selection**.

If no API key is configured, CopilotX still starts and uses its offline local
response so you can verify the extension and routing.

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
