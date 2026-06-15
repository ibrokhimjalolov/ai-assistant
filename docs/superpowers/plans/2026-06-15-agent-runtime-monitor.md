# Agent Runtime Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, read-only Electron desktop app (`gui/`) that shows the personal agent runtime's live state — daemon status, which agents are Working/Idle, sessions, recent tasks, and schedules.

**Architecture:** A pure-Node data core (`gui/src/datasource.js`) reads each agent's SQLite DB read-only via Node's built-in `node:sqlite` (WAL-aware) and probes daemon liveness via `launchctl`. A thin CLI (`gui/src/snapshot-cli.js`) prints the snapshot as JSON. The Electron main process spawns that CLI under **system Node** (verified to expose `node:sqlite` unflagged) every 3s and relays the JSON to a plain HTML/CSS/JS renderer. No native modules, no `electron-rebuild`. The data core is unit-tested with Vitest against fixture DBs.

**Tech Stack:** Electron (window only), Node built-in `node:sqlite` (read-only, WAL-aware), Vitest, plain HTML/CSS/JS. CommonJS throughout.

---

## Environment facts (verified 2026-06-15)

- App Data root: `~/Library/Application Support/agent-runtime`.
- `config.json` currently uses the **legacy single-agent** shape (top-level `telegramBotToken`, `whitelist`, `agentHome`). The runtime treats this as one agent named `default`. We mirror that.
- Per-agent DB: `<root>/agents/<name>/agent.db` (WAL mode; live `-wal`/`-shm` sidecars exist).
- System `node` is **v26** and exposes `node:sqlite` with no flag; `DatabaseSync(path,{readOnly:true})` reads current WAL data. (Verified.)
- launchd label: `uz.domo.agent-runtime`. `launchctl list | grep <label>` yields a `PID<TAB>STATUS<TAB>LABEL` line; numeric PID column ⇒ running.
- Relevant tables: `tasks(id,source,kind,user_id,chat_id,prompt,status,session_id,result_summary,created_at,started_at,finished_at)`, `sessions(user_id,claude_session_id,created_at)`, `schedules(id,cron_expr,run_at,prompt,enabled,missed_policy,created_by_user_id,chat_id,last_run_at)`.
- Timestamp formats differ: `tasks.*` and `sessions.created_at` are `YYYY-MM-DD HH:MM:SS` (UTC, no `Z`); `schedules.run_at`/`last_run_at` are ISO-8601 with `Z`. The `parseSqliteTime` helper handles both.

## File structure

```
gui/
  package.json          # scripts + devDeps (electron, vitest). NO runtime deps.
  .gitignore            # node_modules
  README.md             # how to run
  main.js               # Electron main: window + IPC + spawns snapshot CLI
  preload.js            # contextBridge → window.api.getSnapshot()
  src/
    paths.js            # path resolution (root-overridable)
    datasource.js       # PURE core: config normalize, per-agent read, daemon, getSnapshot
    snapshot-cli.js     # thin: getSnapshot() → JSON to stdout (honors GUI_APPDATA_ROOT)
  renderer/
    index.html
    style.css
    format.mjs          # PURE formatting helpers, ESM (tested) — browser loads it natively
    renderer.mjs        # ESM; polls window.api.getSnapshot() every 3s, paints
  test/
    paths.test.js
    datasource.test.js
    format.test.js
    snapshot-cli.test.js
    helpers.js          # fixture-DB builder (writable node:sqlite)
```

---

## Task 1: Scaffold the `gui/` package

**Files:**
- Create: `gui/package.json`
- Create: `gui/.gitignore`

- [ ] **Step 1: Create `gui/package.json`**

```json
{
  "name": "agent-runtime-monitor",
  "version": "0.1.0",
  "private": true,
  "description": "Read-only desktop monitor for the personal agent runtime",
  "type": "commonjs",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "test": "vitest run"
  },
  "devDependencies": {
    "electron": "^35.0.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create `gui/.gitignore`**

```
node_modules/
```

- [ ] **Step 3: Install dependencies**

Run: `cd gui && npm install`
Expected: completes; `node_modules/.bin/electron` and `node_modules/.bin/vitest` exist. (No native build step — there are no native deps.)

- [ ] **Step 4: Sanity-check the toolchain**

Run: `cd gui && node -e "require('node:sqlite'); console.log('sqlite ok')" && npx vitest --version && npx electron --version`
Expected: prints `sqlite ok`, a Vitest version, and an Electron version (e.g. `v35.x.x`).

- [ ] **Step 5: Commit**

```bash
git add gui/package.json gui/.gitignore
git commit -m "chore(gui): scaffold agent-runtime-monitor package"
```

---

## Task 2: `paths.js` — path resolution

**Files:**
- Create: `gui/src/paths.js`
- Test: `gui/test/paths.test.js`

- [ ] **Step 1: Write the failing test**

```js
// gui/test/paths.test.js
import { describe, it, expect } from 'vitest';
import { appDataRoot, configPath, agentsDir, agentDbPath } from '../src/paths.js';

