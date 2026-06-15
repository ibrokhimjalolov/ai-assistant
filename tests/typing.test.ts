import { describe, it, expect } from 'vitest';
import { pulseTyping } from '../src/typing.js';
import type { TelegramApi } from '../src/sender.js';
import type { Task } from '../src/types.js';

function fakeApi() {
  const calls: { chatId: number; action: string }[] = [];
  const api: TelegramApi = {
    async sendMessage() { return 1; },
    async editMessageText() {},
    async sendChatAction(chatId, action) { calls.push({ chatId, action }); },
  };
  return { api, calls };
}
const task = (chatId: number) => ({ id: 1, chatId, userId: 1, source: 'telegram', kind: 'chat', prompt: 'x', status: 'running', sessionId: null, resultSummary: null } as Task);

describe('pulseTyping', () => {
  it('sends a typing action for the current task chat', async () => {
    const { api, calls } = fakeApi();
    await pulseTyping({ currentTask: () => task(70) }, api);
    expect(calls).toEqual([{ chatId: 70, action: 'typing' }]);
  });

  it('does nothing when the worker is idle', async () => {
    const { api, calls } = fakeApi();
    await pulseTyping({ currentTask: () => null }, api);
    expect(calls).toEqual([]);
  });

  it('swallows API errors (transient indicator must never crash the loop)', async () => {
    const calls: number[] = [];
    const api: TelegramApi = {
      async sendMessage() { return 1; },
      async editMessageText() {},
      async sendChatAction() { calls.push(1); throw new Error('telegram down'); },
    };
    await expect(pulseTyping({ currentTask: () => task(70) }, api)).resolves.toBeUndefined();
    expect(calls).toEqual([1]);
  });
});
