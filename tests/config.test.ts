import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appPaths, ensureAppData, agentPaths, ensureAgentData, migrateLegacyDb } from '../src/paths.js';
import { loadConfig, ConfigError } from '../src/config.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'art-')); });
const writeCfg = (o: unknown): string => { const p = join(root, 'config.json'); writeFileSync(p, JSON.stringify(o)); return p; };

describe('paths', () => {
  it('derives app paths from root and creates dirs', () => {
    const p = appPaths(root);
    ensureAppData(p);
    expect(p.dbPath).toBe(join(root, 'agent.db'));
    expect(existsSync(p.logsDir)).toBe(true);
    expect(existsSync(p.backupsDir)).toBe(true);
  });

  it('derives per-agent paths and creates the agent dir', () => {
    const ap = agentPaths(root, 'alice');
    ensureAgentData(ap);
    expect(ap.dbPath).toBe(join(root, 'agents', 'alice', 'agent.db'));
    expect(existsSync(ap.backupsDir)).toBe(true);
  });

  it('migrates a legacy agent.db (+ sidecars) into agents/default/ once', () => {
    writeFileSync(join(root, 'agent.db'), 'DB');
    writeFileSync(join(root, 'agent.db-wal'), 'WAL');
    expect(migrateLegacyDb(root, 'default')).toBe(true);
    expect(existsSync(join(root, 'agent.db'))).toBe(false);
    expect(readFileSync(join(root, 'agents', 'default', 'agent.db'), 'utf8')).toBe('DB');
    expect(readFileSync(join(root, 'agents', 'default', 'agent.db-wal'), 'utf8')).toBe('WAL');
    expect(migrateLegacyDb(root, 'default')).toBe(false); // no legacy left → no-op
  });

  it('does not migrate when the target DB already exists', () => {
    writeFileSync(join(root, 'agent.db'), 'LEGACY');
    const ap = agentPaths(root, 'default'); mkdirSync(ap.dir, { recursive: true });
    writeFileSync(ap.dbPath, 'EXISTING');
    expect(migrateLegacyDb(root, 'default')).toBe(false);
    expect(readFileSync(ap.dbPath, 'utf8')).toBe('EXISTING');
  });
});

describe('loadConfig', () => {
  it('writes a multi-agent template and throws on first run', () => {
    const cfgPath = join(root, 'config.json');
    expect(() => loadConfig(cfgPath)).toThrow(ConfigError);
    const tpl = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(Array.isArray(tpl.agents)).toBe(true);
    expect(tpl.agents[0]).toHaveProperty('name');
    expect(tpl.agents[0]).toHaveProperty('telegramBotToken');
    expect(tpl.agents[0]).toHaveProperty('agentHome');
  });

  it('loads a multi-agent config; per-agent token falls back to the top-level default', () => {
    const a = join(root, 'a'); mkdirSync(a);
    const b = join(root, 'b'); mkdirSync(b);
    const cfg = loadConfig(writeCfg({
      claudeOauthToken: 'shared-tok',
      agents: [
        { name: 'alice', telegramBotToken: 't1', whitelist: [11], agentHome: a, claudeOauthToken: 'own-tok' },
        { name: 'bob', telegramBotToken: 't2', whitelist: [22], agentHome: b },
      ],
    }));
    expect(cfg.agents.map((x) => x.name)).toEqual(['alice', 'bob']);
    expect(cfg.agents[0].claudeOauthToken).toBe('own-tok');    // explicit
    expect(cfg.agents[1].claudeOauthToken).toBe('shared-tok'); // inherited default
    expect(cfg.agents[1].approvalTimeoutMs).toBe(900_000);     // defaults applied
    expect(cfg.agents[1].taskTimeoutMs).toBe(600_000);
    expect(cfg.agents[1].bashAllowlist.length).toBeGreaterThan(0);
  });

  it('back-compat: wraps an old single-agent config as agents:[default]', () => {
    const home = join(root, 'home'); mkdirSync(home);
    const cfg = loadConfig(writeCfg({ telegramBotToken: 't', whitelist: [11, 22], agentHome: home, claudeOauthToken: 'legacy-tok' }));
    expect(cfg.agents).toHaveLength(1);
    expect(cfg.agents[0].name).toBe('default');
    expect(cfg.agents[0].whitelist).toEqual([11, 22]);
    expect(cfg.agents[0].claudeOauthToken).toBe('legacy-tok');
    expect(cfg.agents[0].bashAllowlist.length).toBeGreaterThan(0);
  });

  it('rejects empty agents, bad names, duplicates, bad whitelist, missing agentHome', () => {
    const home = join(root, 'h'); mkdirSync(home);
    expect(() => loadConfig(writeCfg({ agents: [] }))).toThrow(/at least one agent/);
    expect(() => loadConfig(writeCfg({ agents: [{ name: 'Bad Name', telegramBotToken: 't', whitelist: [1], agentHome: home }] }))).toThrow(/name/);
    expect(() => loadConfig(writeCfg({ agents: [
      { name: 'x', telegramBotToken: 't', whitelist: [1], agentHome: home },
      { name: 'x', telegramBotToken: 't', whitelist: [1], agentHome: home },
    ] }))).toThrow(/duplicate/);
    expect(() => loadConfig(writeCfg({ agents: [{ name: 'x', telegramBotToken: 't', whitelist: [], agentHome: home }] }))).toThrow(/whitelist/);
    expect(() => loadConfig(writeCfg({ agents: [{ name: 'x', telegramBotToken: 't', whitelist: [1], agentHome: '/nope' }] }))).toThrow(/agentHome/);
  });

  it('reports corrupt JSON as an actionable ConfigError', () => {
    const cfgPath = join(root, 'config.json');
    writeFileSync(cfgPath, '{ not json');
    expect(() => loadConfig(cfgPath)).toThrow(/not valid JSON/);
  });
});
