// packages/config/test/includes.test.ts
import { describe, it, expect } from 'vitest';
import { CircularIncludeError } from '../src/errors.js';
import { resolveIncludes, deepMerge } from '../src/includes.js';

describe('deepMerge', () => {
  it('객체를 재귀적으로 병합한다', () => {
    const target = { a: { b: 1, c: 2 } };
    const source = { a: { c: 3, d: 4 } };
    expect(deepMerge(target, source)).toEqual({ a: { b: 1, c: 3, d: 4 } });
  });

  it('배열을 연결한다', () => {
    expect(deepMerge([1, 2], [3, 4])).toEqual([1, 2, 3, 4]);
  });

  it('원시값은 source가 우선한다', () => {
    expect(deepMerge('old', 'new')).toBe('new');
    expect(deepMerge(1, 2)).toBe(2);
  });

  it('프로토타입 오염 키를 무시한다', () => {
    const source = JSON.parse('{"__proto__": {"polluted": true}}');
    const result = deepMerge({}, source) as Record<string, unknown>;
    expect(Object.hasOwn(result, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('resolveIncludes', () => {
  it('$include 없으면 원본 반환한다', () => {
    const raw = { key: 'value' };
    const result = resolveIncludes(raw, () => ({}), '/base/config.json5');
    expect(result).toEqual({ key: 'value' });
  });

  it('$include를 해석하고 deep merge한다', () => {
    const files: Record<string, Record<string, unknown>> = {
      '/base/common.json5': { shared: { a: 1 } },
    };
    const raw = { $include: 'common.json5', shared: { b: 2 } };
    const result = resolveIncludes(raw, (p) => files[p] ?? {}, '/base/config.json5');
    expect(result).toEqual({ shared: { a: 1, b: 2 } });
  });

  it('순환 참조를 감지한다', () => {
    const files: Record<string, Record<string, unknown>> = {
      '/a.json5': { $include: 'b.json5' },
      '/b.json5': { $include: 'a.json5' },
    };
    expect(() =>
      resolveIncludes({ $include: 'a.json5' }, (p) => files[p] ?? {}, '/config.json5'),
    ).toThrow(CircularIncludeError);
  });

  it('깊이 제한(10)을 초과하면 에러를 던진다', () => {
    const readFile = (p: string): Record<string, unknown> => ({
      $include: `${p}_next`,
    });
    expect(() => resolveIncludes({ $include: 'level0' }, readFile, '/base.json5')).toThrow(
      CircularIncludeError,
    );
  });
});
