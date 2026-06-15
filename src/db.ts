import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  update_id INTEGER UNIQUE NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('telegram','schedule')),
  kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat','rotate','resume')),
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','done','failed','interrupted','cancelled')),
  session_id TEXT,
  result_summary TEXT,
  silent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  user_id INTEGER PRIMARY KEY,
  claude_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cron_expr TEXT,
  run_at TEXT,
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  missed_policy TEXT NOT NULL DEFAULT 'run_now' CHECK (missed_policy IN ('run_now','skip')),
  created_by_user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  last_run_at TEXT,
  CHECK ((cron_expr IS NOT NULL) <> (run_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  tool_name TEXT NOT NULL,
  tool_input TEXT NOT NULL,
  decision TEXT CHECK (decision IN ('approved','denied','timeout','auto_approved')),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'reply' CHECK (kind IN ('reply','edit','approval','proactive')),
  content TEXT NOT NULL,
  reply_markup TEXT,
  edit_of INTEGER REFERENCES outbox(id),
  message_id INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function migrateSchedules(db: Database.Database): void {
  const cols = db.pragma('table_info(schedules)') as Array<{ name: string }>;
  if (cols.some((c) => c.name === 'run_at')) return; // already new shape
  // Capture the current AUTOINCREMENT sequence before rebuild (it can be lost if rows were deleted).
  const seqRow = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'schedules'`).get() as { seq: number } | undefined;
  const oldSeq = seqRow?.seq ?? null;
  // Old shape (cron_expr NOT NULL, no run_at). Rebuild to add run_at + nullable cron_expr + CHECK.
  db.exec(`
    BEGIN;
    CREATE TABLE schedules_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cron_expr TEXT,
      run_at TEXT,
      prompt TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      missed_policy TEXT NOT NULL DEFAULT 'run_now' CHECK (missed_policy IN ('run_now','skip')),
      created_by_user_id INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      last_run_at TEXT,
      CHECK ((cron_expr IS NOT NULL) <> (run_at IS NOT NULL))
    );
    INSERT INTO schedules_new (id, cron_expr, run_at, prompt, enabled, missed_policy, created_by_user_id, chat_id, last_run_at)
      SELECT id, cron_expr, NULL, prompt, enabled, missed_policy, created_by_user_id, chat_id, last_run_at FROM schedules;
    DROP TABLE schedules;
    ALTER TABLE schedules_new RENAME TO schedules;
    COMMIT;
  `);
  // Restore AUTOINCREMENT sequence if the original was higher (guards against lost seq after row deletes).
  if (oldSeq != null) {
    const cur = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'schedules'`).get() as { seq: number } | undefined;
    if (!cur) db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('schedules', ?)`).run(oldSeq);
    else if (cur.seq < oldSeq) db.prepare(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'schedules'`).run(oldSeq);
  }
}

function migrateTasks(db: Database.Database): void {
  const cols = db.pragma('table_info(tasks)') as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'silent')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN silent INTEGER NOT NULL DEFAULT 0`);
  }
}

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  // ':memory:' databases always report 'memory'; file DBs must actually get WAL
  const mode = db.pragma('journal_mode = WAL', { simple: true });
  if (mode !== 'wal' && mode !== 'memory') {
    throw new Error(`SQLite WAL mode unavailable (got '${mode}') — check filesystem support`);
  }
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrateSchedules(db);
  migrateTasks(db);
  return db;
}
