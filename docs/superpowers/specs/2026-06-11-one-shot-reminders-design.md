# One-Shot Reminders — Design Spec

**Date:** 2026-06-11
**Status:** Approved, building
**Builds on:** the recurring cron scheduler (`2026-06-10-personal-agent-runtime-design.md`)

## Problem

The scheduler is recurring-cron-only. When asked for a one-time reminder
("remind me in 1 minute to sleep"), the agent can't map it onto a 5-field cron,
so it **fakes success** — replying *"Done! ✅ you'll get your reminder"* while
creating nothing (`schedules` and `approvals` tables stay empty). Nothing ever
fires. Confirmed root cause: there is no one-shot reminder capability and no tool
the agent can call for relative/absolute one-time reminders.

## Goal

Add one-shot reminders that fire **once** at a target time, run the stored prompt
through the agent, deliver the result to the creator's chat, then stop — reusing
the existing scheduler tick, task queue, and delivery path. No chat loop.

## Design

### Data model (`schedules` table, extended)

A schedule row is now **exactly one of**:
- **recurring** — `cron_expr` set, `run_at` NULL (existing behaviour), or
- **one-shot** — `run_at` (ISO-8601) set, `cron_expr` NULL.

Changes:
- `cron_expr` becomes **nullable**.
- add `run_at TEXT` (nullable).
- table CHECK: `(cron_expr IS NOT NULL) <> (run_at IS NOT NULL)` — exactly one.

**Migration** (existing DBs already have a `schedules` table with `cron_expr NOT NULL`):
`openDb` runs an idempotent migration — if the `run_at` column is absent, rebuild
the table into the new shape inside a transaction (`CREATE schedules_new …;
INSERT … SELECT …, NULL AS run_at FROM schedules; DROP TABLE schedules; RENAME`).
Existing recurring rows copy over with `run_at = NULL` (satisfies the CHECK). Fresh
DBs get the new shape directly via `CREATE TABLE IF NOT EXISTS`.

### Store (`src/store.ts`)

- `createReminder({ runAt, prompt, createdByUserId, chatId })` → inserts a one-shot
  row (`run_at` set, `cron_expr` NULL). Returns id.
- `disableSchedule(id)` → sets `enabled = 0` (used to retire a fired one-shot).
- `Schedule` type gains `runAt: string | null`; `cronExpr` becomes `string | null`.
  `toSchedule` maps both. `enabledSchedules()` already returns both kinds.

### MCP tool (`src/tools.ts`)

New `reminder_create({ delay_seconds?, at?, prompt })`, scoped to the asking
user/chat like the others:
- **Runtime computes `run_at` from the server clock** — `delay_seconds` → `now +
  delay_seconds`; `at` → parsed absolute time (ISO-8601, or `HH:MM` interpreted as
  the next occurrence today/tomorrow in local time). The agent never guesses the
  clock.
- Requires exactly one of `delay_seconds` / `at`; rejects neither/both.
- Description makes the split explicit: *"Use this for ONE-TIME reminders ('remind
  me in N minutes' / 'at HH:MM'). For recurring jobs use schedule_create."* —
  `schedule_create`'s description is updated to say "recurring only."
- `schedule_list` shows both kinds; `schedule_delete` works on both.

### Scheduler (`src/scheduler.ts`)

`tick(now)` handles both row kinds per enabled schedule:
- **recurring** (`cron_expr`): unchanged.
- **one-shot** (`run_at`): if `new Date(run_at) <= now` → enqueue a
  `source:'schedule'` task (runs the prompt through the agent, delivered to the
  creator's chat) and `disableSchedule(id)` so it fires exactly once.

`startupCatchup`: one-shots default to `run_now` → a reminder whose `run_at` passed
during downtime fires once on the next tick after restart, then disables. A `skip`
one-shot whose time passed is disabled without firing.

### Granularity

Tick stays at 30s (matches the recurring path), so a reminder fires within ~30s of
`run_at` ("in 1 minute" lands at ~60–90s). Tightening the tick is out of scope.

### Persona (`src/agent-home.ts`)

The scaffolded `CLAUDE.md` template gains a line pointing at `reminder_create` for
one-time reminders. (Existing Agent Homes aren't rewritten by code; the tool
description alone is sufficient for the agent to call it — confirmed the agent calls
well-described scheduling tools without CLAUDE.md guidance.)

## Testing

- `reminder_create` computes `run_at` correctly from `delay_seconds` and from an
  absolute `at`; rejects neither/both.
- `tick` fires a due one-shot exactly once then disables it; a not-yet-due one-shot
  does not fire; a fired one-shot never re-fires on subsequent ticks.
- CHECK rejects a row with both or neither of `cron_expr`/`run_at`.
- Migration: a DB created in the old shape (cron_expr NOT NULL, no run_at) is
  upgraded in place with existing recurring rows preserved.
- Existing recurring scheduler + store tests still pass unchanged.

## Out of scope

- Sub-30s precision; recurring-with-end-date; snooze/edit of reminders;
  natural-language time parsing beyond ISO / `HH:MM` (the agent does NL → structured
  args before calling the tool).
