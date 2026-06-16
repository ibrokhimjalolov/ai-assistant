import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';

let store: Store;
beforeEach(() => { store = new Store(openDb(':memory:')); });

describe('inbox', () => {
  it('records updates once; duplicates return false', () => {
    expect(store.recordUpdate(100, '{"a":1}')).toBe(true);
    expect(store.recordUpdate(100, '{"a":1}')).toBe(false);
  });
});

describe('tasks', () => {
  const t = { source: 'telegram', kind: 'chat', userId: 7, chatId: 7, prompt: 'hi' } as const;

  it('enqueues and claims FIFO, marking running', () => {
    const a = store.enqueueTask(t);
    const b = store.enqueueTask({ ...t, prompt: 'second' });
    const claimed = store.claimNextTask();
    expect(claimed?.id).toBe(a);
    expect(claimed?.status).toBe('running');
    expect(store.claimNextTask()?.id).toBe(b);
    expect(store.claimNextTask()).toBeUndefined();
  });

  it('finishes, requeues, attaches session', () => {
    const id = store.enqueueTask(t);
    store.claimNextTask();
    store.attachSession(id, 'sess-1');
    store.finishTask(id, 'done', 'summary');
    expect(store.getTask(id)).toMatchObject({ status: 'done', sessionId: 'sess-1', resultSummary: 'summary' });
    store.requeueTask(id);
    expect(store.getTask(id)?.status).toBe('queued');
  });

  it('marks running tasks interrupted on startup', () => {
    const id = store.enqueueTask(t);
    store.claimNextTask();
    const id2 = store.enqueueTask({ ...t, prompt: 'also running' });
    // force a second running task by claiming it too
    store.claimNextTask();
    const interrupted = store.markInterruptedOnStartup();
    expect(interrupted.map((x) => x.id).sort()).toEqual([id, id2].sort());
    expect(store.getTask(id)?.status).toBe('interrupted');
    expect(store.getTask(id2)?.status).toBe('interrupted');
  });

  it('pendingTasks lists queued+running in order', () => {
    store.enqueueTask(t);
    store.enqueueTask({ ...t, prompt: 'b' });
    store.claimNextTask();
    const p = store.pendingTasks();
    expect(p.map((x) => x.status)).toEqual(['running', 'queued']);
  });
});

describe('sessions', () => {
  it('set/get/rotate per user', () => {
    expect(store.getSession(7)).toBeUndefined();
    store.setSession(7, 's1');
    store.setSession(7, 's2');
    expect(store.getSession(7)?.claudeSessionId).toBe('s2');
    store.rotateSession(7);
    expect(store.getSession(7)).toBeUndefined();
  });
});

// openDb + Store are already imported at the top of this file.
describe('silent tasks', () => {
  it('defaults silent=false and round-trips silent=true', () => {
    const db = openDb(':memory:');
    const store = new Store(db);
    const a = store.enqueueTask({ source: 'telegram', kind: 'chat', userId: 1, chatId: 1, prompt: 'hi' });
    const b = store.enqueueTask({ source: 'telegram', kind: 'rotate', userId: 1, chatId: 1, prompt: 'x', silent: true });
    expect(store.getTask(a)!.silent).toBe(false);
    expect(store.getTask(b)!.silent).toBe(true);
  });
});
