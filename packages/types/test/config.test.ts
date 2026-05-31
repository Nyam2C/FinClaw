import type { FinClawConfig, ConfigValidationIssue } from '@finclaw/types';
import { describe, it, expect, expectTypeOf } from 'vitest';

describe('FinClawConfig', () => {
  it('빈 객체가 유효한 FinClawConfig이다 (모든 필드 optional)', () => {
    const config: FinClawConfig = {};
    expectTypeOf(config).toMatchTypeOf<FinClawConfig>();
  });

  it('gateway, agents, channels 등 최상위 필드를 가질 수 있다', () => {
    const config: FinClawConfig = {
      gateway: { port: 18789, host: 'localhost' },
      logging: { level: 'info' },
      finance: { portfolios: {} },
    };
    expectTypeOf(config).toMatchTypeOf<FinClawConfig>();
  });
});

describe('ConfigValidationIssue', () => {
  it('severity가 error 또는 warning이다', () => {
    const issue: ConfigValidationIssue = {
      path: 'gateway.port',
      message: 'Invalid port',
      severity: 'error',
    };
    expect(['error', 'warning']).toContain(issue.severity);
  });
});
