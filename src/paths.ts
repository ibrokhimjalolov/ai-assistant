import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export interface AppPaths {
  root: string;
  dbPath: string;
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
