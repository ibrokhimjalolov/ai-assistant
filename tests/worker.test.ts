import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { PermissionGate } from '../src/gate.js';
import { Worker } from '../src/worker.js';
import { UsageLimitError, type ClaudeRunner, type RunEvent } from '../src/types.js';

function runnerOf(events: RunEvent[] | (() => AsyncGenerator<RunEvent>)): ClaudeRunner {
  return {
    async *run() {
      if (typeof events === 'function') { yield* events(); return; }
      for (const e of events) yield e;
    },
  };
}

let store: Store; let gate: PermissionGate;
beforeEach(() => {
  store = new Store(openDb(':memory:'));
  gate = new PermissionGate(store, new Policy('/home', []), 50);
});

function makeWorker(runner: ClaudeRunner): Worker {
  return new Worker({ store, runner, gate, agentHome: '/home' });
}

function enqueueChat(prompt = 'hello'): number {
  return store.enqueueTask({ source: 'telegram', kind: 'chat', userId: 7, chatId: 70, prompt });
}

describe('Worker', () => {
  it('processes a task: session saved, progress edited, final sent, task done', async () => {
    const w = makeWorker(runnerOf([
      { kind: 'session', sessionId: 's1' },
      { kind: 'progress', text: 'working on it' },
      { kind: 'final', text: 'the answer' },
    ]));
    const id = enqueueChat();
    expect(await w.tick()).toBe(true);
    expect(store.getTask(id)).toMatchObject({ status: 'done', sessionId: 's1' });
    expect(store.getSession(7)?.claudeSessionId).toBe('s1');
    const out = store.unsentMessages();
    expect(out.some((m) => m.kind === 'edit' && m.content.includes('working on it'))).toBe(true);
    expect(out.some((m) => m.content === 'the answer')).toBe(true);
  });

  it('returns false when queue empty', async () => {
    expect(await makeWorker(runnerOf([])).tick()).toBe(false);
  });

  it('pauses and requeues on usage limit, then resumes after reset', async () => {
    let calls = 0;
    const w = makeWorker(runnerOf(async function* () {
      calls++;
      if (calls === 1) throw new UsageLimitError(new Date(Date.now() + 60_000));
      yield { kind: 'final', text: 'ok now' } as RunEvent;
    }));
    const id = enqueueChat();
    await w.tick();
    expect(store.getTask(id)?.status).toBe('queued');
    expect(w.pausedUntil).not.toBeNull();
    expect(store.unsentMessages().some((m) => m.content.includes('usage limit'))).toBe(true);
    expect(await w.tick()).toBe(false); // paused
    w.pausedUntil = new Date(0); // simulate reset passed
    await w.tick();
    expect(store.getTask(id)?.status).toBe('done');
  });

  it('retries once with fresh session on error, then fails with notification', async () => {
    const w = makeWorker(runnerOf(async function* () { throw new Error('corrupt session'); }));
    const id = enqueueChat();
    await w.tick();
    expect(store.getTask(id)?.status).toBe('failed');
    expect(store.unsentMessages().some((m) => m.content.startsWith('❌'))).toBe(true);
  });

  it('recovers when fresh-session retry succeeds', async () => {
    let calls = 0;
    const w = makeWorker(runnerOf(async function* () {
      calls++;
      if (calls === 1) throw new Error('corrupt session');
      yield { kind: 'final', text: 'recovered' } as RunEvent;
    }));
    const id = enqueueChat();
    await w.tick();
    expect(store.getTask(id)?.status).toBe('done');
    expect(store.unsentMessages().some((m) => m.content.includes('context was lost'))).toBe(true);
  });

  it('rotates the session after a rotate-kind task completes', async () => {
    store.setSession(7, 'old-session');
    store.enqueueTask({ source: 'telegram', kind: 'rotate', userId: 7, chatId: 70, prompt: 'save memory' });
    const w = makeWorker(runnerOf([{ kind: 'final', text: 'saved' }]));
    await w.tick();
    expect(store.getSession(7)).toBeUndefined();
  });

  it('cancel aborts only the requesting user\'s running task', async () => {
    let aborted = false;
    const w = makeWorker({
      async *run(req) {
        yield { kind: 'session', sessionId: 's' };
        await new Promise<void>((res) => { req.signal.addEventListener('abort', () => { aborted = true; res(); }); });
        throw new Error('aborted');
      },
    });
    const id = enqueueChat();
    const ticking = w.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(w.cancel(999)).toBe(false); // not this user's task
    expect(w.cancel(7)).toBe(true);
    await ticking;
    expect(aborted).toBe(true);
    expect(store.getTask(id)?.status).toBe('cancelled');
  });

  it('injects the asking user identity into the prompt', async () => {
    let seenPrompt = '';
    const w = makeWorker({
      async *run(req) { seenPrompt = req.prompt; yield { kind: 'final', text: 'ok' }; },
    });
    enqueueChat('what is my balance');
    await w.tick();
    expect(seenPrompt).toContain('Telegram user 7');
    expect(seenPrompt).toContain('what is my balance');
  });

  it('marks cancelled when cancel fires during the first run (before retry)', async () => {
    const w = makeWorker({
      async *run(req) {
        yield { kind: 'session', sessionId: 's' };
        // wait until cancelled, then throw a NON-abort-looking error
        await new Promise<void>((res) => req.signal.addEventListener('abort', () => res()));
        throw new Error('boom after abort');
      },
    });
    const id = enqueueChat();
    const ticking = w.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(w.cancel(7)).toBe(true);
    await ticking;
    expect(store.getTask(id)?.status).toBe('cancelled');
  });
});
