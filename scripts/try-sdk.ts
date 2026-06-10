import { SdkClaudeRunner } from '../src/claude.js';

const runner = new SdkClaudeRunner();
const ac = new AbortController();
for await (const ev of runner.run({
  prompt: 'Reply with exactly one word: pong',
  cwd: process.env.HOME!,
  signal: ac.signal,
  canUseTool: async (_t, input) => ({ behavior: 'allow', updatedInput: input }),
})) {
  console.log(JSON.stringify(ev));
}
