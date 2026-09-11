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
- Workspace tools: `read_file`, `list_dir`, and content `search_files`
- **File editing with approval**: the model proposes `write_file` / `edit_file`
  changes; you review a diff and Accept or Discard (`copilotx.allowWrites`)
- **Streaming responses**: token-by-token output with a Stop button
- Optional Copilot-style **ghost-text inline completions** while you type
- Optional local text-to-speech for every sidebar assistant response
- Works offline with a local deterministic engine if no key is set
- Commands: Explain Selection, Fix / Improve Selection, Store API Key, Stop
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

The safest option is the **CopilotX: Store API Key** command from the Command
Palette: it stores the key in VS Code's SecretStorage (OS keychain), which
never touches `settings.json` or Git. Keys stored this way take precedence
over `copilotx.apiKey`; environment variables take precedence over both.

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

Every assistant response in the CopilotX sidebar has a **Hear aloud** button,
and the chat footer has a persistent **speaker symbol** that reads the most
recent response aloud — click it again (it turns into a stop square) to stop
playback. Both use the VS Code webview's built-in browser speech synthesis, so
the response stays local and no speech service or additional API key is
required. The controls are available when the host environment exposes
`speechSynthesis`; otherwise the sidebar reports that text-to-speech is
unavailable.

## Live model (optional)

Settings (`Ctrl+,` → CopilotX):

| Setting | Example |
|---|---|
| `copilotx.provider` | `none` (offline), `local`, `anthropic`, `openai`, or `nim` |
| `copilotx.apiKey` | your key (prefer the **CopilotX: Store API Key** command) |
| `copilotx.model` | `claude-sonnet-4-5` or `gpt-4o` |
| `copilotx.openaiBaseUrl` | `https://api.openai.com/v1` (or a proxy) |

`local` points CopilotX at an OpenAI-compatible server on your machine
(default `http://127.0.0.1:8082/v1`). When no model is specified, CopilotX
probes the server's `/models` endpoint and picks an available instruct/chat
model; an explicit `copilotx.model` is always sent unchanged. No API key is
required for `local` unless your server enforces one.

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
`none` (the default) is fully offline — it never touches the network and always
uses the deterministic engine. Choose `local` explicitly if you want a
model on `http://127.0.0.1:8082/v1`.

## Package as a `.vsix`

```bash
npm install -g @vscode/vsce
npm test
vsce package
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

Read tools — `read_file`, `list_dir`, `search_files` — execute immediately.
They accept workspace-relative or in-workspace absolute paths and reject paths
that resolve outside an open workspace (including symlink escapes). Search and
listing results are capped so a large repository cannot blow up the context.

## Editing your code

With `copilotx.allowWrites` set to `approval` (the default), the model can
propose changes with two tools:

- `write_file` — full content for a new or existing file
- `edit_file` — replace one exact, unique snippet inside a file

Proposed changes **never touch disk automatically**. Each proposal appears in
the sidebar as a card with `+added` / `-removed` counts and three actions:

| Action | What happens |
|---|---|
| **Review** | Opens a VS Code diff editor: original ⇄ proposed |
| **Accept** | Applies the change (only if the file is unchanged since the proposal) and opens the file |
| **Discard** | Drops the proposal |

Setting `copilotx.allowWrites` to `auto` applies changes immediately (the diff
still opens for reference); `off` removes the write tools from the model's tool
list entirely, so it cannot even request them.

## Streaming and inline completions

`copilotx.streamResponses` (default on) streams live-provider responses
token-by-token into the sidebar. A **Stop** button (and the
**CopilotX: Stop Generation** command) aborts mid-response; the partial text is
kept. Both Anthropic and OpenAI-compatible Server-Sent-Events streams are
supported, including streamed tool calls.

`copilotx.inlineCompletions` (default off) enables Copilot-style ghost text in
the editor. It requires a live provider and a valid key; suggestions are
requested after a short debounce, aborted when superseded, and deduplicated
against the text before your cursor.

## Layout

```
  package.json          # contribution points, chat participant, view, test script
  config/               # router + personas
  src/extension.js      # activate, commands, Chat API, inline completions
  src/chatView.js       # sidebar webview (streaming bubble, proposal cards)
  src/proposalReview.js # diff preview + apply/discard for write proposals
  src/inlineCompletion.js
  src/workspaceCollector.js
  src/core/             # router, session, workspace, llm (+SSE streaming), engine, tools, proposals
  tests/                # zero-dependency node:test suite (npm test)
  media/icon.svg
```
