import { describe, it, expect, vi } from 'vitest';
import { Dedupe } from '../src/dedupe.js';

describe('Dedupe', () => {
  it('동일 키 동시 호출 시 fn을 1회만 실행한다', async () => {
    const dedupe = new Dedupe();
    const fn = vi.fn().mockResolvedValue('result');

    const [r1, r2, r3] = await Promise.all([
      dedupe.execute('key', fn),
      dedupe.execute('key', fn),
      dedupe.execute('key', fn),
    ]);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(r1).toBe('result');
    expect(r2).toBe('result');
    expect(r3).toBe('result');
  });

  it('다른 키는 각각 실행한다', async () => {
    const dedupe = new Dedupe();
    const fn = vi.fn().mockResolvedValue('ok');

    await Promise.all([dedupe.execute('a', fn), dedupe.execute('b', fn)]);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('TTL=0이면 완료 후 즉시 삭제한다', async () => {
    const dedupe = new Dedupe({ ttlMs: 0 });
    await dedupe.execute('key', async () => 'ok');
    expect(dedupe.size).toBe(0);
  });

  it('TTL>0이면 결과를 캐시한다', async () => {
    const dedupe = new Dedupe({ ttlMs: 10000 });
    const fn = vi.fn().mockResolvedValue('cached');

    await dedupe.execute('key', fn);
    await dedupe.execute('key', fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(dedupe.size).toBe(1);
  });

  it('maxSize 초과 시 가장 오래된 것을 삭제한다', async () => {
    const dedupe = new Dedupe({ ttlMs: 10000, maxSize: 2 });

    await dedupe.execute('a', async () => 1);
    await dedupe.execute('b', async () => 2);
    await dedupe.execute('c', async () => 3);

    expect(dedupe.size).toBe(2);
    expect(dedupe.check('a')).toBe(false);
    expect(dedupe.check('b')).toBe(true);
    expect(dedupe.check('c')).toBe(true);
  });

  it('check/peek/clear가 동작한다', async () => {
    const dedupe = new Dedupe({ ttlMs: 10000 });
    await dedupe.execute('key', async () => 'val');

    expect(dedupe.check('key')).toBe(true);
    expect(dedupe.check('none')).toBe(false);
    await expect(dedupe.peek('key')).resolves.toBe('val');
    expect(dedupe.peek('none')).toBeUndefined();

    dedupe.clear();
    expect(dedupe.size).toBe(0);
  });

  it('fn 에러 시 동일 키 재실행이 가능하다', async () => {
    const dedupe = new Dedupe();
    const fn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValue('ok');

    await expect(dedupe.execute('key', fn)).rejects.toThrow('fail');
    const result = await dedupe.execute('key', fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
