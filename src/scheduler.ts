import parser from 'cron-parser';
import type { Store } from './store.js';
import { logger } from './log.js';
import { truncate } from './util.js';

const log = logger('scheduler');

export class Scheduler {
  constructor(private store: Store) {}

  /** Call every ~30s. Fires each due schedule once. */
  tick(now: Date = new Date()): void {
    for (const s of this.store.enabledSchedules()) {
      if (s.runAt) {
        // one-shot: fire once when due, then disable
        if (new Date(s.runAt) <= now) {
          this.store.markScheduleRun(s.id, now);
          this.store.enqueueTask({
            source: 'schedule', kind: 'chat', userId: s.createdByUserId, chatId: s.chatId, prompt: s.prompt,
          });
          this.store.disableSchedule(s.id);
          log.info('reminder fired', { scheduleId: s.id, prompt: truncate(s.prompt, 2000) });
        }
        continue;
      }
      // recurring (existing cron logic)
      const after = s.lastRunAt ? new Date(s.lastRunAt) : new Date(now.getTime() - 60_000);
      const next = parser.parseExpression(s.cronExpr as string, { currentDate: after }).next().toDate();
      if (next <= now) {
        this.store.markScheduleRun(s.id, now);
        this.store.enqueueTask({
          source: 'schedule', kind: 'chat', userId: s.createdByUserId, chatId: s.chatId, prompt: s.prompt,
        });
        log.info('schedule fired', { scheduleId: s.id, prompt: truncate(s.prompt, 2000) });
      }
    }
  }

  /** On startup: skip-policy jobs missed during downtime are fast-forwarded; run_now jobs fire on next tick. */
  startupCatchup(now: Date = new Date()): void {
    for (const s of this.store.enabledSchedules()) {
      if (s.runAt) {
        if (s.missedPolicy === 'skip' && new Date(s.runAt) <= now) this.store.disableSchedule(s.id);
        continue; // run_now one-shots fire on next tick
      }
      if (s.missedPolicy !== 'skip' || !s.lastRunAt) continue;
      const next = parser.parseExpression(s.cronExpr as string, { currentDate: new Date(s.lastRunAt) }).next().toDate();
      if (next <= now) {
        this.store.markScheduleRun(s.id, now);
        log.info('schedule catch-up skipped missed run', { scheduleId: s.id });
      }
    }
  }
}
