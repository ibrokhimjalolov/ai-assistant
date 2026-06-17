import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldAgentHome, ensureProjectMcpSettings } from '../src/agent-home.js';

describe('scaffoldAgentHome', () => {
  it('scaffolds CLAUDE.md and memory/ into an empty folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'home-'));
    expect(scaffoldAgentHome(dir)).toBe(true);
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(dir, 'memory', 'README.md'))).toBe(true);
    const md = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(md).toContain('memory/');
    expect(md).toContain('Telegram');
  });

  it('does not touch a folder that already has CLAUDE.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'home-'));
    writeFileSync(join(dir, 'CLAUDE.md'), 'custom persona');
    expect(scaffoldAgentHome(dir)).toBe(false);
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('custom persona');
  });
});

describe('ensureProjectMcpSettings', () => {
  it('creates .claude/settings.json with enableAllProjectMcpServers when missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'home-'));
    expect(ensureProjectMcpSettings(dir)).toBe(true);
    const s = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
    expect(s.enableAllProjectMcpServers).toBe(true);
  });

  it('is idempotent and preserves existing settings (incl. permissions.ask)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'home-'));
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { ask: ['mcp__whoop__*'] }, model: 'opus' }),
    );
    expect(ensureProjectMcpSettings(dir)).toBe(true); // added the flag
    const s1 = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
    expect(s1.enableAllProjectMcpServers).toBe(true);
    expect(s1.model).toBe('opus');                     // untouched
    expect(s1.permissions.ask).toEqual(['mcp__whoop__*']);
    expect(ensureProjectMcpSettings(dir)).toBe(false);  // already set → no change
  });

  it('leaves an unparsable settings.json untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'home-'));
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), '{ not json');
    expect(ensureProjectMcpSettings(dir)).toBe(false);
    expect(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).toBe('{ not json');
  });
});
