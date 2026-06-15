#!/bin/sh
# Tests the agent-browser wrapper's isolation logic using a stub "real" binary.
set -eu
WRAP="$(cd "$(dirname "$0")" && pwd)/agent-browser"
TMP="$(mktemp -d)"
STUB="$TMP/stub"
cat > "$STUB" <<'EOF'
#!/bin/sh
echo "PROFILE=$AGENT_BROWSER_PROFILE"
echo "SESSION=$AGENT_BROWSER_SESSION"
echo "ARGS=$*"
EOF
chmod +x "$STUB"
fail() { echo "FAIL: $1" >&2; exit 1; }

# 1. Unset profile/session → derived from cwd; args forwarded; profile dir created.
cd "$TMP"
OUT="$(AGENT_BROWSER_REAL="$STUB" "$WRAP" open https://example.com)"
echo "$OUT" | grep -q "PROFILE=$TMP/.agent-browser/profile" || fail "profile not cwd-derived: $OUT"
echo "$OUT" | grep -q "SESSION=$(basename "$TMP")" || fail "session not cwd-derived: $OUT"
echo "$OUT" | grep -q "ARGS=open https://example.com" || fail "args not forwarded: $OUT"
[ -d "$TMP/.agent-browser/profile" ] || fail "profile dir not created"

# 2. Preset profile/session are respected, not overridden.
OUT="$(AGENT_BROWSER_REAL="$STUB" AGENT_BROWSER_PROFILE="$TMP/preset" AGENT_BROWSER_SESSION=s "$WRAP" snapshot)"
echo "$OUT" | grep -q "PROFILE=$TMP/preset" || fail "preset profile overridden: $OUT"
echo "$OUT" | grep -q "SESSION=s" || fail "preset session overridden: $OUT"

# 3. Isolation: two different cwds → two different profiles.
A="$(mktemp -d)"; B="$(mktemp -d)"
OA="$(cd "$A" && AGENT_BROWSER_REAL="$STUB" "$WRAP" x | grep '^PROFILE=')"
OB="$(cd "$B" && AGENT_BROWSER_REAL="$STUB" "$WRAP" x | grep '^PROFILE=')"
[ "$OA" != "$OB" ] || fail "two cwds share a profile: $OA == $OB"

echo "ALL TESTS PASSED"
