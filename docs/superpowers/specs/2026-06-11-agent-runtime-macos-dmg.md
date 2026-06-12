# Agent Runtime — macOS DMG Installer

**Date:** 2026-06-11
**Status:** Approved design, pending implementation
**Owner:** Ibrokhim

## 1. Goal

Package the existing personal agent runtime as a single double-clickable macOS
installer distributed as one `.dmg`, so a trusted teammate can install it without
manual `npm`/`tsc`/`launchctl` steps. Configuration is done by editing one
`config.json`. The runtime continues to run under launchd (the `.app` is the
installer/manager, not the long-running process).

## 2. Decisions (locked)

- **Audience:** a few trusted teammates → **unsigned**, ad-hoc-signed build. No
  Apple notarization. First launch uses the one-time right-click → Open Gatekeeper
  step (documented in the README). Public distribution is out of scope.
- **Self-containment:** assume the target Mac has **Node 22+** and a **Claude
  subscription**. The app bundles the prebuilt `dist/` and `node_modules` (so no
  `npm install`), uses the **system `node`**, and uses the Agent SDK's bundled
  Claude engine. Auth is a `claude setup-token` pasted into `config.json`
  (generating it needs Claude Code installed; running the daemon does not).
- **Setup UX:** **edit one config file**. First launch writes a `config.json`
  template and opens it; a second launch (after it's filled) installs + starts
  the launchd service.

## 3. Deliverables

1. `scripts/build-dmg.sh` — produces `AgentRuntime.dmg` from a clean tree.
2. `installer/` — source assets the build script consumes:
   - `installer/Info.plist.template`
   - `installer/launcher.sh` (the app's `Contents/MacOS` executable)
   - `installer/launchd.plist.template` (already exists at `launchd/uz.domo.agent-runtime.plist`; reuse/adapt)
   - `installer/config.template.json`
   - `installer/README.txt` (install steps incl. right-click→Open, prereqs, token)
3. The built `AgentRuntime.dmg` (produced locally, test-mounted).

## 4. DMG layout

```
AgentRuntime.dmg  (mounts as "Agent Runtime")
├── AgentRuntime.app
├── Applications -> /Applications   (symlink; drag-to-install)
└── README.txt
```

## 5. .app bundle layout

```
AgentRuntime.app/Contents/
├── Info.plist                # CFBundleExecutable=launcher, bundle id uz.domo.agent-runtime, LSUIElement=1
├── MacOS/launcher            # bash; the app's executable
└── Resources/
    ├── dist/                 # prebuilt JS (tsc output)
    ├── node_modules/         # bundled deps incl. @anthropic-ai/claude-agent-sdk
    ├── package.json
    ├── config.template.json
    ├── launchd.plist.template
    └── README.txt
```

Node module resolution: `dist/index.js` lives at `Resources/dist/index.js`; Node
walks up and resolves `Resources/node_modules` — no `NODE_PATH` needed, but the
launchd plist sets a sane `PATH` so the SDK can find `node`.

## 6. Launcher behavior (`Contents/MacOS/launcher`)

On every double-click:

1. Resolve `RES="$(.../Contents/Resources)"`, `APP_DATA="$HOME/Library/Application Support/agent-runtime"`.
2. `mkdir -p "$APP_DATA/logs"`.
3. Locate `node` (PATH, then `/opt/homebrew/bin`, `/usr/local/bin`). If absent →
   error dialog ("Install Node 22+ from nodejs.org") and exit.
4. **If `config.json` missing OR `telegramBotToken` empty:** copy
   `config.template.json` → `config.json` (mode 600) if missing; `open -e` the
   `config.json` and `open` the README; show dialog: *"Fill in config.json (bot
   token, whitelist, agentHome, claudeOauthToken), save, then re-open AgentRuntime
   to start."*; exit 0.
5. **Else (configured):** render `launchd.plist.template` (`__NODE__`, the app's
   `Resources/dist/index.js`, `__LOGS__`) → `~/Library/LaunchAgents/uz.domo.agent-runtime.plist`;
   `launchctl unload` (ignore errors) then `launchctl load -w`; show dialog:
   *"Installed & running ✅. Starts automatically at login; manage with launchctl."*; exit 0.

Re-opening the app re-renders the plist (picks up a moved `.app`) and reloads —
acts as update/restart. All user-facing messages use `osascript -e 'display dialog…'`.

## 7. config.template.json

```json
{
  "telegramBotToken": "",
  "whitelist": [],
  "agentHome": "",
  "claudeOauthToken": "",
  "approvalTimeoutMs": 900000,
  "taskTimeoutMs": 600000
}
```
(README explains each field + how to get a `claude setup-token`.)

## 8. build-dmg.sh steps

1. `cd` repo root; `rm -rf dist && npx tsc` (clean build incl. all recent fixes).
2. `npm prune --omit=dev` into a staging copy of `node_modules` (ship runtime deps
   only; keep `vitest`/`tsx`/types out). Build in a temp staging dir to avoid
   touching the dev tree.
3. Assemble `build/AgentRuntime.app/Contents/{Info.plist,MacOS/launcher,Resources/…}`;
   `chmod +x` the launcher; copy `dist`, pruned `node_modules`, templates, README.
4. `codesign --force --deep --sign - build/AgentRuntime.app` (ad-hoc).
5. Stage a DMG root with the `.app`, `ln -s /Applications`, `README.txt`;
   `hdiutil create -volname "Agent Runtime" -srcfolder <root> -ov -format UDZO AgentRuntime.dmg`.
6. Print the output path + size.

## 9. Non-goals

- No bundled Node runtime (assume system Node).
- No GUI config wizard (edit-config only).
- No notarization / Developer ID signing.
- No menu-bar/status UI; the `.app` only installs/updates/starts.
- No auto-update mechanism.

## 10. Testing / verification

- **Unit-ish:** `bash -n` syntax-check launcher + build script; render the plist
  template and assert placeholders resolved.
- **Build:** run `build-dmg.sh`; assert `AgentRuntime.dmg` exists and mounts
  (`hdiutil attach`), contains `AgentRuntime.app` + `Applications` alias + README,
  and `codesign --verify` passes (ad-hoc).
- **Smoke (manual, documented):** on a target Mac — open app → fill config →
  re-open → `launchctl list | grep agent-runtime` shows it running and the bot
  answers. (Full smoke not automatable headlessly.)

## 11. Caveats (carried into README)

- Unsigned: first open = right-click → Open (or `xattr -dr com.apple.quarantine`).
- Requires Node 22+ and a Claude subscription + a `claude setup-token`.
- DMG ~100–200 MB (bundled deps).
- Moving the `.app` after install: just re-open it to re-point the launchd plist.
