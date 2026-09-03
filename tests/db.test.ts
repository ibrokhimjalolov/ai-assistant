import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';

describe('openDb', () => {
  it('creates all tables and enables WAL', () => {
    const db = openDb(':memory:');
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r: any) => r.name);
    for (const t of ['inbox', 'tasks', 'sessions', 'schedules', 'approvals', 'outbox', 'meta']) {
      expect(tables).toContain(t);
    }
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('rejects invalid task status via CHECK', () => {
    const db = openDb(':memory:');
    expect(() =>
      db.prepare(`INSERT INTO tasks (source, user_id, chat_id, prompt, status) VALUES ('telegram', 1, 1, 'x', 'bogus')`).run(),
    ).toThrow();
  });

  it('uses real WAL mode on file-backed databases', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'db-')), 'test.db'));
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('schedules CHECK rejects rows with both or neither of cron_expr/run_at', () => {
    const db = openDb(':memory:');
    expect(() => db.prepare(`INSERT INTO schedules (cron_expr, run_at, prompt, created_by_user_id, chat_id) VALUES ('0 8 * * *', '2026-01-01T00:00:00Z', 'p', 1, 1)`).run()).toThrow();
    expect(() => db.prepare(`INSERT INTO schedules (cron_expr, run_at, prompt, created_by_user_id, chat_id) VALUES (NULL, NULL, 'p', 1, 1)`).run()).toThrow();
    expect(() => db.prepare(`INSERT INTO schedules (cron_expr, run_at, prompt, created_by_user_id, chat_id) VALUES (NULL, '2026-01-01T00:00:00Z', 'p', 1, 1)`).run()).not.toThrow();
  });

  it('migrates an old-shape schedules table (cron_expr NOT NULL, no run_at) preserving rows', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'mig-')), 'old.db');
    const raw = new Database(p);
    raw.exec(`CREATE TABLE schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, cron_expr TEXT NOT NULL, prompt TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, missed_policy TEXT NOT NULL DEFAULT 'run_now', created_by_user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, last_run_at TEXT)`);
    raw.prepare(`INSERT INTO schedules (cron_expr, prompt, created_by_user_id, chat_id) VALUES ('0 8 * * *','brief',7,70)`).run();
    raw.close();
    const db = openDb(p); // should migrate
    const cols = (db.pragma('table_info(schedules)') as any[]).map((c) => c.name);
    expect(cols).toContain('run_at');
    const row = db.prepare('SELECT cron_expr, run_at, prompt FROM schedules').get() as any;
    expect(row).toMatchObject({ cron_expr: '0 8 * * *', run_at: null, prompt: 'brief' });
  });

  it('migration preserves the AUTOINCREMENT sequence past deleted rows', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'mig2-')), 'old.db');
    const raw = new Database(p);
    raw.exec(`CREATE TABLE schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, cron_expr TEXT NOT NULL, prompt TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, missed_policy TEXT NOT NULL DEFAULT 'run_now', created_by_user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, last_run_at TEXT)`);
    raw.prepare(`INSERT INTO schedules (cron_expr,prompt,created_by_user_id,chat_id) VALUES ('0 8 * * *','a',1,1)`).run();
    raw.prepare(`INSERT INTO schedules (cron_expr,prompt,created_by_user_id,chat_id) VALUES ('0 9 * * *','b',1,1)`).run();
    raw.prepare(`DELETE FROM schedules`).run(); // seq now 2, table empty
    raw.close();
    const db = openDb(p);
    const seq = (db.prepare(`SELECT seq FROM sqlite_sequence WHERE name='schedules'`).get() as any)?.seq;
    expect(seq).toBe(2);
  });
});

describe('outbox file_path (outbound file delivery)', () => {
  it('fresh schema has a nullable file_path column on outbox', () => {
    const db = openDb(':memory:');
    const cols = (db.pragma('table_info(outbox)') as any[]).map((c) => c.name);
    expect(cols).toContain('file_path');
    expect(() => db.prepare(`INSERT INTO outbox (chat_id, content) VALUES (1, 'x')`).run()).not.toThrow();
  });

  it('migrates an old outbox table (no file_path) preserving rows', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'mig3-')), 'old.db');
    const raw = new Database(p);
    raw.exec(`CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'reply', content TEXT NOT NULL, reply_markup TEXT, edit_of INTEGER, message_id INTEGER, attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT, sent_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    raw.prepare(`INSERT INTO outbox (chat_id, content) VALUES (5, 'old row')`).run();
    raw.close();
    const db = openDb(p);
    const cols = (db.pragma('table_info(outbox)') as any[]).map((c) => c.name);
    expect(cols).toContain('file_path');
    const row = db.prepare(`SELECT chat_id, content, file_path FROM outbox`).get() as any;
    expect(row).toMatchObject({ chat_id: 5, content: 'old row', file_path: null });
  });
});
