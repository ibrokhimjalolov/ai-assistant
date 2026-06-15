import { describe, it, expect } from 'vitest';
import { formatDuration, statusClass, daemonText, elapsedSeconds } from '../renderer/format.mjs';

describe('formatDuration', () => {
  it('formats seconds and minutes', () => {
    expect(formatDuration(5)).toBe('5s');
    expect(formatDuration(65)).toBe('1m 5s');
    expect(formatDuration(null)).toBe('—');
  });
});
describe('statusClass', () => {
  it('maps statuses to css classes', () => {
    expect(statusClass('done')).toBe('ok');
    expect(statusClass('failed')).toBe('bad');
    expect(statusClass('running')).toBe('busy');
    expect(statusClass('queued')).toBe('muted');
  });
});
describe('daemonText', () => {
  it('renders each daemon state', () => {
    expect(daemonText({ alive: true, pid: 7 })).toBe('Running (pid 7)');
    expect(daemonText({ alive: false })).toBe('Stopped');
    expect(daemonText({ status: 'unknown' })).toBe('Unknown');
  });
});
describe('elapsedSeconds', () => {
  it('computes whole seconds from a SQLite UTC time to now', () => {
    expect(elapsedSeconds('2026-06-15 10:00:00', Date.parse('2026-06-15T10:00:42Z'))).toBe(42);
  });
  it('handles ISO-with-Z, clamps negative to 0, and returns null for empty', () => {
    expect(elapsedSeconds('2026-06-15T10:00:00.000Z', Date.parse('2026-06-15T10:01:00Z'))).toBe(60);
    expect(elapsedSeconds('2026-06-15T10:05:00Z', Date.parse('2026-06-15T10:00:00Z'))).toBe(0);
    expect(elapsedSeconds(null, Date.parse('2026-06-15T10:00:00Z'))).toBeNull();
  });
});
