# Agent Runtime Monitor

Read-only desktop monitor for the personal agent runtime. Shows daemon status,
each agent's Working/Idle state, sessions, recent tasks, and schedules.

## Requirements
- macOS (reads `~/Library/Application Support/agent-runtime` and uses `launchctl`).
- System `node` ≥ 24 on `PATH` (exposes built-in `node:sqlite` unflagged; this
  machine runs v26). The Electron window reads data by spawning a short-lived
  `node` snapshot subprocess, so it never bundles a native SQLite module.
  Override the binary with `GUI_NODE_BIN=/path/to/node`.

## Run
```
cd gui
npm install
npm start
```

## Test
```
cd gui
npm test
```

## Notes
- Strictly read-only: opens agent DBs with `{ readOnly: true }`; never writes.
- Polls every 3s.
- Out of scope: controls, auth, packaging into a signed `.app`.
