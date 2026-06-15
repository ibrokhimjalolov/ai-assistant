# Auto Session Rotation at Context Threshold — Design

**Date:** 2026-06-16
**Status:** Approved (pending spec review)

## Purpose

When a per-user Claude session fills its context window, automatically rotate to
a fresh session — first saving durable facts to the agent's `memory/` — so the
conversation never hits the context limit and the agent doesn't degrade. Rotation
is **silent** (no extra Telegram message) and triggers at a **configurable
per-agent threshold (default 70%)**.

## Decisions (confirmed)

- **Rotate behavior:** reuse the existing `/new` path — agent writes durable
  facts/unfinished business to `memory/` (the `ROTATE_PROMPT` rotate task), then
  `rotateSession` drops the session row so the next message starts fresh.
- **Threshold:** per-agent `rotateAtContextFraction` (default `0.70`), clamped to
  `[0,1]`; `0` disables.
- **Notification:** silent — the auto-rotate does NOT post a Telegram reply.
  (Manual `/new` keeps its confirmation reply.)

## Context (verified 2026-06-16)

- Runtime source is back in `src/` (TypeScript); build via `npm run build` (tsc)
  → `dist/`. Deploy: ibrokhim's Mac via `scripts/build-dmg.sh` → reinstall
  `AgentRuntime.app`; mini via the `npm install` on-device path.
- One **FIFO worker per agent**; `worker.ts` `runOnce()` streams SDK events; on a
  `final` event it stores the reply (`complete()` → outbox) and, for
  `kind==='rotate'`, calls `store.rotateSession(userId)`.
- `/new` is `commands.ts` `newConversation()` → enqueues a `kind:'rotate'` task
  with `ROTATE_PROMPT` (save memory, reply one-line confirmation).
- **SDK signal (verified):** the success `result` message carries `modelUsage`, a
  record of model → `ModelUsage { inputTokens, outputTokens, cacheReadInputTokens,
  cacheCreationInputTokens, contextWindow, maxOutputTokens, ... }`. The resumed
  turn's input side (`inputTokens + cacheReadInputTokens + cacheCreationInputTokens`)
  approximates current context occupancy; `contextWindow` is the model's limit.
- `claude.ts` `mapSdkMessage` currently maps the `result` success to
  `{kind:'final', text}` and **ignores `modelUsage`**.

## Components (all in `src/`)

### 1. `contextFractionFromUsage(modelUsage)` — pure helper (`src/util.ts`)
- Input: the SDK result's `modelUsage` record (or undefined).
- Output: `number | null` = **max over models** of
  `(inputTokens + cacheReadInputTokens + cacheCreationInputTokens) / contextWindow`.
- Returns `null` when there's no usable entry or `contextWindow <= 0`.
- Pure, fully unit-tested.

### 2. `src/claude.ts` + `src/types.ts`
- In `mapSdkMessage`, on `result`/success, call the helper and attach the value:
  `{ kind:'final', text, contextFraction?: number }`.
- `types.ts`: add `contextFraction?: number` to the `final` run-event variant.

### 3. `src/config.ts` + `src/types.ts`
- Add per-agent optional `rotateAtContextFraction: number`.
- Default `0.70` in `AGENT_DEFAULTS`. Validation: if present, must be a number in
  `[0,1]` (reject otherwise with a `config:` error); `0` disables auto-rotation.
- Surfaced on the resolved `AgentConfig`.

### 4. `src/db.ts` — guarded migration
- Add column `silent INTEGER NOT NULL DEFAULT 0` to `tasks` (guard: only
  `ALTER TABLE` if the column is absent, mirroring the existing `migrateSchedules`
  pattern). Lets an auto-rotate task suppress its reply without affecting `/new`.

### 5. `src/store.ts`
- `enqueueTask` accepts an optional `silent?: boolean` (persisted to the new
  column). Task read model exposes `silent: boolean`.
- `pendingTasks()`/a helper lets the worker check whether a rotate is already
  queued for a user (dup-guard).

### 6. `src/worker.ts`
- `runOnce` captures `contextFraction` from the `final` event and returns it
  alongside the final text (e.g. `{ text, contextFraction }`).
- New pure helper `shouldAutoRotate({ kind, contextFraction, threshold, rotateQueued })`
  → boolean: true iff `kind==='chat'` && `threshold>0` && `contextFraction!=null`
  && `contextFraction >= threshold` && `!rotateQueued`. Unit-tested.
- After a successful chat task (in/after `complete()`), if `shouldAutoRotate(...)`,
  enqueue a **silent** rotate task: `enqueueTask({ source:'telegram', kind:'rotate',
  silent:true, userId, chatId, prompt: ROTATE_PROMPT })`.
- `complete()`: when `task.silent`, skip the outbox enqueue (deliver nothing);
  still `finishTask` and, for `kind==='rotate'`, `rotateSession(userId)`.
- Worker deps gain `rotateAtContextFraction` (passed from `index.ts` per agent).

### 7. `src/index.ts`
- Pass `agentCfg.rotateAtContextFraction` into the `Worker` deps.

## Data flow

```
chat task runs → SDK result(modelUsage) → claude.ts contextFractionFromUsage()
  → final event {text, contextFraction} → worker.complete() delivers reply
  → shouldAutoRotate? → enqueue SILENT rotate task
     → worker runs it (resumes full session, writes memory/) → complete()
       sees silent → no outbox; kind==='rotate' → rotateSession(userId)
  → next user message starts on a fresh session
```

## Error handling / safety
- No `modelUsage` / `contextWindow<=0` → `contextFraction=null` → never rotates.
- `rotateAtContextFraction` `0`/unset-as-0 → disabled.
- Dup-guard: don't enqueue a rotate if one is already queued for that user.
- Loop-safe: the rotate task is `kind:'rotate'` (not `chat`) → can't itself trigger
  another rotate; after `rotateSession` the next turn starts low-context.
- A failed silent-rotate falls through the existing `retryFresh`/`fail` paths; worst
  case the session isn't rotated this round and may rotate again next message. The
  user's normal reply was already delivered before rotation is considered.

## Testing
- **Unit (vitest):**
  - `contextFractionFromUsage`: correct max-fraction math across models;
    `null` on missing data / zero window; cache tokens included.
  - `config`: `rotateAtContextFraction` default `0.70`, clamp/validate `[0,1]`,
    `0` disables, rejects out-of-range.
  - `shouldAutoRotate`: true only at/above threshold for `kind==='chat'`,
    respects disabled (0), null fraction, and dup-guard.
  - `store`/`db`: `silent` round-trips; migration adds the column idempotently.
- **Manual (live):** set `rotateAtContextFraction` very low (e.g. `0.02`) on a test
  agent, send 2 messages; confirm — a `memory/` file is written, the `sessions` row's
  `claude_session_id` changes (rotation), and **no extra Telegram message** appears.

## Out of scope
- Notifying the user of rotation (chosen silent).
- Changing `/new`'s behavior (stays chatty).
- Mid-task rotation (we rotate between tasks, not within one).
- Token accounting beyond the SDK's reported `modelUsage`.

## Deploy
Touches `src/` → `npm run build`; redeploy: ibrokhim's Mac `scripts/build-dmg.sh`
→ reinstall `AgentRuntime.app` + restart; mini via its `npm install` install path.
New config knob `rotateAtContextFraction` is optional (defaults to 0.70), so
existing configs keep working with auto-rotation on at 70%.
