import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { PermissionGate } from '../src/gate.js';
import { Worker } from '../src/worker.js';
import { Sender, type TelegramApi } from '../src/sender.js';
import { intakeMessage } from '../src/intake.js';
import type { ClaudeRunner } from '../src/types.js';

class FakeApi implements TelegramApi {
  sent: { chatId: number; text: string; markup: string | null }[] = [];
  private nextId = 1;
  async sendMessage(chatId: number, text: string, markup?: string | null): Promise<number> {
    this.sent.push({ chatId, text, markup: markup ?? null });
    return this.nextId++;
  }
  async editMessageText(): Promise<void> {}
}

async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('pipeline: telegram in → worker → approval → telegram out', () => {
  it('runs a risky task end-to-end with user approval', async () => {
    const store = new Store(openDb(':memory:'));
    const api = new FakeApi();
    const sender = new Sender(store, api);
    const gate = new PermissionGate(store, new Policy('/home', []), 2000);
    // fake agent: asks permission for a risky command, then reports
    const runner: ClaudeRunner = {
      async *run(req) {
        yield { kind: 'session', sessionId: 's1' };
        const r = await req.canUseTool('Bash', { command: 'rm -rf /tmp/cache' });
        yield { kind: 'final', text: r.behavior === 'allow' ? 'cleaned the cache' : `refused: ${r.message}` };
      },
    };
    const worker = new Worker({ store, runner, gate, agentHome: '/home' });

    // 1. message arrives and is durably queued
    const r = intakeMessage(store, { updateId: 1, userId: 11, chatId: 11, text: 'clean the cache' });
    expect(r.queued).toBe(true);

    // 2. worker starts; gate blocks on approval
    const ticking = worker.tick();
    await until(() => store.unsentMessages().some((m) => m.kind === 'approval'));
    await sender.drainOnce();
    const approvalMsg = api.sent.find((m) => m.text.includes('Approval needed'))!;
    expect(approvalMsg.markup).toContain('apv:');

    // 3. user presses Approve
    const approvalId = Number(JSON.parse(approvalMsg.markup!).inline_keyboard[0][0].callback_data.split(':')[1]);
    expect(gate.resolve(approvalId, 'approved')).toBe(true);

    // 4. task completes; final answer delivered
    await ticking;
    await sender.drainOnce();
    expect(api.sent.some((m) => m.text === 'cleaned the cache')).toBe(true);
    expect(store.getTask(r.taskId!)?.status).toBe('done');
    expect(store.getApproval(approvalId)?.decision).toBe('approved');
  });
});
