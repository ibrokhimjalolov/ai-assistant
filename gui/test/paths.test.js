import { describe, it, expect } from 'vitest';
import { appDataRoot, configPath, agentsDir, agentDbPath } from '../src/paths.js';

describe('paths', () => {
  it('defaults appDataRoot under ~/Library/Application Support', () => {
    expect(appDataRoot()).toMatch(/Library\/Application Support\/agent-runtime$/);
  });
  it('derives config and per-agent db paths from a given root', () => {
    const root = '/tmp/fake-root';
    expect(configPath(root)).toBe('/tmp/fake-root/config.json');
    expect(agentsDir(root)).toBe('/tmp/fake-root/agents');
    expect(agentDbPath(root, 'default')).toBe('/tmp/fake-root/agents/default/agent.db');
  });
});
