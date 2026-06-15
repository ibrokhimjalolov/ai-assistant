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

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arm-test-'));
}

function writeConfig(root, configObj) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(configObj, null, 2));
}

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
