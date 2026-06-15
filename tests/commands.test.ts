import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { intakeMessage } from '../src/intake.js';
import { statusText, queueText, newConversation, schedulesText, ROTATE_PROMPT } from '../src/commands.js';

let store: Store;
beforeEach(() => { store = new Store(openDb(':memory:')); });

describe('intakeMessage', () => {
  it('persists update then enqueues a chat task', () => {
    const r = intakeMessage(store, { updateId: 1, userId: 7, chatId: 70, text: 'do thing' });
    expect(r.queued).toBe(true);
    expect(store.getTask(r.taskId!)).toMatchObject({ kind: 'chat', userId: 7, chatId: 70, prompt: 'do thing' });
  });

  it('ignores duplicate update_ids (redelivery)', () => {
    intakeMessage(store, { updateId: 1, userId: 7, chatId: 70, text: 'x' });
    const r = intakeMessage(store, { updateId: 1, userId: 7, chatId: 70, text: 'x' });
    expect(r.queued).toBe(false);
    expect(store.pendingTasks()).toHaveLength(1);
  });
});

describe('commands', () => {
  it('statusText reports idle and queue depth', () => {
    const fakeWorker = { pausedUntil: null, currentTask: () => null } as any;
    const s = statusText(store, fakeWorker, new Date(Date.now() - 120_000));
    expect(s).toContain('Idle');
    expect(s).toContain('Queued: 0');
  });

  it('statusText reports running task and pause', () => {
    store.enqueueTask({ source: 'telegram', kind: 'chat', userId: 7, chatId: 70, prompt: 'long job' });
    const t = store.claimNextTask()!;
    const fakeWorker = { pausedUntil: new Date(), currentTask: () => t } as any;
    const s = statusText(store, fakeWorker, new Date());
    expect(s).toContain('long job');
    expect(s).toContain('usage limit');
  });

  it('queueText lists queued tasks', () => {
    store.enqueueTask({ source: 'telegram', kind: 'chat', userId: 7, chatId: 70, prompt: 'first thing to do' });
    expect(queueText(store)).toContain('first thing to do');
  });

  it('newConversation enqueues a rotate task with the rotation prompt', () => {
    const id = newConversation(store, 7, 70);
    expect(store.getTask(id)).toMatchObject({ kind: 'rotate', prompt: ROTATE_PROMPT });
  });

  it('schedulesText lists schedules', () => {
    store.createSchedule({ cronExpr: '0 8 * * 1', prompt: 'weekly review', missedPolicy: 'skip', createdByUserId: 7, chatId: 70 });
    const s = schedulesText(store);
    expect(s).toContain('0 8 * * 1');
    expect(s).toContain('weekly review');
  });
});
