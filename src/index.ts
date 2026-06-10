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

async function main(): Promise<void> {
  const paths = appPaths();
  ensureAppData(paths);

  let cfg;
  try {
    cfg = loadConfig(paths.configPath);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`[startup] ${e.message}`);
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
  const sender = new Sender(store, new GrammyTelegramApi(bot.api));
  const scheduler = new Scheduler(store);

  try {
    const me = await bot.api.getMe();
    console.log(`[startup] telegram ok (@${me.username})`);
  } catch (e) {
    console.error('[startup] telegram auth failed:', e);
    process.exit(1);
  }

  const recovered = recoverInterrupted(store);
  if (recovered.length) console.log(`[startup] recovered ${recovered.length} interrupted task(s)`);
  scheduler.startupCatchup();

  let draining = false;
  setInterval(async () => {
    if (draining) return;
    draining = true;
    try { await sender.drainOnce(); } finally { draining = false; }
  }, 2000);

  setInterval(() => {
    try {
      scheduler.tick();
      maybeBackup(store, db, { dbPath: paths.dbPath, backupsDir: paths.backupsDir, agentHome: cfg.agentHome });
    } catch (e) { console.error('[scheduler]', e); }
  }, 30_000);

  void (async () => {
    for (;;) {
      try {
        const worked = await worker.tick();
        if (!worked) await new Promise((r) => setTimeout(r, 1000));
      } catch (e) {
        console.error('[worker]', e);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();

  console.log('[startup] agent-runtime up — long polling');
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

main().catch((e) => { console.error('[fatal]', e); process.exit(1); });
