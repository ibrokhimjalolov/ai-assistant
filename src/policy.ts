import { isAbsolute, join, relative, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { AgentConfig } from './config.js';

const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookRead', 'Task', 'TaskOutput',
]);
const FILE_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Tools that ALWAYS require explicit Telegram Approve/Deny, even though the runtime
 * otherwise auto-runs everything. These send a message/email to a THIRD PARTY — an
 * irreversible, outward-facing action — so a hallucinated call must not fire silently
 * (2026-06-18 "Отправлено" incident). Add patterns here to gate more tools.
 */
const GATED_TOOLS: RegExp[] = [
  // Outbound sends made AS the user's own account. Match ANY Telegram MCP server,
  // however it's named in .mcp.json (mytelegram, personal_telegram, telegram_account…),
  // so renaming the server can never silently un-gate sends. Reads/reactions
  // (get_messages, list_chats, search_messages, react) are intentionally NOT gated.
  /^mcp__[a-z0-9_]*telegram[a-z0-9_]*__(send_message|sendMessage|reply|replyMessage|forward\w*)$/i,
  /^mcp__emails__(compose_email|reply_email)$/i,
];

export class Policy {
  /** Operator-tunable gate list, read once from <agentHome>/.claude/settings.json `permissions.ask`. */
  private askPatterns: RegExp[];

  constructor(private agentHome: string, private bashAllowlist: RegExp[]) {
    this.askPatterns = loadAskPatterns(agentHome);
  }

  static fromConfig(cfg: AgentConfig): Policy {
    return new Policy(cfg.agentHome, cfg.bashAllowlist.map((s) => new RegExp(s)));
  }

  /**
   * Tools that must go through Telegram Approve/Deny in the allow-by-default posture
   * (everything else auto-runs). Two sources, unioned:
   *  1. GATED_TOOLS — the built-in outbound-send floor (always enforced; an .mcp.json
   *     rename or settings edit can never silently un-gate a real send).
   *  2. `permissions.ask` from <agentHome>/.claude/settings.json — operator additions,
   *     so approvals are tuned in the standard Claude Code settings file, not in code.
   */
  requiresApproval(toolName: string): boolean {
    return GATED_TOOLS.some((r) => r.test(toolName)) || this.askPatterns.some((r) => r.test(toolName));
  }

  /**
   * Strict allow-list: true ⇒ a tool is safe to auto-run. NOT wired into the gate in
   * the current allow-by-default posture (the gate uses requiresApproval); retained so
   * shell/file gating can be re-enabled by switching gate.ts back to `policy.isSafe`.
   */
  isSafe(toolName: string, input: Record<string, unknown>): boolean {
    if (READ_ONLY_TOOLS.has(toolName)) return true;
    if (toolName.startsWith('mcp__runtime__')) return true;
    if (FILE_EDIT_TOOLS.has(toolName)) {
      const p = String(input.file_path ?? input.notebook_path ?? '');
      return p !== '' && isInside(this.agentHome, p);
    }
    if (toolName === 'Bash') {
      const cmd = String(input.command ?? '');
      // Any of these let a command escape the allowlisted prefix:
      // ; & | ` $ ( ) chaining/substitution, < > redirection, and newlines
      // (a newline after an allowlisted prefix smuggles a second command).
      if (/[;&|`$(){}<>\n\r]/.test(cmd)) return false;
      return this.bashAllowlist.some((r) => r.test(cmd));
    }
    return false;
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Read `permissions.ask` tool patterns from the agent home's settings.json (+ settings.local.json). */
function loadAskPatterns(agentHome: string): RegExp[] {
  const patterns: string[] = [];
  for (const name of ['settings.json', 'settings.local.json']) {
    const f = join(agentHome, '.claude', name);
    if (!existsSync(f)) continue;
    try {
      const json = JSON.parse(readFileSync(f, 'utf8')) as { permissions?: { ask?: unknown } };
      const ask = json.permissions?.ask;
      if (Array.isArray(ask)) patterns.push(...ask.filter((x): x is string => typeof x === 'string'));
    } catch {
      /* ignore malformed settings — the built-in send floor still applies */
    }
  }
  return patterns.map(toToolMatcher);
}

/**
 * Convert a Claude Code permission entry to a tool-name matcher. Gates at TOOL
 * granularity: `Bash(rm:*)` → any Bash; `mcp__server` → all of that server's tools;
 * `mcp__server__tool` / trailing `*` → exact / prefix. Argument specifiers are ignored.
 */
export function toToolMatcher(pattern: string): RegExp {
  let p = pattern.trim();
  const paren = p.indexOf('(');
  if (paren >= 0) p = p.slice(0, paren);
  if (p.startsWith('mcp__') && p.split('__').length === 2) p += '__*';
  const esc = p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${esc}$`, 'i');
}
