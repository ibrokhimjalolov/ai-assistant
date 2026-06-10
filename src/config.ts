import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

export interface Config {
  telegramBotToken: string;
  whitelist: number[];
  agentHome: string;
  claudeOauthToken?: string;
  approvalTimeoutMs: number;
  bashAllowlist: string[];
}

export class ConfigError extends Error {}

const DEFAULT_BASH_ALLOWLIST = [
  '^git (status|log|diff|show)\\b',
  '^ls\\b',
  '^grep\\b',
  '^cat\\b',
  '^echo\\b',
  '^pwd$',
];

const TEMPLATE = {
  telegramBotToken: '',
  whitelist: [],
  agentHome: '',
  claudeOauthToken: '',
  approvalTimeoutMs: 900_000,
  bashAllowlist: DEFAULT_BASH_ALLOWLIST,
};

export function loadConfig(configPath: string): Config {
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(TEMPLATE, null, 2) + '\n', { mode: 0o600 });
    throw new ConfigError(
      `First run: created config template at ${configPath}. ` +
        `Fill in telegramBotToken, whitelist (Telegram user IDs), and agentHome (existing folder), then restart.`,
    );
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!raw.telegramBotToken) throw new ConfigError('config: telegramBotToken is required');
  if (!Array.isArray(raw.whitelist) || raw.whitelist.length === 0 || !raw.whitelist.every((n: unknown) => Number.isInteger(n))) {
    throw new ConfigError('config: whitelist must be a non-empty array of Telegram user IDs');
  }
  if (!raw.agentHome || !existsSync(raw.agentHome) || !statSync(raw.agentHome).isDirectory()) {
    throw new ConfigError('config: agentHome must point to an existing directory — create it first (it is user-provided)');
  }
  return {
    approvalTimeoutMs: 900_000,
    bashAllowlist: DEFAULT_BASH_ALLOWLIST,
    ...raw,
    claudeOauthToken: raw.claudeOauthToken || undefined,
  };
}
