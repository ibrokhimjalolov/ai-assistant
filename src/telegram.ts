import { Bot, type Api, type Context, type NextFunction } from 'grammy';
import type { AgentConfig } from './config.js';
import type { Store } from './store.js';
import type { PermissionGate } from './gate.js';
import type { Worker } from './worker.js';
import type { TelegramApi } from './sender.js';
import { intakeMessage } from './intake.js';
import { statusText, queueText, newConversation, schedulesText } from './commands.js';
import { logger } from './log.js';

const log = logger('telegram');

export function whitelistMiddleware(whitelist: number[]) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const id = ctx.from?.id;
    if (!id || !whitelist.includes(id)) {
      log.warn('dropped non-whitelisted sender', { senderId: id ?? null });
      return;
    }
    await next();
  };
}

export async function handleApprovalCallback(
  gate: PermissionGate,
  store: Store,
  ctx: Context & { match: RegExpMatchArray },
): Promise<void> {
  const approvalId = Number(ctx.match[1]);
  const approval = store.getApproval(approvalId);
  const task = approval ? store.getTask(approval.taskId) : undefined;
  if (!task || task.userId !== ctx.from?.id) {
    log.warn('approval callback rejected: not owner', { approvalId, from: ctx.from?.id });
    await ctx.answerCallbackQuery({ text: 'Not your approval' });
    return;
  }
  const ok = gate.resolve(approvalId, ctx.match[2] === 'y' ? 'approved' : 'denied');
  log.info('approval callback', { approvalId, decision: ctx.match[2] === 'y' ? 'approved' : 'denied', ok });
  await ctx.answerCallbackQuery({ text: ok ? 'Recorded ✓' : 'Already decided or expired' });
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
}

export async function handleResumeCallback(store: Store, ctx: Context & { match: RegExpMatchArray }): Promise<void> {
  const taskId = Number(ctx.match[1]);
  const t = store.getTask(taskId);
  const resumable = !!(t && t.status === 'interrupted' && t.userId === ctx.from?.id);
  log.info('resume callback', { taskId, resumable });
  if (resumable && t) {
    store.enqueueTask({
      source: 'telegram', kind: 'resume', userId: t.userId, chatId: t.chatId,
      prompt: 'Continue where you left off on the interrupted task.',
    });
    await ctx.answerCallbackQuery({ text: 'Resuming ▶️' });
  } else {
    await ctx.answerCallbackQuery({ text: 'Not resumable' });
  }
}

export interface BotDeps { store: Store; gate: PermissionGate; worker: Worker; startedAt: Date; }

export function buildBot(cfg: AgentConfig, d: BotDeps): Bot {
  const bot = new Bot(cfg.telegramBotToken);
  bot.use(whitelistMiddleware(cfg.whitelist));

  bot.command('status', (ctx) => ctx.reply(statusText(d.store, d.worker, d.startedAt)));
  bot.command('queue', (ctx) => ctx.reply(queueText(d.store)));
  bot.command('schedules', (ctx) => ctx.reply(schedulesText(d.store)));
  bot.command('cancel', (ctx) =>
    ctx.reply(d.worker.cancel(ctx.from!.id) ? '🛑 Cancelling…' : 'No running task of yours to cancel.'));
  bot.command('new', (ctx) => {
    newConversation(d.store, ctx.from!.id, ctx.chat.id);
    return ctx.reply('🔄 Rotation queued — durable facts will be saved to memory first.');
  });

  // ctx.match is typed as string | RegExpMatchArray in grammY v1.30 CallbackQueryContext;
  // with a regex filter it is always a RegExpMatchArray — cast to satisfy handleApprovalCallback/handleResumeCallback.
  bot.callbackQuery(/^apv:(\d+):(y|n)$/, (ctx) =>
    handleApprovalCallback(d.gate, d.store, ctx as unknown as Context & { match: RegExpMatchArray }));
  bot.callbackQuery(/^rsm:(\d+)$/, (ctx) =>
    handleResumeCallback(d.store, ctx as unknown as Context & { match: RegExpMatchArray }));

  // generic text intake LAST so command handlers win
  bot.on('message:text', (ctx) => {
    intakeMessage(d.store, {
      updateId: ctx.update.update_id, userId: ctx.from.id, chatId: ctx.chat.id, text: ctx.message.text,
    });
  });

  bot.catch((err) => log.error('bot error', { error: String(err.error) }));
  return bot;
}

/** Adapter: grammY Api → the Sender's TelegramApi interface. */
export class GrammyTelegramApi implements TelegramApi {
  constructor(private api: Api) {}
  async sendMessage(chatId: number, text: string, replyMarkupJson?: string | null): Promise<number> {
    const r = await this.api.sendMessage(chatId, text,
      replyMarkupJson ? { reply_markup: JSON.parse(replyMarkupJson) } : undefined);
    return r.message_id;
  }
  async editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
    await this.api.editMessageText(chatId, messageId, text);
  }
  async sendChatAction(chatId: number, action: string): Promise<void> {
    await this.api.sendChatAction(chatId, action as Parameters<typeof this.api.sendChatAction>[1]);
  }
}