describe('paths', () => {
  it('defaults appDataRoot under ~/Library/Application Support', () => {
    expect(appDataRoot()).toMatch(/Library\/Application Support\/agent-runtime$/);
  });
  it('derives config and per-agent db paths from a given root', () => {
    const root = '/tmp/fake-root';
    expect(configPath(root)).toBe('/tmp/fake-root/config.json');
    expect(agentsDir(root)).toBe('/tmp/fake-root/agents');
    expect(agentDbPath(root, 'default')).toBe('/tmp/fake-root/agents/default/agent.db');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gui && npx vitest run test/paths.test.js`
Expected: FAIL — cannot resolve `../src/paths.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// gui/src/paths.js
'use strict';
const os = require('node:os');
const path = require('node:path');

function appDataRoot() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'agent-runtime');
}
function configPath(root = appDataRoot()) {
  return path.join(root, 'config.json');
}
function agentsDir(root = appDataRoot()) {
  return path.join(root, 'agents');
}
function agentDbPath(root, name) {
  return path.join(agentsDir(root), name, 'agent.db');
}

module.exports = { appDataRoot, configPath, agentsDir, agentDbPath };
```

> Note: tests import with ESM `import` but the file is CommonJS. Vitest resolves `module.exports` as the default and also exposes named bindings via its interop. To keep this seamless, add the Vitest config in Step 4 before running.

- [ ] **Step 4: Add `gui/vitest.config.js` so CJS modules expose named exports**

Create `gui/vitest.config.js`:

```js
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node' },
});
```

(Vitest's default Node interop already maps CommonJS `module.exports = {a,b}` to named ESM imports `{a,b}`. This config just pins the Node environment and silences env auto-detection.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd gui && npx vitest run test/paths.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add gui/src/paths.js gui/test/paths.test.js gui/vitest.config.js
git commit -m "feat(gui): path resolution for app-data root and agent DBs"
```

---

## Task 3: Fixture-DB test helper

**Files:**
- Create: `gui/test/helpers.js`

This helper builds a real, writable SQLite `agent.db` (same schema as the runtime) under a temp App Data root, so later tests exercise the real `node:sqlite` read path.

- [ ] **Step 1: Write the helper (no test of its own — it is exercised by Task 4+)**

```js
// gui/test/helpers.js
'use strict';
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  session_id TEXT,
  result_summary TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE sessions (
  user_id INTEGER PRIMARY KEY,
  claude_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cron_expr TEXT,
  run_at TEXT,
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  missed_policy TEXT NOT NULL DEFAULT 'run_now',
  created_by_user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  last_run_at TEXT
);
`;

// Create a temp App Data root and return its path. Caller cleans up.
function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arm-test-'));
}

// Write config.json (object passed verbatim) at <root>/config.json.
function writeConfig(root, configObj) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(configObj, null, 2));
}

// Build <root>/agents/<name>/agent.db with the schema and the given rows.
// rows = { tasks?: [...], sessions?: [...], schedules?: [...] } where each row
// is an object whose keys match the column names.
function buildAgentDb(root, name, rows = {}) {
  const dir = path.join(root, 'agents', name);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'agent.db'));
  db.exec(SCHEMA);
  insertAll(db, 'tasks', rows.tasks || []);
  insertAll(db, 'sessions', rows.sessions || []);
  insertAll(db, 'schedules', rows.schedules || []);
  db.close();
}

