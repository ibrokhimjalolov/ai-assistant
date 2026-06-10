import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { PermissionGate } from '../src/gate.js';
import { whitelistMiddleware, handleApprovalCallback, handleResumeCallback } from '../src/telegram.js';

let store: Store; let gate: PermissionGate;
beforeEach(() => {
  store = new Store(openDb(':memory:'));
  gate = new PermissionGate(store, new Policy('/home', []), 50);
});

describe('whitelistMiddleware', () => {
  const mw = whitelistMiddleware([11, 22]);

  it('passes whitelisted users through', async () => {
    let called = false;
    await mw({ from: { id: 11 } } as any, async () => { called = true; });
    expect(called).toBe(true);
  });

  it('drops unknown users and missing from', async () => {
    let called = false;
    await mw({ from: { id: 99 } } as any, async () => { called = true; });
    await mw({ from: undefined } as any, async () => { called = true; });
    expect(called).toBe(false);
  });
});

describe('handleApprovalCallback', () => {
  it('resolves a pending approval', async () => {
    const tid = store.enqueueTask({ source: 'telegram', kind: 'chat', userId: 11, chatId: 11, prompt: 'p' });
    const task = store.getTask(tid)!;
    const pending = gate.check(task, 'Bash', { command: 'sudo x' });
    const approvalMsg = store.unsentMessages().find((m) => m.kind === 'approval')!;
    const approvalId = Number(JSON.parse(approvalMsg.replyMarkup!).inline_keyboard[0][0].callback_data.split(':')[1]);
    const answers: string[] = [];
    const ctx = {
      match: [`apv:${approvalId}:y`, String(approvalId), 'y'],
      answerCallbackQuery: async (o: any) => { answers.push(o.text); },
      editMessageReplyMarkup: async () => {},
    } as any;
    await handleApprovalCallback(gate, ctx);
    expect((await pending).behavior).toBe('allow');
    expect(answers[0]).toContain('Recorded');
  });
});

describe('handleResumeCallback', () => {
  it('re-enqueues an interrupted task with its session intact', async () => {
    const tid = store.enqueueTask({ source: 'telegram', kind: 'chat', userId: 11, chatId: 11, prompt: 'long job' });
    store.claimNextTask();
    store.markInterruptedOnStartup();
    const answers: string[] = [];
    const ctx = {
      match: [`rsm:${tid}`, String(tid)],
      answerCallbackQuery: async (o: any) => { answers.push(o.text); },
    } as any;
    await handleResumeCallback(store, ctx);
    const queued = store.pendingTasks().filter((t) => t.status === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0].kind).toBe('resume');
    expect(answers[0]).toContain('Resuming');
  });

  it('rejects non-interrupted tasks', async () => {
    const answers: string[] = [];
    await handleResumeCallback(store, {
      match: ['rsm:999', '999'],
      answerCallbackQuery: async (o: any) => { answers.push(o.text); },
    } as any);
    expect(answers[0]).toContain('Not resumable');
  });
});
