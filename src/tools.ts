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
          'Create a recurring scheduled job. cron is a standard 5-field cron expression in local time. ' +
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
      ],
    }),
  };
}
