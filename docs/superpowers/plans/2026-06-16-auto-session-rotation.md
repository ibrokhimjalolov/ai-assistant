# Auto Session Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically rotate an agent's per-user session (save durable facts to `memory/`, then start fresh) when its context usage crosses a configurable per-agent threshold (default 70%), silently.

**Architecture:** `claude.ts` reads `modelUsage` from each SDK result and attaches a `contextFraction` to the `final` event. After a successful chat task, `worker.ts` enqueues a **silent** `rotate` task (reusing the existing `/new` `ROTATE_PROMPT`) when the fraction ≥ the agent's `rotateAtContextFraction`. The rotate task writes memory and drops the session; the next message starts fresh. A new `silent` task column suppresses the rotate's reply so it's invisible to the user.

**Tech Stack:** TypeScript, better-sqlite3, `@anthropic-ai/claude-agent-sdk`, vitest. Build: `npm run build` (tsc). Tests: `npm test` (vitest, tests in `tests/*.test.ts`).

---

## File structure (what changes)
- `src/util.ts` — add pure `contextFractionFromUsage(modelUsage)`.
- `src/types.ts` — `Task.silent`; `final` RunEvent gains `contextFraction?`.
- `src/claude.ts` — `mapSdkMessage` attaches `contextFraction` from `m.modelUsage`.
- `src/config.ts` — per-agent `rotateAtContextFraction` (default 0.70, validated).
- `src/db.ts` — `tasks.silent` column (in SCHEMA + guarded `migrateTasks`).
- `src/store.ts` — `enqueueTask` accepts `silent`; `toTask` maps it.
- `src/worker.ts` — exported pure `shouldAutoRotate`; `runOnce` returns `{text, contextFraction}`; `complete` honors `silent`; `maybeAutoRotate` enqueues the silent rotate; `WorkerDeps.rotateAtContextFraction`.
- `src/index.ts` — pass `rotateAtContextFraction` into the Worker.
- Tests: `tests/util.test.ts` (new), `tests/config.test.ts` (append), `tests/store-tasks.test.ts` (append), `tests/claude.test.ts` (append), `tests/worker.test.ts` (append).

---

## Task 1: `contextFractionFromUsage` pure helper

**Files:** Modify `src/util.ts`; Create `tests/util.test.ts`

- [ ] **Step 1: Write the failing test** — create `tests/util.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { contextFractionFromUsage } from '../src/util.js';

describe('contextFractionFromUsage', () => {
  it('returns used/contextWindow including cache tokens', () => {
    const usage = { 'claude-x': { inputTokens: 100, cacheReadInputTokens: 50, cacheCreationInputTokens: 50, contextWindow: 1000 } };
    expect(contextFractionFromUsage(usage)).toBeCloseTo(0.2, 5); // (100+50+50)/1000
  });
  it('takes the max fraction across models', () => {
    const usage = {
      a: { inputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 1000 }, // 0.1
      b: { inputTokens: 800, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 1000 }, // 0.8
    };
    expect(contextFractionFromUsage(usage)).toBeCloseTo(0.8, 5);
  });
  it('returns null for missing / zero-window / non-object', () => {
    expect(contextFractionFromUsage(undefined)).toBeNull();
    expect(contextFractionFromUsage({})).toBeNull();
    expect(contextFractionFromUsage({ a: { inputTokens: 5, contextWindow: 0 } })).toBeNull();
    expect(contextFractionFromUsage('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run tests/util.test.ts`
Expected: FAIL — `contextFractionFromUsage` is not exported.

- [ ] **Step 3: Implement** — append to `src/util.ts`

