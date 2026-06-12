# Multi-Agent Runtime

**Date:** 2026-06-11
**Status:** Approved design, pending implementation
**Owner:** Ibrokhim

## 1. Goal

Run N fully-isolated agents inside one daemon (one launchd service). Each agent
has its own Telegram bot, Agent Home (workdir + memory), SQLite DB + backups,
worker/scheduler/sender, and Claude token. Backward-compatible with the existing
single-agent config so the live install keeps working.

## 2. Decisions (locked)

- **Process model:** one daemon, agents run in parallel (in-process multi-runtime).
- **Auth:** per-agent `claudeOauthToken` (falls back to a top-level default if omitted).
- **Config:** one `config.json` with an `agents` array; the old single-agent shape auto-wraps.
- Agents are fully independent — no cross-agent messaging/shared memory. Static list (edit config + restart to change).

## 3. Config schema (backward-compatible)

```json
{
  "claudeOauthToken": "<optional shared default>",
  "agents": [
    { "name": "alice", "telegramBotToken": "...", "whitelist": [111],
      "agentHome": "/Users/you/agents/alice", "claudeOauthToken": "sk-ant-oat01-..." },
    { "name": "bob", "telegramBotToken": "...", "whitelist": [222],
      "agentHome": "/Users/you/agents/bob" }
  ]
}
```

- Per agent: `name` (unique, `^[a-z0-9_-]+$`), `telegramBotToken`, `whitelist`
  (non-empty int[]), `agentHome` (must exist + be a dir), optional
  `claudeOauthToken`, `approvalTimeoutMs`, `taskTimeoutMs`, `bashAllowlist`.
- **Token resolution:** `agent.claudeOauthToken ?? config.claudeOauthToken ?? undefined`.
- **Backward compat:** if the file has no `agents` key but has a top-level
  `telegramBotToken`, wrap it as `agents: [{ name: "default", ...topLevel }]`.
- **Validation:** non-empty `agents`; unique + safe names; each agent valid; a
  bad single agent is a fatal config error only if it can't be skipped at load —
  otherwise per-agent startup failures are isolated at runtime (see §7).

## 4. Types (`src/types.ts`, `src/config.ts`)

- Rename the current single-agent `Config` shape to **`AgentConfig`**
  (`name` added; `claudeOauthToken` required-after-resolution string).
- New **`Config`** = `{ agents: AgentConfig[]; claudeOauthToken?: string }`.
- `RunRequest` gains `claudeToken?: string`.

## 5. Paths (`src/paths.ts`)

- `appPaths(root)` unchanged: `{ root, configPath, logsDir, backupsDir }`
  (`config.json` + the launchd service log stay at root).
- New `agentPaths(root, name)` → `{ dir: root/agents/<name>, dbPath, backupsDir }`.
- `ensureAgentData(agentPaths)` creates the per-agent dirs.
- `migrateLegacyDb(root, name)`: if `root/agent.db` exists and
  `agents/<name>/agent.db` does not, move `agent.db` (+ `-wal`, `-shm`) into
  `agents/<name>/`. Called for the `default` agent so the **current live DB
  (sessions/schedules/history) carries over**.

## 6. Per-agent Claude token (`src/claude.ts`, `src/worker.ts`)

- `claude.ts` `run()` builds `options.env` per call:
  `{ ...process.env, CLAUDE_CODE_OAUTH_TOKEN: req.claudeToken, ANTHROPIC_API_KEY: undefined }`
  when `req.claudeToken` is set (SDK supports per-call `env` — verified). Keep
  `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions` as-is.
- `WorkerDeps` gains `claudeToken?: string`; `runOnce` passes it into `RunRequest`.
- `index.ts` stops setting a process-global `CLAUDE_CODE_OAUTH_TOKEN`; each agent's
  worker carries its own token.

## 7. Orchestration (`src/index.ts`)

- `main()`: `loadConfig` → for each agent: `ensureAgentData`, migrate legacy (default),
  then `runAgent(agentCfg, agentPaths)`. `await Promise.allSettled(agents.map(runAgent))`.
- `runAgent(agentCfg, agentPaths)`: the current per-agent wiring, extracted —
  `openDb` → `Store` → `Gate` (Policy.fromConfig(agentCfg)) → `Worker`
  (taskTimeoutMs + claudeToken + mcpServersFor) → `buildBot(agentCfg, …)` →
  `GrammyTelegramApi` → `Sender` → `Scheduler`; `scaffoldAgentHome`,
  `recoverInterrupted`, `startupCatchup`; the sender/typing/scheduler intervals
  and the worker tick loop; then `await bot.start()` (long-poll).
- **Per-agent isolation of failures:** wrap each `runAgent` so a bad token /
  missing home / `getMe` failure logs and skips that agent without killing the
  daemon or other agents. (Today's "exit(1) on telegram auth fail" becomes
  per-agent skip.)

## 8. Logging (`src/log.ts`, light touch)

- `runAgent` logs lifecycle lines tagged with the agent name
  (`starting`, `telegram ok {username}`, `skipped {reason}`).
- Component logs (worker/scheduler) stay module-level; structured fields
  (`chat_id`/`user_id`) disambiguate. A per-component agent-name prefix is a
  deferred nicety (out of scope for v1).

## 9. Installer / DMG

- `installer/config.template.json` → the `agents` array shape (one example agent,
  fields blank) + optional top-level `claudeOauthToken`.
- `installer/README.txt` updated for multi-agent (one bot token + workdir +
  token per agent).
- `launcher.sh` "configured?" grep (`"telegramBotToken"\s*:\s*"[^"]+"`) still
  matches any agent's token in the array — no change needed.
- Rebuild `AgentRuntime.dmg`.

## 10. Tests

- `config.test.ts`: multi-agent parse; backward-compat wrap (old shape →
  `agents:[default]`); validation (empty agents, duplicate/invalid names, per-agent
  missing `agentHome`); token fallback to top-level default. Update existing
  single-agent assertions to the new shape.
- `paths.test.ts`: `agentPaths` derivation; `migrateLegacyDb` moves
  `agent.db`(+wal/shm) into `agents/<name>/` only when legacy exists and target absent.
- `worker.test.ts`: a worker with `claudeToken` in deps passes it through on
  `RunRequest` (fake runner captures `req.claudeToken`).
- All existing tests stay green.

## 11. Non-goals (YAGNI)

- No cross-agent messaging or shared memory.
- No runtime add/remove of agents (edit config + restart).
- No per-agent launchd services (single service).
- No GUI for managing agents; no per-component log prefixing (deferred).

## 12. Migration / live impact

The running daemon currently uses the legacy single-agent `config.json` +
`App Data/agent.db`. After deploy: `loadConfig` wraps it to the `default` agent
and `migrateLegacyDb` moves the DB into `agents/default/` — the live agent keeps
its sessions, schedules, and history. To actually add a second agent, the owner
edits `config.json` into the `agents` array form and restarts.
