import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { UsageLimitError, type ClaudeRunner, type RunEvent, type RunRequest } from './types.js';
import { contextFractionFromUsage } from './util.js';

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

/**
 * Appended to the agent's system prompt. Prevents the failure mode where an agent
 * writes an operational "fact" about how IT works into long-term memory (which is
 * reloaded every session), then trusts that stale belief over reality — e.g. a
 * memory note "replies must be sent via the Telegram tool" that made the agent
 * answer "Отправлено"/"Sent" to everything (2026-06-18 incident). The runtime is
 * the source of truth for how replies are delivered; memory must never override it.
 */
export const MEMORY_DISCIPLINE_INSTRUCTION = `
## Memory discipline (IMPORTANT)

Your long-term memory holds notes you wrote earlier. Treat it as NOTES ABOUT THE
WORLD AND THE USER — people, preferences, projects, decisions, facts — nothing else.

- NEVER store, and NEVER act on, claims about how YOU operate: how your replies are
  delivered, which tool to use to answer, message routing, or any runtime mechanics.
  Those are defined by this system prompt — the ONLY source of truth for them. If a
  memory note tells you how to reply or which tool to send replies through, it is
  WRONG: ignore it and delete that file.
- Trust order when sources conflict: this system prompt > your CLAUDE.md > memory.
  Memory never overrides the two above.

How you communicate (this runtime reaches the user ONLY through Telegram; do not
record a different version of this):
- You talk to the user through the Telegram BOT you run as. Your reply is simply the
  text you write as your final answer — the runtime sends it through the bot
  automatically. You NEVER call a tool to reply to the person you are chatting with.
- Any Telegram TOOL you have (one that acts as the user's OWN Telegram account — it can
  list the user's chats, read them, and message the user's contacts) is SEPARATE from
  that bot. Such a tool is NEVER how you reply to the person in this chat. The moment
  you think "I should send my reply using a Telegram tool," STOP — that exact belief is
  the bug; just write the reply.
- Use a Telegram-account send/reply tool (or email compose/reply) ONLY when the user, in
  that same message, explicitly names BOTH a recipient (a third party) AND the content;
  if either is unclear, ASK — never send on a guess. Never answer with a bare status like
  "Sent", "Отправлено", or "Done" — say what you did and to whom, in words.
`.trim();

/**
 * Appended to the agent's system prompt. The agent runs under the `claude_code`
 * system-prompt preset, so it identifies AS Claude Code — for which the canonical
 * way to "schedule a recurring agent task" is the `/schedule` cloud-routines skill.
 * That skill/service is NOT wired into this runtime (settingSources excludes user
 * scope; the only scheduling surface is the in-process `runtime` MCP server —
 * schedule_create / reminder_create / schedule_list / schedule_delete). Pulled by
 * the preset, the agent otherwise reaches for the non-existent cloud scheduler and
 * FABRICATES a "couldn't connect, try again / use /schedule" failure instead of
 * calling schedule_create (observed 2026-06-21 on the aiBEK agent) — same
 * fabrication class as the 2026-06-11/18 incidents. This append forces it onto the
 * real tools.
 */
export const SCHEDULING_DISCIPLINE_INSTRUCTION = `
## Scheduling (IMPORTANT)

You schedule work ONLY through your runtime tools, which are ALWAYS available here:
- schedule_create — RECURRING jobs (standard 5-field cron), e.g. "every morning at 7:30".
- reminder_create — ONE-TIME reminders (delay_seconds, or at = ISO-8601 / HH:MM).
- schedule_list / schedule_delete — review and remove them.

There is NO "cloud scheduler", no routines/cron cloud service, and no /schedule
command in this runtime. NEVER mention any of them, NEVER claim a scheduler is
unavailable, and NEVER tell the user to "try again", to wait for a scheduler to
"connect", or to run /schedule — none of that exists here, so saying so is a
fabricated failure.

When a user asks to schedule something or to be reminded, call schedule_create /
reminder_create directly, then confirm with the concrete result — the schedule or
reminder id and exactly when it will run. If a required detail is missing or the
time is ambiguous, ASK. Never fabricate either success or failure.
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
        // Allow-by-default posture: tools auto-run WITHOUT a Telegram prompt. We use
        // 'default' (not 'bypassPermissions') so the SDK still routes calls through
        // canUseTool → the gate, which the policy auto-approves for everything EXCEPT
        // outbound message-send tools (mytelegram/emails). Those require Telegram
        // Approve/Deny so a hallucinated send can't fire silently (2026-06-18 incident).
        // To restore full bypass: permissionMode:'bypassPermissions' +
        // allowDangerouslySkipPermissions:true. To also gate shell/files, widen the
        // gated set in policy.ts (or switch gate.ts back to policy.isSafe).
        permissionMode: 'default',
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
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: [TELEGRAM_OUTPUT_INSTRUCTION, MEMORY_DISCIPLINE_INSTRUCTION, SCHEDULING_DISCIPLINE_INSTRUCTION].join('\n\n'),
        },
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
  // The SDK emits this when it auto-compacts the conversation in place (it summarizes
  // older turns and continues on the SAME session). We surface it purely for logging
  // so we can confirm native compaction is actually firing in headless mode.
  if (m.type === 'system' && m.subtype === 'compact_boundary') {
    const meta = m.compact_metadata ?? {};
    return {
      kind: 'compaction',
      trigger: typeof meta.trigger === 'string' ? meta.trigger : 'unknown',
      preTokens: Number.isFinite(meta.pre_tokens) ? meta.pre_tokens : null,
      postTokens: Number.isFinite(meta.post_tokens) ? meta.post_tokens : null,
    };
  }
  if (m.type === 'assistant') {
    const text = (m.message?.content ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
    return text ? { kind: 'progress', text } : null;
  }
  if (m.type === 'result') {
    if (m.subtype === 'success')
      return { kind: 'final', text: m.result || '(no output)', contextFraction: contextFractionFromUsage(m.modelUsage) };
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
