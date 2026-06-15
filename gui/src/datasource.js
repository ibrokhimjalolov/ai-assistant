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

module.exports = { ConfigError, parseSqliteTime, loadAgents };
