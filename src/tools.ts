import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import parser from 'cron-parser';
import { z } from 'zod';
import type { Store } from './store.js';
import type { Task } from './types.js';

/** Resolve a reminder's absolute fire time from a relative delay or an absolute/HH:MM `at`. Pure + testable. */
export function resolveRunAt(
  input: { delay_seconds?: number; at?: string },
  now: Date,
): { runAt: string } | { error: string } {
  const hasDelay = input.delay_seconds != null;
  const hasAt = input.at != null;
  if (hasDelay === hasAt) return { error: 'Provide exactly one of delay_seconds or at.' };
  if (hasDelay) {
    if (!(input.delay_seconds! > 0)) return { error: 'delay_seconds must be a positive number.' };
    return { runAt: new Date(now.getTime() + input.delay_seconds! * 1000).toISOString() };
  }
  const at = input.at!.trim();
  const hm = at.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (hm) {
    const h = Number(hm[1]); const m = Number(hm[2]); const s = hm[3] ? Number(hm[3]) : 0;
    if (h > 23 || m > 59 || s > 59) return { error: 'Invalid HH:MM time.' };
    const d = new Date(now);
    d.setHours(h, m, s, 0);
    if (d <= now) d.setDate(d.getDate() + 1); // next occurrence today/tomorrow, local time
    return { runAt: d.toISOString() };
  }
  const parsed = new Date(at);
  if (isNaN(parsed.getTime())) return { error: 'Invalid "at": use an ISO-8601 timestamp or HH:MM.' };
  return { runAt: parsed.toISOString() };
}

/** In-process MCP server exposing schedule management to the agent, scoped to the requesting task's user/chat. */
export function runtimeMcpServer(store: Store, task: Pick<Task, 'userId' | 'chatId'>): Record<string, unknown> {
  return {
    runtime: createSdkMcpServer({
      name: 'runtime',
      version: '1.0.0',
      tools: [
        tool(
          'schedule_create',
          'Create a RECURRING scheduled job (standard 5-field cron). For one-time reminders use reminder_create instead. ' +
            'cron is a standard 5-field cron expression in local time. ' +
            'The prompt runs as a task and its FINAL REPLY is delivered to the creating user automatically. ' +
            "Phrase `prompt` as the work/content to produce (e.g. \"Summarize my open tasks for today\"), NOT as " +
            '"send a Telegram message" — do not instruct it to send or deliver anything; the delivery is automatic.',
          { cron: z.string(), prompt: z.string(), missed_policy: z.enum(['run_now', 'skip']).optional() },
          async (a) => {
            parser.parseExpression(a.cron); // throws on invalid cron
            const id = store.createSchedule({
              cronExpr: a.cron, prompt: a.prompt, missedPolicy: a.missed_policy ?? 'run_now',
              createdByUserId: task.userId, chatId: task.chatId,
            });
            return { content: [{ type: 'text', text: `Created schedule #${id} (${a.cron})` }] };
          },
        ),
        tool('schedule_list', 'List all scheduled jobs.', {}, async () => ({
          content: [{ type: 'text', text: JSON.stringify(store.listSchedules(), null, 2) }],
        })),
        tool('schedule_delete', 'Delete a scheduled job by its id.', { id: z.number() }, async (a) => {
          store.deleteSchedule(a.id);
          return { content: [{ type: 'text', text: `Deleted schedule #${a.id}` }] };
        }),
        tool(
          'reminder_create',
          'Create a ONE-TIME reminder that fires once. Use this for "remind me in N minutes", ' +
            '"remind me at HH:MM", or any single future reminder. Provide either delay_seconds ' +
            '(relative, from now) OR at (absolute ISO-8601 timestamp or HH:MM, next occurrence). ' +
            'The reminder prompt runs and its FINAL REPLY is delivered to you automatically. ' +
            "Phrase `prompt` as what to remind/produce (e.g. \"Remind me to sleep\"), NOT as \"send a Telegram message\" — " +
            'do not instruct it to send anything; delivery is automatic. For RECURRING jobs use schedule_create instead.',
          {
            delay_seconds: z.number().int().positive().optional(),
            at: z.string().optional().describe('Absolute time: ISO-8601 timestamp, or HH:MM (next occurrence, local time).'),
            prompt: z.string(),
          },
          async (a) => {
            const r = resolveRunAt({ delay_seconds: a.delay_seconds, at: a.at }, new Date());
            if ('error' in r) return { content: [{ type: 'text', text: r.error }], isError: true };
            const id = store.createReminder({ runAt: r.runAt, prompt: a.prompt, createdByUserId: task.userId, chatId: task.chatId });
            return { content: [{ type: 'text', text: `Reminder #${id} set for ${r.runAt}` }] };
          },
        ),
      ],
    }),
  };
}
