// packages/config/test/normalize-paths.test.ts
import { describe, it, expect } from 'vitest';
import { normalizePaths } from '../src/normalize-paths.js';

describe('normalizePaths', () => {
  const homedir = () => '/home/user';

  it('~/를 homedir로 확장한다', () => {
    expect(normalizePaths('~/data', homedir)).toBe('/home/user/data');
  });

  it('~만 있으면 homedir로 확장한다', () => {
    expect(normalizePaths('~', homedir)).toBe('/home/user');
  });

  it('~/로 시작하지 않는 문자열은 그대로 반환한다', () => {
    expect(normalizePaths('/absolute/path', homedir)).toBe('/absolute/path');
    expect(normalizePaths('relative/path', homedir)).toBe('relative/path');
  });

  it('객체를 재귀적으로 처리한다', () => {
    const input = { dir: '~/config', nested: { path: '~/logs' } };
    expect(normalizePaths(input, homedir)).toEqual({
      dir: '/home/user/config',
      nested: { path: '/home/user/logs' },
    });
  });

  it('배열을 재귀적으로 처리한다', () => {
    expect(normalizePaths(['~/a', '~/b'], homedir)).toEqual(['/home/user/a', '/home/user/b']);
  });

  it('숫자/불리언 등은 그대로 반환한다', () => {
    expect(normalizePaths(42, homedir)).toBe(42);
    expect(normalizePaths(true, homedir)).toBe(true);
  });
});
