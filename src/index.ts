import { readFileSync } from 'node:fs';
import { appPaths, ensureAppData, agentPaths, ensureAgentData, migrateLegacyDb, type AppPaths } from './paths.js';
import { loadConfig, ConfigError, type AgentConfig } from './config.js';
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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

  // Subscription auth only; per-agent tokens are injected per Claude call (see claude.ts).
  delete process.env.ANTHROPIC_API_KEY;

  // Upgrade path: move a pre-multi-agent DB into agents/default/ so its history isn't lost.
  if (cfg.agents.some((a) => a.name === 'default')) migrateLegacyDb(paths.root, 'default');

  log.info('starting', { appData: paths.root, agents: cfg.agents.map((a) => a.name) });
  // Each agent runs concurrently and independently; one failing never stops the others.
  await Promise.allSettled(cfg.agents.map((a) => runAgent(a, paths)));
}

/** Wire and run one isolated agent (own bot, DB, workdir, worker, scheduler, Claude token). */
async function runAgent(agentCfg: AgentConfig, paths: AppPaths): Promise<void> {
  const alog = logger(`agent:${agentCfg.name}`);
  try {
    const ap = agentPaths(paths.root, agentCfg.name);
    ensureAgentData(ap);
    scaffoldAgentHome(agentCfg.agentHome);

    const db = openDb(ap.dbPath);
    const store = new Store(db);
    const gate = new PermissionGate(store, Policy.fromConfig(agentCfg), agentCfg.approvalTimeoutMs);
    const worker = new Worker({
      store,
      gate,
      runner: new SdkClaudeRunner(),
      agentHome: agentCfg.agentHome,
      taskTimeoutMs: agentCfg.taskTimeoutMs,
      claudeToken: agentCfg.claudeOauthToken,
      mcpServersFor: (task) => runtimeMcpServer(store, task),
    });
    const startedAt = new Date();
    const bot = buildBot(agentCfg, { store, gate, worker, startedAt });
    const tgApi = new GrammyTelegramApi(bot.api);
    const sender = new Sender(store, tgApi);
    const scheduler = new Scheduler(store);

    const recovered = recoverInterrupted(store);
    if (recovered.length) alog.info('recovered interrupted tasks', { count: recovered.length });
    scheduler.startupCatchup();

    try {
      const me = await bot.api.getMe();
      alog.info('telegram ok', { username: me.username });
    } catch (e) {
      alog.error('telegram auth failed — agent skipped', { error: String(e) });
      return;
    }

    let draining = false;
    setInterval(async () => {
      if (draining) return;
      draining = true;
      try { await sender.drainOnce(); } catch (e) { alog.error('drain failed', { error: String(e) }); } finally { draining = false; }
    }, 2000);

    setInterval(() => { void pulseTyping(worker, tgApi); }, 4000);

    setInterval(() => {
      try {
        scheduler.tick();
        maybeBackup(store, db, { dbPath: ap.dbPath, backupsDir: ap.backupsDir, agentHome: agentCfg.agentHome });
      } catch (e) { alog.error('scheduler tick failed', { error: String(e) }); }
    }, 30_000);

    void (async () => {
      for (;;) {
        try {
          const worked = await worker.tick();
          if (!worked) await sleep(1000);
        } catch (e) {
          alog.error('worker tick failed', { error: String(e) });
          await sleep(5000);
        }
      }
    })();

    alog.info('up — long polling');
    await bot.start();
  } catch (e) {
    alog.error('agent failed to start — skipped', { error: String(e) });
  }
}

async function tryBroadcastStartupError(configPath: string, msg: string): Promise<void> {
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    const agents: any[] = Array.isArray(raw.agents) ? raw.agents : raw.telegramBotToken ? [raw] : [];
    const { Bot } = await import('grammy');
    for (const a of agents) {
      if (!a || !a.telegramBotToken || !Array.isArray(a.whitelist)) continue;
      const bot = new Bot(a.telegramBotToken);
      for (const uid of a.whitelist) {
        await bot.api.sendMessage(uid, `🚨 agent-runtime failed to start: ${msg}`).catch(() => {});
      }
    }
  } catch { /* best effort only */ }
}

main().catch((e) => { log.error('fatal', { error: String(e) }); process.exit(1); });
