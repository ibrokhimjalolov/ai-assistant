import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { makeTempRoot, writeConfig, buildAgentDb, cleanup } from './helpers.js';

let roots = [];
afterEach(() => { roots.forEach(cleanup); roots = []; });

describe('snapshot-cli', () => {
  it('prints a JSON snapshot honoring GUI_APPDATA_ROOT', () => {
    const root = makeTempRoot(); roots.push(root);
    writeConfig(root, { telegramBotToken: 'x', whitelist: [7], agentHome: '/h' });
    buildAgentDb(root, 'default', { tasks: [
      { source: 'telegram', user_id: 7, chat_id: 7, prompt: 'hi', status: 'done',
        created_at: '2026-06-15 03:00:00' },
    ]});
    const cli = path.join(process.cwd(), 'src', 'snapshot-cli.js');
    const out = execFileSync('node', [cli], { encoding: 'utf8', env: { ...process.env, GUI_APPDATA_ROOT: root } });
    const snap = JSON.parse(out);
    expect(snap.agents[0].name).toBe('default');
    expect(snap.agents[0].counts.done).toBe(1);
  });
});
