import { defineConfig, configDefaults } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    // Don't collect the test copies that get bundled into the packaged .app.
    exclude: [...configDefaults.exclude, '**/dist-app/**'],
  },
});
