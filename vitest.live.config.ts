import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    maxWorkers: 1,
    testTimeout: 60_000,
    include: [
      'packages/*/src/**/*.live.test.ts',
      'packages/*/test/**/*.live.test.ts',
      'test/**/*.live.test.ts',
    ],
    exclude: ['dist/**', 'node_modules/**'],
    setupFiles: ['test/setup.ts'],
    passWithNoTests: true,
  },
});
