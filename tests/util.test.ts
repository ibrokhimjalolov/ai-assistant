import { describe, it, expect } from 'vitest';
import { contextFractionFromUsage } from '../src/util.js';

describe('contextFractionFromUsage', () => {
  it('returns used/contextWindow including cache tokens', () => {
    const usage = { 'claude-x': { inputTokens: 100, cacheReadInputTokens: 50, cacheCreationInputTokens: 50, contextWindow: 1000 } };
    expect(contextFractionFromUsage(usage)).toBeCloseTo(0.2, 5); // (100+50+50)/1000
  });
  it('takes the max fraction across models', () => {
    const usage = {
      a: { inputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 1000 }, // 0.1
      b: { inputTokens: 800, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 1000 }, // 0.8
    };
    expect(contextFractionFromUsage(usage)).toBeCloseTo(0.8, 5);
  });
  it('returns null for missing / zero-window / non-object', () => {
    expect(contextFractionFromUsage(undefined)).toBeNull();
    expect(contextFractionFromUsage({})).toBeNull();
    expect(contextFractionFromUsage({ a: { inputTokens: 5, contextWindow: 0 } })).toBeNull();
    expect(contextFractionFromUsage('nope')).toBeNull();
  });
});
