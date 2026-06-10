import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
