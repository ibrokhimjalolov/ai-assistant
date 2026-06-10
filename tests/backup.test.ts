import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { maybeBackup } from '../src/backup.js';

describe('maybeBackup', () => {
  it('copies db and agent home once per day and prunes old backups', () => {
    const root = mkdtempSync(join(tmpdir(), 'bk-'));
    const dbPath = join(root, 'agent.db');
    const home = join(root, 'home'); mkdirSync(home);
    writeFileSync(join(home, 'CLAUDE.md'), 'persona');
    const backups = join(root, 'backups'); mkdirSync(backups);
    const db = openDb(dbPath);
    const store = new Store(db);

    const day1 = new Date('2026-06-10T03:00:00');
    expect(maybeBackup(store, db, { dbPath, backupsDir: backups, agentHome: home }, day1)).toBe(true);
    expect(maybeBackup(store, db, { dbPath, backupsDir: backups, agentHome: home }, day1)).toBe(false); // same day
    expect(existsSync(join(backups, '2026-06-10', 'agent.db'))).toBe(true);
    expect(existsSync(join(backups, '2026-06-10', 'AgentHome', 'CLAUDE.md'))).toBe(true);

    // 8 more days → oldest pruned, 7 kept
    for (let i = 11; i <= 18; i++) {
      maybeBackup(store, db, { dbPath, backupsDir: backups, agentHome: home }, new Date(`2026-06-${i}T03:00:00`));
    }
    expect(readdirSync(backups).sort()).toHaveLength(7);
    expect(existsSync(join(backups, '2026-06-10'))).toBe(false);
  });
});
