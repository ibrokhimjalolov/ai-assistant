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

const DEFAULTS = {
  approvalTimeoutMs: 900_000,
  bashAllowlist: DEFAULT_BASH_ALLOWLIST,
};

const TEMPLATE = {
  telegramBotToken: '',
  whitelist: [],
  agentHome: '',
  claudeOauthToken: '',
  ...DEFAULTS,
};

export function loadConfig(configPath: string): Config {
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(TEMPLATE, null, 2) + '\n', { mode: 0o600 });
    throw new ConfigError(
      `First run: created config template at ${configPath}. ` +
        `Fill in telegramBotToken, whitelist (Telegram user IDs), and agentHome (existing folder), then restart.`,
    );
  }
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new ConfigError(`config: ${configPath} is not valid JSON — fix it or delete it to regenerate the template (${e instanceof SyntaxError ? e.message : String(e)})`);
  }
  if (!raw.telegramBotToken) throw new ConfigError('config: telegramBotToken is required');
  if (!Array.isArray(raw.whitelist) || raw.whitelist.length === 0 || !raw.whitelist.every((n: unknown) => Number.isInteger(n))) {
    throw new ConfigError('config: whitelist must be a non-empty array of Telegram user IDs');
  }
  if (!raw.agentHome || !existsSync(raw.agentHome) || !statSync(raw.agentHome).isDirectory()) {
    throw new ConfigError('config: agentHome must point to an existing directory — create it first (it is user-provided)');
  }
  return {
    ...DEFAULTS,
    ...raw,
    claudeOauthToken: raw.claudeOauthToken || undefined,
  };
}
