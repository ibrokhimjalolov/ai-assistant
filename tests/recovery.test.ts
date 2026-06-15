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
