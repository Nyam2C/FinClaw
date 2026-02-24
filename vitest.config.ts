import os from 'node:os';
import { defineConfig } from 'vitest/config';

const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
const localWorkers = Math.max(4, Math.min(16, os.cpus().length));
const ciWorkers = process.platform === 'win32' ? 2 : 3;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: [],
      },
    },
    maxWorkers: isCI ? ciWorkers : localWorkers,
    hookTimeout: process.platform === 'win32' ? 60_000 : 30_000,
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: [
      'dist/**',
      'node_modules/**',
      '**/*.storage.test.ts',
      '**/*.e2e.test.ts',
      '**/*.live.test.ts',
    ],
    setupFiles: ['test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      thresholds: {
        statements: 70,
        branches: 70,
        functions: 70,
        lines: 55,
      },
    },
  },
});
