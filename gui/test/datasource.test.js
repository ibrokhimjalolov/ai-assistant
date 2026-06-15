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

// --- append to gui/test/datasource.test.js ---
import { readAgent } from '../src/datasource.js';
import { buildAgentDb } from './helpers.js';

describe('readAgent', () => {
  it('reports Working with current task when a task is running', () => {
    const root = tmp();
    buildAgentDb(root, 'default', { tasks: [
      { source: 'telegram', user_id: 7, chat_id: 7, prompt: 'do a thing', status: 'running',
        session_id: 's1', created_at: '2026-06-15 10:00:00', started_at: '2026-06-15 10:00:01' },
    ]});
    const a = readAgent(root, 'default');
    expect(a.busy).toBe(true);
    expect(a.currentTask.id).toBe(1);
    expect(a.currentTask.prompt).toBe('do a thing');
    expect(a.currentTask.startedAt).toBe('2026-06-15 10:00:01');
  });

  it('reports Idle, recent tasks (cap 15, desc), counts, durations', () => {
    const root = tmp();
    const tasks = [];
    for (let i = 1; i <= 20; i++) {
      tasks.push({ source: 'schedule', user_id: 7, chat_id: 7, prompt: `t${i}`,
        status: 'done', session_id: 's1', created_at: '2026-06-15 09:00:00',
        started_at: '2026-06-15 09:00:00', finished_at: '2026-06-15 09:00:05' });
    }
    buildAgentDb(root, 'default', { tasks });
    const a = readAgent(root, 'default');
    expect(a.busy).toBe(false);
    expect(a.currentTask).toBeNull();
    expect(a.recentTasks).toHaveLength(15);
    expect(a.recentTasks[0].id).toBe(20);          // newest first
    expect(a.recentTasks[0].durationSec).toBe(5);  // finished - started
    expect(a.counts.done).toBe(20);
    expect(a.lastActivityAt).toBe('2026-06-15 09:00:05');
  });

  it('returns sessions with task counts and schedules', () => {
    const root = tmp();
    buildAgentDb(root, 'default', {
      sessions: [{ user_id: 7, claude_session_id: 'sess-abc', created_at: '2026-06-11 17:00:45' }],
      tasks: [
        { source: 'telegram', user_id: 7, chat_id: 7, prompt: 'a', status: 'done',
          session_id: 'sess-abc', created_at: '2026-06-12 03:18:20' },
        { source: 'telegram', user_id: 7, chat_id: 7, prompt: 'b', status: 'done',
          session_id: 'sess-abc', created_at: '2026-06-12 12:55:19' },
      ],
      schedules: [
        { cron_expr: '0 8 * * *', run_at: null, prompt: 'daily report', enabled: 1,
          missed_policy: 'run_now', created_by_user_id: 7, chat_id: 7,
          last_run_at: '2026-06-15T03:00:00.790Z' },
      ],
    });
    const a = readAgent(root, 'default');
    expect(a.sessions).toEqual([
      { userId: 7, sessionId: 'sess-abc', createdAt: '2026-06-11 17:00:45', taskCount: 2 },
    ]);
    expect(a.schedules[0]).toMatchObject({ id: 1, cronExpr: '0 8 * * *', enabled: true });
  });

  it('returns an error entry when the agent DB is missing', () => {
    const root = tmp();              // no agents/default/agent.db created
    const a = readAgent(root, 'default');
    expect(a.name).toBe('default');
    expect(a.error).toBeTruthy();
  });
});

// --- append to gui/test/datasource.test.js ---
import { parseLaunchctlList, getSnapshot } from '../src/datasource.js';

describe('parseLaunchctlList', () => {
  const label = 'uz.domo.agent-runtime';
  it('returns alive+pid for a numeric PID line', () => {
    expect(parseLaunchctlList('74264\t0\tuz.domo.agent-runtime\n', label)).toEqual({ alive: true, pid: 74264 });
  });
  it('returns not-alive when PID column is "-"', () => {
    expect(parseLaunchctlList('-\t0\tuz.domo.agent-runtime\n', label)).toEqual({ alive: false });
  });
  it('returns unknown when the label is absent', () => {
    expect(parseLaunchctlList('123\t0\tsomething.else\n', label)).toEqual({ status: 'unknown' });
  });
});

describe('getSnapshot', () => {
  it('composes daemon status and per-agent data', () => {
    const root = tmp();
    writeConfig(root, { telegramBotToken: 'x', whitelist: [7], agentHome: '/h' });
    buildAgentDb(root, 'default', { tasks: [
      { source: 'telegram', user_id: 7, chat_id: 7, prompt: 'hi', status: 'done',
        created_at: '2026-06-15 03:00:00', started_at: '2026-06-15 03:00:00', finished_at: '2026-06-15 03:00:02' },
    ]});
    const snap = getSnapshot({ root, daemonStatusFn: () => ({ alive: true, pid: 999 }) });
    expect(snap.daemon).toEqual({ alive: true, pid: 999 });
    expect(snap.agents).toHaveLength(1);
    expect(snap.agents[0].name).toBe('default');
    expect(snap.agents[0].counts.done).toBe(1);
    expect(typeof snap.generatedAt).toBe('string');
  });
  it('returns an error snapshot when config is bad', () => {
    const root = tmp();
    writeConfig(root, { nonsense: true });
    const snap = getSnapshot({ root, daemonStatusFn: () => ({ alive: false }) });
    expect(snap.error).toBeTruthy();
    expect(snap.agents).toEqual([]);
  });
});
