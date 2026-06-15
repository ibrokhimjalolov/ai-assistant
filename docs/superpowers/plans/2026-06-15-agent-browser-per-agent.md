# Per-Agent Agentic Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. NOTE: Tasks 1, 3, 4, 5 make **system changes outside the repo** (global npm install, Chrome download, placing a wrapper on disk, editing the live agent's `CLAUDE.md`, launching real Chrome). These should be run inline with the owner's confirmation, not by an unattended subagent.

**Goal:** Give the runtime's agents web browsing via Vercel's `agent-browser`, isolated per agent (own persistent profile, no cross-agent conflict), with **no edits to the source-less runtime**.

**Architecture:** A small `sh` wrapper around `agent-browser` scopes `AGENT_BROWSER_PROFILE`/`AGENT_BROWSER_SESSION` to the caller's working directory (= each agent's Agent Home). Agents call the wrapper by absolute path (launchd `PATH` is minimal) and learn the workflow from their Agent Home `CLAUDE.md` (which the runtime already loads). Isolation is enforced by the wrapper; the agent-browser daemon runs concurrent sessions without conflict.

**Tech Stack:** `agent-browser` (Rust CLI + CDP daemon), POSIX `sh` wrapper + shell test, the runtime's existing `settingSources: ['project','local']` CLAUDE.md loading.

---

## Key paths (this machine)
- Repo: `/Users/ibrokhim/AIAssistent/ai_assistent`
- Wrapper source (repo): `scripts/agent-browser`
- Wrapper test (repo): `scripts/agent-browser.test.sh`
- Installed wrapper (stable abs path agents call): `/Users/ibrokhim/AIAssistent/bin/agent-browser`
- `default` agent's Agent Home: `/Users/ibrokhim/AIAssistent/workdir` (its `CLAUDE.md` is loaded by the runtime)
- Per-agent profiles (auto, persistent): `<agentHome>/.agent-browser/profile`

`<REAL_AB>` below = the absolute path to the real `agent-browser` binary, captured in Task 1.

---

## Task 1: Install agent-browser + Chrome (system)

**No code. System setup. Confirm with owner before running.**

- [ ] **Step 1: Install the CLI globally**

Run: `npm install -g agent-browser`
Expected: completes; `agent-browser` is installed.

- [ ] **Step 2: Capture the real binary's absolute path (this is `<REAL_AB>`)**

Run: `command -v agent-browser`
Expected: an absolute path, e.g. `/opt/homebrew/bin/agent-browser` or `/usr/local/bin/agent-browser` or an nvm path. **Record it — it is `<REAL_AB>` used in Tasks 2 & 3.**

- [ ] **Step 3: Download the browser it drives**

Run: `agent-browser install`
Expected: downloads Chrome for Testing; finishes without error.

- [ ] **Step 4: Smoke-test the real CLI**

Run: `agent-browser --version && AGENT_BROWSER_PROFILE="$(mktemp -d)/p" agent-browser open https://example.com && agent-browser snapshot -i | head -5 && agent-browser close`
Expected: prints a version, opens the page, prints a snapshot with refs (`@e1`…), closes cleanly. (No commit — nothing in the repo changed.)

---

## Task 2: Wrapper script + shell test (TDD)

**Files:**
- Create: `scripts/agent-browser`
- Test: `scripts/agent-browser.test.sh`

- [ ] **Step 1: Write the failing test `scripts/agent-browser.test.sh`**

```sh
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `sh scripts/agent-browser.test.sh`
Expected: FAIL — `scripts/agent-browser` does not exist yet (wrapper not found / not executable).

- [ ] **Step 3: Write the wrapper `scripts/agent-browser`**

Replace `<REAL_AB>` with the absolute path captured in Task 1 Step 2.

```sh
#!/bin/sh
# Per-agent isolation wrapper for agent-browser. Scopes the browser profile and
# session to the caller's working directory (each agent's Agent Home) so agents
# never share browser state. Override the real binary via AGENT_BROWSER_REAL
# (used by the test). Agents call this by absolute path (launchd PATH is minimal).
REAL="${AGENT_BROWSER_REAL:-<REAL_AB>}"
: "${AGENT_BROWSER_PROFILE:=$PWD/.agent-browser/profile}"
: "${AGENT_BROWSER_SESSION:=$(basename "$PWD")}"
export AGENT_BROWSER_PROFILE AGENT_BROWSER_SESSION
mkdir -p "$AGENT_BROWSER_PROFILE"
exec "$REAL" "$@"
```

- [ ] **Step 4: Make it executable and run the test to verify it passes**

Run: `chmod +x scripts/agent-browser && sh scripts/agent-browser.test.sh`
Expected: `ALL TESTS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add scripts/agent-browser scripts/agent-browser.test.sh
git commit -m "feat(browser): per-agent isolation wrapper for agent-browser + test"
```

---

## Task 3: Install the wrapper to its stable absolute path (system)

**Confirm with owner. Installs the wrapper where agents will call it.**

- [ ] **Step 1: Create the bin dir and copy the wrapper**

Run:
```bash
mkdir -p /Users/ibrokhim/AIAssistent/bin
cp scripts/agent-browser /Users/ibrokhim/AIAssistent/bin/agent-browser
chmod +x /Users/ibrokhim/AIAssistent/bin/agent-browser
```
Expected: file exists and is executable.

- [ ] **Step 2: Verify the installed wrapper isolates by cwd against the REAL binary**

Run (uses the real agent-browser via the baked-in `<REAL_AB>`, headless):
```bash
WD="$(mktemp -d)"; cd "$WD"; /Users/ibrokhim/AIAssistent/bin/agent-browser open https://example.com && /Users/ibrokhim/AIAssistent/bin/agent-browser snapshot -i | head -3 && /Users/ibrokhim/AIAssistent/bin/agent-browser close; ls -d "$WD/.agent-browser/profile"
```
Expected: opens/snapshots/closes; `"$WD/.agent-browser/profile"` exists (proves the wrapper created a cwd-scoped persistent profile).

---

## Task 4: Teach the `default` agent (system — edits the live agent's CLAUDE.md)

**Confirm with owner. Edits `/Users/ibrokhim/AIAssistent/workdir/CLAUDE.md`.**

- [ ] **Step 1: Read the current CLAUDE.md**

Run: `cat /Users/ibrokhim/AIAssistent/workdir/CLAUDE.md` (so the new section is appended cleanly, not duplicating an existing one).

- [ ] **Step 2: Append the "Web browsing" section**

Append exactly this block to `/Users/ibrokhim/AIAssistent/workdir/CLAUDE.md`:

```markdown

