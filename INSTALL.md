# Agent Runtime — First-Time Install Guide

A personal AI agent you talk to from a private **Telegram bot**. It runs in the
background on a Mac (managed by macOS `launchd`), survives crashes, and starts
automatically when you log in. You can run **multiple agents** on one machine —
each with its own bot, working folder, memory, database, and Claude token.

This guide is for setting it up on a **new device** from scratch.

---

## 1. Prerequisites (on the device)

| Requirement | How to get it |
| --- | --- |
| **macOS on Apple Silicon** (M-series) | The bundled engine is built for `arm64`. |
| **Node.js 22+** | Install from <https://nodejs.org> (or `brew install node`). Check: `node -v`. |
| **A Claude subscription** | Needed to authenticate the agent. |
| **Claude Code** (to mint a token) | <https://claude.com/claude-code> — only needed once, to run `claude setup-token`. |
| **A Telegram bot** | Create one in Telegram with **@BotFather** → copy the bot **token**. One bot per agent. |
| **Your Telegram numeric user ID** | Message **@userinfobot** in Telegram → it replies with your numeric ID. |

> ⚠️ **Security:** this runtime drives Claude in **bypass-permissions mode** — it
> auto-runs tools (shell, file edits, sends) with **no approval prompts**. Anyone
> on an agent's `whitelist` effectively has unattended shell access to this Mac
> through the bot. **Keep the whitelist short and fully trusted.**

---

## 2. Gather your secrets

Before installing, collect these for **each** agent you want:

1. **Bot token** — from @BotFather, looks like `8553161905:AAH...`.
2. **Your Telegram user ID(s)** — from @userinfobot, e.g. `1085409133`.
3. **A Claude login token** — in Terminal run:
   ```bash
   claude setup-token
   ```
   Copy the resulting `sk-ant-oat01-...` token.
4. **A working folder** for the agent's files + memory (create it):
   ```bash
   mkdir -p ~/agents/default
   ```

---

## 3. Install the app

1. Open **`AgentRuntime.dmg`** (double-click, or `open AgentRuntime.dmg`).
2. **Drag `AgentRuntime.app`** onto the **Applications** alias in the window.
3. **First launch — one-time Gatekeeper step** (the build is unsigned):
   in `/Applications`, **right-click `AgentRuntime` → Open → Open**.
   A normal double-click will be blocked the first time only.
   - Terminal alternative:
     ```bash
     xattr -dr com.apple.quarantine /Applications/AgentRuntime.app
     ```

On first open it creates and opens a config file in TextEdit (see next step).

---

## 4. Configure

The app opens:

```
~/Library/Application Support/agent-runtime/config.json
```

Fill it in as a list of **agents**. Example with one agent:

```json
{
  "agents": [
    {
      "name": "default",
      "telegramBotToken": "8553161905:AAH...",
      "whitelist": [1085409133],
      "agentHome": "/Users/you/agents/default",
      "claudeOauthToken": "sk-ant-oat01-...",
      "approvalTimeoutMs": 900000,
      "taskTimeoutMs": 600000
    }
  ]
}
```

Field reference:

| Field | Meaning |
| --- | --- |
| `name` | Short id, lowercase `a–z 0–9 _ -`, unique per agent (used for its data folder). |
| `telegramBotToken` | From @BotFather. One bot per agent. |
| `whitelist` | Numeric Telegram user IDs allowed to talk to this agent. **Non-empty.** |
| `agentHome` | An **existing** folder for this agent's files + memory (`CLAUDE.md`, `memory/`). |
| `claudeOauthToken` | The `claude setup-token` value for this agent. |
| `approvalTimeoutMs` | (optional) default `900000`. |
| `taskTimeoutMs` | (optional) default `600000` — a hung task is aborted after this. |

> Tip: set a top-level `"claudeOauthToken"` to share one token as the default;
> any agent that omits its own token inherits it.

**Save the file.**

---

## 5. Start & verify

**Open `AgentRuntime` again.** It installs the background service and shows
"installed and running ✅". Then in Telegram, message your bot — it should reply.

Check it's running:
```bash
launchctl list | grep agent-runtime      # shows PID and last exit code (0 = healthy)
tail -f "$HOME/Library/Application Support/agent-runtime/logs/agent-runtime.log"
```

---

## 6. Make it start after reboot

