# Agent Runtime Monitor

Read-only desktop monitor for the personal agent runtime. Shows daemon status,
each agent's Working/Idle state, sessions, recent tasks, and schedules.

## Requirements
- macOS (reads `~/Library/Application Support/agent-runtime` and uses `launchctl`).
- No external runtime dependency. The window reads data by spawning a short-lived
  snapshot subprocess that uses Electron's **own bundled Node** (`node:sqlite`
  behind `--experimental-sqlite`) — so the packaged `.app` works when
  double-clicked, with no `node` on `PATH`. To force a specific Node binary
  instead, set `GUI_NODE_BIN=/path/to/node` (Node ≥ 24, no flag needed).
- There are no native modules and no `electron-rebuild` step.

## Run (development)
```
cd gui
npm install
npm start
```

## Build a double-clickable app / .dmg
```
cd gui
npm install
npm run dmg      # packages, ad-hoc signs, builds dist-app/Agent-Runtime-Monitor.dmg
```
`npm run package` alone produces the raw `.app`, but **use `npm run dmg`** — it
also **ad-hoc signs** the bundle and stages with `ditto`. Both matter on Apple
Silicon: electron-packager leaves an invalid signature on the renamed bundle, and
`cp -R` corrupts signatures — either one makes macOS report the app as
**"damaged and can't be opened."**

The app is **not Developer-ID signed/notarized** (that needs a paid Apple
account), so a **downloaded** copy is quarantined and the first launch needs
**right-click → Open**, or strip the quarantine flag:
```
xattr -dr com.apple.quarantine "/Applications/Agent Runtime Monitor.app"
```
Locally built copies launch normally.

## Test
```
cd gui
npm test
```

## Notes
- Strictly read-only: opens agent DBs with `{ readOnly: true }`; never writes.
- Polls every 3s.
- Out of scope: controls, auth, code-signing/notarization, `.dmg` installer.
