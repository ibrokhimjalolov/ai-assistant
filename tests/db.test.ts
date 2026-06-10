import { describe, it, expect } from 'vitest';
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
});
