import type { FinClawConfig } from '@finclaw/types';
// packages/config/test/runtime-overrides.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setOverride,
  unsetOverride,
  applyOverrides,
  resetOverrides,
  getOverrideCount,
} from '../src/runtime-overrides.js';

describe('runtime-overrides', () => {
  beforeEach(() => {
    resetOverrides();
  });

  it('오버라이드가 없으면 원본 config를 반환한다', () => {
    const config = { gateway: { port: 8080 } } as FinClawConfig;
    expect(applyOverrides(config)).toBe(config);
  });

  it('set으로 중첩 경로에 값을 설정한다', () => {
    setOverride('gateway.port', 9090);
    const config = { gateway: { port: 8080, host: 'localhost' } } as FinClawConfig;
    const result = applyOverrides(config);
    expect((result.gateway as Record<string, unknown>).port).toBe(9090);
    expect((result.gateway as Record<string, unknown>).host).toBe('localhost');
  });

  it('unset으로 오버라이드를 제거한다', () => {
    setOverride('gateway.port', 9090);
    unsetOverride('gateway.port');
    const config = { gateway: { port: 8080 } } as FinClawConfig;
    expect(applyOverrides(config)).toBe(config);
  });

  it('reset으로 모든 오버라이드를 초기화한다', () => {
    setOverride('gateway.port', 9090);
    setOverride('logging.level', 'debug');
    resetOverrides();
    expect(getOverrideCount()).toBe(0);
  });

  it('원본 config를 변경하지 않는다', () => {
    setOverride('gateway.port', 9090);
    const config = { gateway: { port: 8080 } } as FinClawConfig;
    applyOverrides(config);
    expect((config.gateway as Record<string, unknown>).port).toBe(8080);
  });
});
