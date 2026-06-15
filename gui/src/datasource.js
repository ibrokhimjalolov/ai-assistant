'use strict';
const fs = require('node:fs');
const { configPath } = require('./paths.js');

class ConfigError extends Error {}

// Handle both 'YYYY-MM-DD HH:MM:SS' (UTC, no Z) and ISO-with-Z.
function parseSqliteTime(s) {
  if (!s) return null;
  const str = String(s);
  const iso = str.includes('T') || str.endsWith('Z') ? str : str.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Read <root>/config.json and normalize to [{name, agentHome, whitelist}].
// Mirrors the runtime: agents[] wins; else a top-level telegramBotToken means
// one agent named "default"; else it is an error.
function loadAgents(root) {
  const cp = configPath(root);
  if (!fs.existsSync(cp)) {
    throw new ConfigError(`config.json not found at ${cp}`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(cp, 'utf8'));
  } catch (e) {
    throw new ConfigError(`config.json is not valid JSON: ${e.message}`);
  }
  let list;
  if (Array.isArray(raw.agents)) {
    list = raw.agents;
  } else if (raw.telegramBotToken) {
    list = [{ name: 'default', ...raw }];
  } else {
    throw new ConfigError('config.json must provide an "agents" array or a single-agent telegramBotToken');
  }
  return list.map((a, i) => ({
    name: typeof a.name === 'string' && a.name ? a.name : `agents[${i}]`,
    agentHome: a.agentHome || null,
    whitelist: Array.isArray(a.whitelist) ? a.whitelist : [],
  }));
}

// --- append to gui/src/datasource.js (above module.exports) ---
const fsExtra = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { agentDbPath } = require('./paths.js');

function truncate(s, n) {
  if (s == null) return s;
  const str = String(s);
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function durationSec(startedAt, finishedAt) {
  const s = parseSqliteTime(startedAt);
  const f = parseSqliteTime(finishedAt);
  if (!s || !f) return null;
  return Math.round((f.getTime() - s.getTime()) / 1000);
}

function readAgent(root, name) {
  const dbPath = agentDbPath(root, name);
  if (!fsExtra.existsSync(dbPath)) {
    return { name, error: 'db unavailable', detail: `not found: ${dbPath}` };
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });

    const running = db.prepare(
      `SELECT id, source, prompt, started_at FROM tasks WHERE status='running' ORDER BY id DESC LIMIT 1`
    ).get();
    const currentTask = running
      ? { id: running.id, source: running.source, prompt: truncate(running.prompt, 200), startedAt: running.started_at }
      : null;

    const recentRows = db.prepare(
      `SELECT id, source, status, prompt, started_at, finished_at FROM tasks ORDER BY id DESC LIMIT 15`
    ).all();
    const recentTasks = recentRows.map((r) => ({
      id: r.id, source: r.source, status: r.status,
      prompt: truncate(r.prompt, 80),
      startedAt: r.started_at, finishedAt: r.finished_at,
      durationSec: durationSec(r.started_at, r.finished_at),
    }));

    const countRows = db.prepare(`SELECT status, COUNT(*) AS c FROM tasks GROUP BY status`).all();
    const counts = {};
    for (const row of countRows) counts[row.status] = row.c;

    const sessionRows = db.prepare(
      `SELECT s.user_id, s.claude_session_id, s.created_at,
              (SELECT COUNT(*) FROM tasks t WHERE t.session_id = s.claude_session_id) AS task_count
         FROM sessions s ORDER BY s.created_at`
    ).all();
    const sessions = sessionRows.map((s) => ({
      userId: s.user_id, sessionId: s.claude_session_id, createdAt: s.created_at, taskCount: s.task_count,
    }));

    const scheduleRows = db.prepare(
      `SELECT id, cron_expr, run_at, prompt, enabled, last_run_at FROM schedules ORDER BY id`
    ).all();
    const schedules = scheduleRows.map((r) => ({
      id: r.id, cronExpr: r.cron_expr, runAt: r.run_at,
      prompt: truncate(r.prompt, 60), enabled: !!r.enabled, lastRunAt: r.last_run_at,
    }));

    const lastRow = db.prepare(`SELECT MAX(finished_at) AS m FROM tasks`).get();
    const lastActivityAt = lastRow ? lastRow.m : null;

    return { name, busy: !!currentTask, currentTask, recentTasks, counts, sessions, schedules, lastActivityAt };
  } catch (e) {
    return { name, error: 'db unavailable', detail: e.message };
  } finally {
    if (db) try { db.close(); } catch (_) { /* ignore */ }
  }
}

// --- append to gui/src/datasource.js (above module.exports) ---
const { execFileSync } = require('node:child_process');
const { appDataRoot } = require('./paths.js');

const LAUNCHD_LABEL = 'uz.domo.agent-runtime';

// Pure parser for `launchctl list` output. Columns are PID<TAB>STATUS<TAB>LABEL.
function parseLaunchctlList(output, label = LAUNCHD_LABEL) {
  const line = String(output).split('\n').find((l) => l.includes(label));
  if (!line) return { status: 'unknown' };
  const pidStr = line.split(/\s+/)[0];
  if (/^\d+$/.test(pidStr)) return { alive: true, pid: Number(pidStr) };
  return { alive: false };
}

function daemonStatus(label = LAUNCHD_LABEL) {
  try {
    const out = execFileSync('launchctl', ['list'], { encoding: 'utf8' });
    return parseLaunchctlList(out, label);
  } catch (_) {
    return { status: 'unknown' };
  }
}

// generatedAt is stamped by the caller-injectable clock to keep this testable
// without Date.now noise; defaults to a real ISO timestamp.
function getSnapshot({ root = appDataRoot(), daemonStatusFn = daemonStatus, now = () => new Date().toISOString() } = {}) {
  const daemon = daemonStatusFn();
  let agentNames;
  try {
    agentNames = loadAgents(root).map((a) => a.name);
  } catch (e) {
    return { generatedAt: now(), daemon, agents: [], error: e.message };
  }
  const agents = agentNames.map((name) => readAgent(root, name));
  return { generatedAt: now(), daemon, agents };
}

module.exports = {
  ConfigError, parseSqliteTime, loadAgents, readAgent,
  parseLaunchctlList, daemonStatus, getSnapshot, LAUNCHD_LABEL,
};
