# Seamless Context Continuity via Native Auto-Compaction — Design

**Date:** 2026-06-21
**Status:** Implemented (verification pending live deploy)

## Problem

After a long conversation the bot "forgets" everything mid-thread: the agent
proposes an action, then two turns later asks *"это в продолжение какого
разговора?"* (what conversation is this continuing?). Observed live on the
"AI Assistant" agent (2026-06-21 screenshots).

**Root cause (confirmed):** the custom auto-session-rotation feature
(`2026-06-16-auto-session-rotation`). After each chat turn `worker.maybeAutoRotate`
reads context-window usage; at `rotateAtContextFraction` (default **0.70**) it
silently enqueues a `rotate` task that writes durable facts to `memory/` and then
calls `store.rotateSession(userId)` → `DELETE FROM sessions WHERE user_id = ?`.
The next user message finds no session, resumes nothing, and starts a **brand-new
Claude conversation with zero history**. The `memory/` write captures *durable
facts*, not the *live working thread*, so continuity is lost — silently.

## Decision

**Disable the custom rotation; rely on the SDK's native auto-compaction.**
`@anthropic-ai/claude-agent-sdk@0.3.173` compacts the conversation **in place**
when context fills (it summarizes older turns and continues on the **same**
session), emitting a `system/compact_boundary` event. Native compaction triggers
near the real limit, whereas the custom rotation fired at 70% and *pre-empted* it
by tearing the session down — so today the runtime was replacing the better
built-in mechanism with a lossy one.

This is the smallest change that removes the amnesia: stop dropping the session,
let the SDK keep it coherent.

### Approaches considered

- **Native auto-compaction (chosen).** In-place, seamless, maintained by the SDK;
  near-zero code (disable rotation + ensure the setting + add observability).
- **Conversation-history tool + fresh-session nudge.** A DB-backed
  `conversation_history` tool (auto-scoped to the chat) giving the agent verbatim
  on-demand recall, plus a nudge after a reset. More robust (no SDK dependency,
  verbatim recall) but more code. **Kept as the documented fallback** if native
  compaction proves not to fire in headless `query()`.
- **Summary-handoff rotation (`forkSession`).** Rejected — reinvents compaction
  with more code and a lossier result.

## Known risk / why observability is part of the change

The one thing not provable from the SDK types is that auto-compaction actually
runs in the **headless `query()`** path (it's certainly there interactively). We
did **not** run a dedicated spike. Mitigation: surface the `compact_boundary`
event as a log line, so the **first long live conversation after deploy is the
verification** — its logs will show whether compaction fires.

- **If logs show `context auto-compacted` (trigger `auto`):** confirmed; done.
- **If they never appear and a long chat degrades:** native compaction isn't
  running headless → re-enable a high-threshold backstop (set
  `rotateAtContextFraction` to ~`0.92` per agent — one config value) and/or
  implement the fallback history tool.

## Changes (all in `src/`, with tests)

1. **`config.ts`** — `AGENT_DEFAULTS.rotateAtContextFraction`: `0.70` → **`0`**
   (custom rotation off by default). Knob + validation retained, so any agent can
   set `> 0` to restore the teardown / act as a backstop.
2. **`agent-home.ts`** — `ensureProjectMcpSettings` now also ensures
   `autoCompactEnabled: true` in `<agentHome>/.claude/settings.json` (the daemon
   loads `settingSources: ['project','local']`, so this is the control point).
   Idempotent; still leaves an unparsable file untouched.
3. **`types.ts` + `claude.ts`** — new `RunEvent` variant
   `{ kind:'compaction', trigger, preTokens, postTokens }`; `mapSdkMessage` maps
   `system/compact_boundary` to it (safe defaults on missing metadata).
4. **`worker.ts`** — logs `context auto-compacted` when a compaction event streams.
5. **`index.ts`** — startup log mentions `autoCompactEnabled`.

### Unchanged / retained
- Manual `/new` (`ROTATE_PROMPT` + `rotateSession`) — explicit user reset.
- `kind:'rotate'`, the `silent` column, `shouldAutoRotate`/`maybeAutoRotate` — dead
  by default (threshold 0), kept so the backstop is a config flip, not a code change.

## Data flow (target)

```
chat task → runOnce resumes the per-user session (unchanged)
  context fills → SDK emits system/compact_boundary {trigger:auto, pre,post}
    → SDK summarizes in place, SAME session continues (no DELETE)
  claude.ts → {kind:'compaction'} → worker logs it; reply delivered normally
  next user message resumes the SAME (compacted) session → continuity preserved
```
`sessions.claude_session_id` is updated each turn from the SDK `init` event and is
**never deleted mid-thread**; manual `/new` is the only reset.

## Testing

- **Unit (vitest) — all green (156 tests):**
  - `config`: default `rotateAtContextFraction` is `0`; override accepted; range
    validation unchanged.
  - `agent-home`: ensures `autoCompactEnabled` (and `enableAllProjectMcpServers`);
    adds it when only the MCP flag was present; idempotent; unparsable file left
    untouched.
  - `claude.mapSdkMessage`: `compact_boundary` → compaction event, with safe
    defaults on missing metadata.
- **Manual (live) = the verification:** drive one long conversation past the old
  70% point; confirm `context auto-compacted` in logs, the `sessions` row is not
  deleted mid-thread, and the agent still references earlier turns.

## Out of scope
- Building the fallback history tool now (documented only).
- Long-term cross-session memory changes.
- Tuning `autoCompactWindow`/threshold beyond SDK defaults unless live shows a need.

## Deploy

Touches `src/` → `npm run build`. Redeploy both hosts (see
`agent-runtime-deployment` memory):
- **ibrokhim's Mac:** `scripts/build-dmg.sh` → reinstall `AgentRuntime.app` + restart.
- **Agents-Mac-mini** (runs the agent in the screenshots): update via its
  `npm install` install path so the fix reaches the affected agent.

`autoCompactEnabled` is written into each agent home's `.claude/settings.json` on
startup, so no manual per-agent settings edit is needed. **If any host's
`config.json` sets `rotateAtContextFraction` explicitly, set it to `0`** there —
the default change only affects agents that omit the field.
