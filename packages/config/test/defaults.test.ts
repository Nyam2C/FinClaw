// packages/config/test/defaults.test.ts
import type { FinClawConfig } from '@finclaw/types';
import { describe, it, expect } from 'vitest';
import { applyDefaults, getDefaults } from '../src/defaults.js';

describe('getDefaults', () => {
  it('기본값을 반환한다', () => {
    const defaults = getDefaults();
    expect(defaults.gateway?.port).toBe(3000);
    expect(defaults.gateway?.host).toBe('127.0.0.1');
    expect(defaults.logging?.level).toBe('info');
    expect(defaults.session?.resetPolicy).toBe('idle');
  });

  it('반환값은 frozen이다', () => {
    const defaults = getDefaults();
    expect(Object.isFrozen(defaults)).toBe(true);
  });
});

describe('applyDefaults', () => {
  it('빈 설정에 모든 기본값을 적용한다', () => {
    const result = applyDefaults({});
    expect(result.gateway?.port).toBe(3000);
    expect(result.agents?.defaults?.model).toBe('claude-sonnet-4-20250514');
    expect(result.logging?.redactSensitive).toBe(true);
  });

  it('유저 값이 기본값을 오버라이드한다', () => {
    const user: FinClawConfig = { gateway: { port: 9090 } };
    const result = applyDefaults(user);
    expect(result.gateway?.port).toBe(9090);
    // 다른 gateway 기본값은 유지
    expect(result.gateway?.host).toBe('127.0.0.1');
  });

  it('중첩 객체도 병합한다', () => {
    const user: FinClawConfig = {
      agents: { defaults: { temperature: 0.5 } },
    };
    const result = applyDefaults(user);
    expect(result.agents?.defaults?.temperature).toBe(0.5);
    expect(result.agents?.defaults?.model).toBe('claude-sonnet-4-20250514');
  });

  it('기본값에 없는 섹션은 그대로 통과한다', () => {
    const user: FinClawConfig = {
      finance: {
        dataProviders: [{ name: 'test', apiKey: 'key' }],
      },
    };
    const result = applyDefaults(user);
    expect(result.finance?.dataProviders).toHaveLength(1);
  });
});
