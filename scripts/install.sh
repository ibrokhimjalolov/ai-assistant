#!/usr/bin/env bash
set -euo pipefail

APP="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
LOGS="$HOME/Library/Application Support/agent-runtime/logs"
PLIST_SRC="$APP/launchd/uz.domo.agent-runtime.plist"
PLIST_DST="$HOME/Library/LaunchAgents/uz.domo.agent-runtime.plist"

echo "Building…"
cd "$APP" && npm run build

mkdir -p "$LOGS" "$HOME/Library/LaunchAgents"
sed -e "s|__NODE__|$NODE|g" -e "s|__APP__|$APP|g" -e "s|__LOGS__|$LOGS|g" "$PLIST_SRC" > "$PLIST_DST"

launchctl bootout "gui/$(id -u)" "$PLIST_DST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
echo "Installed. Logs: $LOGS"
echo "First run creates the config template — fill it in, then: launchctl kickstart -k gui/$(id -u)/uz.domo.agent-runtime"
