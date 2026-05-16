# pi-bar TLDR backtest findings

Source: 3 historical pi sessions from `~/.pi/agent/sessions/--Users-tianrendong-pi-pi-bar--/`
replayed through vendored copies of `extensions/status-footer.ts` fact-collection +
prompt-construction code. Live TLDRs generated via OpenAI `gpt-4o-mini` (close
substitute for the production fast model `openai-codex/gpt-5.4-mini`).

Harness: `backtest/run.ts` + `backtest/tldr-logic.ts`. Per-session traces in
`backtest/out/*.live.md`.

## Issues (highest signal first)

### 1. "with success" / "completed successfully" suffix epidemic
Vast majority of normal-priority TLDRs end with a content-free success marker.
Wastes the 60-char budget; reads mechanically.

Samples (real outputs):
- `Editing extensions/status-footer.ts with success.`
- `Reading status-footer file completed successfully.`
- `Publishing package version with success.`
- `Grep for "complete" in stream.d.ts completed successfully.`
- `Editing status footer configuration with success.` (×4 in a row)

Root cause: system prompt says *"Include outcome only if important"* but the
model defaults to a success tag on every action.

**Fix candidates:**
- Add explicit ban list in system prompt: do not emit `with success`,
  `successfully`, `completed`, `completed successfully`, `in progress`,
  `with success.`, `success.` as trailing tokens.
- Post-process sanitizer: strip trailing `(with success|successfully|completed( successfully)?|in progress)\.?$` (idempotent loop).

### 2. File-path leak
System prompt forbids file paths but TLDRs constantly include them.

Samples:
- `extensions/status-footer.ts`, `README.md`, `package.json`,
  `status-footer.ts`, `index.d.ts`, `tools.ts`, `models.d.ts`,
  `auth.json`, `tldr-core.ts`, `stream.d.ts`.

**Fix candidates:**
- Strengthen prompt: enumerate disallowed extensions (`.ts`, `.tsx`, `.js`,
  `.md`, `.json`, `.yml`, `.toml`).
- Post-process sanitizer: regex-strip tokens matching `[\w./-]+\.(ts|tsx|js|jsx|md|json|yml|yaml|toml|lock|sh)\b`.
  Replace with a generic noun (`a file`/`config`/`code`) or drop the clause.

### 3. Backtick / markdown code-formatting leak
Prompt forbids markdown; sanitizer doesn't strip backticks.

Samples:
- ``Published `pi-bar@0.3.3` with installation instructions.``
- ``Editing `extensions/status-footer.ts` with success.`` (×N)
- ``Implemented `/bar` commands and updated relevant files with success.``
- ``Refactoring helpers and `TldrFactCollector` into `tldr-core.ts` in progress.``

