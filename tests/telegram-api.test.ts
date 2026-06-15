import { describe, it, expect, beforeEach } from 'vitest';
import { GrammyTelegramApi } from '../src/telegram.js';

interface Call { chatId: number; text: string; opts: any }

class FakeApi {
  calls: Call[] = [];
  edits: { chatId: number; messageId: number; text: string; opts: any }[] = [];
  failNextWith: unknown = null;
  private nextId = 100;

  async sendMessage(chatId: number, text: string, opts: any) {
    if (this.failNextWith) { const e = this.failNextWith; this.failNextWith = null; throw e; }
    this.calls.push({ chatId, text, opts });
    return { message_id: this.nextId++ };
  }
  async editMessageText(chatId: number, messageId: number, text: string, opts: any) {
    if (this.failNextWith) { const e = this.failNextWith; this.failNextWith = null; throw e; }
    this.edits.push({ chatId, messageId, text, opts });
  }
  async sendChatAction() {}
}

let fake: FakeApi; let api: GrammyTelegramApi;
beforeEach(() => {
  fake = new FakeApi();
  api = new GrammyTelegramApi(fake as any);
});

describe('GrammyTelegramApi.sendMessage', () => {
  it('sends the model HTML unchanged with parse_mode: HTML', async () => {
    const id = await api.sendMessage(5, '<b>hi</b>');
    expect(id).toBe(100);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].text).toBe('<b>hi</b>'); // passthrough — no rewrite of the model's output
    expect(fake.calls[0].opts.parse_mode).toBe('HTML');
  });

  it('preserves reply markup alongside parse_mode', async () => {
    await api.sendMessage(5, 'x', '{"inline_keyboard":[]}');
    expect(fake.calls[0].opts).toMatchObject({ parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
  });

  it('falls back to stripped plain text (no parse_mode) when Telegram rejects entities', async () => {
    fake.failNextWith = { error_code: 400, description: "Bad Request: can't parse entities: bad" };
    const id = await api.sendMessage(5, '<b>hi</b> <i>there</i>');
    expect(id).toBe(100);
    expect(fake.calls).toHaveLength(1); // only the successful retry was recorded
    expect(fake.calls[0].text).toBe('hi there');
    expect(fake.calls[0].opts.parse_mode).toBeUndefined();
  });

  it('preserves reply markup in the plain-text fallback', async () => {
    fake.failNextWith = { error_code: 400, description: "can't parse entities" };
    await api.sendMessage(5, '<b>hi</b>', '{"inline_keyboard":[[1]]}');
    expect(fake.calls[0].opts.reply_markup).toEqual({ inline_keyboard: [[1]] });
    expect(fake.calls[0].opts.parse_mode).toBeUndefined();
  });

  it('propagates non-parse errors so the Sender can retry with backoff', async () => {
    fake.failNextWith = new Error('network down');
    await expect(api.sendMessage(5, 'x')).rejects.toThrow('network down');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('GrammyTelegramApi.editMessageText', () => {
  it('sends the model HTML unchanged with parse_mode: HTML', async () => {
    await api.editMessageText(5, 42, '<b>e</b>');
    expect(fake.edits[0]).toMatchObject({ chatId: 5, messageId: 42, text: '<b>e</b>' });
    expect(fake.edits[0].opts.parse_mode).toBe('HTML');
  });

  it('falls back to stripped plain text on a parse error', async () => {
    fake.failNextWith = { error_code: 400, description: "can't parse entities" };
    await api.editMessageText(5, 42, '<b>e</b>');
    expect(fake.edits).toHaveLength(1);
    expect(fake.edits[0].text).toBe('e');
    expect(fake.edits[0].opts.parse_mode).toBeUndefined();
  });
});
