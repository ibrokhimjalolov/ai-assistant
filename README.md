# agent-runtime

Always-on personal agent on macOS, driven from Telegram, powered by your local
Claude Code with **subscription auth** (no API key).

## Prerequisites

1. **Node.js 22+** — `brew install node`
2. **Claude Code** installed and logged in with your subscription:
   `npm i -g @anthropic-ai/claude-code && claude login`
   (Headless alternative: `claude setup-token`, put the token into `claudeOauthToken` in config.)
3. **Telegram bot** — create via [@BotFather](https://t.me/BotFather), keep the token.
4. **Agent Home folder** — create the folder where the agent's CLAUDE.md, memory
   and working files will live (you provide it; the runtime scaffolds templates
   into it if empty): `mkdir -p ~/AgentHome`
5. **Keep the Mac awake** — `sudo pmset -a sleep 0; sudo pmset -a disablesleep 1`

## Install

```bash
npm install
./scripts/install.sh        # builds, installs the LaunchAgent, starts it
```

First start writes a config template to
`~/Library/Application Support/agent-runtime/config.json`. Fill in:

- `telegramBotToken` — from BotFather
- `whitelist` — array of allowed Telegram user IDs (everyone listed has FULL
  control of this machine; keep it short and trusted)
- `agentHome` — absolute path to your Agent Home folder

Then restart: `launchctl kickstart -k gui/$(id -u)/uz.domo.agent-runtime`

## Chat commands

`/status` uptime+queue · `/queue` pending tasks · `/cancel` abort your running
task · `/new` rotate conversation (saves memory first) · `/schedules` list jobs

## Manual smoke checklist (release gate)

- [ ] Send a message from a whitelisted account → typing indicator shows, then the answer.
- [ ] Send from a non-whitelisted account → silently ignored (check logs).
- [ ] Ask for something risky ("delete /tmp/x") → Approve/Deny buttons; Deny → agent reports denial.
- [ ] `kill -9` the daemon mid-task → launchd restarts it; "interrupted" message with Resume button arrives; Resume continues in the same session.
- [ ] Ask "remind me in 2 minutes to stretch" → schedule fires, proactive message arrives.
- [ ] Hit the subscription usage limit (or simulate) → pause notification with reset time; queue resumes after reset.
- [ ] Reboot the Mac → daemon comes back, queued messages survive.
