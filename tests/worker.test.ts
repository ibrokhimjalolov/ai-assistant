import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { PermissionGate } from '../src/gate.js';
import { Worker, shouldAutoRotate } from '../src/worker.js';
import { UsageLimitError, type ClaudeRunner, type RunEvent, type RunRequest } from '../src/types.js';

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
  it('processes a task: session saved, final sent, task done', async () => {
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
    expect(out.some((m) => m.content.includes('Working'))).toBe(false);
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

  it('scheduled-job prompt says reply is auto-delivered and forbids send tools; result delivered via outbox', async () => {
    let seenPrompt = '';
    const w = makeWorker({
      async *run(req) { seenPrompt = req.prompt; yield { kind: 'final', text: 'report text' }; },
    });
    store.enqueueTask({ source: 'schedule', kind: 'chat', userId: 7, chatId: 70, prompt: 'Summarize my open tasks' });
    await w.tick();
    expect(seenPrompt).toContain('automatically');
    expect(seenPrompt).toMatch(/do NOT call any tool|send_message/);
    expect(seenPrompt).toContain('Summarize my open tasks');
    expect(store.unsentMessages().some((m) => m.content === 'report text')).toBe(true);
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

  it('aborts and FAILS (not cancels) a task that exceeds taskTimeoutMs', async () => {
    let aborted = false;
    const w = new Worker({
      store, gate, agentHome: '/home', taskTimeoutMs: 30,
      runner: {
        async *run(req) {
          yield { kind: 'session', sessionId: 's-timeout' };
          await new Promise<void>((res) => req.signal.addEventListener('abort', () => { aborted = true; res(); }));
          throw new Error('aborted by timeout');
        },
      },
    });
    const id = enqueueChat();
    await w.tick();
    expect(aborted).toBe(true);
    expect(store.getTask(id)?.status).toBe('failed');
    const out = store.unsentMessages();
    expect(out.some((m) => m.content.includes('timed out'))).toBe(true);
    expect(out.some((m) => m.content.includes('cancelled'))).toBe(false);
  });

  it('forwards the agent claudeToken to the runner', async () => {
    let seen: string | undefined;
    const w = new Worker({
      store, gate, agentHome: '/home', claudeToken: 'agent-tok',
      runner: { async *run(req) { seen = req.claudeToken; yield { kind: 'final', text: 'ok' }; } },
    });
    enqueueChat();
    await w.tick();
    expect(seen).toBe('agent-tok');
  });
});

const allowGate = { handlerFor: () => async () => ({ behavior: 'allow', updatedInput: {} }) } as any;
function runnerYielding(events: RunEvent[]) {
  return { async *run(_req: RunRequest) { for (const e of events) yield e; } };
}

describe('shouldAutoRotate', () => {
  const base = { kind: 'chat' as const, contextFraction: 0.8, threshold: 0.7, rotateQueued: false };
  it('true at/above threshold for chat tasks', () => {
    expect(shouldAutoRotate(base)).toBe(true);
    expect(shouldAutoRotate({ ...base, contextFraction: 0.7 })).toBe(true);
  });
  it('false below threshold, when disabled (0), null fraction, non-chat, or already queued', () => {
    expect(shouldAutoRotate({ ...base, contextFraction: 0.5 })).toBe(false);
    expect(shouldAutoRotate({ ...base, threshold: 0 })).toBe(false);
    expect(shouldAutoRotate({ ...base, contextFraction: null })).toBe(false);
    expect(shouldAutoRotate({ ...base, kind: 'rotate' })).toBe(false);
    expect(shouldAutoRotate({ ...base, rotateQueued: true })).toBe(false);
  });
});

describe('worker auto-rotation', () => {
  it('enqueues a silent rotate after a chat task over threshold; rotate task sends nothing and drops the session', async () => {
    const db = openDb(':memory:');
    const store = new Store(db);
    store.enqueueTask({ source: 'telegram', kind: 'chat', userId: 1, chatId: 1, prompt: 'hi' });
    const runner = runnerYielding([
      { kind: 'session', sessionId: 'sess-1' },
      { kind: 'final', text: 'answer', contextFraction: 0.9 },
    ]);
    const worker = new Worker({ store, runner, gate: allowGate, agentHome: '/tmp', rotateAtContextFraction: 0.7 });

    await worker.tick();                 // process the chat task
    expect(store.getSession(1)).toBeDefined();           // session was set
    const outAfterChat = store.unsentMessages();
    expect(outAfterChat.map((m) => m.content)).toContain('answer');  // reply delivered
    const rotateTasks = store.pendingTasks().filter((t) => t.kind === 'rotate');
    expect(rotateTasks).toHaveLength(1);
    expect(rotateTasks[0].silent).toBe(true);

    const outCount = store.unsentMessages().length;
    await worker.tick();                 // process the silent rotate task
    expect(store.unsentMessages().length).toBe(outCount);  // NO new message (silent)
    expect(store.getSession(1)).toBeUndefined();           // session rotated/dropped
  });

  it('does NOT rotate when under threshold', async () => {
    const db = openDb(':memory:');
    const store = new Store(db);
    store.enqueueTask({ source: 'telegram', kind: 'chat', userId: 1, chatId: 1, prompt: 'hi' });
    const runner = runnerYielding([
      { kind: 'session', sessionId: 's' },
      { kind: 'final', text: 'a', contextFraction: 0.3 },
    ]);
    const worker = new Worker({ store, runner, gate: allowGate, agentHome: '/tmp', rotateAtContextFraction: 0.7 });
    await worker.tick();
    expect(store.pendingTasks().filter((t) => t.kind === 'rotate')).toHaveLength(0);
  });
});
