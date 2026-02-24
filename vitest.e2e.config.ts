import os from 'node:os';
import { defineConfig } from 'vitest/config';

const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
const cpuCount = os.cpus().length;
const e2eWorkers = isCI ? 2 : Math.min(4, Math.max(1, Math.floor(cpuCount * 0.25)));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    maxWorkers: e2eWorkers,
    testTimeout: 120_000,
    include: [
      'packages/*/src/**/*.e2e.test.ts',
      'packages/*/test/**/*.e2e.test.ts',
      'test/**/*.e2e.test.ts',
    ],
    exclude: ['dist/**', 'node_modules/**'],
    setupFiles: ['test/setup.ts'],
    passWithNoTests: true,
  },
});
