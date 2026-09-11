# Agent Coordination — CopilotX

Two development streams work on this repository concurrently. This file declares
file ownership so both agents can operate without colliding.

## Stream 1 — Opus 5 (Phase patches: streaming robustness, engine error handling)

Actively editing:

- `src/core/llm.js` (streamComplete/complete signatures, SSE parsing, timeouts)
- `src/core/engine.js` (error classification, round-limit handling)
- `tests/streaming.test.js`
- Other existing files under `tests/` as needed

**Request to Stream 1:** keep exports of `src/core/llm.js`
(`complete`, `streamComplete`, `localResponse`) backward-compatible — add
optional parameters, do not rename or remove existing ones. Other modules
depend on the current call shape used inside `engine.js`.

## Stream 2 — Verdent multi-agent pipeline (`feature/multi-agent-pipeline` branch)

Owns:

- `AGENT_COORDINATION.md` (this file)
- `src/core/pipeline.js` (new — supervisor/worker/QC orchestrator with its own turn runner; deliberately does NOT modify or route through `engine.js`)
- `config/personas.json` (additive keys only: `pipeline`, `supervisor`, `worker`, `qc`)
- `config/router.json` (additive keys only)
- `tests/pipeline.test.js` (new)
- `src/extension.js` (small additive hook only)
- `src/chatView.js` (additive rendering only)
- `src/workspaceCollector.js` (additive settings fields only)
- `package.json` (additive `copilotx.pipeline.*` configuration properties only)
- `container/` (headless runtime: `runtime.js`, `settings.js`, `snapshot.js`, `git.js`, `Dockerfile`, `README.md`; branch `feature/container-runtime`)
- `.dockerignore` (root)

**Hands off for Stream 2:** `src/core/llm.js`, `src/core/engine.js`,
`src/core/tools.js`, and all pre-existing files under `tests/`.

## Merge protocol

- Stream 2 works on `feature/multi-agent-pipeline` and pushes the branch; merge to `main` happens after Stream 1's Phase 2 patches land, resolving any conflict in the small hook regions.
- Both streams keep all changes additive wherever possible to minimize conflicts.

## Status log

- 2026-09-11: Stream 1's stress/patch work landed on `main` (`82de787`, 16 patches + stress/replay suite). Stream 2 merged `origin/main` into `feature/multi-agent-pipeline` (`9762a54`) with zero textual conflicts; combined suite 106/106 green. Stream 1's `streamComplete` gained optional `stallTimeoutMs` (backward-compatible — pipeline.js required no changes). Webview replay path (Stream 1) and pipeline status card (Stream 2) coexist in `src/chatView.js`. Streams merged to `main` afterward.
- 2026-09-11: Stream 2 added the headless container runtime (`container/`, branch `feature/container-runtime`): `container/runtime.js` runs the pipeline against any repo checkout; `branch` mode applies proposals to a `pipeline/run-<id>` branch (git is the approval gate), `dry` mode writes patches only. Coordination protocol: the runtime reads this file for stream boundaries, works only on its own run branch, and leaves a `REPORT.md` per run under `container/runs/`.
