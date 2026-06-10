import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import parser from 'cron-parser';
import { z } from 'zod';
import type { Store } from './store.js';
import type { Task } from './types.js';

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
            'The prompt will run as a task and its result is sent to the creating user.',
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
            '(relative, from now) OR at (absolute ISO-8601 timestamp). The reminder prompt runs ' +
            'and its result is sent to you. For RECURRING jobs use schedule_create instead.',
          { delay_seconds: z.number().int().positive().optional(), at: z.string().optional(), prompt: z.string() },
          async (a) => {
            let runAt: Date;
            if (a.delay_seconds != null && a.at == null) {
              runAt = new Date(Date.now() + a.delay_seconds * 1000);
            } else if (a.at != null && a.delay_seconds == null) {
              const parsed = new Date(a.at);
              if (isNaN(parsed.getTime())) return { content: [{ type: 'text', text: 'Invalid "at" timestamp; use ISO-8601.' }], isError: true };
              runAt = parsed;
            } else {
              return { content: [{ type: 'text', text: 'Provide exactly one of delay_seconds or at.' }], isError: true };
            }
            const id = store.createReminder({ runAt: runAt.toISOString(), prompt: a.prompt, createdByUserId: task.userId, chatId: task.chatId });
            return { content: [{ type: 'text', text: `Reminder #${id} set for ${runAt.toISOString()}` }] };
          },
        ),
      ],
    }),
  };
}