function insertAll(db, table, list) {
  for (const row of list) {
    const cols = Object.keys(row);
    const placeholders = cols.map(() => '?').join(',');
    const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`);
    stmt.run(...cols.map((c) => row[c]));
  }
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

module.exports = { makeTempRoot, writeConfig, buildAgentDb, cleanup };
```

- [ ] **Step 2: Quick smoke-run that the helper imports cleanly**

Run: `cd gui && node -e "const h=require('./test/helpers.js'); const r=h.makeTempRoot(); h.buildAgentDb(r,'default',{tasks:[{source:'telegram',user_id:1,chat_id:1,prompt:'hi',status:'done',created_at:'2026-06-15 03:00:00'}]}); console.log('built at',r); h.cleanup(r);"`
Expected: prints `built at /tmp/arm-test-...` with no error.

- [ ] **Step 3: Commit**

```bash
git add gui/test/helpers.js
git commit -m "test(gui): fixture-DB builder helper"
```

---

## Task 4: `parseSqliteTime` + `loadAgents` (config normalization)

**Files:**
- Create: `gui/src/datasource.js`
- Test: `gui/test/datasource.test.js`

- [ ] **Step 1: Write the failing test**

```js
// gui/test/datasource.test.js
import { describe, it, expect, afterEach } from 'vitest';
import { parseSqliteTime, loadAgents } from '../src/datasource.js';
import { makeTempRoot, writeConfig, cleanup } from './helpers.js';

let roots = [];
afterEach(() => { roots.forEach(cleanup); roots = []; });
function tmp() { const r = makeTempRoot(); roots.push(r); return r; }

describe('parseSqliteTime', () => {
  it('parses space-separated UTC datetime (no Z)', () => {
    const d = parseSqliteTime('2026-06-15 03:00:07');
    expect(d.toISOString()).toBe('2026-06-15T03:00:07.000Z');
  });
  it('parses ISO datetime with Z', () => {
    const d = parseSqliteTime('2026-06-15T03:00:00.790Z');
    expect(d.toISOString()).toBe('2026-06-15T03:00:00.790Z');
  });
  it('returns null for null/empty', () => {
    expect(parseSqliteTime(null)).toBeNull();
    expect(parseSqliteTime('')).toBeNull();
  });
});

describe('loadAgents', () => {
  it('wraps a legacy single-agent config into one agent named default', () => {
    const root = tmp();
    writeConfig(root, { telegramBotToken: 'x', whitelist: [42], agentHome: '/home/x' });
    expect(loadAgents(root)).toEqual([{ name: 'default', agentHome: '/home/x', whitelist: [42] }]);
  });
  it('reads an explicit agents array', () => {
    const root = tmp();
    writeConfig(root, { agents: [
      { name: 'a', telegramBotToken: 't', whitelist: [1], agentHome: '/a' },
      { name: 'b', telegramBotToken: 't', whitelist: [2], agentHome: '/b' },
    ]});
    expect(loadAgents(root)).toEqual([
      { name: 'a', agentHome: '/a', whitelist: [1] },
      { name: 'b', agentHome: '/b', whitelist: [2] },
    ]);
  });
  it('throws ConfigError when neither agents[] nor telegramBotToken present', () => {
    const root = tmp();
    writeConfig(root, { nonsense: true });
    expect(() => loadAgents(root)).toThrow(/agents/);
  });
  it('throws ConfigError when config.json is missing', () => {
    const root = tmp();
    expect(() => loadAgents(root)).toThrow(/config/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gui && npx vitest run test/datasource.test.js`
Expected: FAIL — `../src/datasource.js` not found.

- [ ] **Step 3: Write minimal implementation**

```js
// gui/src/datasource.js
'use strict';
const fs = require('node:fs');
const { configPath } = require('./paths.js');

class ConfigError extends Error {}

// Handle both 'YYYY-MM-DD HH:MM:SS' (UTC, no Z) and ISO-with-Z.
function parseSqliteTime(s) {
  if (!s) return null;
  const str = String(s);
  const iso = str.includes('T') || str.endsWith('Z') ? str : str.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Read <root>/config.json and normalize to [{name, agentHome, whitelist}].
// Mirrors the runtime: agents[] wins; else a top-level telegramBotToken means
// one agent named "default"; else it is an error.
function loadAgents(root) {
  const cp = configPath(root);
  if (!fs.existsSync(cp)) {
    throw new ConfigError(`config.json not found at ${cp}`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(cp, 'utf8'));
  } catch (e) {
    throw new ConfigError(`config.json is not valid JSON: ${e.message}`);
  }
  let list;
  if (Array.isArray(raw.agents)) {
    list = raw.agents;
  } else if (raw.telegramBotToken) {
    list = [{ name: 'default', ...raw }];
  } else {
    throw new ConfigError('config.json must provide an "agents" array or a single-agent telegramBotToken');
  }
  return list.map((a, i) => ({
    name: typeof a.name === 'string' && a.name ? a.name : `agents[${i}]`,
    agentHome: a.agentHome || null,
    whitelist: Array.isArray(a.whitelist) ? a.whitelist : [],
  }));
}

module.exports = { ConfigError, parseSqliteTime, loadAgents };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gui && npx vitest run test/datasource.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add gui/src/datasource.js gui/test/datasource.test.js
git commit -m "feat(gui): time parsing + config normalization"
```

---

## Task 5: `readAgent` — per-agent DB read

**Files:**
- Modify: `gui/src/datasource.js`
- Modify: `gui/test/datasource.test.js`

- [ ] **Step 1: Add the failing test (append to `gui/test/datasource.test.js`)**

```js
// --- append to gui/test/datasource.test.js ---
import { readAgent } from '../src/datasource.js';
import { buildAgentDb } from './helpers.js';

describe('readAgent', () => {
  it('reports Working with current task when a task is running', () => {
    const root = tmp();
    buildAgentDb(root, 'default', { tasks: [
      { source: 'telegram', user_id: 7, chat_id: 7, prompt: 'do a thing', status: 'running',
        session_id: 's1', created_at: '2026-06-15 10:00:00', started_at: '2026-06-15 10:00:01' },
    ]});
    const a = readAgent(root, 'default');
    expect(a.busy).toBe(true);
    expect(a.currentTask.id).toBe(1);
    expect(a.currentTask.prompt).toBe('do a thing');
    expect(a.currentTask.startedAt).toBe('2026-06-15 10:00:01');
  });

  it('reports Idle, recent tasks (cap 15, desc), counts, durations', () => {
    const root = tmp();
    const tasks = [];
    for (let i = 1; i <= 20; i++) {
      tasks.push({ source: 'schedule', user_id: 7, chat_id: 7, prompt: `t${i}`,
        status: 'done', session_id: 's1', created_at: '2026-06-15 09:00:00',
        started_at: '2026-06-15 09:00:00', finished_at: '2026-06-15 09:00:05' });
    }
    buildAgentDb(root, 'default', { tasks });
    const a = readAgent(root, 'default');
    expect(a.busy).toBe(false);
    expect(a.currentTask).toBeNull();
    expect(a.recentTasks).toHaveLength(15);
    expect(a.recentTasks[0].id).toBe(20);          // newest first
    expect(a.recentTasks[0].durationSec).toBe(5);  // finished - started
    expect(a.counts.done).toBe(20);
    expect(a.lastActivityAt).toBe('2026-06-15 09:00:05');
  });

  it('returns sessions with task counts and schedules', () => {
    const root = tmp();
    buildAgentDb(root, 'default', {
      sessions: [{ user_id: 7, claude_session_id: 'sess-abc', created_at: '2026-06-11 17:00:45' }],
      tasks: [
        { source: 'telegram', user_id: 7, chat_id: 7, prompt: 'a', status: 'done',
          session_id: 'sess-abc', created_at: '2026-06-12 03:18:20' },
        { source: 'telegram', user_id: 7, chat_id: 7, prompt: 'b', status: 'done',
          session_id: 'sess-abc', created_at: '2026-06-12 12:55:19' },
      ],
      schedules: [
        { cron_expr: '0 8 * * *', run_at: null, prompt: 'daily report', enabled: 1,
          missed_policy: 'run_now', created_by_user_id: 7, chat_id: 7,
          last_run_at: '2026-06-15T03:00:00.790Z' },
      ],
    });
    const a = readAgent(root, 'default');
    expect(a.sessions).toEqual([
      { userId: 7, sessionId: 'sess-abc', createdAt: '2026-06-11 17:00:45', taskCount: 2 },
    ]);
    expect(a.schedules[0]).toMatchObject({ id: 1, cronExpr: '0 8 * * *', enabled: true });
  });

  it('returns an error entry when the agent DB is missing', () => {
    const root = tmp();              // no agents/default/agent.db created
    const a = readAgent(root, 'default');
    expect(a.name).toBe('default');
    expect(a.error).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gui && npx vitest run test/datasource.test.js`
Expected: FAIL — `readAgent` is not exported.

- [ ] **Step 3: Implement `readAgent` (append to `gui/src/datasource.js`, before `module.exports`)**

```js
// --- append to gui/src/datasource.js (above module.exports) ---
const fsExtra = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { agentDbPath } = require('./paths.js');

function truncate(s, n) {
  if (s == null) return s;
  const str = String(s);
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function durationSec(startedAt, finishedAt) {
  const s = parseSqliteTime(startedAt);
  const f = parseSqliteTime(finishedAt);
  if (!s || !f) return null;
  return Math.round((f.getTime() - s.getTime()) / 1000);
}

function readAgent(root, name) {
  const dbPath = agentDbPath(root, name);
  if (!fsExtra.existsSync(dbPath)) {
    return { name, error: 'db unavailable', detail: `not found: ${dbPath}` };
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });

    const running = db.prepare(
      `SELECT id, source, prompt, started_at FROM tasks WHERE status='running' ORDER BY id DESC LIMIT 1`
    ).get();
    const currentTask = running
      ? { id: running.id, source: running.source, prompt: truncate(running.prompt, 200), startedAt: running.started_at }
      : null;

    const recentRows = db.prepare(
      `SELECT id, source, status, prompt, started_at, finished_at FROM tasks ORDER BY id DESC LIMIT 15`
    ).all();
    const recentTasks = recentRows.map((r) => ({
      id: r.id, source: r.source, status: r.status,
      prompt: truncate(r.prompt, 80),
      startedAt: r.started_at, finishedAt: r.finished_at,
      durationSec: durationSec(r.started_at, r.finished_at),
    }));

    const countRows = db.prepare(`SELECT status, COUNT(*) AS c FROM tasks GROUP BY status`).all();
    const counts = {};
    for (const row of countRows) counts[row.status] = row.c;

    const sessionRows = db.prepare(
      `SELECT s.user_id, s.claude_session_id, s.created_at,
              (SELECT COUNT(*) FROM tasks t WHERE t.session_id = s.claude_session_id) AS task_count
         FROM sessions s ORDER BY s.created_at`
    ).all();
    const sessions = sessionRows.map((s) => ({
      userId: s.user_id, sessionId: s.claude_session_id, createdAt: s.created_at, taskCount: s.task_count,
    }));

    const scheduleRows = db.prepare(
      `SELECT id, cron_expr, run_at, prompt, enabled, last_run_at FROM schedules ORDER BY id`
    ).all();
    const schedules = scheduleRows.map((r) => ({
      id: r.id, cronExpr: r.cron_expr, runAt: r.run_at,
      prompt: truncate(r.prompt, 60), enabled: !!r.enabled, lastRunAt: r.last_run_at,
    }));

    const lastRow = db.prepare(`SELECT MAX(finished_at) AS m FROM tasks`).get();
    const lastActivityAt = lastRow ? lastRow.m : null;

    return { name, busy: !!currentTask, currentTask, recentTasks, counts, sessions, schedules, lastActivityAt };
  } catch (e) {
    return { name, error: 'db unavailable', detail: e.message };
  } finally {
    if (db) try { db.close(); } catch (_) { /* ignore */ }
  }
}
```

- [ ] **Step 4: Export `readAgent` (update the `module.exports` line)**

```js
module.exports = { ConfigError, parseSqliteTime, loadAgents, readAgent };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd gui && npx vitest run test/datasource.test.js`
Expected: PASS (11 tests total).

- [ ] **Step 6: Commit**

```bash
git add gui/src/datasource.js gui/test/datasource.test.js
git commit -m "feat(gui): per-agent read (busy, sessions, recent tasks, schedules)"
```

---

## Task 6: `parseLaunchctlList`, `daemonStatus`, `getSnapshot`

**Files:**
- Modify: `gui/src/datasource.js`
- Modify: `gui/test/datasource.test.js`

- [ ] **Step 1: Add the failing test (append to `gui/test/datasource.test.js`)**

```js
// --- append to gui/test/datasource.test.js ---
import { parseLaunchctlList, getSnapshot } from '../src/datasource.js';

describe('parseLaunchctlList', () => {
  const label = 'uz.domo.agent-runtime';
  it('returns alive+pid for a numeric PID line', () => {
    expect(parseLaunchctlList('74264\t0\tuz.domo.agent-runtime\n', label)).toEqual({ alive: true, pid: 74264 });
  });
  it('returns not-alive when PID column is "-"', () => {
    expect(parseLaunchctlList('-\t0\tuz.domo.agent-runtime\n', label)).toEqual({ alive: false });
  });
  it('returns unknown when the label is absent', () => {
    expect(parseLaunchctlList('123\t0\tsomething.else\n', label)).toEqual({ status: 'unknown' });
  });
});

describe('getSnapshot', () => {
  it('composes daemon status and per-agent data', () => {
    const root = tmp();
    writeConfig(root, { telegramBotToken: 'x', whitelist: [7], agentHome: '/h' });
    buildAgentDb(root, 'default', { tasks: [
      { source: 'telegram', user_id: 7, chat_id: 7, prompt: 'hi', status: 'done',
        created_at: '2026-06-15 03:00:00', started_at: '2026-06-15 03:00:00', finished_at: '2026-06-15 03:00:02' },
    ]});
    const snap = getSnapshot({ root, daemonStatusFn: () => ({ alive: true, pid: 999 }) });
    expect(snap.daemon).toEqual({ alive: true, pid: 999 });
    expect(snap.agents).toHaveLength(1);
    expect(snap.agents[0].name).toBe('default');
    expect(snap.agents[0].counts.done).toBe(1);
    expect(typeof snap.generatedAt).toBe('string');
  });
  it('returns an error snapshot when config is bad', () => {
    const root = tmp();
    writeConfig(root, { nonsense: true });
    const snap = getSnapshot({ root, daemonStatusFn: () => ({ alive: false }) });
    expect(snap.error).toBeTruthy();
    expect(snap.agents).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gui && npx vitest run test/datasource.test.js`
Expected: FAIL — `parseLaunchctlList`/`getSnapshot` not exported.

- [ ] **Step 3: Implement (append to `gui/src/datasource.js`, above `module.exports`)**

```js
// --- append to gui/src/datasource.js (above module.exports) ---
const { execFileSync } = require('node:child_process');
const { appDataRoot } = require('./paths.js');

const LAUNCHD_LABEL = 'uz.domo.agent-runtime';

// Pure parser for `launchctl list` output. Columns are PID<TAB>STATUS<TAB>LABEL.
function parseLaunchctlList(output, label = LAUNCHD_LABEL) {
  const line = String(output).split('\n').find((l) => l.includes(label));
  if (!line) return { status: 'unknown' };
  const pidStr = line.split(/\s+/)[0];
  if (/^\d+$/.test(pidStr)) return { alive: true, pid: Number(pidStr) };
  return { alive: false };
}

function daemonStatus(label = LAUNCHD_LABEL) {
  try {
    const out = execFileSync('launchctl', ['list'], { encoding: 'utf8' });
    return parseLaunchctlList(out, label);
  } catch (_) {
    return { status: 'unknown' };
  }
}

// generatedAt is stamped by the caller-injectable clock to keep this testable
// without Date.now noise; defaults to a real ISO timestamp.
function getSnapshot({ root = appDataRoot(), daemonStatusFn = daemonStatus, now = () => new Date().toISOString() } = {}) {
  const daemon = daemonStatusFn();
  let agentNames;
  try {
    agentNames = loadAgents(root).map((a) => a.name);
  } catch (e) {
    return { generatedAt: now(), daemon, agents: [], error: e.message };
  }
  const agents = agentNames.map((name) => readAgent(root, name));
  return { generatedAt: now(), daemon, agents };
}
```

- [ ] **Step 4: Export the new functions (update `module.exports`)**

```js
module.exports = {
  ConfigError, parseSqliteTime, loadAgents, readAgent,
  parseLaunchctlList, daemonStatus, getSnapshot, LAUNCHD_LABEL,
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd gui && npx vitest run test/datasource.test.js`
Expected: PASS (16 tests total).

- [ ] **Step 6: Run the full suite + a live smoke test against the real DB**

Run: `cd gui && npx vitest run`
Expected: all tests PASS.

Run: `cd gui && node -e "console.log(JSON.stringify(require('./src/datasource.js').getSnapshot().agents[0].counts))"`
Expected: prints a real status-count object (e.g. `{"done":...,"failed":...}`) from the live `default` DB.

- [ ] **Step 7: Commit**

```bash
git add gui/src/datasource.js gui/test/datasource.test.js
git commit -m "feat(gui): daemon liveness + full snapshot composition"
```

---

## Task 7: `snapshot-cli.js` — JSON snapshot subprocess

**Files:**
- Create: `gui/src/snapshot-cli.js`
- Test: `gui/test/snapshot-cli.test.js`

- [ ] **Step 1: Write the failing test**

```js
// gui/test/snapshot-cli.test.js
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { makeTempRoot, writeConfig, buildAgentDb, cleanup } from './helpers.js';

let roots = [];
afterEach(() => { roots.forEach(cleanup); roots = []; });

describe('snapshot-cli', () => {
  it('prints a JSON snapshot honoring GUI_APPDATA_ROOT', () => {
    const root = makeTempRoot(); roots.push(root);
    writeConfig(root, { telegramBotToken: 'x', whitelist: [7], agentHome: '/h' });
    buildAgentDb(root, 'default', { tasks: [
      { source: 'telegram', user_id: 7, chat_id: 7, prompt: 'hi', status: 'done',
        created_at: '2026-06-15 03:00:00' },
    ]});
    const cli = path.join(process.cwd(), 'src', 'snapshot-cli.js');
    const out = execFileSync('node', [cli], { encoding: 'utf8', env: { ...process.env, GUI_APPDATA_ROOT: root } });
    const snap = JSON.parse(out);
    expect(snap.agents[0].name).toBe('default');
    expect(snap.agents[0].counts.done).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gui && npx vitest run test/snapshot-cli.test.js`
Expected: FAIL — `src/snapshot-cli.js` not found.

- [ ] **Step 3: Write the CLI**

```js
// gui/src/snapshot-cli.js
'use strict';
const { getSnapshot } = require('./datasource.js');
const { appDataRoot } = require('./paths.js');

// GUI_APPDATA_ROOT lets tests (and overrides) point at a fixture root.
const root = process.env.GUI_APPDATA_ROOT || appDataRoot();
try {
  const snap = getSnapshot({ root });
  process.stdout.write(JSON.stringify(snap));
} catch (e) {
  process.stdout.write(JSON.stringify({ error: e.message, agents: [], daemon: { status: 'unknown' } }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gui && npx vitest run test/snapshot-cli.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add gui/src/snapshot-cli.js gui/test/snapshot-cli.test.js
git commit -m "feat(gui): snapshot CLI emitting JSON for the Electron main"
```

---

## Task 8: Renderer formatting helpers

> **Module note:** renderer-side files use the `.mjs` extension and ESM `export`
> syntax because the Electron renderer loads them natively as ES modules
> (`<script type="module">`). The Node-side files (`main.js`, `preload.js`,
> `src/*.js`) stay CommonJS. Vitest imports the `.mjs` helpers directly.

**Files:**
- Create: `gui/renderer/format.mjs`
- Test: `gui/test/format.test.js`

- [ ] **Step 1: Write the failing test**

```js
// gui/test/format.test.js
import { describe, it, expect } from 'vitest';
import { formatDuration, statusClass, daemonText } from '../renderer/format.mjs';

describe('formatDuration', () => {
  it('formats seconds and minutes', () => {
    expect(formatDuration(5)).toBe('5s');
    expect(formatDuration(65)).toBe('1m 5s');
    expect(formatDuration(null)).toBe('—');
  });
});
describe('statusClass', () => {
  it('maps statuses to css classes', () => {
    expect(statusClass('done')).toBe('ok');
    expect(statusClass('failed')).toBe('bad');
    expect(statusClass('running')).toBe('busy');
    expect(statusClass('queued')).toBe('muted');
  });
});
describe('daemonText', () => {
  it('renders each daemon state', () => {
    expect(daemonText({ alive: true, pid: 7 })).toBe('Running (pid 7)');
    expect(daemonText({ alive: false })).toBe('Stopped');
    expect(daemonText({ status: 'unknown' })).toBe('Unknown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gui && npx vitest run test/format.test.js`
Expected: FAIL — `../renderer/format.mjs` not found.

- [ ] **Step 3: Write the helpers**

```js
// gui/renderer/format.mjs
export function formatDuration(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}
export function statusClass(status) {
  switch (status) {
    case 'done': return 'ok';
    case 'failed': case 'interrupted': case 'cancelled': return 'bad';
    case 'running': return 'busy';
    default: return 'muted';
  }
}
export function daemonText(d) {
  if (d && d.alive) return `Running (pid ${d.pid})`;
  if (d && d.alive === false) return 'Stopped';
  return 'Unknown';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gui && npx vitest run test/format.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add gui/renderer/format.mjs gui/test/format.test.js
git commit -m "feat(gui): pure renderer formatting helpers"
```

---

## Task 9: Electron main + preload

**Files:**
- Create: `gui/main.js`
- Create: `gui/preload.js`

- [ ] **Step 1: Write `gui/main.js`**

```js
// gui/main.js
'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const { execFile } = require('node:child_process');
const path = require('node:path');

const CLI = path.join(__dirname, 'src', 'snapshot-cli.js');
// Use system `node` (verified to expose node:sqlite unflagged). Override with GUI_NODE_BIN.
const NODE_BIN = process.env.GUI_NODE_BIN || 'node';

function fetchSnapshot() {
  return new Promise((resolve) => {
    execFile(NODE_BIN, [CLI], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        return resolve({ error: 'snapshot subprocess failed', detail: String(stderr || err.message).slice(0, 600), agents: [], daemon: { status: 'unknown' } });
      }
      try { resolve(JSON.parse(stdout)); }
      catch (e) { resolve({ error: 'invalid snapshot JSON', detail: String(e).slice(0, 300), agents: [], daemon: { status: 'unknown' } }); }
    });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 880, height: 720, title: 'Agent Runtime Monitor',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('getSnapshot', () => fetchSnapshot());

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
```

- [ ] **Step 2: Write `gui/preload.js`**

```js
// gui/preload.js
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  getSnapshot: () => ipcRenderer.invoke('getSnapshot'),
});
```

- [ ] **Step 3: Verify both files parse under Node**

Run: `cd gui && node --check main.js && node --check preload.js && echo "syntax ok"`
Expected: prints `syntax ok`.

- [ ] **Step 4: Commit**

```bash
git add gui/main.js gui/preload.js
git commit -m "feat(gui): Electron main window + preload bridge"
```

---

## Task 10: Renderer UI (HTML/CSS/JS) + polling

**Files:**
- Create: `gui/renderer/index.html`
- Create: `gui/renderer/style.css`
- Create: `gui/renderer/renderer.mjs`

- [ ] **Step 1: Write `gui/renderer/index.html`**

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'" />
  <link rel="stylesheet" href="style.css" />
  <title>Agent Runtime Monitor</title>
</head>
<body>
  <header>
    <h1>Agent Runtime Monitor</h1>
    <div id="daemon" class="daemon">…</div>
    <div id="generated" class="generated"></div>
  </header>
  <main id="agents"></main>
  <div id="error" class="error" hidden></div>
  <script type="module" src="renderer.mjs"></script>
</body>
</html>
```

- [ ] **Step 2: Write `gui/renderer/style.css`**

```css
:root { font-family: -apple-system, system-ui, sans-serif; }
body { margin: 0; background: #1115; color: #1d1d1f; background: #f5f5f7; }
header { padding: 16px 20px; border-bottom: 1px solid #d2d2d7; position: sticky; top: 0; background: #f5f5f7; }
h1 { font-size: 16px; margin: 0 0 6px; }
.daemon { font-size: 13px; font-weight: 600; }
.daemon.ok { color: #1a7f37; } .daemon.bad { color: #b3261e; } .daemon.muted { color: #6e6e73; }
.generated { font-size: 11px; color: #86868b; margin-top: 2px; }
main { padding: 16px 20px; display: flex; flex-direction: column; gap: 16px; }
.card { background: #fff; border: 1px solid #d2d2d7; border-radius: 10px; padding: 14px 16px; }
.card h2 { font-size: 15px; margin: 0 0 4px; display: flex; align-items: center; gap: 8px; }
.pill { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
.pill.busy { background: #fff3cd; color: #8a6d00; } .pill.idle { background: #e8f5e9; color: #1a7f37; }
.meta { font-size: 12px; color: #6e6e73; margin: 4px 0 10px; }
.section-title { font-size: 12px; font-weight: 700; color: #6e6e73; margin: 10px 0 4px; text-transform: uppercase; letter-spacing: .04em; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
td, th { text-align: left; padding: 3px 6px; border-bottom: 1px solid #f0f0f2; }
.badge { font-weight: 700; }
.badge.ok { color: #1a7f37; } .badge.bad { color: #b3261e; } .badge.busy { color: #8a6d00; } .badge.muted { color: #6e6e73; }
.error { margin: 16px 20px; padding: 12px; background: #fde7e9; color: #b3261e; border-radius: 8px; font-size: 13px; }
.unavailable { color: #b3261e; font-size: 13px; }
```

- [ ] **Step 3: Write `gui/renderer/renderer.js`**

```js
// gui/renderer/renderer.mjs
import { formatDuration, statusClass, daemonText } from './format.mjs';

const $ = (id) => document.getElementById(id);

function daemonClass(d) {
  if (d && d.alive) return 'ok';
  if (d && d.alive === false) return 'bad';
  return 'muted';
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderAgent(a) {
  const card = el('div', 'card');
  if (a.error) {
    card.appendChild(el('h2', null, a.name));
    card.appendChild(el('div', 'unavailable', `DB unavailable — ${a.detail || a.error}`));
    return card;
  }
  const h2 = el('h2', null, a.name);
  h2.appendChild(el('span', `pill ${a.busy ? 'busy' : 'idle'}`, a.busy ? 'Working' : 'Idle'));
  card.appendChild(h2);

  const countStr = Object.entries(a.counts || {}).map(([k, v]) => `${k}: ${v}`).join('   ') || 'no tasks';
  card.appendChild(el('div', 'meta', `Last activity: ${a.lastActivityAt || '—'}    •    ${countStr}`));

  if (a.busy && a.currentTask) {
    card.appendChild(el('div', 'section-title', 'Current task'));
    card.appendChild(el('div', null, `#${a.currentTask.id} (${a.currentTask.source}) — ${a.currentTask.prompt}`));
  }

  card.appendChild(el('div', 'section-title', 'Sessions'));
  if ((a.sessions || []).length === 0) card.appendChild(el('div', 'meta', 'none'));
  for (const s of a.sessions || []) {
    card.appendChild(el('div', 'meta', `user ${s.userId} · ${String(s.sessionId).slice(0, 8)}… · ${s.taskCount} tasks · since ${s.createdAt}`));
  }

  card.appendChild(el('div', 'section-title', 'Recent tasks'));
  const table = el('table');
  for (const t of a.recentTasks || []) {
    const tr = el('tr');
    tr.appendChild(el('td', `badge ${statusClass(t.status)}`, t.status));
    tr.appendChild(el('td', null, t.source));
    tr.appendChild(el('td', null, t.prompt));
    tr.appendChild(el('td', null, formatDuration(t.durationSec)));
    table.appendChild(tr);
  }
  card.appendChild(table);

  if ((a.schedules || []).length) {
    card.appendChild(el('div', 'section-title', 'Schedules'));
    for (const sc of a.schedules) {
      const when = sc.cronExpr ? `cron ${sc.cronExpr}` : `at ${sc.runAt}`;
      card.appendChild(el('div', 'meta', `#${sc.id} ${when} · ${sc.enabled ? 'enabled' : 'disabled'} · last ${sc.lastRunAt || '—'} · ${sc.prompt}`));
    }
  }
  return card;
}

function paint(snap) {
  const d = $('daemon');
  d.textContent = daemonText(snap.daemon || {});
  d.className = `daemon ${daemonClass(snap.daemon || {})}`;
  $('generated').textContent = snap.generatedAt ? `updated ${new Date(snap.generatedAt).toLocaleTimeString()}` : '';

  const err = $('error');
  if (snap.error) { err.hidden = false; err.textContent = `Error: ${snap.error}${snap.detail ? ' — ' + snap.detail : ''}`; }
  else { err.hidden = true; }

  const main = $('agents');
  main.replaceChildren(...(snap.agents || []).map(renderAgent));
}

async function tick() {
  try { paint(await window.api.getSnapshot()); }
  catch (e) { $('error').hidden = false; $('error').textContent = `Refresh failed: ${e}`; }
}

tick();
setInterval(tick, 3000);
```

- [ ] **Step 4: Run the full test suite (ensure nothing regressed)**

Run: `cd gui && npx vitest run`
Expected: all tests PASS (22 total across the 4 test files).

- [ ] **Step 5: Commit**

```bash
git add gui/renderer/index.html gui/renderer/style.css gui/renderer/renderer.mjs
git commit -m "feat(gui): renderer UI with 3s polling"
```

---

## Task 11: README + manual verification

**Files:**
- Create: `gui/README.md`

- [ ] **Step 1: Write `gui/README.md`**

```markdown
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
```

- [ ] **Step 2: Commit the README**

```bash
git add gui/README.md
git commit -m "docs(gui): how to run and test the monitor"
```

- [ ] **Step 3: Manual verification — launch the app against the live runtime**

Run: `cd gui && npm start`
Expected, in the window:
- Top banner shows **Running (pid …)** (the daemon is loaded under launchd).
- One agent card named **default** with an **Idle**/**Working** pill.
- Sessions line for user `1085409133` with a session id and task count.
- Recent-tasks table populated (newest first) with status badges and durations.
- A schedule line for the daily `0 8 * * *` job.
- The "updated …" timestamp advances every ~3s.

- [ ] **Step 4: Manual verification — error paths (via the CLI directly)**

The renderer turns these snapshot shapes into a red banner / "DB unavailable"
card; verifying the CLI output confirms the data layer produces them.

1. Missing config → error snapshot:
   Run: `cd gui && GUI_APPDATA_ROOT=$(mktemp -d) node src/snapshot-cli.js`
   Expected: JSON with `"error"` set and `"agents":[]`.
2. Config present but agent DB missing → per-agent error entry:
   Run:
   ```bash
   cd gui && R=$(mktemp -d) && printf '{"telegramBotToken":"x","whitelist":[7],"agentHome":"/h"}' > "$R/config.json" && GUI_APPDATA_ROOT="$R" node src/snapshot-cli.js
   ```
   Expected: JSON where `agents[0]` has `"error":"db unavailable"`.

- [ ] **Step 5: Final confirmation**

Run: `cd gui && npx vitest run`
Expected: all green. The monitor is complete.

---

## Self-review notes (resolved)

- **Spec coverage:** daemon status (Task 6/10), agents Working/Idle (Task 5/10), sessions (Task 5/10), recent tasks (Task 5/10), schedules (Task 5/10), read-only (Task 5 `{readOnly:true}`), 3s polling (Task 10), legacy-config wrap (Task 4), error handling — missing DB (Task 5), bad config (Task 6), launchctl unknown (Task 6), subprocess failure (Task 9). All covered.
- **No native modules / no electron-rebuild:** data path uses built-in `node:sqlite` via a system-`node` subprocess; the only npm deps are `electron` and `vitest` (both dev). Confirmed `node:sqlite` is unflagged on system Node 26 and WAL-correct.
- **Module strategy:** package is CommonJS (`"type":"commonjs"`); Node-side files (`main.js`, `preload.js`, `src/*.js`) use `require`/`module.exports`. Renderer-side files the browser loads natively (`renderer/format.mjs`, `renderer/renderer.mjs`) use `.mjs` + ESM `export`/`import`. Vitest imports both forms. This avoids the earlier bug where the browser would fail to `import` a `module.exports` file.
- **Type/name consistency:** `appDataRoot/configPath/agentsDir/agentDbPath` (paths.js) used identically downstream; `loadAgents→[{name,agentHome,whitelist}]`; `readAgent→{name,busy,currentTask,recentTasks,counts,sessions,schedules,lastActivityAt}` or `{name,error,detail}`; `getSnapshot→{generatedAt,daemon,agents,error?}`; renderer helpers `formatDuration/statusClass/daemonText` match their tests.
```
