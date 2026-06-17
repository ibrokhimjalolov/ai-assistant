import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('rejects bash bypasses: newline, redirection, substitution', () => {
    expect(policy.isSafe('Bash', { command: 'git status\nrm -rf /' })).toBe(false);
    expect(policy.isSafe('Bash', { command: 'git status\r\nrm -rf /' })).toBe(false);
    expect(policy.isSafe('Bash', { command: 'git status > /Users/me/.zshrc' })).toBe(false);
    expect(policy.isSafe('Bash', { command: 'cat /etc/passwd > /tmp/x' })).toBe(false);
    expect(policy.isSafe('Bash', { command: 'ls $(whoami)' })).toBe(false);
    expect(policy.isSafe('Bash', { command: 'ls `whoami`' })).toBe(false);
  });

  it('allows runtime MCP tools; denies unknown tools by default', () => {
    expect(policy.isSafe('mcp__runtime__schedule_create', { cron: '* * * * *' })).toBe(true);
    expect(policy.isSafe('SomeNewTool', {})).toBe(false);
  });
});

describe('Policy.requiresApproval (gated outbound-send tools)', () => {
  it('gates Telegram + email send/reply tools (both camelCase and snake_case)', () => {
    for (const t of [
      'mcp__mytelegram__send_message',
      'mcp__mytelegram__sendMessage',
      'mcp__mytelegram__reply',
      'mcp__mytelegram__replyMessage',
      'mcp__mytelegram__forwardMessage',
      'mcp__emails__compose_email',
      'mcp__emails__reply_email',
    ]) {
      expect(policy.requiresApproval(t)).toBe(true);
    }
  });

  it('still gates the Telegram account server after an .mcp.json rename', () => {
    // rename-proof: the gate keys off "telegram" + a send action, not the literal name
    for (const t of [
      'mcp__personal_telegram__send_message',
      'mcp__telegram_account__sendMessage',
      'mcp__telegram_account__reply',
    ]) {
      expect(policy.requiresApproval(t)).toBe(true);
    }
  });

  it('does NOT gate reads, reactions, shell, files, or runtime tools (allow-by-default)', () => {
    for (const t of [
      'mcp__mytelegram__get_messages',
      'mcp__mytelegram__list_chats',
      'mcp__mytelegram__search_messages',
      'mcp__mytelegram__react',
      'mcp__emails__read_email',
      'mcp__emails__search_emails',
      'mcp__whoop__get_today',
      'Bash',
      'Write',
      'Read',
      'mcp__runtime__schedule_create',
    ]) {
      expect(policy.requiresApproval(t)).toBe(false);
    }
  });
});

describe('Policy.requiresApproval reads permissions.ask from .claude/settings.json', () => {
  it('gates operator-listed tools (additive over the built-in send floor)', () => {
    const home = mkdtempSync(join(tmpdir(), 'agenthome-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        enableAllProjectMcpServers: true,
        permissions: { ask: ['mcp__whoop__*', 'Bash(rm:*)', 'mcp__notion'] },
      }),
    );
    const p = new Policy(home, []);
    expect(p.requiresApproval('mcp__whoop__get_today')).toBe(true);        // prefix glob
    expect(p.requiresApproval('Bash')).toBe(true);                          // Tool(...) → tool granularity
    expect(p.requiresApproval('mcp__notion__create_page')).toBe(true);      // server-level entry
    expect(p.requiresApproval('mcp__mytelegram__send_message')).toBe(true); // floor still enforced
    expect(p.requiresApproval('Read')).toBe(false);                         // unmatched → auto-accept
  });

  it('falls back to just the send floor when no settings.json is present', () => {
    const home = mkdtempSync(join(tmpdir(), 'agenthome-'));
    const p = new Policy(home, []);
    expect(p.requiresApproval('mcp__mytelegram__send_message')).toBe(true);
    expect(p.requiresApproval('mcp__whoop__get_today')).toBe(false);
    expect(p.requiresApproval('Bash')).toBe(false);
  });
});
