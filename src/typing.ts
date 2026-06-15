import type { TelegramApi } from './sender.js';
import type { Task } from './types.js';

/** Minimal worker view needed for the typing pulse. */
export interface TypingWorker {
  currentTask(): Task | null;
}

/**
 * Send one Telegram "typing…" chat action for the worker's current task, if any.
 * Transient and best-effort: never throws (a failed indicator must not crash the loop).
 * Intended to be called on a ~4s interval (the action expires after ~5s).
 */
export async function pulseTyping(worker: TypingWorker, api: TelegramApi): Promise<void> {
  const task = worker.currentTask();
  if (!task) return;
  try {
    await api.sendChatAction(task.chatId, 'typing');
  } catch {
    /* transient indicator — ignore failures */
  }
}
