# Per-Agent Agentic Browser — Design

**Date:** 2026-06-15
**Status:** Approved (pending spec review)

## Purpose

Give the runtime's agents the ability to browse the web, using Vercel Labs'
**`agent-browser`** CLI, such that **multiple agents never conflict** — each
agent gets its own persistent, isolated browser profile, even when agents run in
parallel.

## Decision

**Approach 1 — enforcing wrapper + Agent Home `CLAUDE.md`, with NO edits to the
runtime code.** Browsing is available to **all** agents, isolated per agent by
their working directory. Chosen because the runtime's TypeScript `src/` no longer
exists (only compiled `dist/`), so we avoid hand-editing compiled output.

Rejected: (2) runtime env-injection + a `browser:true` config flag — requires
editing source-less `dist/claude.js`/`worker.js`/`config.js`; (3) a custom
in-process MCP browser tool — unnecessary, since `agent-browser` is a clean CLI
and Bash auto-runs under `bypassPermissions`.

## Context (verified 2026-06-15)

- Runtime = Node/TS Telegram-bot daemon under launchd (`uz.domo.agent-runtime`).
  `src/` is gone; only `dist/` runs. So: **no runtime code edits.**
- `dist/claude.js` runs each agent's Claude with `cwd: req.cwd` (the agent's
  **Agent Home**), `permissionMode: 'bypassPermissions'` (tools auto-run, no
  approvals), and `settingSources: ['project','local']` + the `claude_code`
  preset — i.e. it **loads the Agent Home `CLAUDE.md`**. So instructions added to
  `<agentHome>/CLAUDE.md` reach the agent with no code change.
- One **single FIFO worker per agent** → an agent runs one task at a time
  (serial). Multiple agents can run in parallel.
- Current state: one agent `default`, Agent Home `/Users/ibrokhim/AIAssistent/workdir`.
- **launchd PATH is minimal** (`launchctl getenv PATH` is empty → default
  `/usr/bin:/bin:/usr/sbin:/sbin`). The agent's Bash inherits this, so
  `agent-browser` will **not** be found on `PATH`. ⇒ invoke it by **absolute
  path** (avoids editing the launchd plist or restarting the daemon).

### agent-browser facts (vercel-labs/agent-browser)

- Rust CLI + auto-starting daemon (CDP); **CLI-only, no MCP**. Install:
  `npm i -g agent-browser` then `agent-browser install` (downloads Chrome for
  Testing). Headless by default (`--headed` to show).
- Isolation: `AGENT_BROWSER_PROFILE` (persistent profile dir — cookies,
  localStorage, IndexedDB, logins) and `AGENT_BROWSER_SESSION` (isolated browser
  instance). One daemon runs **many sessions concurrently without conflict**.
- Agent workflow: `open <url>` → `snapshot -i` (returns refs `@e1`,`@e2`) →
  `click @ref` / `fill @ref "text"` → `screenshot` → `close`.

## Components

### 1. Install (one-time, system)
`npm i -g agent-browser && agent-browser install`. Record the resulting real
binary's **absolute path** (e.g. from `npm bin -g`) — call it `REAL_AB`.

### 2. Isolation wrapper (repo-tracked, installed to a stable absolute path)
A small POSIX `sh` script, stored in this repo at `scripts/agent-browser` and
installed to a fixed absolute location the agents will call (e.g.
`/Users/ibrokhim/AIAssistent/bin/agent-browser`). Behavior:

```sh
#!/bin/sh
# Per-agent isolation: scope profile + session to the caller's working dir
# (each agent's distinct Agent Home), unless already set.
: "${AGENT_BROWSER_PROFILE:=$PWD/.agent-browser/profile}"
: "${AGENT_BROWSER_SESSION:=$(basename "$PWD")}"
export AGENT_BROWSER_PROFILE AGENT_BROWSER_SESSION
exec "REAL_AB" "$@"     # REAL_AB = absolute path to the real agent-browser
```

The real binary path is written in at install time. Because each agent's Bash
runs with `cwd = <agentHome>`, profiles land at `<agentHome>/.agent-browser/profile`
— distinct per agent, persistent across tasks/restarts.

### 3. Agent instructions (`<agentHome>/CLAUDE.md`)
Append a short **"Web browsing"** section telling the agent: to browse, run
`<abs wrapper path> <cmd>` (absolute path, because PATH is minimal); the flow
(`open`/`snapshot -i`/`click @ref`/`fill`/`screenshot`/`close`); and that
profile/session are auto-isolated — **do not pass `--profile`/`--session`**.

## Isolation / no-conflict guarantee

- **Across agents:** distinct `cwd` ⇒ distinct `AGENT_BROWSER_PROFILE` dir ⇒
  distinct persistent browser instance; the agent-browser daemon supports
  concurrent sessions. No shared profile dir, no port (daemon is CDP/local).
- **Within an agent:** single FIFO worker ⇒ serial use of that agent's one
  profile. No overlap.
- The wrapper **enforces** scoping (the agent cannot accidentally fall back to a
  shared default profile by forgetting a flag).

## Persistence & display
- Persistent per-agent profile at `<agentHome>/.agent-browser/profile`
  (cookies/logins survive restarts).
- Headless (agent-browser default; no `--headed`).

## Security
Under `bypassPermissions`, browser actions (navigate, fill, submit) **auto-run
with no Telegram approval**, and persistent profiles retain logins. Consistent
with the runtime's current posture. Keep the Telegram whitelist short/trusted.
Domain allowlisting / sandboxing is out of scope for v1.

## Testing / verification
External CLI + real Chrome ⇒ no meaningful unit tests. Verify manually:
1. From two different working dirs, run the wrapper's `open`+`snapshot` and
   confirm two separate profile dirs are created (no shared state).
2. Drive a real browse task end-to-end through the `default` agent via Telegram
   (e.g. "open example.com and tell me the heading") and confirm it works and
   writes to `<agentHome>/.agent-browser/profile`.

## Out of scope (v1)
- Per-agent opt-in config flag (would need Approach 2 / `dist/` edits).
- Headed mode, video/streaming, proxies.
- Domain allowlist / action sandboxing.
- MCP-native integration.
- Editing the launchd plist `PATH` (avoided via absolute-path invocation).

## Files
- New (repo): `scripts/agent-browser` (wrapper), this spec, the plan.
- System (not repo): global `agent-browser` install + Chrome; wrapper copied to
  its stable absolute path; `<agentHome>/CLAUDE.md` "Web browsing" section;
  per-agent `<agentHome>/.agent-browser/` profiles (git-ignored within the
  workdir, which is outside this repo).
