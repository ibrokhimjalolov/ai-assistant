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
