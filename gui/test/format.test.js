import { describe, it, expect } from 'vitest';
import { formatDuration, statusClass, daemonText } from '../renderer/format.mjs';

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
