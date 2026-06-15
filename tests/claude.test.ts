import { describe, it, expect } from 'vitest';
import { mapSdkMessage, parseResetTime, formatSpawnError, TELEGRAM_OUTPUT_INSTRUCTION } from '../src/claude.js';
import { UsageLimitError } from '../src/types.js';

describe('TELEGRAM_OUTPUT_INSTRUCTION', () => {
  it('instructs the agent to use Telegram HTML, not Markdown', () => {
    expect(TELEGRAM_OUTPUT_INSTRUCTION).toMatch(/HTML/);
    expect(TELEGRAM_OUTPUT_INSTRUCTION).toMatch(/<b>/);
    expect(TELEGRAM_OUTPUT_INSTRUCTION.toLowerCase()).toContain('markdown');
  });

  it('explicitly forbids the **bold** markdown the model defaults to', () => {
    expect(TELEGRAM_OUTPUT_INSTRUCTION).toContain('**');
  });
});

describe('formatSpawnError', () => {
  it('appends the tail of captured stderr to the error message', () => {
    const out = formatSpawnError(new Error('Claude Code process exited with code 1'), 'boom\nConfigParseError: bad marketplace url');
    expect(out).toContain('exited with code 1');
    expect(out).toContain('ConfigParseError');
    expect(out).toContain('claude stderr');
  });
  it('returns just the base message when stderr is empty', () => {
    expect(formatSpawnError(new Error('x'), '   ')).toBe('x');
  });
});

describe('mapSdkMessage', () => {
  it('maps system init to session event', () => {
    expect(mapSdkMessage({ type: 'system', subtype: 'init', session_id: 's1' }))
      .toEqual({ kind: 'session', sessionId: 's1' });
  });

  it('maps assistant text blocks to progress', () => {
    const m = { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking…' }, { type: 'tool_use' }] } };
    expect(mapSdkMessage(m)).toEqual({ kind: 'progress', text: 'thinking…' });
  });

  it('maps successful result to final', () => {
    expect(mapSdkMessage({ type: 'result', subtype: 'success', result: 'done!' }))
      .toEqual({ kind: 'final', text: 'done!' });
  });

  it('throws UsageLimitError on limit errors', () => {
    expect(() => mapSdkMessage({ type: 'result', subtype: 'error_during_execution', result: '5-hour limit reached ∙ resets 6pm' }))
      .toThrow(UsageLimitError);
  });

  it('throws plain Error on other result errors', () => {
    expect(() => mapSdkMessage({ type: 'result', subtype: 'error_max_turns', result: '' })).toThrow(Error);
  });

  it('ignores unknown message types', () => {
    expect(mapSdkMessage({ type: 'user' })).toBeNull();
  });
});

describe('parseResetTime', () => {
  it('parses "resets 6pm" into a future Date', () => {
    const d = parseResetTime('limit reached ∙ resets 6pm', new Date('2026-06-10T10:00:00'));
    expect(d?.getHours()).toBe(18);
  });
  it('returns null when unparseable', () => {
    expect(parseResetTime('limit reached', new Date())).toBeNull();
  });
});
