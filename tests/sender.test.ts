import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { Sender, type TelegramApi } from '../src/sender.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  async sendChatAction(): Promise<void> {}
  docs: { chatId: number; filePath: string; caption: string }[] = [];
  async sendDocument(chatId: number, filePath: string, caption: string): Promise<number> {
    if (this.failNext > 0) { this.failNext--; throw new Error('telegram down'); }
    this.docs.push({ chatId, filePath, caption });
    return this.nextId++;
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

describe('Sender: file delivery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sender-file-'));
  const f = join(dir, 'report.pdf');
  writeFileSync(f, 'pdf');

  it('uploads a queued file with its caption and records the message id', async () => {
    const id = store.enqueueFile({ chatId: 5, filePath: f, caption: 'Q3' });
    await sender.drainOnce();
    expect(api.docs).toEqual([{ chatId: 5, filePath: f, caption: 'Q3' }]);
    expect(api.sent).toHaveLength(0);
    expect(store.sentMessageId(id)).toBe(100);
  });

  it('drops a file row permanently when the file no longer exists (no retries)', async () => {
    store.enqueueFile({ chatId: 5, filePath: join(dir, 'vanished.pdf') });
    await sender.drainOnce(new Date(0));
    expect(api.docs).toHaveLength(0);
    expect(store.unsentMessages()).toEqual([]);
    await sender.drainOnce(new Date(60_000));
    expect(api.docs).toHaveLength(0);
  });

  it('retries a transient upload failure with backoff', async () => {
    store.enqueueFile({ chatId: 5, filePath: f });
    api.failNext = 1;
    await sender.drainOnce(new Date(0));
    expect(api.docs).toHaveLength(0);
    await sender.drainOnce(new Date(3000));
    expect(api.docs).toHaveLength(1);
  });

  it('preserves ordering: a text reply queued before a file goes out first', async () => {
    store.enqueueMessage({ chatId: 5, content: 'here is the report' });
    store.enqueueFile({ chatId: 5, filePath: f });
    await sender.drainOnce();
    expect(api.sent).toHaveLength(1);
    expect(api.docs).toHaveLength(1);
  });
});
