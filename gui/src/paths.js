'use strict';
const os = require('node:os');
const path = require('node:path');

function appDataRoot() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'agent-runtime');
}
function configPath(root = appDataRoot()) {
  return path.join(root, 'config.json');
}
function agentsDir(root = appDataRoot()) {
  return path.join(root, 'agents');
}
function agentDbPath(root, name) {
  return path.join(agentsDir(root), name, 'agent.db');
}

module.exports = { appDataRoot, configPath, agentsDir, agentDbPath };
