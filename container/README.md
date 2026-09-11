# CopilotX Container Runtime

Headless runner for the CopilotX supervisor/worker/QC pipeline
(`src/core/pipeline.js`, which has no VS Code dependencies). Zero npm
dependencies; needs Node 18+ and, for `branch`/`auto` modes, `git`.

```
node container/runtime.js "<goal>" [options]
```

## Modes

| Mode | Behavior |
|---|---|
| `branch` (default) | Proposals are applied to a fresh `pipeline/run-<id>` branch and committed. `main`/the base branch is never touched. Review the branch with `git diff <base>..pipeline/run-<id>` or a PR. |
| `dry` | Writes `container/runs/<id>/patches/*.patch` + `proposals.json`. Changes nothing. |
| `auto` | Applies proposals directly to the working tree. Use with care. |

The run report (`REPORT.md`: plan, per-task status, QC findings, proposal
table) is always written — inside the repo at `container/runs/<id>/` unless
`--report` overrides the path — and is committed on the run branch in
`branch` mode.

## Options

```
--goal-file <path>     Read the goal from a file
--repo <path>          Target repository (default: cwd)
--mode <mode>          branch | dry | auto
--provider <p>         openai | anthropic | nim | local | none
--model <m>            Model for all roles (role overrides via env, below)
--max-workers <1-4>    Concurrent worker tasks (default 2)
--max-qc-rounds <1-3>  QC fix-loop rounds per task (default 2)
--report <path>        Report file path override
--active-file <rel>    Include one file as active-file context
--strict-claims        Drop proposals outside claimed files (default: warn)
--allow-dirty          Permit dirty working tree in branch/auto modes
--push                 Push the run branch to origin after committing
--stream               Forward model deltas to stderr
```

## Configuration (env)

Same conventions as the VS Code extension:

| Variable | Purpose |
|---|---|
| `COPILOTX_PROVIDER` | `openai` (default target) / `anthropic` / `nim` / `local` / `none` |
| `NVIDIA_NIM_API_KEY` | API key when provider is `nim` |
| `ANTHROPIC_AUTH_TOKEN` | Auth token when provider is `local` |
| `COPILOTX_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Generic key fallbacks |
| `COPILOTX_MODEL` | Model id |
| `COPILOTX_BASE_URL` | OpenAI-compatible base URL |
| `COPILOTX_SUPERVISOR_MODEL` / `COPILOTX_WORKER_MODEL` / `COPILOTX_QC_MODEL` | Per-role model overrides |
| `COPILOTX_PIPELINE_MAX_WORKERS` / `COPILOTX_PIPELINE_MAX_QC_ROUNDS` | Concurrency / QC rounds |

## Docker

Build from the **repo root** (the Dockerfile needs the `src/` and `config/`
contexts):

```
docker build -f container/Dockerfile -t copilotx-runtime .
docker run --rm -v /path/to/target-repo:/target \
  -e COPILOTX_PROVIDER=openai -e OPENAI_API_KEY=sk-... \
  copilotx-runtime "Refactor the router" --repo /target
```

## Coordination protocol

The runtime is a third participant in the file-based coordination already
used by the development streams:

- It reads `AGENT_COORDINATION.md` for stream boundaries (humans/agents
  should keep it accurate).
- It never commits outside its own `pipeline/run-<id>` branch (branch mode).
- Every run leaves a `REPORT.md` with the plan, task statuses, QC findings,
  and the claim-guard result, so other agents can review what it did via git.
- Proposals outside the supervisor's claimed files are flagged in the report
  (or dropped with `--strict-claims`).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Run completed (escalated tasks / skipped proposals are noted in the report) |
| 1 | Pipeline ended in `fallback` or `stopped` mode |
| 2 | Usage, environment, or fatal error |
