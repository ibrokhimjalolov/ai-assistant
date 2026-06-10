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
    if (abort.signal.aborted) {
      this.d.store.finishTask(task.id, 'cancelled');
      this.d.store.enqueueMessage({ chatId: task.chatId, content: '🛑 Task cancelled.' });
      return;
    }
    try {
      const final = await this.runOnce(task, abort.signal, false, statusId);
      this.complete(task, final, '⚠️ Previous conversation context was lost due to a session error.');
    } catch (e2) {
      const err = e2 ?? firstError;
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
