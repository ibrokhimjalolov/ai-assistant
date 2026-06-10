import type { Database } from 'better-sqlite3';
import type { Decision, OutKind, OutMessage, Schedule, Task, TaskKind, TaskSource, TaskStatus } from './types.js';

/**
 * Timestamp convention: columns read back into JS for comparisons
 * (last_attempt_at, last_run_at, sent_at) store ISO-8601 strings written from JS.
 * Pure audit columns (created_at, received_at, started_at, finished_at,
 * requested_at, decided_at) use SQLite's datetime('now') defaults.
 */
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
      if (!orig) throw new Error(`enqueueEdit: no outbox row with id=${editOf}`);
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
      .prepare(`UPDATE outbox SET sent_at = ?, message_id = ? WHERE id = ?`)
      .run(new Date().toISOString(), telegramMessageId, id);
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
