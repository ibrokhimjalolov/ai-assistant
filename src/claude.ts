import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { UsageLimitError, type ClaudeRunner, type RunEvent, type RunRequest } from './types.js';

export class SdkClaudeRunner implements ClaudeRunner {
  async *run(req: RunRequest): AsyncIterable<RunEvent> {
    const abortController = new AbortController();
    req.signal.addEventListener('abort', () => abortController.abort(), { once: true });
    const q = query({
      prompt: req.prompt,
      options: {
        cwd: req.cwd,
        resume: req.resume,
        permissionMode: 'default',
        abortController,
        // The SDK's CanUseTool receives a third `options` argument (signal, toolUseID, etc.)
        // that our RunRequest.canUseTool does not expose. We bridge by ignoring it.
        canUseTool: (toolName: string, input: Record<string, unknown>) =>
          req.canUseTool(toolName, input),
        // RunRequest.mcpServers is Record<string, unknown>; cast to the SDK's McpServerConfig
        mcpServers: req.mcpServers as Record<string, McpServerConfig> | undefined,
      },
    });
    for await (const m of q) {
      const ev = mapSdkMessage(m as Record<string, unknown>);
      if (ev) yield ev;
    }
  }
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
