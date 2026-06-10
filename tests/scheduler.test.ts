import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';

let store: Store; let sched: Scheduler;
beforeEach(() => { store = new Store(openDb(':memory:')); sched = new Scheduler(store); });

function addDaily8am(missedPolicy: 'run_now' | 'skip' = 'run_now'): number {
  return store.createSchedule({ cronExpr: '0 8 * * *', prompt: 'brief', missedPolicy, createdByUserId: 7, chatId: 70 });
}

describe('Scheduler.tick', () => {
  it('fires a due job once and enqueues a schedule-sourced task', () => {
    const id = addDaily8am();
    store.markScheduleRun(id, new Date('2026-06-09T08:00:00'));
    sched.tick(new Date('2026-06-10T08:00:30'));
    const tasks = store.pendingTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ source: 'schedule', prompt: 'brief', chatId: 70 });
    sched.tick(new Date('2026-06-10T08:01:30')); // same day: not due again
    expect(store.pendingTasks()).toHaveLength(1);
  });

  it('does not fire before due time', () => {
    const id = addDaily8am();
    store.markScheduleRun(id, new Date('2026-06-10T08:00:00'));
    sched.tick(new Date('2026-06-10T12:00:00'));
    expect(store.pendingTasks()).toHaveLength(0);
  });

  it('never-run schedule fires only when cron matches the last minute', () => {
    addDaily8am();
    sched.tick(new Date('2026-06-10T12:00:00'));
    expect(store.pendingTasks()).toHaveLength(0);
    sched.tick(new Date('2026-06-10T08:00:20'));
    expect(store.pendingTasks()).toHaveLength(1);
  });
});

describe('Scheduler.startupCatchup', () => {
  it('fast-forwards skip-policy jobs missed during downtime', () => {
    const id = addDaily8am('skip');
    store.markScheduleRun(id, new Date('2026-06-08T08:00:00'));
    sched.startupCatchup(new Date('2026-06-10T12:00:00'));
    sched.tick(new Date('2026-06-10T12:00:30'));
    expect(store.pendingTasks()).toHaveLength(0); // skipped, not backfilled
  });

  it('leaves run_now jobs to fire on next tick', () => {
    const id = addDaily8am('run_now');
    store.markScheduleRun(id, new Date('2026-06-08T08:00:00'));
    sched.startupCatchup(new Date('2026-06-10T12:00:00'));
    sched.tick(new Date('2026-06-10T12:00:30'));
    expect(store.pendingTasks()).toHaveLength(1);
  });
});
