import type { Store } from './store.js';

export interface TelegramApi {
  sendMessage(chatId: number, text: string, replyMarkupJson?: string | null): Promise<number>;
  editMessageText(chatId: number, messageId: number, text: string): Promise<void>;
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
      } catch {
        this.store.bumpAttempts(m.id, now);
      }
    }
  }
}
