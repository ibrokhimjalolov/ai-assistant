import type { Store } from './store.js';
import type { PermissionGate } from './gate.js';
import { UsageLimitError, type ClaudeRunner, type Task, type TaskKind } from './types.js';
import { ROTATE_PROMPT } from './commands.js';
import { fmtTime, truncate } from './util.js';
import { escapeHtml } from './format.js';
import { logger } from './log.js';

const log = logger('worker');

export interface WorkerDeps {
  store: Store;
  runner: ClaudeRunner;
  gate: PermissionGate;
  agentHome: string;
  /** Total wall-clock per task before the run is aborted as a safety backstop. 0/undefined disables. */
  taskTimeoutMs?: number;
  /** Per-agent Claude subscription token, forwarded to the runner. */
  claudeToken?: string;
  mcpServersFor?: (task: Task) => Record<string, unknown>;
  /** Auto-rotate the session when context usage reaches this fraction; 0/undefined disables. */
  rotateAtContextFraction?: number;
}

export function shouldAutoRotate(args: {
  kind: TaskKind;
  contextFraction: number | null | undefined;
  threshold: number;
  rotateQueued: boolean;
}): boolean {
  const { kind, contextFraction, threshold, rotateQueued } = args;
  return (
    kind === 'chat' &&
    threshold > 0 &&
    contextFraction != null &&
    contextFraction >= threshold &&
    !rotateQueued
  );
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
    const state = { timedOut: false };
    const timeoutMs = this.d.taskTimeoutMs ?? 600_000;
    const timer = timeoutMs > 0
      ? setTimeout(() => { state.timedOut = true; abort.abort(); }, timeoutMs)
      : undefined;
    log.info('task claimed', { id: task.id, userId: task.userId, kind: task.kind, source: task.source });
    try {
      const { text, contextFraction } = await this.runOnce(task, abort.signal, true);
      this.complete(task, text, null);
      this.maybeAutoRotate(task, contextFraction);
    } catch (e) {
      if (state.timedOut) {
        this.failTimedOut(task, timeoutMs);
      } else if (abort.signal.aborted) {
        this.d.store.finishTask(task.id, 'cancelled');
        this.d.store.enqueueMessage({ chatId: task.chatId, content: '🛑 Task cancelled.' });
        log.info('task cancelled', { id: task.id });
      } else if (e instanceof UsageLimitError) {
        this.pausedUntil = e.resetAt ?? new Date(Date.now() + 30 * 60_000);
        this.d.store.requeueTask(task.id);
        this.d.store.enqueueMessage({
          chatId: task.chatId,
          content: `⚠️ Subscription usage limit reached — your task is paused and will resume around ${fmtTime(this.pausedUntil)}.`,
        });
        log.warn('usage limit — pausing', { id: task.id, resumeAt: this.pausedUntil?.toISOString() });
      } else {
        await this.retryFresh(task, abort, e, state);
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.current = null;
    }
  }

  private failTimedOut(task: Task, timeoutMs: number): void {
    const mins = Math.max(1, Math.round(timeoutMs / 60_000));
    this.d.store.finishTask(task.id, 'failed', `Task timed out after ${mins} min`);
    this.d.store.enqueueMessage({
      chatId: task.chatId,
      content: `⏱️ Task timed out after ${mins} min with no completion and was aborted. Try again or break it into smaller steps.`,
    });
    log.warn('task timed out', { id: task.id, timeoutMs });
  }

  private async retryFresh(task: Task, abort: AbortController, firstError: unknown, state: { timedOut: boolean }): Promise<void> {
    if (state.timedOut) { this.failTimedOut(task, this.d.taskTimeoutMs ?? 600_000); return; }
    if (abort.signal.aborted) {
      this.d.store.finishTask(task.id, 'cancelled');
      this.d.store.enqueueMessage({ chatId: task.chatId, content: '🛑 Task cancelled.' });
      log.info('task cancelled', { id: task.id });
      return;
    }
    log.warn('retrying with fresh session', { id: task.id });
    try {
      const { text } = await this.runOnce(task, abort.signal, false);
      this.complete(task, text, '⚠️ Previous conversation context was lost due to a session error.');
    } catch (e2) {
      if (state.timedOut) { this.failTimedOut(task, this.d.taskTimeoutMs ?? 600_000); return; }
      const err = e2 ?? firstError;
      this.d.store.finishTask(task.id, 'failed', truncate(String(err), 500));
      this.d.store.enqueueMessage({ chatId: task.chatId, content: `❌ Task failed: ${escapeHtml(truncate(String(err), 300))}` });
      log.error('task failed', { id: task.id, error: String(err) });
    }
  }

  private complete(task: Task, final: string, prefixNote: string | null): void {
    if (!task.silent) {
      const content = prefixNote ? `${prefixNote}\n\n${final}` : final;
      this.d.store.enqueueMessage({ chatId: task.chatId, content });
    }
    this.d.store.finishTask(task.id, 'done', truncate(final, 500));
    if (task.kind === 'rotate') this.d.store.rotateSession(task.userId);
    log.info('task done', { id: task.id, silent: task.silent });
  }

  private maybeAutoRotate(task: Task, contextFraction: number | null): void {
    const threshold = this.d.rotateAtContextFraction ?? 0;
    const rotateQueued = this.d.store.pendingTasks().some((t) => t.kind === 'rotate' && t.userId === task.userId);
    log.debug('context fraction', { userId: task.userId, contextFraction, threshold });
    if (!shouldAutoRotate({ kind: task.kind, contextFraction, threshold, rotateQueued })) return;
    this.d.store.enqueueTask({ source: 'telegram', kind: 'rotate', userId: task.userId, chatId: task.chatId, prompt: ROTATE_PROMPT, silent: true });
    log.info('auto-rotating session (context threshold reached)', { userId: task.userId, contextFraction, threshold });
  }

  private effectivePrompt(task: Task): string {
    if (task.source === 'schedule') {
      return (
        `[Scheduled job created by Telegram user ${task.userId}. Your final reply is automatically delivered ` +
        `to them as a Telegram message in this chat. Respond with ONLY the content to show the user, and do NOT ` +
        `call any tool to send or deliver it — no send_message, no Telegram/messaging tools. Just write the message ` +
        `as your answer.]\n\n${task.prompt}`
      );
    }
    return `[Message from Telegram user ${task.userId}]\n\n${task.prompt}`;
  }

  private async runOnce(task: Task, signal: AbortSignal, useResume: boolean): Promise<{ text: string; contextFraction: number | null }> {
    const session = useResume ? this.d.store.getSession(task.userId) : undefined;
    let final = '';
    let contextFraction: number | null = null;
    for await (const ev of this.d.runner.run({
      prompt: this.effectivePrompt(task),
      cwd: this.d.agentHome,
      resume: session?.claudeSessionId,
      signal,
      canUseTool: this.d.gate.handlerFor(task),
      mcpServers: this.d.mcpServersFor?.(task),
      claudeToken: this.d.claudeToken,
    })) {
      if (ev.kind === 'session') {
        this.d.store.setSession(task.userId, ev.sessionId);
        this.d.store.attachSession(task.id, ev.sessionId);
        log.debug('session attached', { taskId: task.id, sessionId: ev.sessionId });
        // progress events are intentionally ignored — the Telegram typing indicator signals activity
      } else if (ev.kind === 'final') {
        final = ev.text;
        contextFraction = ev.contextFraction ?? null;
      }
    }
    return { text: final, contextFraction };
  }
}