**Fix candidates:**
- Sanitizer: `text.replace(/`+/g, "")` after `stripTerminalControls`.
- Could also strip `*`, `_`, `~` emphasis markers if model emits them.

### 4. Tool-name / command verb leak
System prompt forbids tool names but the model picks command-style verbs.

Samples:
- `Grep for "complete" in stream.d.ts completed successfully.`
- `Counting lines and checking for "tldr" in footer file.`
- `Extracting prompt references from status-footer file.`
- `Displaying first 40 lines of auth.json content.`
- `Listing pi-ai directories completed successfully.`

The verbs *Grep / Listing / Counting / Extracting / Reading / Displaying /
Fetching* always narrate the **tool** rather than the **task**.

**Fix candidates:**
- Explicit prompt ban: do not start with `Grep`, `Listing`, `Displaying`,
  `Counting`, `Extracting`, `Reading`, `Writing`, `Editing` when the work is
  *about* code/state. Prefer task verbs: `Investigating`, `Updating`,
  `Refactoring`, `Bumping`, `Configuring`, `Fixing`, `Publishing`.
- Few-shot examples in the system prompt would help here. Right now the
  prompt is all rules / no positive exemplars.

### 5. Premature fire on `tool_call` (without `tool_result`)
The engine records `tool_call` activity as normal priority, so debounce can
flush before the result arrives. The model then hallucinates an outcome.

Samples (real, fired from tool_call before result):
- `Running live backtest with new session file in progress.`
- `Running live backtest with session file completed successfully.` ← hallucinated
- `Checking for tsx installation and node version in progress.`

**Fix candidate:**
- In `recordToolCall`, still record the activity for future-prompt context but
  mark its `displayPriority` so it does NOT enqueue a job. Only `tool_result`
  triggers a normal checkpoint. Simpler: drop the `enqueue` call entirely for
  tool_call.
  ```ts
  recordToolCall(ctx, event): void {
    this.facts.recordToolCall(event); // record fact only, don't enqueue
  }
  ```

### 6. `assistant_failure` final-priority fabricates a reason
For `message_end` with `stopReason: "aborted"`, the only activity is
`final: aborted`. The model invents content.

Sample:
- `Aborted operation due to final status.` ← invented "final status" reason

**Fix candidates:**
- Skip the final checkpoint when there is no error message (just clear the
  TLDR or show literal `aborted`).
- Or: bypass the LLM and render a fixed string (`Aborted.`, `Errored.`) for
  these terminal-but-empty cases.

### 7. Burst of near-identical TLDRs flashes across footer
Sessions where the user does N similar edits in a row produce N near-identical
TLDRs. Engine drops *exactly-equal* re-renders but not the slight variations.

Sample (single session, consecutive):
1. `Editing extensions/status-footer.ts with success.`
2. `Editing extensions/status-footer.ts with success.`
3. `Editing extensions/status-footer.ts with success.`
4. `Editing extensions/status-footer.ts with success.`

Plus extra model-call cost (each call is real money).

**Fix candidates:**
- Bump `NORMAL_CHECKPOINT_QUIET_MS` from 700 → ~1500ms so adjacent fast
  results coalesce into one richer TLDR.
- After accepting a checkpoint, skip the next normal job if the new raw
  activities are only tool_results matching the same tool/path as the most
  recent accepted checkpoint's source activities (heuristic; risky).
- Cheap: sanitize the TLDR text to its action-only fragment (`Editing X`) and
  skip re-display when the action fragment equals the previous one.

### 8. Code identifier leak (CamelCase / slash-prefixed)
System prompt says no code. Class/symbol names still appear:
- `Refactoring helpers and TldrFactCollector into tldr-core.ts in progress.`
- `Implemented /bar commands and updated relevant files with success.`
- `Implemented interactive /bar with status visibility picker.`

**Fix candidate:** prompt mentions "no markdown, JSON, code, file paths, or
tool names" — add "no class names, slash commands, CamelCase identifiers."
Hard to enforce; sanitizer could strip but risks clipping legit content.

### 9. First-turn TLDR parrots user request
Immediate-priority checkpoint produces:
- `Backtesting current pi-bar TLDR logic on past transcripts.` (no work yet)
- `Publishing package to npm with success.` ← invents "with success" on a
  request that hasn't started.

Slightly awkward UX: looks like work is done before any tool runs.

**Fix candidate:** for `immediate` (user-message-only) checkpoint, instruct
the model to use a *present-progressive* but explicitly *not* claim
completion or progress. Or: render a placeholder like `Working…` until the
first tool_result lands.

### 10. Accepted-checkpoints carry across user-message boundaries
Within a session the engine keeps `acceptedCheckpoints` across user turns.
Prior turn's TLDRs end up in the "Prior TLDRs (context only, do not copy
phrasing)" block for the new turn. They risk biasing the new TLDR toward
unrelated phrasing.

**Fix candidate:** clear `acceptedCheckpoints` (and reset
`latestAcceptedActivityIndex`) inside `recordUserMessage`. The existing
`lastRenderedText` clear already does this for *display*; do the same for
prompt context.

## Improvement areas — summarized fixes

| # | Area | Code path | Difficulty |
|---|------|-----------|-----------|
| 1 | Strip trailing "with success"/"completed successfully" | `sanitizeTldrText` | trivial |
| 2 | Strip file paths/extensions | `sanitizeTldrText` | small |
| 3 | Strip backticks/asterisks | `sanitizeTldrText` | trivial |
| 4 | Stronger system prompt: ban list + 3 few-shot exemplars | `checkpointSystemPrompt` | small |
| 5 | Don't enqueue on `tool_call` (only on `tool_result`) | `FooterTldrEngine.recordToolCall` | trivial |
| 6 | Bypass LLM for empty-detail `assistant_failure` | `FooterTldrEngine.recordMessageEnd` | small |
| 7 | Bump `NORMAL_CHECKPOINT_QUIET_MS` to 1500ms | constants | trivial |
| 8 | Reset `acceptedCheckpoints` on new user message | `FooterTldrEngine.recordUserMessage` | trivial |
| 9 | Immediate-priority prompt variant: forbid claim of progress/completion | `checkpointSystemPrompt` | small |

## Backtest harness notes (not pi-bar regressions)

- The harness has its own simulated scheduler — does not call the real
  engine's `complete()` path. Two bugs were caught + fixed during testing:
  (a) `message_end` with non-`stop` stopReason now correctly maps to `final`
  priority; (b) facts/checkpoints are no longer reset on user-message
  boundaries (matches engine behavior).
- Live mode uses `gpt-4o-mini` not the prod `openai-codex/gpt-5.4-mini`.
  Issues 1–4, 7 reproduce on both models in spot checks; this is a prompt /
  sanitizer problem, not a model-choice problem.
- Per-session traces with full prompts: `backtest/out/*.live.md`.
