import { describe, it, expect } from 'vitest';
import { Policy } from '../src/policy.js';

const policy = new Policy('/Users/me/AgentHome', [/^git (status|log)\b/, /^ls\b/]);

describe('Policy.isSafe', () => {
  it('allows read-only tools', () => {
    expect(policy.isSafe('Read', { file_path: '/etc/passwd' })).toBe(true);
    expect(policy.isSafe('Grep', { pattern: 'x' })).toBe(true);
    expect(policy.isSafe('WebSearch', { query: 'x' })).toBe(true);
  });

  it('allows file edits only inside the Agent Home', () => {
    expect(policy.isSafe('Write', { file_path: '/Users/me/AgentHome/memory/fact.md' })).toBe(true);
    expect(policy.isSafe('Edit', { file_path: '/Users/me/AgentHome/CLAUDE.md' })).toBe(true);
    expect(policy.isSafe('Write', { file_path: '/Users/me/other/x.md' })).toBe(false);
    expect(policy.isSafe('Write', { file_path: '/Users/me/AgentHome/../other/x.md' })).toBe(false);
  });

  it('allows only allowlisted bash commands', () => {
    expect(policy.isSafe('Bash', { command: 'git status' })).toBe(true);
    expect(policy.isSafe('Bash', { command: 'ls -la /tmp' })).toBe(true);
    expect(policy.isSafe('Bash', { command: 'rm -rf /' })).toBe(false);
    expect(policy.isSafe('Bash', { command: 'git status && rm -rf /' })).toBe(false);
  });

  it('allows runtime MCP tools; denies unknown tools by default', () => {
    expect(policy.isSafe('mcp__runtime__schedule_create', { cron: '* * * * *' })).toBe(true);
    expect(policy.isSafe('SomeNewTool', {})).toBe(false);
  });
});
