# Personal Agent Runtime — Design Spec

**Date:** 2026-06-10
**Status:** Approved design, pending implementation plan
**Owner:** Ibrokhim

## 1. Overview

A personal AI agent that runs permanently on the owner's macOS machine. Whitelisted
Telegram users talk to it from anywhere via a private Telegram bot; everyone on the
whitelist has equal capabilities, no one else gets in. Messages flow into Claude Code
sessions driven by the Claude Agent SDK, giving the agent full assistant capabilities
on the machine (files, shell, code, apps). The agent has persistent memory, survives
crashes and reboots without losing messages or context, and can run scheduled jobs
that message their creator proactively.

## 2. Goals

- Telegram is the sole interface; the Mac needs no inbound ports (long polling).
- Access restricted to a configurable whitelist of Telegram user IDs; all
  whitelisted users have the same single role and capabilities.
- Full Claude Code capabilities on the local machine, driven remotely.
- Risky actions require explicit approval via Telegram inline buttons, answered by
  the user whose request triggered them.
- Three persistent memory layers: long-term facts, conversation continuity, task
  state/history.
- Always-on: auto-start at login, auto-restart on crash, no lost messages.
- Scheduled (cron-like) jobs in v1, managed conversationally.
- **Authentication: Claude subscription only.** The runtime drives the locally
  installed, already-logged-in Claude Code (or a `claude setup-token` OAuth token in
  the environment). `ANTHROPIC_API_KEY` is never used or set.

## 3. Non-goals (v1)

- Group chats. Only private chats with whitelisted users.
- Roles or per-user permission tiers. One flat role; whitelist membership is the
  only access control. The whitelist is edited in the config file, not via chat.
- Parallel task execution. Tasks run strictly one at a time, FIFO, globally across
  all users.
- Voice messages, inline mode, or Telegram payments.
- A web UI or any interface other than Telegram.
- Cross-machine sync or cloud backup of agent state.

## 4. Architecture

One Python daemon process, supervised by launchd. Five internal units communicate
through SQLite (the single source of durable truth) and in-process interfaces.

```
Telegram Bot API
      ↑↓ long polling
┌─────────────────────────────────────────────────────┐
│ agent-runtime (Python daemon, launchd-supervised)    │
│                                                      │
│  Telegram Gateway ──► SQLite (WAL)  ◄── Scheduler    │
│        ▲              inbox/tasks/sessions/          │
│        │              schedules/approvals/outbox     │
│        │                   ▲                         │
│        │                   │                         │
│  Permission Gate ◄──── Agent Worker                  │
│   (can_use_tool)           │                         │
│                            ▼                         │
│              Claude Agent SDK ──► local Claude Code  │
│                                   (subscription auth)│
└─────────────────────────────────────────────────────┘
                            │
                  ~/AgentHome/ (CLAUDE.md, memory/)
```

### 4.1 Stack

| Concern | Choice | Why |
|---|---|---|
| Language | Python 3.12+ | Owner had no preference; mature ecosystem for every piece below |
| Telegram | `python-telegram-bot` v21+ | Long polling, inline keyboards, built-in JobQueue usable for the scheduler |
| Claude | `claude-agent-sdk` | Spawns the locally installed Claude Code; supports `resume`, `can_use_tool`, custom in-process MCP tools |
| Storage | SQLite (WAL mode), via `aiosqlite` | Durable, zero-ops, single file, safe with one writer process |
| Cron parsing | `croniter` | Standard cron expressions for schedules |
| Supervision | macOS launchd LaunchAgent | `KeepAlive` + `RunAtLoad`; no extra supervisor dependency |

### 4.2 Components

**Telegram Gateway**
- Long-polls `getUpdates`. No webhook, no inbound ports.
- Drops and logs any update whose sender is not in the configured whitelist of
  Telegram user IDs, before persisting anything.
- Persists accepted updates to `inbox` *before* advancing the update offset, so a
  crash between receive and process never loses a message.
- All outbound traffic (replies, progress edits, approval prompts, proactive
  scheduler results) goes through the `outbox` table with retry + backoff.
