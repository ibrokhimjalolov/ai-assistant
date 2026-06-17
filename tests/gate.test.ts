import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { PermissionGate } from '../src/gate.js';
import type { Task } from '../src/types.js';

let store: Store; let gate: PermissionGate; let task: Task;
beforeEach(() => {
  store = new Store(openDb(':memory:'));
  gate = new PermissionGate(store, new Policy('/home', []), 50); // 50ms timeout for tests
  const id = store.enqueueTask({ source: 'telegram', kind: 'chat', userId: 7, chatId: 70, prompt: 'p' });
  task = store.getTask(id)!;
});

describe('PermissionGate', () => {
  it('auto-approves safe tools without messaging', async () => {
    const r = await gate.check(task, 'Read', { file_path: '/x' });
    expect(r.behavior).toBe('allow');
    expect(store.unsentMessages()).toHaveLength(0);
  });

  it('auto-approves shell/file tools in the allow-by-default posture (no prompt)', async () => {
    const r = await gate.check(task, 'Bash', { command: 'rm -rf /tmp/x' });
    expect(r.behavior).toBe('allow');
    expect(store.unsentMessages()).toHaveLength(0);
  });

  it('sends approval message and allows on user approval (outbound send)', async () => {
    const p = gate.check(task, 'mcp__mytelegram__send_message', { to: 'Ali', text: 'on my way' });
    const msg = store.unsentMessages().find((m) => m.kind === 'approval');
    expect(msg).toBeDefined();
    expect(msg!.chatId).toBe(70);
    expect(msg!.content).toContain('on my way');
    const approvalId = Number(JSON.parse(msg!.replyMarkup!).inline_keyboard[0][0].callback_data.split(':')[1]);
    expect(gate.resolve(approvalId, 'approved')).toBe(true);
    const r = await p;
    expect(r.behavior).toBe('allow');
    expect(store.getApproval(approvalId)?.decision).toBe('approved');
  });

  it('denies on user denial', async () => {
    const p = gate.check(task, 'mcp__emails__compose_email', { to: 'x@y.z', body: 'hi' });
    const msg = store.unsentMessages().find((m) => m.kind === 'approval')!;
    const approvalId = Number(JSON.parse(msg.replyMarkup!).inline_keyboard[0][1].callback_data.split(':')[1]);
    gate.resolve(approvalId, 'denied');
    const r = await p;
    expect(r.behavior).toBe('deny');
  });

  it('denies on timeout and records it', async () => {
    const r = await gate.check(task, 'mcp__mytelegram__sendMessage', { to: 'Bob', text: 'hey' });
    expect(r.behavior).toBe('deny');
    if (r.behavior === 'deny') expect(r.message).toContain('time limit');
  });

  it('resolve returns false for unknown/expired approvals', () => {
    expect(gate.resolve(9999, 'approved')).toBe(false);
  });
});
