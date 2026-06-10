import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldAgentHome } from '../src/agent-home.js';

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
