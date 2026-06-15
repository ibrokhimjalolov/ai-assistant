import { describe, it, expect } from 'vitest';
import { resolveRunAt } from '../src/tools.js';

const now = new Date('2026-06-11T10:00:00'); // local time

describe('resolveRunAt', () => {
  it('delay_seconds → now + delay', () => {
    const r = resolveRunAt({ delay_seconds: 60 }, now);
    expect('runAt' in r && new Date(r.runAt).getTime()).toBe(now.getTime() + 60_000);
  });
  it('absolute ISO at is passed through', () => {
    const r = resolveRunAt({ at: '2026-06-11T12:30:00.000Z' }, now);
    expect('runAt' in r && r.runAt).toBe('2026-06-11T12:30:00.000Z');
  });
  it('HH:MM later today → today', () => {
    const r = resolveRunAt({ at: '14:00' }, now) as { runAt: string };
    const d = new Date(r.runAt);
    expect(d.getHours()).toBe(14); expect(d.getMinutes()).toBe(0); expect(d.getDate()).toBe(11);
  });
  it('HH:MM already passed → tomorrow', () => {
    const r = resolveRunAt({ at: '09:00' }, now) as { runAt: string };
    expect(new Date(r.runAt).getDate()).toBe(12);
  });
  it('rejects neither delay_seconds nor at', () => { expect('error' in resolveRunAt({}, now)).toBe(true); });
  it('rejects both', () => { expect('error' in resolveRunAt({ delay_seconds: 60, at: '14:00' }, now)).toBe(true); });
  it('rejects non-positive delay', () => { expect('error' in resolveRunAt({ delay_seconds: 0 }, now)).toBe(true); });
  it('rejects garbage at', () => { expect('error' in resolveRunAt({ at: 'nonsense' }, now)).toBe(true); });
  it('rejects out-of-range HH:MM', () => { expect('error' in resolveRunAt({ at: '99:99' }, now)).toBe(true); });
});
