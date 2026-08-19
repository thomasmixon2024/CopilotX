# Smart Router (v0.2.0)

## What changed

The original keyword-only router has been upgraded with an optional LLM
classification path while remaining fully backward-compatible.

### Keyword path (still the default fast path)
- Expanded intent vocabularies in `Config/router.json` (added common
  question words, synonyms, etc.).
- Better handling of multi-agent keyword hits (score by match count,
  fall back to `rules.ambiguousIntent` on ties).
- Returns richer metadata: `candidates`, clearer `reason` values.

### LLM path (new, optional)
- Config section `llmRouter` in `Config/router.json`:
  - `enabled` (default true)
  - `mode`: `"fallback"` (default) | `"always"` | `"off"`
  - `model`, `maxTokens`, `systemPrompt`
- When mode is `"fallback"`, Claude is consulted only when keywords miss
  or produce an ambiguity.
- When mode is `"always"`, every input is classified by the LLM (keyword
  result is still computed for logging).
- Requires `ANTHROPIC_API_KEY`. If the key is absent or the call fails,
  the system silently uses the keyword result. No hard dependency.
- The public API `runCopilotX(input, { forceLlmRouter: true })` can force
  the LLM path for testing or special cases.

### Return shape (additive)
```js
{
  agent,            // "ask" | "explore" | "plan" | "custom"
  matchedKeywords,  // string[]
  mode,             // "live" | "deterministic"
  text,             // response body
  reason,           // "keyword-match" | "keyword-ambiguous" |
                    // "fallback-missing-intent" | "llm-classification"
  llmUsed           // boolean
}
```

### Tests
`tests/router.test.js` now contains 12 cases covering both the sync
keyword path and the async graceful-degradation path (no API key required
to pass the suite).

### PowerShell note
The PowerShell runtime continues to use pure keyword routing. The LLM
router is currently Node-only (VS Code extension + programmatic API).
Parity can be added later if desired.

## PowerShell parity (v0.2.0 continued)

`Runtime/CopilotX_Runtime.ps1` now implements the same smart-router
behavior as the Node core:

- Keyword scoring with ambiguity handling (`keyword-ambiguous`)
- Optional LLM classification via `Invoke-LlmClassify` when
  `llmRouter.mode` is `"fallback"` or `"always"` (or when forced)
- Graceful degradation if `ANTHROPIC_API_KEY` is absent
- Logs include `(via LLM)` when classification was used
- `CopilotX_Verify.ps1` checks for a valid `llmRouter` section

The two runtimes are now structurally aligned on routing.

## Richer deterministic responses (v0.3.0)

Both Node (`src/core/agents.js`) and PowerShell (`Build-DeterministicResponse`)
now produce structured offline responses that:

- Pull Purpose and Core Behaviors from the agent persona markdown
- List registered actions with descriptions from Config/actions.json
- Follow each agent's Interaction Model (interpret / expand / sequence / apply)
- Stay fully offline and zero-dependency
- Clearly label Mode: deterministic and point users at ANTHROPIC_API_KEY for live mode

Test suite expanded to 16 cases covering all four agent deterministic bodies.