```ts
/**
 * Fraction of the context window used, from the SDK result's `modelUsage` record.
 * Returns the max over models of (input + cacheRead + cacheCreate) / contextWindow,
 * or null when there is no usable entry (missing data → never auto-rotate).
 */
export function contextFractionFromUsage(modelUsage: unknown): number | null {
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  let max: number | null = null;
  for (const u of Object.values(modelUsage as Record<string, any>)) {
    if (!u || typeof u !== 'object') continue;
    const windowSize = Number(u.contextWindow);
    if (!Number.isFinite(windowSize) || windowSize <= 0) continue;
    const used =
      Number(u.inputTokens || 0) + Number(u.cacheReadInputTokens || 0) + Number(u.cacheCreationInputTokens || 0);
    const frac = used / windowSize;
    if (max === null || frac > max) max = frac;
  }
  return max;
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `npx vitest run tests/util.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/util.ts tests/util.test.ts
git commit -m "feat(runtime): contextFractionFromUsage helper"
```

---

## Task 2: per-agent `rotateAtContextFraction` config

**Files:** Modify `src/config.ts`; Append `tests/config.test.ts`

- [ ] **Step 1: Write the failing test** — append to `tests/config.test.ts`

```ts
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// (loadConfig + ConfigError are already imported at the top of this file.)

