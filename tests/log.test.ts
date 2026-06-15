import { describe, it, expect, beforeEach } from 'vitest';
import { logger, setLevel, setSink, type LogLevel } from '../src/log.js';

let lines: { level: LogLevel; line: string }[];
beforeEach(() => {
  lines = [];
  setSink((line, level) => lines.push({ level, line }));
  setLevel('debug');
});

describe('logger', () => {
  it('emits ISO-timestamped lines with level, component, message', () => {
    logger('worker').info('task done');
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('info');
    expect(lines[0].line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO\s+\[worker\] task done$/);
  });

  it('appends meta as compact JSON when provided', () => {
    logger('gate').info('approval', { approvalId: 5, tool: 'Bash' });
    expect(lines[0].line).toContain('approval {"approvalId":5,"tool":"Bash"}');
  });

  it('filters below the configured level', () => {
    setLevel('warn');
    const l = logger('x');
    l.debug('d'); l.info('i'); l.warn('w'); l.error('e');
    expect(lines.map((x) => x.level)).toEqual(['warn', 'error']);
  });

  it('child() namespaces the component', () => {
    logger('worker').child('retry').info('hi');
    expect(lines[0].line).toContain('[worker.retry]');
  });

  it('silent level suppresses everything', () => {
    setLevel('silent');
    logger('x').error('boom');
    expect(lines).toHaveLength(0);
  });
});
