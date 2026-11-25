import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getEnv } from '../src/env.js';

describe('getEnv', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('FINCLAW_ 접두사 변수를 우선 반환한다', () => {
    vi.stubEnv('FINCLAW_STATE_DIR', '/a');
    vi.stubEnv('STATE_DIR', '/b');
    expect(getEnv('STATE_DIR')).toBe('/a');
  });

  it('FINCLAW_ 없으면 접두사 없는 키를 반환한다', () => {
    vi.stubEnv('STATE_DIR', '/b');
    expect(getEnv('STATE_DIR')).toBe('/b');
  });

  it('둘 다 없으면 fallback을 반환한다', () => {
    expect(getEnv('FINCLAW_TEST_MISSING', 'default')).toBe('default');
  });

  it('fallback도 없으면 undefined를 반환한다', () => {
    expect(getEnv('FINCLAW_TEST_MISSING')).toBeUndefined();
  });
});
