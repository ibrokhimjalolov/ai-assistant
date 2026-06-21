# Conversation History Recall — Design

**Date:** 2026-06-21
**Status:** Approved (pending spec review)

## Problem

After a long conversation the bot "forgets" everything mid-thread: the agent
proposes an action, then two turns later asks *"это в продолжение какого
разговора?"* (what conversation is this continuing?). Observed live on the
"AI Assistant" agent (2026-06-21 screenshots).

**Root cause (confirmed):** the auto-session-rotation feature
(`2026-06-16-auto-session-rotation`). After each chat turn `worker.maybeAutoRotate`
reads context-window usage; at `rotateAtContextFraction` (default **0.70**) it
silently enqueues a `rotate` task that writes durable facts to `memory/` and then
calls `store.rotateSession(userId)` → `DELETE FROM sessions WHERE user_id = ?`.
The next user message finds no session, resumes nothing, and starts a **brand-new
Claude conversation with zero history**. The only bridge is the `memory/` write,
which captures *durable facts* — not the *live working thread*. So continuity is
lost, silently.

The same amnesia also occurs on any other context reset: daemon restart
(session row survives but the SDK session may not), or a session error that forces
`retryFresh`.

## Goal

**Seamless continuity** (chosen priority): the user should never have to repeat
themselves because the agent lost the thread. Achieve this by giving the agent a
reliable way to **read the earlier messages of the current conversation on
demand**, plus a signal telling it to do so after a context reset.

## Decision (confirmed)

Add a **DB-backed conversation-history tool** the agent can call, **auto-scoped to
the current chat**, AND a **fresh-session nudge** that tells the agent (only when a
prior conversation exists but the live session was reset) that earlier messages
aren't in context and to consult the tool before asking the user to repeat.
**Keep auto-rotation at 70%** — it usefully bounds context so we never hit the hard
limit; the tool makes its context-drops invisible instead of removing it.

### Approaches considered

- **History tool + fresh-session nudge (chosen).** Additive, no SDK dependency,
  robust to *any* cause of context loss (rotation, restart, session error). The
  data already exists in the runtime DB. Smallest reliable change.
- **Native SDK auto-compaction.** `claude-agent-sdk@0.3.173` has the machinery
  (`autoCompactEnabled` setting, `compact_boundary` events). Rejected as the
  primary fix because we could **not** verify it runs in the headless `query()`
  path, and the setting's runtime default is not statically determinable
  (`autoCompactEnabled` is an optional zod boolean with no forced default in the
  bundle). Left as a possible future enhancement, not a dependency.
- **Summary-handoff rotation (`forkSession` / prepend summary).** More code, a
  quality downgrade vs. on-demand full recall, and still lossy. Rejected.

## Why the tool is sound

- **The data already exists.** Each user turn is a row in `tasks`
  (`kind='chat'`, `source='telegram'`, `prompt` = raw user text, `created_at`).
  Each reply is a row in `outbox` (`kind IN ('reply','proactive')`, `content` =
  full reply text, `created_at`). Both carry `chat_id`. The conversation is
  reconstructable by interleaving the two on `created_at`.
- **Auto-scoping = no cross-user leak.** The tool reads only the requesting task's
  `chatId`; it takes **no** chat/user parameter, so the agent cannot read another
  user's conversation.
- **Reliability gap is closed by the nudge.** The current bug is the agent not
  *realizing* it lost context. The nudge converts "what conversation?" into "let me
  check" without depending on the agent to guess.

## Components

### 1. `src/store.ts` — `conversationHistory(chatId, opts)`
- Signature: `conversationHistory(chatId: number, opts?: { limit?: number; beforeTs?: string }): ConversationTurn[]`
  where `ConversationTurn = { role: 'user' | 'assistant'; ts: string; text: string }`.
- User turns: `SELECT prompt, created_at FROM tasks WHERE chat_id=? AND
  source='telegram' AND kind='chat'` (excludes `rotate`/`resume`/silent tasks and
  scheduled jobs).
- Assistant turns: `SELECT content, created_at FROM outbox WHERE chat_id=? AND
  kind IN ('reply','proactive')` (excludes `approval` prompts and `edit` control
  rows).
- Merge, sort by `created_at` ascending, return the **most recent `limit`** turns
  (default 20, hard cap 100). `beforeTs` pages further back (returns the `limit`
  turns immediately older than the timestamp). Per-turn text capped (e.g. 4000
  chars, "…") to bound token cost; the cap is documented in the tool output.
- Pure SQL over existing columns; no schema change.

