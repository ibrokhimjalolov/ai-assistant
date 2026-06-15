import { defineConfig } from 'vitest/config';

// The runtime's tests live in tests/*.test.ts. Without this, vitest's default
// glob also collects the GUI's gui/test/*.test.js (which has its own config and
// runs under node:sqlite) plus stale copies under build/ and .claude/worktrees/,
// which fail when run from the runtime root.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'build/**', 'gui/**', '.claude/**'],
  },
});
