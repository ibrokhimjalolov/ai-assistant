#!/bin/sh
# One-command installer for the agent-runtime daemon (macOS).
#   curl -fsSL https://raw.githubusercontent.com/ibrokhimjalolov/ai-assistant/main/scripts/install-runtime.sh | sh
#
# Downloads the runtime artifact, installs deps for THIS machine's Node (builds
# the native better-sqlite3 locally), installs a launchd service, and starts it.
# Re-runnable (it updates an existing install). It never touches your config.json
# — fill that in first at ~/Library/Application Support/agent-runtime/config.json.
set -eu

TARBALL_URL="https://github.com/ibrokhimjalolov/ai-assistant/releases/download/runtime-v1.0.0/agent-runtime-dist.tar.gz"
LABEL="uz.domo.agent-runtime"
APP_DIR="$HOME/agent-runtime-app"
ROOT="$HOME/Library/Application Support/agent-runtime"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "==> 1/6 locating Node"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  for n in "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$n" ] && NODE_BIN="$n" && break
  done
fi
[ -n "$NODE_BIN" ] || { echo "ERROR: Node not found. Install Node >=18 (e.g. via nvm) and re-run."; exit 1; }
NPM_BIN="$(dirname "$NODE_BIN")/npm"
[ -x "$NPM_BIN" ] || NPM_BIN="$(command -v npm || true)"
[ -n "$NPM_BIN" ] || { echo "ERROR: npm not found next to Node."; exit 1; }
echo "    node: $NODE_BIN ($("$NODE_BIN" -v))"

echo "==> 2/6 stopping any running service"
launchctl unload "$PLIST" 2>/dev/null || true

echo "==> 3/6 downloading runtime"
mkdir -p "$APP_DIR"
curl -fsSL "$TARBALL_URL" -o "$APP_DIR/runtime.tar.gz"
tar -xzf "$APP_DIR/runtime.tar.gz" -C "$APP_DIR"
rm -f "$APP_DIR/runtime.tar.gz"

echo "==> 4/6 installing dependencies (builds better-sqlite3 for your Node; first run ~10-30s)"
( cd "$APP_DIR" && "$NPM_BIN" install --omit=dev --no-audit --no-fund --loglevel=error )

echo "==> 5/6 installing launchd service"
mkdir -p "$ROOT/logs" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$APP_DIR/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$ROOT/logs/agent-runtime.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/agent-runtime.err.log</string>
</dict>
</plist>
PLIST_EOF

echo "==> 6/6 starting service"
launchctl load -w "$PLIST"
sleep 3

echo
echo "==== status ===="
launchctl list | grep "$LABEL" | awk '{print "launchd: PID="$1" laststatus="$2" label="$3}' || echo "launchd: not listed"
echo "--- err.log (last lines) ---"
tail -n 12 "$ROOT/logs/agent-runtime.err.log" 2>/dev/null || echo "(no err.log yet)"
echo "--- agent DBs ---"
if [ -d "$ROOT/agents" ]; then
  for d in "$ROOT/agents"/*/; do [ -d "$d" ] && { n=$(basename "$d"); [ -f "$d/agent.db" ] && echo "  OK  $n -> agent.db created" || echo "  X   $n -> no agent.db"; }; done
else
  echo "  (no agents/ dir — check err.log above for a config error)"
fi
echo
echo "Done. Manage with:"
echo "  restart: launchctl kickstart -k \"gui/\$(id -u)/$LABEL\""
echo "  stop:    launchctl unload \"$PLIST\""
echo "  logs:    tail -f \"$ROOT/logs/agent-runtime.err.log\""
