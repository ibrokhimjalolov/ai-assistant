import { describe, it, expect } from 'vitest';
import { mapSdkMessage, parseResetTime } from '../src/claude.js';
import { UsageLimitError } from '../src/types.js';

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
