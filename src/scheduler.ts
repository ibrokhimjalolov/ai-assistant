import parser from 'cron-parser';
import type { Store } from './store.js';

export class Scheduler {
  constructor(private store: Store) {}

  /** Call every ~30s. Fires each due schedule once. */
  tick(now: Date = new Date()): void {
    for (const s of this.store.enabledSchedules()) {
      const after = s.lastRunAt ? new Date(s.lastRunAt) : new Date(now.getTime() - 60_000);
      const next = parser.parseExpression(s.cronExpr, { currentDate: after }).next().toDate();
      if (next <= now) {
        this.store.markScheduleRun(s.id, now);
        this.store.enqueueTask({
          source: 'schedule', kind: 'chat', userId: s.createdByUserId, chatId: s.chatId, prompt: s.prompt,
        });
      }
    }
  }

  /** On startup: skip-policy jobs missed during downtime are fast-forwarded; run_now jobs fire on next tick. */
  startupCatchup(now: Date = new Date()): void {
    for (const s of this.store.enabledSchedules()) {
      if (s.missedPolicy !== 'skip' || !s.lastRunAt) continue;
      const next = parser.parseExpression(s.cronExpr, { currentDate: new Date(s.lastRunAt) }).next().toDate();
      if (next <= now) this.store.markScheduleRun(s.id, now);
    }
  }
}