## Web browsing

You can browse the web with the `agent-browser` CLI. Always call it by its
**absolute path** (PATH is minimal under the daemon):

    /Users/ibrokhim/AIAssistent/bin/agent-browser <command>

Your browser profile and session are **isolated and persistent automatically** —
never pass `--profile` or `--session`. Typical flow:

    /Users/ibrokhim/AIAssistent/bin/agent-browser open https://example.com
    /Users/ibrokhim/AIAssistent/bin/agent-browser snapshot -i      # lists refs @e1, @e2…
    /Users/ibrokhim/AIAssistent/bin/agent-browser click @e2
    /Users/ibrokhim/AIAssistent/bin/agent-browser fill @e3 "search text"
    /Users/ibrokhim/AIAssistent/bin/agent-browser screenshot
    /Users/ibrokhim/AIAssistent/bin/agent-browser close

Snapshots return accessibility refs (`@e1`…) — use those to click/fill, then
re-snapshot to see the result. Close the browser when the task is done.
```

- [ ] **Step 3: Verify the edit**

Run: `tail -25 /Users/ibrokhim/AIAssistent/workdir/CLAUDE.md`
Expected: the "Web browsing" section is present at the end, intact.

---

## Task 5: End-to-end verification

- [ ] **Step 1: Re-run the wrapper unit test**

Run: `sh scripts/agent-browser.test.sh`
Expected: `ALL TESTS PASSED`.

- [ ] **Step 2: Prove cross-agent isolation with the real binary**

Run:
```bash
A="$(mktemp -d)"; B="$(mktemp -d)"
( cd "$A" && /Users/ibrokhim/AIAssistent/bin/agent-browser open https://example.com >/dev/null && /Users/ibrokhim/AIAssistent/bin/agent-browser close )
( cd "$B" && /Users/ibrokhim/AIAssistent/bin/agent-browser open https://example.org >/dev/null && /Users/ibrokhim/AIAssistent/bin/agent-browser close )
ls -d "$A/.agent-browser/profile" "$B/.agent-browser/profile"
```
Expected: BOTH profile dirs exist and are distinct — two "agents" got separate persistent profiles (no conflict).

- [ ] **Step 3: Live end-to-end via the agent (owner runs through Telegram)**

Ask the `default` agent via Telegram something like: *"Using agent-browser, open example.com and tell me the page heading."*
Expected: the agent runs the wrapper, returns the heading ("Example Domain"), and a profile appears at `/Users/ibrokhim/AIAssistent/workdir/.agent-browser/profile`.

Run (to confirm the agent used its own home profile):
```bash
ls -d /Users/ibrokhim/AIAssistent/workdir/.agent-browser/profile
```
Expected: the directory exists.

---

## Task 6: Document + finalize

**Files:**
- Create: `scripts/README.md`

- [ ] **Step 1: Write `scripts/README.md`**

```markdown
# agent-browser wrapper

`agent-browser` here is a thin wrapper that gives each runtime agent its own
**isolated, persistent** browser profile, so parallel agents never conflict.

- It scopes `AGENT_BROWSER_PROFILE` and `AGENT_BROWSER_SESSION` to the caller's
  working directory (each agent's Agent Home), then execs the real
  `agent-browser` (Vercel Labs).
- Agents call it by absolute path (`/Users/ibrokhim/AIAssistent/bin/agent-browser`)
  because the launchd daemon's PATH is minimal. Usage is taught in each agent's
  Agent Home `CLAUDE.md`.

## Install / update
    npm i -g agent-browser && agent-browser install   # one-time
    cp scripts/agent-browser /Users/ibrokhim/AIAssistent/bin/agent-browser
    chmod +x /Users/ibrokhim/AIAssistent/bin/agent-browser

Set `AGENT_BROWSER_REAL` to override the real binary (used by the test).

## Test
    sh scripts/agent-browser.test.sh
```

- [ ] **Step 2: Commit**

```bash
git add scripts/README.md
git commit -m "docs(browser): document the agent-browser isolation wrapper"
```

---

## Self-review notes (resolved)
- **Spec coverage:** install (Task 1), wrapper isolation by cwd + enforcement (Task 2), absolute-path invocation / stable install (Task 3), CLAUDE.md instructions (Task 4), persistent per-agent profiles + no-conflict proof (Tasks 2/5), headless default (real binary default; no `--headed`), no runtime/`dist` edits (entire approach). Security/auto-run posture is inherited (documented in spec; no action). All covered.
- **No placeholders:** the only token is `<REAL_AB>`, explicitly defined (Task 1 Step 2) and substituted in Task 2 Step 3 / baked into Task 3's installed copy; `AGENT_BROWSER_REAL` overrides it for tests.
- **Consistency:** `AGENT_BROWSER_PROFILE`/`AGENT_BROWSER_SESSION`/`AGENT_BROWSER_REAL` and the wrapper/install paths are used identically across Tasks 2–5.
