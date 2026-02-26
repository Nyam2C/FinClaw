// packages/config/test/merge-config.test.ts
import { describe, it, expect } from 'vitest';
import { mergeConfig } from '../src/merge-config.js';

describe('mergeConfig', () => {
  it('객체를 재귀 병합한다', () => {
    const target = { a: { b: 1, c: 2 }, d: 'keep' };
    const source = { a: { c: 3, e: 4 } };
    expect(mergeConfig(target, source)).toEqual({
      a: { b: 1, c: 3, e: 4 },
      d: 'keep',
    });
  });

  it('배열을 연결한다', () => {
    const target = { arr: [1, 2] };
    const source = { arr: [3, 4] };
    expect(mergeConfig(target, source)).toEqual({ arr: [1, 2, 3, 4] });
  });

  it('원시값은 source가 우선한다', () => {
    const target = { key: 'old' };
    const source = { key: 'new' };
    expect(mergeConfig(target, source)).toEqual({ key: 'new' });
  });

  it('source의 새 키를 추가한다', () => {
    expect(mergeConfig({}, { newKey: 'value' })).toEqual({ newKey: 'value' });
  });

  it('프로토타입 오염 키를 무시한다', () => {
    const source = JSON.parse('{"__proto__": {"x": 1}, "constructor": "bad"}');
    const result = mergeConfig({}, source);
    expect(Object.hasOwn(result, '__proto__')).toBe(false);
    expect(Object.hasOwn(result, 'constructor')).toBe(false);
  });

  it('target을 변경하지 않는다 (불변)', () => {
    const target = { a: { b: 1 } };
    const frozen = JSON.parse(JSON.stringify(target));
    mergeConfig(target, { a: { c: 2 } });
    expect(target).toEqual(frozen);
  });
});
