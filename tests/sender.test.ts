import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { Sender, type TelegramApi } from '../src/sender.js';

class FakeApi implements TelegramApi {
  sent: { chatId: number; text: string; markup: string | null }[] = [];
  edits: { chatId: number; messageId: number; text: string }[] = [];
  failNext = 0;
  private nextId = 100;
  async sendMessage(chatId: number, text: string, markup?: string | null): Promise<number> {
    if (this.failNext > 0) { this.failNext--; throw new Error('telegram down'); }
    this.sent.push({ chatId, text, markup: markup ?? null });
    return this.nextId++;
  }
  async editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
    if (this.failNext > 0) { this.failNext--; throw new Error('telegram down'); }
    this.edits.push({ chatId, messageId, text });
  }
}

let store: Store; let api: FakeApi; let sender: Sender;
beforeEach(() => {
  store = new Store(openDb(':memory:'));
  api = new FakeApi();
  sender = new Sender(store, api);
});

describe('Sender', () => {
  it('sends pending messages and records telegram message id', async () => {
    const id = store.enqueueMessage({ chatId: 5, content: 'hi' });
    await sender.drainOnce();
    expect(api.sent).toHaveLength(1);
    expect(store.sentMessageId(id)).toBe(100);
  });

  it('keeps failed messages for retry with backoff', async () => {
    store.enqueueMessage({ chatId: 5, content: 'hi' });
    api.failNext = 1;
    await sender.drainOnce(new Date(0));
    expect(api.sent).toHaveLength(0);
    // immediately after failure: backoff not elapsed → skipped
    await sender.drainOnce(new Date(1000));
    expect(api.sent).toHaveLength(0);
    // after 2^1 seconds: retried
    await sender.drainOnce(new Date(3000));
    expect(api.sent).toHaveLength(1);
  });

  it('sends edits against the original message id, deferring if original unsent', async () => {
    const orig = store.enqueueMessage({ chatId: 5, content: 'status' });
    const edit = store.enqueueEdit(orig, 'progress');
    // drain sends orig first, then edit can resolve target on same pass order
    await sender.drainOnce();
    await sender.drainOnce();
    expect(api.edits).toEqual([{ chatId: 5, messageId: 100, text: 'progress' }]);
    expect(store.sentMessageId(edit)).toBe(100);
  });
});
