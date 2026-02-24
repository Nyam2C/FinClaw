import type {
  FinClawConfig,
  ConfigFileSnapshot,
  ConfigChangeEvent,
  ConfigIoDeps,
  ConfigValidationIssue,
} from '@finclaw/types';
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
      finance: { dataProviders: [] },
    };
    expectTypeOf(config).toMatchTypeOf<FinClawConfig>();
  });
});

describe('ConfigFileSnapshot', () => {
  it('필수 필드를 갖는다', () => {
    expectTypeOf<ConfigFileSnapshot>().toHaveProperty('path');
    expectTypeOf<ConfigFileSnapshot>().toHaveProperty('exists');
    expectTypeOf<ConfigFileSnapshot>().toHaveProperty('valid');
    expectTypeOf<ConfigFileSnapshot>().toHaveProperty('config');
    expectTypeOf<ConfigFileSnapshot>().toHaveProperty('issues');
  });
});

describe('ConfigChangeEvent', () => {
  it('previous, current, changedPaths 필드를 갖는다', () => {
    expectTypeOf<ConfigChangeEvent>().toHaveProperty('previous');
    expectTypeOf<ConfigChangeEvent>().toHaveProperty('current');
    expectTypeOf<ConfigChangeEvent>().toHaveProperty('changedPaths');
  });
});

describe('ConfigIoDeps', () => {
  it('5개 메서드를 정의한다', () => {
    expectTypeOf<ConfigIoDeps>().toHaveProperty('readFile');
    expectTypeOf<ConfigIoDeps>().toHaveProperty('writeFile');
    expectTypeOf<ConfigIoDeps>().toHaveProperty('exists');
    expectTypeOf<ConfigIoDeps>().toHaveProperty('env');
    expectTypeOf<ConfigIoDeps>().toHaveProperty('log');
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
