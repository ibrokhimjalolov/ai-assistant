import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

/** One agent's configuration: its own bot, whitelist, Agent Home, and Claude token. */
export interface AgentConfig {
  name: string;
  telegramBotToken: string;
  whitelist: number[];
  agentHome: string;
  claudeOauthToken?: string;
  approvalTimeoutMs: number;
  taskTimeoutMs: number;
  bashAllowlist: string[];
  /** Auto-rotate the session when context usage reaches this fraction [0,1]; 0 disables. */
  rotateAtContextFraction: number;
}

/** Top-level config: a list of agents, plus an optional shared default Claude token. */
export interface Config {
  agents: AgentConfig[];
  claudeOauthToken?: string;
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

const AGENT_DEFAULTS = {
  approvalTimeoutMs: 900_000,
  taskTimeoutMs: 600_000,
  bashAllowlist: DEFAULT_BASH_ALLOWLIST,
  rotateAtContextFraction: 0.70,
};

const TEMPLATE = {
  claudeOauthToken: '',
  agents: [
    {
      name: 'default',
      telegramBotToken: '',
      whitelist: [],
      agentHome: '',
      claudeOauthToken: '',
      approvalTimeoutMs: AGENT_DEFAULTS.approvalTimeoutMs,
      taskTimeoutMs: AGENT_DEFAULTS.taskTimeoutMs,
    },
  ],
};

const NAME_RE = /^[a-z0-9_-]+$/;

export function loadConfig(configPath: string): Config {
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(TEMPLATE, null, 2) + '\n', { mode: 0o600 });
    throw new ConfigError(
      `First run: created config template at ${configPath}. ` +
        `Fill in each agent's telegramBotToken, whitelist (Telegram user IDs), ` +
        `agentHome (an existing folder), and claudeOauthToken, then restart.`,
    );
  }
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new ConfigError(
      `config: ${configPath} is not valid JSON — fix it or delete it to regenerate the template ` +
        `(${e instanceof SyntaxError ? e.message : String(e)})`,
    );
  }

  // Backward compatibility: an old single-agent config (top-level telegramBotToken)
  // is treated as one agent named "default".
  let agentsRaw: any[];
  if (Array.isArray(raw.agents)) {
    agentsRaw = raw.agents;
  } else if (raw.telegramBotToken) {
    agentsRaw = [{ name: 'default', ...raw }];
  } else {
    throw new ConfigError(
      'config: provide an "agents" array (each with name, telegramBotToken, whitelist, agentHome)',
    );
  }
  if (agentsRaw.length === 0) throw new ConfigError('config: "agents" must contain at least one agent');

  const defaultToken: string | undefined = raw.claudeOauthToken || undefined;
  const seen = new Set<string>();
  const agents = agentsRaw.map((a, i) => validateAgent(a, i, defaultToken, seen));
  return { agents, claudeOauthToken: defaultToken };
}

function validateAgent(a: any, i: number, defaultToken: string | undefined, seen: Set<string>): AgentConfig {
  const where = a && typeof a.name === 'string' && a.name ? `agent "${a.name}"` : `agents[${i}]`;
  if (!a || typeof a !== 'object') throw new ConfigError(`config: ${where} must be an object`);
  if (typeof a.name !== 'string' || !NAME_RE.test(a.name)) {
    throw new ConfigError(`config: ${where} needs a "name" matching ^[a-z0-9_-]+$`);
  }
  if (seen.has(a.name)) throw new ConfigError(`config: duplicate agent name "${a.name}"`);
  seen.add(a.name);
  if (!a.telegramBotToken) throw new ConfigError(`config: ${where} telegramBotToken is required`);
  if (
    !Array.isArray(a.whitelist) ||
    a.whitelist.length === 0 ||
    !a.whitelist.every((n: unknown) => Number.isInteger(n))
  ) {
    throw new ConfigError(`config: ${where} whitelist must be a non-empty array of Telegram user IDs`);
  }
  if (!a.agentHome || !existsSync(a.agentHome) || !statSync(a.agentHome).isDirectory()) {
    throw new ConfigError(`config: ${where} agentHome must point to an existing directory — create it first`);
  }
  if (a.rotateAtContextFraction !== undefined) {
    const v = a.rotateAtContextFraction;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new ConfigError(`config: ${where} rotateAtContextFraction must be a number in [0,1] (0 disables)`);
    }
  }
  return {
    ...AGENT_DEFAULTS,
    ...a,
    name: a.name,
    claudeOauthToken: a.claudeOauthToken || defaultToken || undefined,
  };
}
