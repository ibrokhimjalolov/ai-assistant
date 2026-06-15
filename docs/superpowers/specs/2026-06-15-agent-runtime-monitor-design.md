# Agent Runtime Monitor — Design

**Date:** 2026-06-15
**Status:** Approved (pending spec review)

## Purpose

A simple, **read-only** desktop GUI that shows the live state of the personal
agent runtime: which agents are configured, whether the daemon is running,
whether each agent is currently **working** (processing a task), and recent
activity (sessions, tasks, schedules).

It exists because the runtime today is observable only by hand-querying SQLite.
This gives an at-a-glance window into "what is the bot doing right now."

## Non-goals (YAGNI)

- **No controls.** It never writes to the runtime's data. No cancelling tasks,
  toggling schedules, or sending messages.
- **No auth, no remote access.** Local machine only.
- **No packaging/signing.** Runs via `npm start`. A double-clickable `.app`
  (electron-builder) is a possible later step, explicitly out of scope now.
- **No new runtime features.** The monitor is fully standalone and does not
  modify or depend on the runtime's source (which is no longer present in the
  repo — only `dist/` remains).

## Context (verified 2026-06-15)

- Runtime = Node/TS Telegram-bot daemon, runs under **launchd**
  (`uz.domo.agent-runtime`, `node dist/index.js`).
- **Multi-agent capable**, currently **1 agent** named `default`.
- App Data root: `~/Library/Application Support/agent-runtime`
  - `config.json` — currently the **legacy single-agent** shape (top-level
    `telegramBotToken`, `whitelist`, `agentHome`, …). The runtime auto-wraps
    this into one agent named `default`. The monitor must do the same.
  - `agents/<name>/agent.db` — per-agent SQLite.
- Relevant `agent.db` tables:
  - `tasks(id, source['telegram'|'schedule'], kind, user_id, chat_id, prompt,
    status['queued'|'running'|'done'|'failed'|'interrupted'|'cancelled'],
    session_id, result_summary, created_at, started_at, finished_at)`
  - `sessions(user_id PK, claude_session_id, created_at)`
  - `schedules(id, cron_expr, run_at, prompt, enabled, missed_policy,
    created_by_user_id, chat_id, last_run_at)`
  - (also `approvals`, `outbox`, `inbox`, `meta` — not surfaced in v1)
- No existing HTTP/web surface. `better-sqlite3` and `electron`-compatible
  tooling available via npm.

## Form factor & framework

- **Native desktop window via Electron** (chosen). Reuses the Node stack so the
  same `better-sqlite3` can open the agent DBs directly.
- Native modules must be rebuilt for Electron's ABI (`electron-rebuild`, run via
  a `postinstall` script). **Fallback** if rebuild misbehaves: shell out to the
  system `sqlite3 -readonly` with `.mode json`. Primary path is `better-sqlite3`.

## Architecture

New self-contained folder `gui/` with its own `package.json` and `node_modules`.
Four small, independently understandable units:

### `gui/src/paths.js` (pure Node)
- `appDataRoot()` → `~/Library/Application Support/agent-runtime`.
- `configPath()`, `agentsDir()`, `agentDbPath(name)`.
- No side effects beyond path string construction.

### `gui/src/datasource.js` (pure Node — the testable core)
- `loadAgentsFromConfig(configJson)` → normalizes config into
  `[{name, agentHome, whitelist}]`, wrapping the **legacy single-agent** shape
  into one agent named `default`.
- `readAgent(name)` → opens `agentDbPath(name)` with
  `{ readonly: true, fileMustExist: true }` and returns:
  - `busy: boolean` + `currentTask` (the row with `status='running'`, if any,
    incl. prompt + `started_at`),
  - `sessions[]` (`user_id`, `claude_session_id`, `created_at`, task count),
  - `recentTasks[]` (last 15 by `id` desc: id, source, status, truncated prompt,
    `started_at`, `finished_at`, derived duration),
  - `schedules[]` (id, cron_expr/run_at, enabled, last_run_at, truncated prompt),
  - `counts` (totals per task status),
  - `lastActivityAt` (max `finished_at`).
  - On open failure → `{ name, error: 'db unavailable', detail }`.
- `getSnapshot()` → `{ daemon, agents[], generatedAt }`, composing the above for
  every configured agent. Never throws for a single bad agent; isolates failures
  to that agent's entry. A missing/invalid `config.json` yields
  `{ error, agents: [] }`.

### `gui/main.js` (Electron main)
- Creates a `BrowserWindow` (contextIsolation on, nodeIntegration off).
- One IPC handler: `ipcMain.handle('getSnapshot', …)` → `datasource.getSnapshot()`
  plus `daemonStatus()`.
- `daemonStatus()` → runs `launchctl list | grep uz.domo.agent-runtime`,
  parses the PID column: numeric PID → `{ alive: true, pid }`; present but `-`
  → `{ alive: false }`; not found / `launchctl` error → `{ status: 'unknown' }`.

### `gui/preload.js` + `gui/renderer/` (plain HTML/CSS/JS)
- `preload.js` exposes `window.api.getSnapshot()` over `contextBridge`.
- `renderer/index.html`, `renderer/renderer.js`, `renderer/style.css`.
- Polls `getSnapshot()` every **3s**, repaints. No UI framework.

## Data flow

```
renderer (setInterval 3s)
  → window.api.getSnapshot()         [contextBridge]
  → ipcRenderer.invoke('getSnapshot')
  → main: datasource.getSnapshot() + daemonStatus()
        ├─ read config.json (normalize agents)
        ├─ for each agent: open agent.db readonly, query
        └─ launchctl list → daemon liveness
  → JSON snapshot
  → renderer repaints
```

## UI (single window)

- **Top banner:** daemon status — `Running (pid N)` / `Stopped` / `Unknown`,
  plus snapshot timestamp.
- **Agent card(s)** (one per configured agent; just `default` today):
  - Name + status pill: **Working** (with current prompt + elapsed) or **Idle**.
  - Last-activity time; task-status counts.
  - **Sessions** sub-list: user id, short session id, created date, task count.
  - **Recent tasks** table: status badge, source, truncated prompt, duration.
  - **Schedules** sub-list: cron/run-at, enabled, last run, truncated prompt.
  - If the agent errored: a "DB unavailable" notice instead of the body.

## Error handling

| Condition | Behavior |
|---|---|
| `config.json` missing / unparseable | Full-window error banner; no agent cards |
| One agent's `agent.db` missing/locked/corrupt | That card shows "DB unavailable"; other agents still render |
| `launchctl` absent or unexpected output | Daemon banner shows "Unknown" |
| Daemon mid-write (WAL) | Read-only connections read committed data safely |
| IPC/query throws | Renderer keeps last good snapshot, shows a small "refresh failed" note |

## Testing

- **Vitest unit tests on `datasource.js`** against a temp fixture `agent.db`
  built in `beforeEach` (create the 3 tables, insert rows):
  - busy detection (a `running` task → `busy:true` + correct `currentTask`),
  - idle when no running task,
  - `recentTasks` ordering + 15-row cap + duration derivation,
  - status `counts` correctness,
  - `loadAgentsFromConfig` legacy single-agent → `default`, and explicit
    `agents[]` shape passthrough,
  - missing-DB path returns the `error` entry rather than throwing.
- The Electron shell (window, IPC, polling) is verified **manually** by
  launching `npm start` and observing live data while the daemon runs.

## Out of scope / future

- electron-builder packaging into a signed `.app`/`.dmg`.
- Live push (file-watch) instead of 3s polling.
- Surfacing `approvals` / `outbox` / `inbox`.
- Any write/control actions.
