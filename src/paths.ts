import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, renameSync } from 'node:fs';

export interface AppPaths {
  root: string;
  dbPath: string; // legacy single-agent DB location (used only for migration)
  configPath: string;
  logsDir: string;
  backupsDir: string;
}

export function appPaths(
  root: string = join(homedir(), 'Library', 'Application Support', 'agent-runtime'),
): AppPaths {
  return {
    root,
    dbPath: join(root, 'agent.db'),
    configPath: join(root, 'config.json'),
    logsDir: join(root, 'logs'),
    backupsDir: join(root, 'backups'),
  };
}

export function ensureAppData(p: AppPaths): void {
  mkdirSync(p.logsDir, { recursive: true });
  mkdirSync(p.backupsDir, { recursive: true });
}

/** Per-agent state lives under <root>/agents/<name>/ — its own DB and backups. */
export interface AgentPaths {
  dir: string;
  dbPath: string;
  backupsDir: string;
}

export function agentPaths(root: string, name: string): AgentPaths {
  const dir = join(root, 'agents', name);
  return { dir, dbPath: join(dir, 'agent.db'), backupsDir: join(dir, 'backups') };
}

export function ensureAgentData(p: AgentPaths): void {
  mkdirSync(p.backupsDir, { recursive: true }); // also creates p.dir
}

/**
 * Move a pre-multi-agent DB (`<root>/agent.db` + WAL/SHM sidecars) into
 * `agents/<name>/` so an upgraded single-agent install keeps its sessions,
 * schedules, and history. No-op unless the legacy DB exists and the target is empty.
 * Returns true if a migration happened.
 */
export function migrateLegacyDb(root: string, name: string): boolean {
  const legacy = join(root, 'agent.db');
  const ap = agentPaths(root, name);
  if (!existsSync(legacy) || existsSync(ap.dbPath)) return false;
  mkdirSync(ap.dir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const from = legacy + suffix;
    if (existsSync(from)) renameSync(from, ap.dbPath + suffix);
  }
  return true;
}
