# Seamless Context Continuity — Design

**Date:** 2026-06-21
**Status:** Approved (pending spec review)

## Problem

After a long conversation the bot "forgets" everything mid-thread: the agent
proposes an action, then two turns later asks *"это в продолжение какого
разговора?"* (what conversation is this continuing?). Observed live on the
"AI Assistant" agent (2026-06-21 screenshots).

**Root cause (confirmed):** the custom **auto-session-rotation** feature
(`2026-06-16-auto-session-rotation`). After each chat turn `worker.maybeAutoRotate`
reads context-window usage; at `rotateAtContextFraction` (default **0.70**) it
silently enqueues a `rotate` task that writes durable facts to `memory/`
(`ROTATE_PROMPT`) and then calls `store.rotateSession(userId)` →
`DELETE FROM sessions WHERE user_id = ?`. The next user message finds no session,
resumes nothing, and starts a **brand-new Claude conversation with zero history**.
The only bridge is the `memory/` write, which captures *durable facts* — not the
*live working thread* ("we are mid-way through booking studio tickets on the
24th"). So continuity is lost and the loss is silent.

## Goal

**Seamless continuity** (chosen priority): the user should never notice the
context filling up. The thread keeps flowing; older detail is summarized but the
agent stays coherent on the **same** session. Long-term cross-session memory is a
non-goal for this change (the agent can still write `memory/` normally; we only
remove the *destructive, rotation-triggered* path).

## Key finding — the SDK already does this, better

`@anthropic-ai/claude-agent-sdk@0.3.173` (already in use) has **native
auto-compaction**:

- Setting `autoCompactEnabled` (a `.claude/settings.json` field; also
  `autoCompactThreshold`, `autoCompactWindow`).
- When it fires, the SDK emits a `system` message
  `subtype: 'compact_boundary'` with
  `compact_metadata { trigger: 'manual' | 'auto', pre_tokens, post_tokens, … }`
  and **continues on the same session** — it summarizes/relinks older messages
  (`preserved_segment` / `preserved_messages`) and resume after a boundary loads
  the compacted form (`load_reason: 'compact'`).
- Runtime context info reports `isAutoCompactEnabled` and `autoCompactThreshold`.

Compaction is **not** a `query()` argument — it is read from settings via
`settingSources`. The runtime loads `settingSources: ['project','local']`
(`claude.ts`), i.e. `<agentHome>/.claude/settings.json` + `settings.local.json`;
it does **not** load `'user'` (global) settings, so the agent home's project
settings are the control point.

Critically, the custom rotation fires at 70% — **before** the SDK would ever
compact — so today the runtime actively pre-empts the better built-in mechanism
with a lossy one.

## Decisions (confirmed)

- **Approach A, gated by a spike (= Approach C):** rely on native SDK
  auto-compaction; first prove it runs in headless `query()`. If the spike fails,
  fall back to Approach B (summary handoff) — documented, not built now.
- **Disable the custom auto-rotation by default** (`rotateAtContextFraction: 0`),
  keep the config knob and keep manual `/new` (memory write + reset) unchanged.
- **Keep observability:** log `compact_boundary` events (no Telegram message —
  continuity stays seamless for the user).
- **Scope:** change the default for all agents; the knob remains an opt-in override
  for anyone who still wants the teardown behavior.

## Approaches considered

- **A — Native SDK auto-compaction (recommended).** Smallest change (mostly
  *removing* behavior); uses the maintained mechanism Claude Code itself uses;
  eliminates amnesia by construction. Risk: confirm headless `query()` compacts.
- **B — Continuity-preserving custom rotation.** Carry a conversation summary into
  a forked/fresh session (`forkSession`). Full control, works even if headless
  compaction doesn't; but reinvents the SDK with more code and a quality
  downgrade vs. in-place compaction. **Fallback only.**
- **C — Hybrid.** A as primary, B as fallback if the spike fails. This is the
  shape we adopt.

## Components

### 0. Spike (gating, throwaway) — `src/claude.ts`
- Temporarily surface every `system` message in `mapSdkMessage` (it currently
  returns `null` for all non-`init` system messages — which is why
  `compact_boundary` has never been seen).
- Run one long live session past the threshold; confirm a
  `system/compact_boundary` with `trigger:'auto'` appears and the session
  continues coherently; note `isAutoCompactEnabled` / `autoCompactThreshold` from
  the runtime context info.
- **Go** → proceed with A. **No-go** → switch to Approach B (separate spec).

### 1. `src/config.ts` — default flip
- `AGENT_DEFAULTS.rotateAtContextFraction: 0.70` → **`0`** (disabled).
- Keep validation/range `[0,1]`; `0` already documented as "disables". The knob
  stays so an operator can re-enable per agent via `config.json`.

### 2. `src/agent-home.ts` — ensure compaction is on
- Extend `ensureProjectMcpSettings` (rename intent to "ensure project settings"):
  in addition to `enableAllProjectMcpServers: true`, ensure
  `autoCompactEnabled: true` in `<agentHome>/.claude/settings.json`. Idempotent;
  never clobber a file it can't parse (existing guard). Only writes when a value
  is missing/different.
- `autoCompactThreshold` left at the SDK default unless the spike shows a reason
  to set it.

### 3. `src/claude.ts` — keep visibility (permanent)
- In `mapSdkMessage`, recognize `system/compact_boundary` and emit a log line
  (trigger, `pre_tokens` → `post_tokens`). No new user-facing event. (Replaces the
  rotation log we lose.)

### 4. Dead-path cleanup (after spike passes)
- Remove the **auto** rotation path: `maybeAutoRotate`, `shouldAutoRotate`, the
  `rotateAtContextFraction` worker dep + its wiring in `index.ts`, and
  `contextFractionFromUsage` (+ its `final`-event `contextFraction` plumbing) **iff**
  nothing else uses them. Keep `kind:'rotate'`, `ROTATE_PROMPT`, `rotateSession`,
  and the `silent` column (manual `/new` still uses them).
- Update tests: drop the auto-rotation worker tests; keep the manual-rotate and
  `/new` tests.
- Decision recorded: keep the config field name `rotateAtContextFraction`
  (back-compat for existing `config.json`); default `0` makes it inert.

## Data flow (target)

```
chat task → runOnce resumes the per-user session (unchanged)
  → context fills → SDK emits system/compact_boundary {trigger:auto, pre,post}
     → SDK summarizes in place, SAME session continues (no DELETE)
  → claude.ts logs the boundary; reply delivered as normal
  → next user message resumes the SAME (now compacted) session → full continuity
```

The `sessions.claude_session_id` is updated each turn from the SDK `init` event as
today; it is **never deleted mid-thread**. Manual `/new` is the only reset.

## Error handling / safety

- **Spike is the go/no-go gate** — we do not delete the auto-rotation code until a
  live `compact_boundary trigger:auto` is observed.
- If compaction fails server-side, the SDK reports `compact_result:'failed'` /
  `compact_error`; we log it. Worst case the turn proceeds without compaction and
  may hit the context limit — surfaced as the existing session-error path
  (`retryFresh`), which already warns the user that context was lost. That path is
  unchanged and remains the backstop.
- Default-`0` is back-compatible: existing `config.json` files that omit the field
  get auto-compaction; files that set it keep their explicit value.
- `ensureProjectMcpSettings` keeps its parse-guard: a hand-edited unparsable
  settings file is left untouched.

## Testing

- **Unit (vitest):**
  - `config`: `rotateAtContextFraction` default is now `0`; still validates `[0,1]`
    and accepts explicit overrides.
  - `agent-home`: `ensureProjectMcpSettings` adds `autoCompactEnabled: true`
    idempotently; preserves existing keys; no-ops when already set; leaves
    unparsable files untouched.
  - `claude.ts` `mapSdkMessage`: a `compact_boundary` system message maps to a
    log/ignored event (does not break the stream, does not become a `final`).
  - Remove/replace the auto-rotation worker tests (`shouldAutoRotate`,
    "enqueues a silent rotate over threshold"); keep manual-rotate + `/new` tests.
- **Manual (live) — also the spike:** long session past the old 70% mark; confirm
  (1) a `compact_boundary trigger:auto` log, (2) the `sessions` row's
  `claude_session_id` is **not** deleted mid-thread, (3) the agent still references
  earlier turns after the boundary.

## Out of scope

- Long-term cross-session memory improvements (ranked below continuity).
- Notifying the user when compaction happens (kept seamless/silent).
- Tuning `autoCompactThreshold`/`autoCompactWindow` beyond SDK defaults (only if
  the spike indicates a need).
- Building Approach B now — only documented as the fallback.

## Deploy

Touches `src/` → `npm run build`. Redeploy per the two hosts
(see `agent-runtime-deployment` memory):
- **ibrokhim's Mac:** `scripts/build-dmg.sh` → reinstall `AgentRuntime.app` +
  restart. (Note: the currently installed `.app` predates auto-rotation entirely,
  so it is unaffected today; it will pick up compaction on reinstall.)
- **Agents-Mac-mini** (runs the agent in the screenshots): its `npm install`
  install path runs current `dist/` — update it so the fix reaches the affected
  agent.

`autoCompactEnabled` is ensured in each agent home's `.claude/settings.json` on
startup by `ensureProjectMcpSettings`, so no manual per-agent settings edit is
needed.
