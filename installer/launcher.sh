#!/bin/bash
# Agent Runtime — installer/launcher (the .app's executable).
# It configures and (re)installs the launchd service; the daemon itself runs
# under launchd. Re-opening the app updates/restarts it.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
RES="$(cd "$SELF_DIR/../Resources" && pwd)"

APP_DATA="$HOME/Library/Application Support/agent-runtime"
CONFIG="$APP_DATA/config.json"
LOGS="$APP_DATA/logs"
LA_DIR="$HOME/Library/LaunchAgents"
PLIST="$LA_DIR/uz.domo.agent-runtime.plist"

dialog() {
  /usr/bin/osascript -e "display dialog \"$1\" with title \"Agent Runtime\" buttons {\"OK\"} default button \"OK\" with icon note" >/dev/null 2>&1 || true
}

# Don't run from the mounted DMG — must be installed somewhere stable first.
case "$RES" in
  /Volumes/*)
    dialog "Please drag AgentRuntime.app into the Applications folder first, then open it from there."
    exit 0 ;;
esac

mkdir -p "$LOGS" "$LA_DIR"

# Locate Node (Node 22+ is assumed installed on the machine).
NODE=""
for c in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
done
if [ -z "$NODE" ]; then
  dialog "Node.js was not found. Install Node 22 or newer from https://nodejs.org, then open Agent Runtime again."
  exit 1
fi

# Configured? (telegramBotToken set to a non-empty string)
if [ ! -f "$CONFIG" ] || ! /usr/bin/grep -Eq '"telegramBotToken"[[:space:]]*:[[:space:]]*"[^"]+"' "$CONFIG"; then
  if [ ! -f "$CONFIG" ]; then cp "$RES/config.template.json" "$CONFIG"; chmod 600 "$CONFIG"; fi
  /usr/bin/open "$RES/README.txt" >/dev/null 2>&1 || true
  /usr/bin/open -e "$CONFIG" >/dev/null 2>&1 || true
  dialog "Welcome to Agent Runtime.

Fill in config.json (now open in TextEdit):
• telegramBotToken — from @BotFather
• whitelist — your numeric Telegram user IDs, e.g. [123456789]
• agentHome — an EXISTING folder, e.g. /Users/$USER/AgentHome
• claudeOauthToken — run 'claude setup-token' in Terminal, paste the token

Save the file, then open Agent Runtime again to start."
  exit 0
fi

# Render the launchd plist for THIS install location, then (re)load it.
/usr/bin/sed -e "s#__NODE__#${NODE}#g" -e "s#__APP__#${RES}#g" -e "s#__LOGS__#${LOGS}#g" \
  "$RES/launchd.plist.template" > "$PLIST"

/bin/launchctl unload "$PLIST" >/dev/null 2>&1 || true
if /bin/launchctl load -w "$PLIST" >/dev/null 2>&1; then
  sleep 2
  dialog "Agent Runtime is installed and running. ✅

• Starts automatically at login.
• Logs: $LOGS
• To stop:  launchctl unload \"$PLIST\""
else
  /usr/bin/open "$LOGS" >/dev/null 2>&1 || true
  dialog "The service failed to start. The logs folder just opened — check agent-runtime.err.log."
  exit 1
fi
