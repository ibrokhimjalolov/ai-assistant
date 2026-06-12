#!/bin/bash
# Build a one-file macOS installer DMG for the agent runtime.
# Produces AgentRuntime.dmg containing AgentRuntime.app + an Applications alias + README.
# Assumes the TARGET Mac has Node 22+ and Claude Code; bundles dist/ + prod node_modules.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

APP_NAME="AgentRuntime"
VOL="Agent Runtime"
BUILD="$REPO/build"
APP="$BUILD/$APP_NAME.app"
STAGE="$BUILD/stage"
DMGROOT="$BUILD/dmgroot"
DMG="$REPO/$APP_NAME.dmg"

echo "==> clean build dir"
rm -rf "$BUILD" "$DMG"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$STAGE" "$DMGROOT"

echo "==> tsc (clean build)"
rm -rf dist && npx tsc

echo "==> stage production node_modules (copy + prune dev deps; preserves native binary)"
cp -R node_modules "$STAGE/node_modules"
cp package.json package-lock.json "$STAGE/" 2>/dev/null || cp package.json "$STAGE/"
( cd "$STAGE" && npm prune --omit=dev >/dev/null 2>&1 ) || echo "   (npm prune skipped — shipping full tree)"
test -f "$STAGE/node_modules/better-sqlite3/build/Release/better_sqlite3.node" \
  || { echo "FATAL: better-sqlite3 native binary missing after staging"; exit 1; }
echo "   prod node_modules: $(du -sh "$STAGE/node_modules" | cut -f1)"

echo "==> assemble .app"
cp installer/Info.plist                 "$APP/Contents/Info.plist"
cp installer/launcher.sh                "$APP/Contents/MacOS/launcher"
chmod +x "$APP/Contents/MacOS/launcher"
cp -R dist                              "$APP/Contents/Resources/dist"
cp -R "$STAGE/node_modules"             "$APP/Contents/Resources/node_modules"
cp package.json                         "$APP/Contents/Resources/package.json"
cp installer/config.template.json       "$APP/Contents/Resources/config.template.json"
cp launchd/uz.domo.agent-runtime.plist  "$APP/Contents/Resources/launchd.plist.template"
cp installer/README.txt                 "$APP/Contents/Resources/README.txt"

echo "==> smoke test: bundled payload loads (exercises imports incl. better-sqlite3 + Agent SDK)"
SMOKE_HOME="$(mktemp -d)"
set +e
OUT="$(HOME="$SMOKE_HOME" "$(command -v node)" "$APP/Contents/Resources/dist/index.js" 2>&1)"
set -e
if echo "$OUT" | grep -q "First run: created config template"; then
  echo "   smoke OK (payload loaded, reached config gate)"
else
  echo "   SMOKE FAILED — bundled payload did not load:"; echo "$OUT" | head -25; rm -rf "$SMOKE_HOME"; exit 1
fi
rm -rf "$SMOKE_HOME"

echo "==> ad-hoc codesign"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP" >/dev/null 2>&1 && echo "   codesign verify ok"

echo "==> assemble DMG root"
cp -R "$APP" "$DMGROOT/"
ln -s /Applications "$DMGROOT/Applications"
cp installer/README.txt "$DMGROOT/README.txt"

echo "==> create DMG"
hdiutil create -volname "$VOL" -srcfolder "$DMGROOT" -ov -format UDZO "$DMG" >/dev/null
echo "==> DONE: $DMG ($(du -h "$DMG" | cut -f1))"
