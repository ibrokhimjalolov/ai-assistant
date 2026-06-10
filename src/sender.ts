import type { Store } from './store.js';
import { logger } from './log.js';

const log = logger('sender');

export interface TelegramApi {
  sendMessage(chatId: number, text: string, replyMarkupJson?: string | null): Promise<number>;
  editMessageText(chatId: number, messageId: number, text: string): Promise<void>;
  sendChatAction(chatId: number, action: string): Promise<void>;
}

export class Sender {
  constructor(private store: Store, private api: TelegramApi) {}

  async drainOnce(now: Date = new Date()): Promise<void> {
    for (const m of this.store.unsentMessages()) {
      if (m.lastAttemptAt) {
        const backoffMs = 2 ** m.attempts * 1000;
        if (now.getTime() < new Date(m.lastAttemptAt).getTime() + backoffMs) continue;
      }
      try {
        if (m.kind === 'edit') {
          const target = m.editOf == null ? null : this.store.sentMessageId(m.editOf);
          if (target == null) continue; // original not sent yet — pick up next drain
          await this.api.editMessageText(m.chatId, target, m.content);
          this.store.markSent(m.id, target);
        } else {
          const mid = await this.api.sendMessage(m.chatId, m.content, m.replyMarkup);
          this.store.markSent(m.id, mid);
        }
        log.debug('sent', { id: m.id, chatId: m.chatId, kind: m.kind });
      } catch (e) {
        this.store.bumpAttempts(m.id, now);
        const attempts = m.attempts + 1;
        log.warn('send failed, will retry', { id: m.id, chatId: m.chatId, attempt: attempts, error: e instanceof Error ? e.message : String(e) });
        if (attempts >= 8) {
          log.error('message permanently dropped', { id: m.id, attempts });
        }
      }
    }
  }
}