- User commands: `/status` (uptime, queue depth, current task), `/cancel` (abort
  your own running task), `/new` (rotate your conversation), `/queue` (pending
  tasks), `/schedules` (list jobs).

**Durable Store (SQLite)**
- `inbox` — raw accepted Telegram updates: id, payload, received_at, processed_at.
- `tasks` — id, source (telegram|schedule), user_id, chat_id, prompt, status
  (queued|running|done|failed|interrupted|cancelled), session_id, result_summary,
  created_at, started_at, finished_at. Replies, approvals, and resume offers all
  route to the task's chat_id.
- `sessions` — user_id, claude_session_id, created_at, rotated_at. One active
  conversation per whitelisted user.
- `schedules` — id, cron_expr, prompt, enabled, missed_policy (run_now|skip),
  created_by_user_id, chat_id, last_run_at. Job output is delivered to the
  creator's chat.
- `approvals` — id, task_id, tool_name, tool_input (rendered), decision
  (approved|denied|timeout), requested_at, decided_at.
- `outbox` — id, chat_id, content, kind (reply|edit|approval|proactive), attempts,
  sent_at.

**Agent Worker**
- Single sequential loop: claim oldest `queued` task → mark `running` → call SDK
  `query()` with `resume=<claude_session_id>` and `cwd=~/AgentHome` → stream events.
