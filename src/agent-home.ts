import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLAUDE_MD = `# Personal Agent

You are a personal assistant agent running permanently on the owner's Mac.
Users talk to you through Telegram; your replies are delivered as Telegram
messages, so keep them concise and avoid heavy markdown (no tables, no headers).

## Memory

Your long-term memory lives in the \`memory/\` directory of this folder.

- At the start of a conversation, read \`memory/index.md\` (if present) to load context.
- When you learn a durable fact (a preference, a person, a project, a decision),
  write it to a small markdown file under \`memory/\` and keep \`memory/index.md\`
  updated with one line per file.
- Several different users may talk to you. Attribute person-specific facts to the
  person they belong to (the runtime tells you who is asking in each task).

## Conduct

- You have full access to this machine; risky actions are gated by user approval.
- For scheduled-job prompts, do the work and reply with the result only.
- Use the runtime tools: \`reminder_create\` for one-time reminders ("remind me in N minutes"),
  and \`schedule_create\`/\`schedule_list\`/\`schedule_delete\` for recurring jobs.
`;

const MEMORY_README = `Long-term memory of the agent. One small markdown file per topic; index.md lists them.
`;

/** Scaffold template files into an empty Agent Home. Returns false if CLAUDE.md already exists. */
export function scaffoldAgentHome(dir: string): boolean {
  if (existsSync(join(dir, 'CLAUDE.md'))) return false;
  mkdirSync(join(dir, 'memory'), { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), CLAUDE_MD);
  writeFileSync(join(dir, 'memory', 'README.md'), MEMORY_README);
  return true;
}

/**
 * Ensure <agentHome>/.claude/settings.json has the daemon's required defaults,
 * without clobbering anything else:
 *  - `enableAllProjectMcpServers: true` — the headless daemon loads project/local
 *    settings only (see claude.ts settingSources) and won't connect an agent's
 *    .mcp.json servers otherwise (known issue #9).
 *  - `autoCompactEnabled: true` — let the SDK compact the conversation in place
 *    when context fills, so the thread stays coherent instead of hitting the
 *    context limit. This is now the primary context-management mechanism (the
 *    custom session rotation is disabled by default; see config.ts).
 *
 * Idempotent — safe to run on every startup; covers existing agent homes, not just
 * freshly scaffolded ones. The same file's `permissions.ask` list is the
 * operator-tunable input to the approval gate (read by Policy, additive over the
 * built-in outbound-send floor).
 *
 * Returns true if it wrote a change. If the file exists but is unparsable, it is
 * left untouched (returns false) rather than risk clobbering hand-edited settings.
 */
export function ensureProjectMcpSettings(dir: string): boolean {
  const claudeDir = join(dir, '.claude');
  const file = join(claudeDir, 'settings.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      return false; // don't overwrite a file we can't safely parse
    }
  }
  let changed = false;
  if (settings.enableAllProjectMcpServers !== true) {
    settings.enableAllProjectMcpServers = true;
    changed = true;
  }
  if (settings.autoCompactEnabled !== true) {
    settings.autoCompactEnabled = true;
    changed = true;
  }
  if (!changed) return false;
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return true;
}
