import { readFileSync } from 'node:fs';
import { appPaths, ensureAppData } from './paths.js';
import { loadConfig, ConfigError } from './config.js';
import { openDb } from './db.js';
import { Store } from './store.js';
import { Policy } from './policy.js';
import { PermissionGate } from './gate.js';
import { SdkClaudeRunner } from './claude.js';
import { Worker } from './worker.js';
import { Sender } from './sender.js';
import { Scheduler } from './scheduler.js';
import { runtimeMcpServer } from './tools.js';
import { scaffoldAgentHome } from './agent-home.js';
import { recoverInterrupted } from './recovery.js';
import { buildBot, GrammyTelegramApi } from './telegram.js';
import { maybeBackup } from './backup.js';
import { pulseTyping } from './typing.js';
import { logger } from './log.js';

const log = logger('runtime');

async function main(): Promise<void> {
  const paths = appPaths();
  ensureAppData(paths);

  let cfg;
  try {
    cfg = loadConfig(paths.configPath);
  } catch (e) {
    if (e instanceof ConfigError) {
      log.error('config error', { message: e.message });
      await tryBroadcastStartupError(paths.configPath, e.message);
      process.exit(1);
    }
    throw e;
  }

  if (cfg.claudeOauthToken) process.env.CLAUDE_CODE_OAUTH_TOKEN = cfg.claudeOauthToken;
  // Subscription auth: never pass an API key through to the SDK.
  delete process.env.ANTHROPIC_API_KEY;

  scaffoldAgentHome(cfg.agentHome);

  const db = openDb(paths.dbPath);
  const store = new Store(db);
  const gate = new PermissionGate(store, Policy.fromConfig(cfg), cfg.approvalTimeoutMs);
  const worker = new Worker({
    store, gate, runner: new SdkClaudeRunner(), agentHome: cfg.agentHome,
    mcpServersFor: (task) => runtimeMcpServer(store, task),
  });
  const startedAt = new Date();
  const bot = buildBot(cfg, { store, gate, worker, startedAt });
  const tgApi = new GrammyTelegramApi(bot.api);
  const sender = new Sender(store, tgApi);
  const scheduler = new Scheduler(store);

  log.info('starting', { appData: paths.root, agentHome: cfg.agentHome });
  const recovered = recoverInterrupted(store);
  if (recovered.length) log.info('recovered interrupted tasks', { count: recovered.length });
  scheduler.startupCatchup();

  try {
    const me = await bot.api.getMe();
    log.info('telegram ok', { username: me.username });
  } catch (e) {
    log.error('telegram auth failed', { error: String(e) });
    process.exit(1);
  }

  let draining = false;
  setInterval(async () => {
    if (draining) return;
    draining = true;
    try { await sender.drainOnce(); } catch (e) { log.error('drain failed', { error: String(e) }); } finally { draining = false; }
  }, 2000);

  setInterval(() => { void pulseTyping(worker, tgApi); }, 4000);

  setInterval(() => {
    try {
      scheduler.tick();
      maybeBackup(store, db, { dbPath: paths.dbPath, backupsDir: paths.backupsDir, agentHome: cfg.agentHome });
    } catch (e) { log.error('scheduler tick failed', { error: String(e) }); }
  }, 30_000);

  void (async () => {
    for (;;) {
      try {
        const worked = await worker.tick();
        if (!worked) await new Promise((r) => setTimeout(r, 1000));
      } catch (e) {
        log.error('worker tick failed', { error: String(e) });
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();

  log.info('up — long polling');
  await bot.start();
}

async function tryBroadcastStartupError(configPath: string, msg: string): Promise<void> {
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!raw.telegramBotToken || !Array.isArray(raw.whitelist)) return;
    const { Bot } = await import('grammy');
    const bot = new Bot(raw.telegramBotToken);
    for (const uid of raw.whitelist) {
      await bot.api.sendMessage(uid, `🚨 agent-runtime failed to start: ${msg}`).catch(() => {});
    }
  } catch { /* best effort only */ }
}

main().catch((e) => { log.error('fatal', { error: String(e) }); process.exit(1); });
