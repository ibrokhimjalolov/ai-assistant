import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { Store } from './store.js';
import { logger } from './log.js';

const log = logger('backup');

const KEEP = 7;

export function maybeBackup(
  store: Store,
  db: Database,
  p: { dbPath: string; backupsDir: string; agentHome: string },
  now: Date = new Date(),
): boolean {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const today = `${y}-${m}-${d}`;
  if (store.getMeta('last_backup_date') === today) return false;
  const dest = join(p.backupsDir, today);
  mkdirSync(dest, { recursive: true });
  db.pragma('wal_checkpoint(TRUNCATE)');
  cpSync(p.dbPath, join(dest, 'agent.db'));
  cpSync(p.agentHome, join(dest, 'AgentHome'), { recursive: true });
  log.info('backup created', { date: today });
  const days = readdirSync(p.backupsDir).sort();
  for (const old of days.slice(0, Math.max(0, days.length - KEEP))) {
    rmSync(join(p.backupsDir, old), { recursive: true, force: true });
    log.info('old backup pruned', { dir: old });
  }
  store.setMeta('last_backup_date', today);
  return true;
}
