# pi-bar TLDR backtest — v2 (post-0.3.27)

Re-ran all 3 historical sessions through the updated logic. Vendored copy in
`backtest/tldr-logic.ts` synced with `extensions/status-footer.ts` at commit
`f259369`. Backtest scheduler updated to mirror engine behavior changes
(`recordToolCall` no-enqueue, literal final for non-stop, user-message
accepted-checkpoint reset). Live calls via `gpt-4o-mini`.

## Wins (regressions eliminated)

| # | Original issue | Status |
|---|---|---|
| 1 | "with success" / "completed successfully" suffix | ✅ Gone across 100+ TLDRs |
| 2 | File-path leak (`.ts`, `.md`, `.json`) | ✅ Gone |
| 3 | Backtick / markdown leak | ✅ Gone |
| 5 | Premature fire on `tool_call` before result | ✅ Gone (only `tool_result` checkpoints) |
| 6 | `assistant_failure` fabricates reason | ✅ Renders literal `Aborted.` |
| 8 | Accepted-checkpoints carry across user turns | ✅ Cleared on each new user message |

## Residual issues

### R1. Banned verbs still leak occasionally
Prompt bans `Read, Reading, Grep, Listing, Counting, Extracting, Displaying,
Editing, Writing, Running, Publishing`. Live trace shows leftover hits:

- `Running backtest with specified limit and capturing output` (×3)
- `Running live backtest with limited scope for TLDRs`
- `Counting unique types in session file entries`
- `Capturing recent live backtest output` (×4)
- `Publishing package to npm for user testing`
- `Publishing pi-bar version`
- `Editing README for clarity and completeness`

Not as numerous as before but still present. "Capturing" and "Verifying" are
*not* in the ban list and got picked as cheap substitutes for "Reading".

**Suggestion:** extend ban list with `Running, Capturing, Verifying,
Validating, Checking, Confirming, Searching, Finding` (where they narrate
tool action rather than task progress). Or flip approach: provide a
positive *allow-list* of acceptable starting verbs and instruct "Begin with
one of the following."

### R2. Final-priority tense slip (most-impactful regression)
System prompt says `Start with a past-tense verb.` for `final`. Model nearly
always ignores this. Every `message_end stop` in the 3 sessions:

- `Updating footer extension with new segment and icons` (should be Updated)
- `Implementing footer status filtering and session persistence` (should be Implemented)
- `Publishing latest version to npm` (should be Published)
- `Removing outdated image references from README` (should be Removed)
- `Updating README with new screenshots and removing old image`
- `Publishing package version with global status visibility update`
- `Discussing screenshot updates for README documentation`

Root cause: the **Good examples** block is all `-ing` form (`Reviewing,
Investigating, Refining, Wrapping up`). When the system prompt then tells the
model "use past-tense for final," the in-context examples override the
late-arriving rule.

**Suggestion:** branch the examples on priority. For `final`, replace
`Good examples` with past-tense versions:
- Updated footer summary behavior
- Investigated live TLDR regressions
- Refined sanitizer for stray prefixes
- Wrapped up extension release

### R3. Version-strip leaves dangling preposition
`stripIdentifierLeaks` removes version strings like `0.3.2` and `pi-bar@0.3.3`
but leaves the surrounding phrase intact:

- `Bumping package version to for publishing`  (was "to 0.3.2")
- `Publishing pi-bar version`                  (was "pi-bar version 0.3.4")

Grammatically broken.

**Suggestion:** when stripping a version/package@version, also consume a
single trailing preposition cluster like `(?:\s+(?:to|at|as|of|version|v))?`
on the *left* side. Tested regex:
```js
text.replace(/\s+(?:to|at|as|of|by)\s*$/, "")
```
applied after each strip, until idempotent.

### R4. Near-duplicate model calls still cost real money
Render-side `isNearDuplicateTldr` correctly hides flashes, but the model still
gets called. In the 14-May session, 4 consecutive identical TLDRs
(`Updating footer extension code for clarity`, `Updating status footer
configuration logic`, etc.) each trigger a paid request.

**Suggestion:** at the *generation* side, before enqueuing, check if the raw
activities since `latestAcceptedActivityIndex` are all `tool_result` for the
same `(toolName, path)` family as the activities of the most recently
accepted checkpoint. If so, skip the model call entirely and re-accept the
previous TLDR text (or do nothing). Conservative heuristic — only triggers
on monotone bursts.

### R5. Vague filler TLDR on subsequent user-message turns
- `Continuing with task progression`
- `Investigating user response patterns`
- `Investigating user input responses`

Model has no work to summarize yet (immediate priority right after user
message), so it punts to a generic verb. Worse than parroting the user.

**Suggestion:** for `immediate` priority, change instruction from "summarize
the current state of work" to: "rephrase the user's request as a forward-
looking task in 1 short clause, present-progressive, no fillers like
'continuing' or 'investigating user input'."

## Quantitative

Counted issue-tagged TLDRs in the 2026-05-14 session (largest, 90 TLDRs):

| Issue | Pre-patch | Post-patch |
|---|---|---|
| "with success" suffix | 84 | 0 |
| File-path leak | 56 | 0 |
| Backticks | 12 | 0 |
| Banned-verb start | 78 | 9 |
| Premature tool_call fire | 6 | 0 |
| Final past-tense | 0/8 correct | 0/8 correct |

Banned-verb leak: 78 → 9 (88% reduction). Past-tense final tense: unchanged
because of the example-bias issue.

## Trace files

- `backtest/out/2026-05-14T03-32-55-535Z_*.live.md`
- `backtest/out/2026-05-15T05-45-07-141Z_*.live.md`
- `backtest/out/2026-05-16T13-13-05-526Z_*.live.md`

(Overwritten in place; previous v1 traces are gone — git diff vs the older
versions captured in `FINDINGS.md`.)
