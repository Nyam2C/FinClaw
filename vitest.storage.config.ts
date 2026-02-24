import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    maxWorkers: 1,
    testTimeout: 30_000,
    include: [
      'packages/*/src/**/*.storage.test.ts',
      'packages/*/test/**/*.storage.test.ts',
      'test/**/*.storage.test.ts',
    ],
    exclude: ['dist/**', 'node_modules/**'],
    setupFiles: ['test/setup.ts'],
    passWithNoTests: true,
  },
});
