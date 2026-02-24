import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { isolateEnv, restoreEnv } from './test-env.js';

beforeAll(() => {
  isolateEnv();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  restoreEnv();
});
