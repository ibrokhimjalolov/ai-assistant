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