The installer already configures auto-start (`RunAtLoad`) and auto-restart on
crash (`KeepAlive`) via a LaunchAgent. Two things to know:

- **It starts at *login*, not the pre-login boot screen** (it needs your user
  session). If this Mac reboots unattended, enable **auto-login** so it reaches
  the desktop and the agent starts:
  *System Settings → Users & Groups → Automatically log in as …*
- **Keep the Mac awake** so scheduled jobs/reminders fire and the bot stays
  reachable:
  ```bash
  sudo pmset -a sleep 0          # optional: displaysleep 10 to still blank the screen
  ```

---

## 7. Add more agents (optional)

Add another object to the `agents` array — each gets its own bot, working
folder, memory, database, and Claude token, all running **in parallel**:

```json
{
  "agents": [
    { "name": "default", "telegramBotToken": "...", "whitelist": [111], "agentHome": "/Users/you/agents/default", "claudeOauthToken": "sk-ant-oat01-..." },
    { "name": "work",    "telegramBotToken": "...", "whitelist": [111], "agentHome": "/Users/you/agents/work",    "claudeOauthToken": "sk-ant-oat01-..." }
  ]
}
```

Create each `agentHome` folder first, then restart the service (below).

---

## 8. Managing the service

```bash
PLIST=~/Library/LaunchAgents/uz.domo.agent-runtime.plist

launchctl kickstart -k gui/$(id -u)/uz.domo.agent-runtime   # restart (after editing config)
launchctl unload "$PLIST"                                   # stop / disable
launchctl load -w "$PLIST"                                  # start / enable
launchctl list | grep agent-runtime                         # status
```

Where things live:

| What | Path |
| --- | --- |
| Config you edit | `~/Library/Application Support/agent-runtime/config.json` |
| Per-agent database | `~/Library/Application Support/agent-runtime/agents/<name>/agent.db` |
| Per-agent persona + memory | `<agentHome>/CLAUDE.md` and `<agentHome>/memory/` |
| Logs | `~/Library/Application Support/agent-runtime/logs/agent-runtime.{log,err.log}` |
| Service definition | `~/Library/LaunchAgents/uz.domo.agent-runtime.plist` |

---

## 9. Updating

To install a newer build: stop the service, replace the app, reopen it.
```bash
launchctl unload ~/Library/LaunchAgents/uz.domo.agent-runtime.plist
# drag the new AgentRuntime.app into /Applications (replace), then open it once
```
Your config, databases, and memory are untouched (they live in App Data and the
agent homes, not inside the app).

---

## 10. Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/uz.domo.agent-runtime.plist
rm ~/Library/LaunchAgents/uz.domo.agent-runtime.plist
rm -rf /Applications/AgentRuntime.app
# optional — also remove all config, databases, logs, backups:
rm -rf "$HOME/Library/Application Support/agent-runtime"
```

---

## 11. Troubleshooting

| Symptom | Fix |
| --- | --- |
| "AgentRuntime can't be opened" (Gatekeeper) | Right-click → Open → Open, or `xattr -dr com.apple.quarantine /Applications/AgentRuntime.app`. |
| "Node.js was not found" dialog | Install Node 22+ from nodejs.org, then open the app again. |
| Bot doesn't reply | `tail` the log (above). Common causes: wrong/duplicate bot token, your ID not in `whitelist`, or an expired `claudeOauthToken` (re-run `claude setup-token` and update config). |
| Service keeps exiting (`launchctl list` shows non-zero) | Check `agent-runtime.err.log`; usually a bad `config.json` (it must be valid JSON) or a missing `agentHome` folder. |
| Doesn't come back after reboot | You're sitting at the login screen — log in, or enable auto-login (§6). |
| Reminders/jobs don't fire on time | The Mac slept; apply `pmset -a sleep 0` (§6). |

---

## 12. Notes

- Unsigned/not notarized — fine for trusted internal use; that's why the first
  open needs right-click → Open.
- Bundled engine is **arm64** (Apple Silicon).
- Each agent's long-term knowledge lives in its `agentHome/memory/` and
  `CLAUDE.md`, so it survives restarts, context compaction, and `/new` resets.
- Useful in-chat commands: `/status`, `/new` (fresh conversation, keeps memory),
  `/cancel`, `/queue`, `/schedules`.
