import { describe, it, expect, afterEach } from 'vitest';
import { parseSqliteTime, loadAgents } from '../src/datasource.js';
import { makeTempRoot, writeConfig, cleanup } from './helpers.js';

let roots = [];
afterEach(() => { roots.forEach(cleanup); roots = []; });
function tmp() { const r = makeTempRoot(); roots.push(r); return r; }

describe('parseSqliteTime', () => {
  it('parses space-separated UTC datetime (no Z)', () => {
    const d = parseSqliteTime('2026-06-15 03:00:07');
    expect(d.toISOString()).toBe('2026-06-15T03:00:07.000Z');
  });
  it('parses ISO datetime with Z', () => {
    const d = parseSqliteTime('2026-06-15T03:00:00.790Z');
    expect(d.toISOString()).toBe('2026-06-15T03:00:00.790Z');
  });
  it('returns null for null/empty', () => {
    expect(parseSqliteTime(null)).toBeNull();
    expect(parseSqliteTime('')).toBeNull();
  });
});

describe('loadAgents', () => {
  it('wraps a legacy single-agent config into one agent named default', () => {
    const root = tmp();
    writeConfig(root, { telegramBotToken: 'x', whitelist: [42], agentHome: '/home/x' });
    expect(loadAgents(root)).toEqual([{ name: 'default', agentHome: '/home/x', whitelist: [42] }]);
  });
  it('reads an explicit agents array', () => {
    const root = tmp();
    writeConfig(root, { agents: [
      { name: 'a', telegramBotToken: 't', whitelist: [1], agentHome: '/a' },
      { name: 'b', telegramBotToken: 't', whitelist: [2], agentHome: '/b' },
    ]});
    expect(loadAgents(root)).toEqual([
      { name: 'a', agentHome: '/a', whitelist: [1] },
      { name: 'b', agentHome: '/b', whitelist: [2] },
    ]);
  });
  it('throws ConfigError when neither agents[] nor telegramBotToken present', () => {
    const root = tmp();
    writeConfig(root, { nonsense: true });
    expect(() => loadAgents(root)).toThrow(/agents/);
  });
  it('throws ConfigError when config.json is missing', () => {
    const root = tmp();
    expect(() => loadAgents(root)).toThrow(/config/i);
  });
});
