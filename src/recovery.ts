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
