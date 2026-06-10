export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled';
export type TaskKind = 'chat' | 'rotate' | 'resume';
export type TaskSource = 'telegram' | 'schedule';

export interface Task {
  id: number;
  source: TaskSource;
  kind: TaskKind;
  userId: number;
  chatId: number;
  prompt: string;
  status: TaskStatus;
  sessionId: string | null;
  resultSummary: string | null;
}

export type OutKind = 'reply' | 'edit' | 'approval' | 'proactive';

export interface OutMessage {
  id: number;
  chatId: number;
  kind: OutKind;
  content: string;
  replyMarkup: string | null;
  editOf: number | null;
  attempts: number;
  lastAttemptAt: string | null;
}

export interface Schedule {
  id: number;
  cronExpr: string | null;
  runAt: string | null;
  prompt: string;
  enabled: boolean;
  missedPolicy: 'run_now' | 'skip';
  createdByUserId: number;
  chatId: number;
  lastRunAt: string | null;
}

export type Decision = 'approved' | 'denied' | 'timeout' | 'auto_approved';

export type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export type CanUseTool = (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>;

export type RunEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'progress'; text: string }
  | { kind: 'final'; text: string };

export interface RunRequest {
  prompt: string;
  cwd: string;
  resume?: string;
  signal: AbortSignal;
  canUseTool: CanUseTool;
  mcpServers?: Record<string, unknown>;
}

export interface ClaudeRunner {
  run(req: RunRequest): AsyncIterable<RunEvent>;
}

export class UsageLimitError extends Error {
  constructor(public resetAt: Date | null) {
    super('Subscription usage limit reached');
  }
}
