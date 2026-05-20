import { describe, it, expect } from 'vitest';
import { DEFAULT_CLAUDE_BACKEND } from '../../../src/providers/claude-cli/backends.js';
import { resolveCliNoOutputTimeoutMs } from '../../../src/providers/claude-cli/reliability.js';

describe('resolveCliNoOutputTimeoutMs', () => {
  it('uses fresh ratio (0.6) by default', () => {
    const result = resolveCliNoOutputTimeoutMs({
      backend: DEFAULT_CLAUDE_BACKEND,
      timeoutMs: 60_000,
      useResume: false,
    });
    // 60_000 * 0.6 = 36_000, bounded by min(30_000) ~ max(240_000), cap 59_000
    expect(result).toBe(36_000);
  });

  it('uses resume ratio (0.4) on resume', () => {
    const result = resolveCliNoOutputTimeoutMs({
      backend: DEFAULT_CLAUDE_BACKEND,
      timeoutMs: 60_000,
      useResume: true,
    });
    // 60_000 * 0.4 = 24_000, bounded by min(15_000) ~ max(90_000)
    expect(result).toBe(24_000);
  });

  it('caps at timeoutMs - 1000', () => {
    const result = resolveCliNoOutputTimeoutMs({
      backend: DEFAULT_CLAUDE_BACKEND,
      timeoutMs: 10_000,
      useResume: false,
    });
    // 10_000 * 0.6 = 6_000, clamped up by minMs(30_000) → bounded 30_000,
    // then capped at timeoutMs - 1000 = 9_000 → 9_000
    expect(result).toBe(9_000);
  });

  it('respects explicit noOutputTimeoutMs', () => {
    const backend = {
      ...DEFAULT_CLAUDE_BACKEND,
      reliability: {
        watchdog: {
          fresh: {
            noOutputTimeoutRatio: 0.6,
            minMs: 30_000,
            maxMs: 240_000,
            noOutputTimeoutMs: 45_000,
          },
        },
      },
    };
    const result = resolveCliNoOutputTimeoutMs({ backend, timeoutMs: 60_000, useResume: false });
    expect(result).toBe(45_000);
  });

  it('clamps ratio outside [0.05, 0.95]', () => {
    const backend = {
      ...DEFAULT_CLAUDE_BACKEND,
      reliability: {
        watchdog: { fresh: { noOutputTimeoutRatio: 1.5, minMs: 30_000, maxMs: 240_000 } },
      },
    };
    const result = resolveCliNoOutputTimeoutMs({ backend, timeoutMs: 60_000, useResume: false });
    // ratio clamped to 0.95 → 60_000 * 0.95 = 57_000, cap = 59_000
    expect(result).toBe(57_000);
  });
});
