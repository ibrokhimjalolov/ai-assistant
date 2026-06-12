Agent Runtime — install guide
==============================

A personal AI agent you talk to from a private Telegram bot. It runs in the
background on this Mac (managed by launchd) and starts automatically at login.

PREREQUISITES (on this Mac)
  • Node.js 22 or newer        →  https://nodejs.org
  • Claude Code + a Claude subscription (used to generate the login token below)
  • A Telegram bot token        →  create one with @BotFather

INSTALL
  1. Drag  AgentRuntime.app  onto the  Applications  folder (in this window).
  2. Open it from Applications. Because this build is not notarized, the first
     time you must RIGHT-CLICK the app → Open → Open (a normal double-click will
     be blocked by Gatekeeper). You only do this once.
       (CLI alternative:  xattr -dr com.apple.quarantine /Applications/AgentRuntime.app )
  3. On first open it creates and opens a config file in TextEdit:
        ~/Library/Application Support/agent-runtime/config.json
     It holds an "agents" list. Fill in one (or more) agent:
        name              — short id, lowercase a-z 0-9 _ - (e.g. "default")
        telegramBotToken  — from @BotFather (one bot per agent)
        whitelist         — numeric Telegram user ID(s), e.g. [123456789]
                            (get yours from @userinfobot)
        agentHome         — an EXISTING folder for THIS agent's files & memory,
                            e.g. /Users/you/agents/default   (create it first)
        claudeOauthToken  — run `claude setup-token` in Terminal, paste it
                            (per agent; or set the top-level one as a shared default)
     Add more agents by adding objects to the "agents" array — each gets its own
     bot, workdir, memory, database, and Claude token, all running in parallel.
     Save the file.
  4. Open AgentRuntime again. It installs the background service and shows
     "installed and running".  Message your bot in Telegram to confirm.

MANAGING IT
  • Logs:    ~/Library/Application Support/agent-runtime/logs/
  • Stop:    launchctl unload  ~/Library/LaunchAgents/uz.domo.agent-runtime.plist
  • Start:   launchctl load -w ~/Library/LaunchAgents/uz.domo.agent-runtime.plist
  • Update config: edit config.json, then re-open AgentRuntime (or restart the service).

UNINSTALL
  launchctl unload ~/Library/LaunchAgents/uz.domo.agent-runtime.plist
  rm ~/Library/LaunchAgents/uz.domo.agent-runtime.plist
  rm -rf /Applications/AgentRuntime.app
  # optional — removes config, database, logs, and backups:
  rm -rf ~/Library/Application\ Support/agent-runtime

NOTES
  • This build is unsigned/not notarized (fine for trusted internal use) — hence
    the one-time right-click→Open step above.
  • The bundled engine is built for Apple Silicon (arm64).
  • The Mac should stay awake for scheduled jobs/reminders to fire on time.
