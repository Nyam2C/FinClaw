import { describe, it, expect, beforeEach, vi } from 'vitest';
import { warnOnce, resetWarnings } from '../src/warnings.js';

describe('warnOnce', () => {
  beforeEach(() => {
    resetWarnings();
  });

  it('동일 키로 최초 1회만 fn을 실행한다', () => {
    const fn = vi.fn();
    warnOnce('key1', fn);
    warnOnce('key1', fn);
    warnOnce('key1', fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('다른 키는 각각 1회씩 실행된다', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    warnOnce('a', fn1);
    warnOnce('b', fn2);
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it('resetWarnings 후 같은 키로 다시 실행된다', () => {
    const fn = vi.fn();
    warnOnce('key1', fn);
    resetWarnings();
    warnOnce('key1', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
