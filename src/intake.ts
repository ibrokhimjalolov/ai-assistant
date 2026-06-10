import type { Store } from './store.js';
import { logger } from './log.js';

const log = logger('gateway');

export function intakeMessage(
  store: Store,
  u: { updateId: number; userId: number; chatId: number; text: string },
): { queued: boolean; taskId?: number } {
  if (!store.recordUpdate(u.updateId, JSON.stringify(u))) {
    log.warn('duplicate update ignored', { updateId: u.updateId });
    return { queued: false };
  }
  log.info('message received', { updateId: u.updateId, userId: u.userId, chatId: u.chatId, chars: u.text.length });
  const taskId = store.enqueueTask({ source: 'telegram', kind: 'chat', userId: u.userId, chatId: u.chatId, prompt: u.text });
  store.markProcessed(u.updateId);
  log.info('task queued', { taskId });
  return { queued: true, taskId };
}
