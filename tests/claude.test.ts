import { describe, it, expect } from 'vitest';
import { mapSdkMessage, parseResetTime, formatSpawnError, TELEGRAM_OUTPUT_INSTRUCTION, MEMORY_DISCIPLINE_INSTRUCTION, SCHEDULING_DISCIPLINE_INSTRUCTION } from '../src/claude.js';
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

describe('MEMORY_DISCIPLINE_INSTRUCTION', () => {
  it('forbids storing/acting on operational facts about how the agent works', () => {
    expect(MEMORY_DISCIPLINE_INSTRUCTION.toLowerCase()).toContain('memory');
    expect(MEMORY_DISCIPLINE_INSTRUCTION).toMatch(/NEVER (store|act)/);
    // states the trust hierarchy: system prompt > CLAUDE.md > memory
    expect(MEMORY_DISCIPLINE_INSTRUCTION).toContain('CLAUDE.md');
  });

  it('states that replies need no tool and bans bare status answers', () => {
    expect(MEMORY_DISCIPLINE_INSTRUCTION.toLowerCase()).toContain('automatically');
    expect(MEMORY_DISCIPLINE_INSTRUCTION).toContain('Отправлено');
    expect(MEMORY_DISCIPLINE_INSTRUCTION.toLowerCase()).toContain('recipient');
  });

  it('distinguishes the reply BOT channel from the user-account Telegram tool', () => {
    // both surfaces are "Telegram" — the instruction must separate them so the agent
    // cannot conflate "reply" with "send via the account tool" (the 2026-06-18 bug).
    // Phrased functionally (not by server name) so it survives an .mcp.json rename.
    expect(MEMORY_DISCIPLINE_INSTRUCTION.toLowerCase()).toContain('bot');
    expect(MEMORY_DISCIPLINE_INSTRUCTION).toMatch(/own Telegram account/i);
    expect(MEMORY_DISCIPLINE_INSTRUCTION).toMatch(/SEPARATE/);
  });
});

describe('SCHEDULING_DISCIPLINE_INSTRUCTION', () => {
  it('points the agent at the runtime scheduling tools', () => {
    expect(SCHEDULING_DISCIPLINE_INSTRUCTION).toContain('schedule_create');
    expect(SCHEDULING_DISCIPLINE_INSTRUCTION).toContain('reminder_create');
  });

  it('forbids the hallucinated cloud scheduler / /schedule deflection', () => {
    // the 2026-06-21 aiBEK bug: agent invented a "cloud scheduler" and told the
    // user to retry / run /schedule instead of calling schedule_create.
    expect(SCHEDULING_DISCIPLINE_INSTRUCTION.toLowerCase()).toContain('cloud scheduler');
    expect(SCHEDULING_DISCIPLINE_INSTRUCTION).toContain('/schedule');
    expect(SCHEDULING_DISCIPLINE_INSTRUCTION).toMatch(/NEVER/);
  });

  it('bans fabricating a scheduler failure/unavailability', () => {
    expect(SCHEDULING_DISCIPLINE_INSTRUCTION.toLowerCase()).toContain('unavailable');
    expect(SCHEDULING_DISCIPLINE_INSTRUCTION.toLowerCase()).toContain('try again');
    expect(SCHEDULING_DISCIPLINE_INSTRUCTION.toLowerCase()).toContain('fabricate');
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

  it('maps a compact_boundary system message to a compaction event', () => {
    expect(
      mapSdkMessage({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 150000, post_tokens: 42000 },
      }),
    ).toEqual({ kind: 'compaction', trigger: 'auto', preTokens: 150000, postTokens: 42000 });
  });

  it('maps a compact_boundary with missing metadata to safe defaults', () => {
    expect(mapSdkMessage({ type: 'system', subtype: 'compact_boundary' }))
      .toEqual({ kind: 'compaction', trigger: 'unknown', preTokens: null, postTokens: null });
  });

  it('maps successful result to final', () => {
    expect(mapSdkMessage({ type: 'result', subtype: 'success', result: 'done!' }))
      .toMatchObject({ kind: 'final', text: 'done!' });
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

// mapSdkMessage is already imported at the top of this file.
describe('mapSdkMessage contextFraction', () => {
  it('attaches contextFraction from modelUsage on success', () => {
    const ev = mapSdkMessage({
      type: 'result', subtype: 'success', result: 'hi',
      modelUsage: { m: { inputTokens: 700, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 1000 } },
    });
    expect(ev).toMatchObject({ kind: 'final', text: 'hi' });
    expect((ev as any).contextFraction).toBeCloseTo(0.7, 5);
  });
  it('contextFraction is null when modelUsage is absent', () => {
    const ev = mapSdkMessage({ type: 'result', subtype: 'success', result: 'hi' });
    expect((ev as any).contextFraction).toBeNull();
  });
});