describe('rotateAtContextFraction', () => {
  function writeCfg(obj: any): string {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    const home = join(dir, 'home'); mkdirSync(home);
    obj.agents[0].agentHome = home;
    const p = join(dir, 'config.json'); writeFileSync(p, JSON.stringify(obj));
    return p;
  }
  const base = () => ({ agents: [{ name: 'a', telegramBotToken: 't', whitelist: [1], agentHome: 'x' }] });

  it('defaults to 0.70 when omitted', () => {
    const cfg = loadConfig(writeCfg(base()));
    expect(cfg.agents[0].rotateAtContextFraction).toBe(0.70);
  });
  it('accepts an in-range override (and 0 to disable)', () => {
    const o = base(); o.agents[0].rotateAtContextFraction = 0;
    expect(loadConfig(writeCfg(o)).agents[0].rotateAtContextFraction).toBe(0);
  });
  it('rejects out-of-range / non-number', () => {
    const o1 = base(); o1.agents[0].rotateAtContextFraction = 1.5;
    expect(() => loadConfig(writeCfg(o1))).toThrow(/rotateAtContextFraction/);
    const o2 = base(); o2.agents[0].rotateAtContextFraction = 'high';
    expect(() => loadConfig(writeCfg(o2))).toThrow(/rotateAtContextFraction/);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — default is `undefined`, no validation.

- [ ] **Step 3: Implement** — three edits in `src/config.ts`

(a) add to the `AgentConfig` interface (after `bashAllowlist: string[];`):
```ts
  /** Auto-rotate the session when context usage reaches this fraction [0,1]; 0 disables. */
  rotateAtContextFraction: number;
```
(b) add to `AGENT_DEFAULTS`:
```ts
const AGENT_DEFAULTS = {
  approvalTimeoutMs: 900_000,
  taskTimeoutMs: 600_000,
  bashAllowlist: DEFAULT_BASH_ALLOWLIST,
  rotateAtContextFraction: 0.70,
};
```
(c) in `validateAgent`, add a check just before the `return {` (after the agentHome check):
```ts
  if (a.rotateAtContextFraction !== undefined) {
    const v = a.rotateAtContextFraction;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new ConfigError(`config: ${where} rotateAtContextFraction must be a number in [0,1] (0 disables)`);
    }
  }
```
(The existing `return { ...AGENT_DEFAULTS, ...a, ... }` already carries the value through — default from `AGENT_DEFAULTS`, overridden by `a` when present.)

- [ ] **Step 4: Run, verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (all config tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(runtime): per-agent rotateAtContextFraction config (default 0.70)"
```

---

## Task 3: `silent` task column (types + db + store)

**Files:** Modify `src/types.ts`, `src/db.ts`, `src/store.ts`; Append `tests/store-tasks.test.ts`

- [ ] **Step 1: Write the failing test** — append to `tests/store-tasks.test.ts`

```ts
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
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run tests/store-tasks.test.ts`
Expected: FAIL — `silent` not on Task / not accepted by `enqueueTask`.

- [ ] **Step 3a: Implement** — `src/types.ts`, add to the `Task` interface (after `resultSummary: string | null;`):
```ts
  silent: boolean;
```

- [ ] **Step 3b: Implement** — `src/db.ts`: add `silent` to the tasks SCHEMA and a guarded migration.

In `SCHEMA`, in the `CREATE TABLE IF NOT EXISTS tasks (...)` block, add this line right after `result_summary TEXT,`:
```
  silent INTEGER NOT NULL DEFAULT 0,
```
Add a migration function (next to `migrateSchedules`):
```ts
function migrateTasks(db: Database.Database): void {
  const cols = db.pragma('table_info(tasks)') as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'silent')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN silent INTEGER NOT NULL DEFAULT 0`);
  }
}
```
In `openDb`, call it after `migrateSchedules(db);`:
```ts
  migrateSchedules(db);
  migrateTasks(db);
```

- [ ] **Step 3c: Implement** — `src/store.ts`:

Change `enqueueTask` to accept + persist `silent`:
```ts
  enqueueTask(t: { source: TaskSource; kind: TaskKind; userId: number; chatId: number; prompt: string; silent?: boolean }): number {
    const r = this.db
      .prepare(`INSERT INTO tasks (source, kind, user_id, chat_id, prompt, silent) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(t.source, t.kind, t.userId, t.chatId, t.prompt, t.silent ? 1 : 0);
    return Number(r.lastInsertRowid);
  }
```
Add `silent` to `toTask` (after `resultSummary: ...`):
```ts
    silent: row.silent === 1,
```

- [ ] **Step 4: Run, verify it passes**

Run: `npx vitest run tests/store-tasks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/db.ts src/store.ts tests/store-tasks.test.ts
git commit -m "feat(runtime): silent task column (suppresses reply delivery)"
```

---

## Task 4: `claude.ts` attaches `contextFraction` to the final event

**Files:** Modify `src/types.ts`, `src/claude.ts`; Append `tests/claude.test.ts`

- [ ] **Step 1: Write the failing test** — append to `tests/claude.test.ts`

```ts
// mapSdkMessage is already imported at the top of this file.
describe('mapSdkMessage contextFraction', () => {
  it('attaches contextFraction from modelUsage on success', () => {
    const ev = mapSdkMessage({
      type: 'result', subtype: 'success', result: 'hi',
      modelUsage: { m: { inputTokens: 700, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 1000 } },
    });
    expect(ev).toMatchObject({ kind: 'final', text: 'hi' });
    expect((ev as any).contextFraction).toBeCloseTo(0.7, 5);
  });
  it('contextFraction is null when modelUsage is absent', () => {
    const ev = mapSdkMessage({ type: 'result', subtype: 'success', result: 'hi' });
    expect((ev as any).contextFraction).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run tests/claude.test.ts`
Expected: FAIL — `contextFraction` undefined on the event.

- [ ] **Step 3a: Implement** — `src/types.ts`: change the `final` RunEvent variant:
```ts
export type RunEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'progress'; text: string }
  | { kind: 'final'; text: string; contextFraction?: number | null };
```

- [ ] **Step 3b: Implement** — `src/claude.ts`:

Add the import at the top (with the other local imports):
```ts
import { contextFractionFromUsage } from './util.js';
```
In `mapSdkMessage`, change the success line:
```ts
    if (m.subtype === 'success')
      return { kind: 'final', text: m.result || '(no output)', contextFraction: contextFractionFromUsage(m.modelUsage) };
```

- [ ] **Step 4: Run, verify it passes**

Run: `npx vitest run tests/claude.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/claude.ts tests/claude.test.ts
git commit -m "feat(runtime): surface context-window fraction on the final event"
```

---

## Task 5: worker auto-rotation (the integration)

**Files:** Modify `src/worker.ts`, `src/index.ts`; Append `tests/worker.test.ts`

- [ ] **Step 1: Write the failing tests** — append to `tests/worker.test.ts`

```ts
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { Worker, shouldAutoRotate } from '../src/worker.js';
import type { RunEvent, RunRequest } from '../src/types.js';

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
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run tests/worker.test.ts`
Expected: FAIL — `shouldAutoRotate` not exported; no rotate enqueued; silent not honored.

- [ ] **Step 3a: Implement** — `src/worker.ts` imports: add `ROTATE_PROMPT` and the `TaskKind` type:
```ts
import { UsageLimitError, type ClaudeRunner, type Task, type TaskKind } from './types.js';
import { ROTATE_PROMPT } from './commands.js';
```

- [ ] **Step 3b: Implement** — add `rotateAtContextFraction` to `WorkerDeps`:
```ts
  /** Auto-rotate the session when context usage reaches this fraction; 0/undefined disables. */
  rotateAtContextFraction?: number;
```

- [ ] **Step 3c: Implement** — add the exported pure predicate (top-level, after the `WorkerDeps` interface):
```ts
export function shouldAutoRotate(args: {
  kind: TaskKind;
  contextFraction: number | null | undefined;
  threshold: number;
  rotateQueued: boolean;
}): boolean {
  const { kind, contextFraction, threshold, rotateQueued } = args;
  return (
    kind === 'chat' &&
    threshold > 0 &&
    contextFraction != null &&
    contextFraction >= threshold &&
    !rotateQueued
  );
}
```

- [ ] **Step 3d: Implement** — change `runOnce` to also return the fraction:

Replace the `runOnce` signature/body's accumulation and return:
```ts
  private async runOnce(task: Task, signal: AbortSignal, useResume: boolean): Promise<{ text: string; contextFraction: number | null }> {
    const session = useResume ? this.d.store.getSession(task.userId) : undefined;
    let final = '';
    let contextFraction: number | null = null;
    for await (const ev of this.d.runner.run({
      prompt: this.effectivePrompt(task),
      cwd: this.d.agentHome,
      resume: session?.claudeSessionId,
      signal,
      canUseTool: this.d.gate.handlerFor(task),
      mcpServers: this.d.mcpServersFor?.(task),
      claudeToken: this.d.claudeToken,
    })) {
      if (ev.kind === 'session') {
        this.d.store.setSession(task.userId, ev.sessionId);
        this.d.store.attachSession(task.id, ev.sessionId);
        log.debug('session attached', { taskId: task.id, sessionId: ev.sessionId });
      } else if (ev.kind === 'final') {
        final = ev.text;
        contextFraction = ev.contextFraction ?? null;
      }
    }
    return { text: final, contextFraction };
  }
```

- [ ] **Step 3e: Implement** — update the two `runOnce` call sites.

In `process()` (the try block):
```ts
    try {
      const { text, contextFraction } = await this.runOnce(task, abort.signal, true);
      this.complete(task, text, null);
      this.maybeAutoRotate(task, contextFraction);
    } catch (e) {
```
In `retryFresh()`:
```ts
      const { text } = await this.runOnce(task, abort.signal, false);
      this.complete(task, text, '⚠️ Previous conversation context was lost due to a session error.');
```

- [ ] **Step 3f: Implement** — honor `silent` in `complete()`:
```ts
  private complete(task: Task, final: string, prefixNote: string | null): void {
    if (!task.silent) {
      const content = prefixNote ? `${prefixNote}\n\n${final}` : final;
      this.d.store.enqueueMessage({ chatId: task.chatId, content });
    }
    this.d.store.finishTask(task.id, 'done', truncate(final, 500));
    if (task.kind === 'rotate') this.d.store.rotateSession(task.userId);
    log.info('task done', { id: task.id, silent: task.silent });
  }
```

- [ ] **Step 3g: Implement** — add `maybeAutoRotate` (private method):
```ts
  private maybeAutoRotate(task: Task, contextFraction: number | null): void {
    const threshold = this.d.rotateAtContextFraction ?? 0;
    const rotateQueued = this.d.store.pendingTasks().some((t) => t.kind === 'rotate' && t.userId === task.userId);
    log.debug('context fraction', { userId: task.userId, contextFraction, threshold });
    if (!shouldAutoRotate({ kind: task.kind, contextFraction, threshold, rotateQueued })) return;
    this.d.store.enqueueTask({ source: 'telegram', kind: 'rotate', userId: task.userId, chatId: task.chatId, prompt: ROTATE_PROMPT, silent: true });
    log.info('auto-rotating session (context threshold reached)', { userId: task.userId, contextFraction, threshold });
  }
```

- [ ] **Step 3h: Implement** — `src/index.ts`: in the `new Worker({ ... })` call (around line 61), add the line after `claudeToken: agentCfg.claudeOauthToken,`:
```ts
      rotateAtContextFraction: agentCfg.rotateAtContextFraction,
```

- [ ] **Step 4: Run, verify it passes**

Run: `npx vitest run tests/worker.test.ts`
Expected: PASS (shouldAutoRotate + both worker tests).

- [ ] **Step 5: Commit**

```bash
git add src/worker.ts src/index.ts tests/worker.test.ts
git commit -m "feat(runtime): auto-rotate session at context threshold (silent)"
```

---

## Task 6: build, full suite, deploy notes

- [ ] **Step 1: Type-check / build**

Run: `npm run build`
Expected: tsc completes with no errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all tests pass (existing + the new ones).

- [ ] **Step 3: Commit any build-config touch-ups (only if build surfaced one)** — otherwise skip.

- [ ] **Step 4: Manual verification (live, optional but recommended)**

On a test machine/agent, set `rotateAtContextFraction` low (e.g. `0.02`) in that agent's config, restart the daemon, and send two messages. Confirm via the agent DB + logs:
```bash
DB="$HOME/Library/Application Support/agent-runtime/agents/<name>/agent.db"
sqlite3 -readonly "$DB" "SELECT id,kind,silent,status FROM tasks ORDER BY id DESC LIMIT 5;"  # expect a kind=rotate, silent=1 row
sqlite3 -readonly "$DB" "SELECT * FROM sessions;"                                            # claude_session_id changed after rotation
ls -t "<agentHome>/memory/"                                                                  # a memory file was written/updated
grep "auto-rotating session" "$HOME/Library/Application Support/agent-runtime/logs/agent-runtime.log"
```
And confirm **no extra Telegram message** appeared for the rotation. (The `log.debug('context fraction', …)` line shows the measured fraction each task — useful if `modelUsage` ever comes back empty, in which case the fraction is `null` and rotation safely never fires.)

- [ ] **Step 5: Deploy** — rebuild + redeploy the runtime (out of plan scope to run automatically):
  - ibrokhim's Mac: `bash scripts/build-dmg.sh` → reinstall `AgentRuntime.app` → `launchctl kickstart -k gui/$(id -u)/uz.domo.agent-runtime`.
  - mini: re-run the on-device install path.

---

## Self-review notes (resolved)
- **Spec coverage:** helper (T1), config default 0.70 + validation + 0-disables (T2), silent column (T3), contextFraction on final event (T4), `shouldAutoRotate` + silent rotate enqueue + silent suppression + dup-guard + index wiring (T5), build/tests/manual (T6). All spec sections covered.
- **No placeholders:** every code step shows complete code; manual step gives exact commands.
- **Type/name consistency:** `contextFractionFromUsage` (util) → used in claude.ts; `final` event `contextFraction?: number | null` consumed by `runOnce`; `Task.silent` set by `enqueueTask({silent})`, mapped in `toTask`, read in `complete`; `shouldAutoRotate({kind,contextFraction,threshold,rotateQueued})` signature identical in worker.ts and worker.test.ts; `WorkerDeps.rotateAtContextFraction` set from `agentCfg.rotateAtContextFraction` (config) in index.ts. Consistent.
- **Safety:** null fraction / threshold 0 → no rotate; dup-guard via `pendingTasks`; rotate task is `kind:'rotate'` so it can't re-trigger; silent rotate suppresses outbox; manual `/new` (`silent` defaults false) still replies.
