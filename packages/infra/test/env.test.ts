import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeEnv, getEnv, requireEnv, isTruthyEnvValue } from '../src/env.js';

describe('normalizeEnv', () => {
  beforeEach(() => {
    vi.stubEnv('FINCLAW_EMPTY', '');
    vi.stubEnv('FINCLAW_VALUE', 'hello');
    vi.stubEnv('OTHER_EMPTY', '');
  });

  it('빈 FINCLAW_ 변수를 삭제한다', () => {
    normalizeEnv();
    expect(process.env.FINCLAW_EMPTY).toBeUndefined();
  });

  it('값이 있는 FINCLAW_ 변수를 유지한다', () => {
    normalizeEnv();
    expect(process.env.FINCLAW_VALUE).toBe('hello');
  });

  it('FINCLAW_ 접두사가 아닌 빈 변수는 무시한다', () => {
    normalizeEnv();
    expect(process.env.OTHER_EMPTY).toBe('');
  });
});

describe('getEnv', () => {
  beforeEach(() => {
    vi.stubEnv('FINCLAW_PORT', '8080');
    vi.stubEnv('HOST', 'localhost');
  });

  it('FINCLAW_ 접두사 변수를 우선 반환한다', () => {
    vi.stubEnv('PORT', '3000');
    expect(getEnv('PORT')).toBe('8080');
  });

  it('FINCLAW_ 없으면 접두사 없는 키를 반환한다', () => {
    expect(getEnv('HOST')).toBe('localhost');
  });

  it('둘 다 없으면 fallback을 반환한다', () => {
    expect(getEnv('MISSING', 'default')).toBe('default');
  });

  it('fallback도 없으면 undefined를 반환한다', () => {
    expect(getEnv('MISSING')).toBeUndefined();
  });
});

describe('requireEnv', () => {
  it('값이 있으면 반환한다', () => {
    vi.stubEnv('FINCLAW_TOKEN', 'abc');
    expect(requireEnv('TOKEN')).toBe('abc');
  });

  it('값이 없으면 throw한다', () => {
    expect(() => requireEnv('NONEXISTENT')).toThrow('Required environment variable');
  });
});

describe('isTruthyEnvValue', () => {
  it.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['yes', true],
    ['YES', true],
    ['0', false],
    ['false', false],
    ['no', false],
    ['', false],
    [undefined, false],
  ])('isTruthyEnvValue(%j) → %s', (input, expected) => {
    expect(isTruthyEnvValue(input)).toBe(expected);
  });
});
