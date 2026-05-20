// packages/agent/src/providers/claude-cli/reliability.ts

import type { CliBackendConfig, CliWatchdogProfile } from './types.js';

export const CLI_WATCHDOG_MIN_TIMEOUT_MS = 5_000;

const FRESH_WATCHDOG_DEFAULTS: CliWatchdogProfile = {
  noOutputTimeoutRatio: 0.6,
  minMs: 30_000,
  maxMs: 240_000,
};
const RESUME_WATCHDOG_DEFAULTS: CliWatchdogProfile = {
  noOutputTimeoutRatio: 0.4,
  minMs: 15_000,
  maxMs: 90_000,
};

function pickWatchdogProfile(backend: CliBackendConfig, useResume: boolean): CliWatchdogProfile {
  const defaults = useResume ? RESUME_WATCHDOG_DEFAULTS : FRESH_WATCHDOG_DEFAULTS;
  const configured = useResume
    ? backend.reliability?.watchdog?.resume
    : backend.reliability?.watchdog?.fresh;

  const ratio = (() => {
    const v = configured?.noOutputTimeoutRatio;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return defaults.noOutputTimeoutRatio;
    }
    return Math.max(0.05, Math.min(0.95, v));
  })();

  const minMs = (() => {
    const v = configured?.minMs;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return defaults.minMs;
    }
    return Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(v));
  })();

  const maxMs = (() => {
    const v = configured?.maxMs;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return defaults.maxMs;
    }
    return Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(v));
  })();

  return {
    noOutputTimeoutMs:
      typeof configured?.noOutputTimeoutMs === 'number' &&
      Number.isFinite(configured.noOutputTimeoutMs)
        ? Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(configured.noOutputTimeoutMs))
        : undefined,
    noOutputTimeoutRatio: ratio,
    minMs: Math.min(minMs, maxMs),
    maxMs: Math.max(minMs, maxMs),
  };
}

export function resolveCliNoOutputTimeoutMs(params: {
  backend: CliBackendConfig;
  timeoutMs: number;
  useResume: boolean;
}): number {
  const profile = pickWatchdogProfile(params.backend, params.useResume);
  // overall timeout 보다 1초 일찍 watchdog 발동 → 정확한 reason 분류 시간 확보
  const cap = Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, params.timeoutMs - 1_000);
  if (profile.noOutputTimeoutMs !== undefined) {
    return Math.min(profile.noOutputTimeoutMs, cap);
  }
  const computed = Math.floor(params.timeoutMs * profile.noOutputTimeoutRatio);
  const bounded = Math.min(profile.maxMs, Math.max(profile.minMs, computed));
  return Math.min(bounded, cap);
}
