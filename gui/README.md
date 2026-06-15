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

## Build a double-clickable app
```
cd gui
npm install
npm run package
```
Produces `dist-app/Agent Runtime Monitor-darwin-<arch>/Agent Runtime Monitor.app`.
Drag it to `/Applications` and double-click. The app is **unsigned**, so if it was
copied/downloaded to another Mac, Gatekeeper will block the first launch —
right-click → **Open** once to allow it. (Locally built copies launch normally.)

## Test
```
cd gui
npm test
```

## Notes
- Strictly read-only: opens agent DBs with `{ readOnly: true }`; never writes.
- Polls every 3s.
- Out of scope: controls, auth, code-signing/notarization, `.dmg` installer.
