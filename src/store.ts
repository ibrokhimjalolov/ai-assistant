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
    const run = this.db.transaction((): Task[] => {
      const rows = this.db.prepare(`SELECT * FROM tasks WHERE status = 'running'`).all() as any[];
      this.db.prepare(`UPDATE tasks SET status = 'interrupted' WHERE status = 'running'`).run();
      return rows.map((r) => toTask({ ...r, status: 'interrupted' }));
    });
    return run();
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
