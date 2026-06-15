import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { UsageLimitError, type ClaudeRunner, type RunEvent, type RunRequest } from './types.js';

/**
 * Appended to the agent's system prompt. The agent's replies are delivered as
 * Telegram messages sent with parse_mode=HTML, so it must produce Telegram HTML
 * directly — Telegram does not render Markdown, and the model otherwise defaults
 * to `**bold**`/`#`/tables that show up as literal characters.
 */
export const TELEGRAM_OUTPUT_INSTRUCTION = `
## Telegram output format (IMPORTANT)

Your replies are delivered to the user as Telegram messages sent with parse_mode=HTML.
Telegram does NOT render Markdown. Format using ONLY these Telegram-supported HTML tags:
<b>bold</b>, <i>italic</i>, <u>underline</u>, <s>strikethrough</s>, <code>inline code</code>,
<pre>multi-line code</pre>, <a href="https://example.com">link</a>, <blockquote>quote</blockquote>.

Hard rules:
- NEVER use Markdown syntax: no **bold**, no __bold__, no *italic*, no \`backticks\`, no # headings,
  no Markdown links [text](url), no | tables |, no --- rules.
- For an emphasised label (e.g. a question), use <b>…</b>. For lists, put each item on its own line
  starting with "• " (bullets) or "1. " (numbered) — Telegram has no list markup.
- Any literal <, >, or & in your prose MUST be escaped as &lt;, &gt;, &amp; so Telegram can parse it.
- Keep replies concise; avoid headings and tables entirely.
`.trim();

export class SdkClaudeRunner implements ClaudeRunner {
  async *run(req: RunRequest): AsyncIterable<RunEvent> {
    const abortController = new AbortController();
    req.signal.addEventListener('abort', () => abortController.abort(), { once: true });
    // Capture the spawned CLI's stderr so failures surface the real cause to the
    // user (and logs) instead of an opaque "process exited with code 1".
    let stderrBuf = '';
    const q = query({
      prompt: req.prompt,
      options: {
        cwd: req.cwd,
        resume: req.resume,
        // Per-agent Claude token → injected into the spawned CLI's env (no process-global token).
        ...(req.claudeToken
          ? { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: req.claudeToken, ANTHROPIC_API_KEY: undefined } }
          : {}),
        // Owner explicitly chose to bypass all approvals (no Telegram Approve/Deny).
        // Tools auto-run; canUseTool below is left wired but NOT consulted in this mode.
        // To restore gating, set permissionMode back to 'default' and drop the next line.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        stderr: (d: string) => {
          stderrBuf += d;
          if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000);
        },
        // Load the Agent Home CLAUDE.md (project scope) so the persona, memory, and
        // tool-usage instructions apply, and adopt Claude Code's system prompt so the
        // agent proactively USES tools. Without these the agent runs in SDK isolation
        // mode as a passive chatbot: it never loads CLAUDE.md and never calls tools
        // like schedule_create, so reminders/memory silently do nothing.
        settingSources: ['project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: TELEGRAM_OUTPUT_INSTRUCTION },
        abortController,
        // The SDK's CanUseTool receives a third `options` argument (signal, toolUseID, etc.)
        // that our RunRequest.canUseTool does not expose. We bridge by ignoring it.
        canUseTool: (toolName: string, input: Record<string, unknown>) =>
          req.canUseTool(toolName, input),
        // RunRequest.mcpServers is Record<string, unknown>; cast to the SDK's McpServerConfig
        mcpServers: req.mcpServers as Record<string, McpServerConfig> | undefined,
      },
    });
    try {
      for await (const m of q) {
        const ev = mapSdkMessage(m as Record<string, unknown>);
        if (ev) yield ev;
      }
    } catch (e) {
      if (e instanceof UsageLimitError) throw e; // worker handles this specially
      throw new Error(formatSpawnError(e, stderrBuf));
    }
  }
}

/** Combine the thrown error with the tail of the CLI's stderr for a human-readable failure. Pure + testable. */
export function formatSpawnError(err: unknown, stderr: string): string {
  const base = err instanceof Error ? err.message : String(err);
  const tail = stderr.trim().split('\n').slice(-12).join('\n').slice(-1200);
  return tail ? `${base}\n— claude stderr —\n${tail}` : base;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapSdkMessage(m: any): RunEvent | null {
  if (m.type === 'system' && m.subtype === 'init') return { kind: 'session', sessionId: m.session_id };
  if (m.type === 'assistant') {
    const text = (m.message?.content ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
    return text ? { kind: 'progress', text } : null;
  }
  if (m.type === 'result') {
    if (m.subtype === 'success') return { kind: 'final', text: m.result || '(no output)' };
    // Non-success result: SDK provides `errors: string[]` in real messages,
    // but the test fixture passes a plain `result` string — handle both.
    const errDetail: string = m.result ?? (Array.isArray(m.errors) ? m.errors.join('; ') : '');
    const errText = `${m.subtype}: ${errDetail}`;
    if (/limit/i.test(errText)) throw new UsageLimitError(parseResetTime(errText, new Date()));
    throw new Error(`Claude session error — ${errText}`);
  }
  return null;
}

export function parseResetTime(text: string, now: Date): Date | null {
  const m = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}
