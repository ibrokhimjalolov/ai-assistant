import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';

let store: Store;
beforeEach(() => { store = new Store(openDb(':memory:')); });

describe('outbox', () => {
  it('enqueues, lists unsent, marks sent', () => {
    const id = store.enqueueMessage({ chatId: 5, content: 'hello' });
    expect(store.unsentMessages().map((m) => m.id)).toEqual([id]);
    store.markSent(id, 999);
    expect(store.unsentMessages()).toEqual([]);
    expect(store.sentMessageId(id)).toBe(999);
  });

  it('coalesces pending edits for the same target', () => {
    const orig = store.enqueueMessage({ chatId: 5, content: 'status' });
    store.enqueueEdit(orig, 'progress 1');
    const e2 = store.enqueueEdit(orig, 'progress 2');
    const unsent = store.unsentMessages();
    expect(unsent.filter((m) => m.kind === 'edit').map((m) => m.id)).toEqual([e2]);
    expect(unsent.find((m) => m.id === e2)?.content).toBe('progress 2');
  });

  it('bumpAttempts tracks retry state and caps listing at 8 attempts', () => {
    const id = store.enqueueMessage({ chatId: 5, content: 'x' });
    for (let i = 0; i < 8; i++) store.bumpAttempts(id, new Date());
    expect(store.unsentMessages()).toEqual([]);
  });
});

describe('approvals', () => {
  it('creates pending and decides', () => {
    const tid = store.enqueueTask({ source: 'telegram', kind: 'chat', userId: 1, chatId: 1, prompt: 'p' });
    const id = store.createApproval(tid, 'Bash', 'command: rm -rf /', null);
    store.decideApproval(id, 'approved');
    const row = store.getApproval(id);
    expect(row?.decision).toBe('approved');
  });

  it('records auto_approved with decided_at set', () => {
    const tid = store.enqueueTask({ source: 'telegram', kind: 'chat', userId: 1, chatId: 1, prompt: 'p' });
    const id = store.createApproval(tid, 'Read', 'file_path: /x', 'auto_approved');
    expect(store.getApproval(id)?.decision).toBe('auto_approved');
  });
});

describe('schedules', () => {
  it('CRUD and markScheduleRun', () => {
    const id = store.createSchedule({
      cronExpr: '0 8 * * *', prompt: 'morning brief', missedPolicy: 'run_now', createdByUserId: 1, chatId: 1,
    });
    expect(store.enabledSchedules()).toHaveLength(1);
    store.markScheduleRun(id, new Date('2026-06-10T08:00:00Z'));
    expect(store.enabledSchedules()[0].lastRunAt).toContain('2026-06-10');
    store.deleteSchedule(id);
    expect(store.listSchedules()).toHaveLength(0);
  });
});

describe('meta', () => {
  it('get/set', () => {
    expect(store.getMeta('k')).toBeNull();
    store.setMeta('k', 'v');
    expect(store.getMeta('k')).toBe('v');
  });
});