- Streams progress to Telegram by editing a single status message (edits don't ping
  the user's phone); sends the final answer as a new message (which does ping).
- Messages arriving mid-task simply queue as new tasks (FIFO). `/cancel` interrupts
  the SDK call and marks the task `cancelled`.
- Registers the runtime's custom tools (scheduler management, send-telegram-message)
  via the SDK's in-process MCP server.

**Permission Gate**
- Implements the SDK's `can_use_tool` callback. Decision order:
  1. Tool/input matches the safe policy (read-only tools; file edits under
     `~/AgentHome`; shell commands matching allowlist patterns defined in a config
     file shipped with conservative defaults such as `git status`, `ls`, `grep`)
     → auto-approve.
  2. Tool/input matches the hard-deny policy (nothing in v1; reserved) → deny.
  3. Everything else → write `approvals` row, send a Telegram message to the chat
     of the user whose task triggered it, showing the exact tool and rendered input
     with **Approve / Deny** inline buttons, and block the callback until that user
     answers or 15 minutes pass.
- Timeout = deny. The SDK receives the denial and the agent continues or fails
  gracefully; the requesting user is informed either way.
- Every decision (including auto-approvals) is recorded in `approvals`.

**Scheduler**
- Tick loop (via PTB JobQueue) checks `schedules` each minute against `croniter`.
- A due job enqueues an ordinary task with `source=schedule`; output is delivered as
  a proactive Telegram message to the job creator's chat.
- On startup, jobs whose fire time passed during downtime are handled per their
  `missed_policy`: `run_now` (default) or `skip`.
- The agent manages jobs itself through custom tools `schedule_create`,
  `schedule_list`, `schedule_delete` — so "every Monday 9:00 remind me to review
  PRs" works conversationally with no config editing.

## 5. Memory model

| Layer | Mechanism | Survives |
|---|---|---|
| Long-term facts & preferences | `~/AgentHome/CLAUDE.md` (persona + standing instructions) and `~/AgentHome/memory/` (small markdown fact files + index). Standing instructions direct the agent to record durable facts as it learns them and consult memory at session start. | Everything — crashes, conversation rotation, reinstalls |
| Conversation continuity | One Claude session ID per whitelisted user, stored in `sessions`. Each user's messages resume their own session; users never share a conversation. Long conversations rely on Claude Code's built-in compaction. | Process restarts, reboots |
| Task state & history | `tasks` table with prompts, statuses, result summaries. | Everything |

Conversation rotation: `/new` asks the user's current session to summarize durable
facts into `memory/`, then creates a fresh session for that user. The memory layer
is what carries identity across rotations.

Long-term memory (`~/AgentHome/`) is shared: there is one agent with one knowledge
base, serving all whitelisted users. Standing instructions tell it to attribute
person-specific facts to the person they belong to.

## 6. Security

- **Identity:** hard whitelist of Telegram user IDs (config file), enforced in the
  Gateway before persistence. Unknown senders are dropped and logged. All
  whitelisted users share one flat role with equal capabilities — anyone on the
  list effectively has full control of the machine, so the list should stay short
  and trusted.
- **Secrets:** bot token and `CLAUDE_CODE_OAUTH_TOKEN` (if used instead of the CLI's
  keychain login) live in a `chmod 600` env file referenced by the launchd plist.
  Never in code, the DB, or logs. Migration to macOS Keychain is a later hardening
  step.
- **Attack surface:** none inbound — long polling only.
- **Prompt injection:** the agent reads untrusted content (web pages, emails) with
  full machine capabilities. The Permission Gate is the backstop: risky actions
  require the requesting user's button press, and the approval message shows exactly what will
  run. This risk is why approval mode was chosen over full autonomy.
- **Audit:** `approvals` + `tasks` form a complete, queryable action history.

## 7. Fault tolerance

| Failure | Behavior |
|---|---|
| Process crash / machine reboot | launchd restarts the daemon (`KeepAlive`, `RunAtLoad`). On startup: tasks stuck in `running` → `interrupted`; the task's user gets a Telegram message with a one-tap **Resume** button (re-enters the same session with a continue prompt). Queued tasks are untouched. |
| Telegram API unreachable | Polling retries with exponential backoff (cap ~5 min). Outbound messages wait in `outbox` and retry. Nothing is lost, only delayed. |
| Subscription usage limit reached | Expected on Pro/Max (5-hour windows). The Worker detects the limit error, notifies the affected user (and any users with queued tasks) with the reset time, pauses the queue, and auto-resumes when the window resets. |
| Claude session failure (corrupt resume, SDK error) | Retry once. If still failing: start a fresh session pre-loaded with memory, note to the agent and the affected user that prior in-conversation context was lost. |
| Approval unanswered | 15-minute timeout → deny; requesting user notified. |
| Scheduled job missed during downtime | Per-job `missed_policy`: `run_now` (default) or `skip`. |
| SQLite corruption | WAL mode + single writer makes this unlikely; additionally the runtime itself performs a daily file-copy backup of the DB and `~/AgentHome` to a local backups folder (a built-in scheduler job). |

## 8. Operations

- **Install:** launchd LaunchAgent plist (`~/Library/LaunchAgents/`) with
  `KeepAlive=true`, `RunAtLoad=true`, env file path, rotating file logs.
- **Keep-awake requirement:** the Mac must not sleep. Setup includes
  `sudo pmset -a sleep 0 displaysleep 10` (or equivalent) documented in the README.
- **Prerequisites:** Claude Code installed and logged in with the owner's
  subscription (`claude login`, or `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`
  in the env file); a Telegram bot created via @BotFather.
- **Observability:** `/status` command; rotating logs; startup self-check that
  verifies Telegram auth, Claude auth, and DB health, reporting failures to all
  whitelisted users' chats if Telegram is reachable.

## 9. Testing

The seams (Gateway ↔ Store ↔ Worker ↔ Gate) allow testing without real Telegram or
real Claude:

- **Unit:** inbox durability ordering (persist-before-ack), FIFO queue claiming,
  permission policy matching, cron firing + missed-policy logic, crash recovery
  (running → interrupted), outbox retry — all against a fake Telegram transport and
  a fake SDK client.
- **Integration:** one end-to-end pipeline test (fake transport in → fake SDK →
  fake transport out) covering the approval round-trip.
- **Manual smoke checklist (release gate):** real bot + real session: send message,
  get answer; trigger an approval; kill -9 the daemon mid-task and verify restart +
  resume offer; fire a one-minute schedule.

## 10. Build order (suggested milestones)

1. Skeleton daemon + Gateway + SQLite inbox/outbox + user whitelist + `/status`.
2. Agent Worker with session resume; basic chat working end-to-end.
3. Permission Gate with Telegram approval round-trip.
4. Memory home (`CLAUDE.md`, `memory/`), `/new` rotation.
5. Crash recovery + launchd packaging + usage-limit handling.
6. Scheduler + custom schedule tools + proactive messages.
7. Test suite + smoke checklist + README (install, pmset, BotFather, claude login).
