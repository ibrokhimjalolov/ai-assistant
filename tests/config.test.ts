import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appPaths, ensureAppData } from '../src/paths.js';
import { loadConfig, ConfigError } from '../src/config.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'art-')); });

describe('paths', () => {
  it('derives all paths from root and creates dirs', () => {
    const p = appPaths(root);
    ensureAppData(p);
    expect(p.dbPath).toBe(join(root, 'agent.db'));
    expect(existsSync(p.logsDir)).toBe(true);
    expect(existsSync(p.backupsDir)).toBe(true);
  });
});

describe('loadConfig', () => {
  it('writes a template and throws on first run', () => {
    const cfgPath = join(root, 'config.json');
    expect(() => loadConfig(cfgPath)).toThrow(ConfigError);
    const tpl = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(tpl).toHaveProperty('telegramBotToken');
    expect(tpl).toHaveProperty('whitelist');
    expect(tpl).toHaveProperty('agentHome');
  });

  it('rejects empty whitelist and missing agentHome dir', () => {
    const cfgPath = join(root, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ telegramBotToken: 't', whitelist: [], agentHome: '/nope' }));
    expect(() => loadConfig(cfgPath)).toThrow(/whitelist/);
    writeFileSync(cfgPath, JSON.stringify({ telegramBotToken: 't', whitelist: [1], agentHome: '/nope' }));
    expect(() => loadConfig(cfgPath)).toThrow(/agentHome/);
  });

  it('loads a valid config with defaults applied', () => {
    const home = join(root, 'home'); mkdirSync(home);
    const cfgPath = join(root, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ telegramBotToken: 't', whitelist: [11, 22], agentHome: home }));
    const cfg = loadConfig(cfgPath);
    expect(cfg.whitelist).toEqual([11, 22]);
    expect(cfg.approvalTimeoutMs).toBe(900_000);
    expect(cfg.bashAllowlist.length).toBeGreaterThan(0);
  });
});
