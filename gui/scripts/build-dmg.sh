#!/bin/sh
# Build a signed, double-clickable .dmg for Agent Runtime Monitor.
#
# Two macOS gotchas this handles:
#  1. electron-packager leaves the renamed bundle with an invalid/mismatched
#     ad-hoc signature → on Apple Silicon the app opens as "damaged". We re-sign
#     the whole bundle ad-hoc so it has a valid signature.
#  2. `cp -R` breaks code signatures; we stage with `ditto`, which preserves them.
#
# The result is still NOT Developer-ID signed/notarized, so a downloaded copy is
# quarantined: first launch needs right-click -> Open (or strip quarantine with
#   xattr -dr com.apple.quarantine "/Applications/Agent Runtime Monitor.app").
set -eu
cd "$(dirname "$0")/.."                       # gui/
APP="dist-app/Agent Runtime Monitor-darwin-arm64/Agent Runtime Monitor.app"
OUT="dist-app/Agent-Runtime-Monitor.dmg"

npm run package
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

STAGE="$(mktemp -d)"
ditto "$APP" "$STAGE/Agent Runtime Monitor.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Agent Runtime Monitor" -srcfolder "$STAGE" -ov -format UDZO "$OUT"
rm -rf "$STAGE"
echo "Built and signed: $OUT"
