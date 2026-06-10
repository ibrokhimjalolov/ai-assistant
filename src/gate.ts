import type { Store } from './store.js';
import type { Policy } from './policy.js';
import type { CanUseTool, PermissionResult, Task } from './types.js';

export class PermissionGate {
  private pending = new Map<number, (d: 'approved' | 'denied') => void>();

  constructor(private store: Store, private policy: Policy, private timeoutMs: number) {}

  handlerFor(task: Task): CanUseTool {
    return (toolName, input) => this.check(task, toolName, input);
  }

  async check(task: Task, toolName: string, input: Record<string, unknown>): Promise<PermissionResult> {
    const rendered = renderInput(input);
    if (this.policy.isSafe(toolName, input)) {
      this.store.createApproval(task.id, toolName, rendered, 'auto_approved');
      return { behavior: 'allow', updatedInput: input };
    }
    const id = this.store.createApproval(task.id, toolName, rendered, null);
    this.store.enqueueMessage({
      chatId: task.chatId,
      kind: 'approval',
      content: `🔐 Approval needed (task #${task.id})\nTool: ${toolName}\n\n${rendered}`,
      replyMarkup: approvalKeyboard(id),
    });
    const decision = await new Promise<'approved' | 'denied' | 'timeout'>((res) => {
      const timer = setTimeout(() => { this.pending.delete(id); res('timeout'); }, this.timeoutMs);
      this.pending.set(id, (d) => { clearTimeout(timer); this.pending.delete(id); res(d); });
    });
    this.store.decideApproval(id, decision);
    if (decision === 'approved') return { behavior: 'allow', updatedInput: input };
    return {
      behavior: 'deny',
      message: decision === 'timeout' ? 'No approval within the time limit — denied.' : 'Denied by user.',
    };
  }

  resolve(approvalId: number, decision: 'approved' | 'denied'): boolean {
    const resolver = this.pending.get(approvalId);
    if (!resolver) return false;
    resolver(decision);
    return true;
  }
}

export function approvalKeyboard(approvalId: number): string {
  return JSON.stringify({
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `apv:${approvalId}:y` },
      { text: '❌ Deny', callback_data: `apv:${approvalId}:n` },
    ]],
  });
}

function renderInput(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n')
    .slice(0, 1500);
}