### 2. `src/tools.ts` — `conversation_history` tool
- Added to the existing `runtime` in-process MCP server (same pattern as
  `schedule_*`/`reminder_*`), closed over `task.chatId`.
- Params: `{ limit?: number (≤100, default 20), before?: string (ISO ts, page older) }`.
  **No** chat/user param — scope is fixed to the current conversation.
- Description (drives correct use): *"Read earlier messages of THIS conversation
  that may not be in your current context. Call this when the user refers to
  something you don't have (a name, date, plan, 'as we discussed') instead of
  asking them to repeat. Returns the most recent turns; use `before` to page
  further back."*
- Output: a compact, readable transcript (e.g. `user [HH:MM]: …` / `assistant
  [HH:MM]: …`), newest block last, with a header noting how many turns and whether
  more exist.

### 3. `src/worker.ts` — fresh-session nudge
- `runOnce` already knows whether a session was resumed (`session` undefined ⇒
  fresh). Add a guard: when the task is a telegram `chat`, the session is fresh,
  **and** the chat has prior turns, prepend a one-line nudge to the effective
  prompt. "Has prior turns" = `store.hasPriorConversation(task.chatId, task.id)`,
  which counts `source='telegram' AND kind='chat'` tasks for the chat with
  `id < task.id` (i.e. excludes the current task) and returns true iff > 0:
  > `[This is a continuing conversation. Earlier messages are NOT in your context. If anything here refers to something you don't have, call conversation_history before replying — do not ask the user to repeat, and do not claim you have no context.]`
- A brand-new user's very first message is fresh but has **no** prior turns ⇒ no
  nudge (avoids a pointless empty lookup).
- Resumed sessions ⇒ no nudge (context is already present).
- `store.hasPriorConversation(chatId, exceptTaskId)` is a small new count helper.

### 4. Rotation, memory, `/new` — unchanged
- Auto-rotation at 70% stays (bounds context). `ROTATE_PROMPT` durable-facts write
  stays. Manual `/new` stays. No config default change.

## Data flow

```
user msg → task(kind=chat) persisted → worker.runOnce
  resumed session?  → full context, no nudge, normal reply
  fresh + prior turns exist (post-rotation/restart/error)
                    → prepend nudge to prompt
  agent sees nudge (or hits an unknown reference)
    → calls conversation_history(limit[, before])
      → store.conversationHistory(task.chatId) → interleaved transcript
    → agent answers with recovered context
reply → outbox (assistant turn) → visible to future history reads
```

## Error handling / safety

- Tool is **read-only** and **chat-scoped**; cannot mutate state or read other
  chats.
- Empty history (new chat, or paged past the start) → tool returns an explicit
  "no earlier messages" note, never an error.
- Large conversations bounded by `limit`+per-turn cap; `before` paging avoids
  dumping everything at once.
- No schema migration ⇒ no migration risk; works on existing agent DBs.
- If the nudge fires but history is genuinely irrelevant, worst case is one cheap
  tool call returning context the agent ignores — strictly better than amnesia.

## Testing

- **Unit (vitest):**
  - `store.conversationHistory`: interleave order by `created_at`; `limit` and
    `before` paging; **scoped to chat_id** (a second chat's rows excluded);
    excludes `rotate`/silent tasks, `approval`/`edit` outbox rows; per-turn
    truncation; empty result on unknown chat.
  - `store.hasPriorConversation`: false for a chat's first message, true once a
    prior `kind='chat'` task exists.
  - `tools.conversation_history`: returns formatted transcript; ignores/forbids any
    attempt to widen scope; respects `limit` cap.
  - `worker` nudge: fresh + prior turns ⇒ prompt contains the nudge; fresh + no
    prior turns ⇒ no nudge; resumed ⇒ no nudge. (Assert via a fake runner that
    captures the prompt passed to `run`.)
- **Manual (live):** force a rotation (set `rotateAtContextFraction` very low on a
  test agent), then send a follow-up that references the prior turn; confirm the
  agent calls `conversation_history` and answers correctly instead of asking what
  conversation it is.

## Out of scope

- Native SDK compaction / summary-handoff / disabling rotation.
- Reading other users' or other chats' conversations.
- Media/attachment content in history (v1 is text turns only).
- Long-term cross-session memory changes (ranked below continuity).

## Deploy

Touches `src/` → `npm run build`. Redeploy both hosts (see
`agent-runtime-deployment` memory):
- **ibrokhim's Mac:** `scripts/build-dmg.sh` → reinstall `AgentRuntime.app` + restart.
- **Agents-Mac-mini** (runs the agent in the screenshots): update via its
  `npm install` install path so the fix reaches the affected agent.

No config or settings changes required; the tool and nudge are always available.
