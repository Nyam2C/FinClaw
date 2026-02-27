// packages/server/test/plugins/hooks.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createHookRunner } from '../../src/plugins/hooks.js';

describe('createHookRunner — void 모드', () => {
  it('등록된 핸들러를 병렬 실행한다', async () => {
    const runner = createHookRunner<string>('test', 'void');
    const order: number[] = [];

    runner.tap(async () => {
      order.push(1);
    });
    runner.tap(async () => {
      order.push(2);
    });

    const results = await runner.fire('payload');
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(order).toContain(1);
    expect(order).toContain(2);
  });

  it('개별 핸들러 예외를 격리한다 (allSettled)', async () => {
    const runner = createHookRunner<string>('test', 'void');

    runner.tap(() => {
      throw new Error('fail');
    });
    runner.tap(async () => 'ok');

    const results = await runner.fire('payload');
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
  });

  it('핸들러 없으면 빈 배열 반환', async () => {
    const runner = createHookRunner<string>('test', 'void');
    const results = await runner.fire('payload');
    expect(results).toEqual([]);
  });
});

describe('createHookRunner — modifying 모드', () => {
  it('핸들러를 순차 실행하여 payload를 변형한다', async () => {
    const runner = createHookRunner<{ count: number }>('test', 'modifying');

    runner.tap((p) => ({ count: p.count + 1 }));
    runner.tap((p) => ({ count: p.count * 10 }));

    const result = await runner.fire({ count: 1 });
    expect(result.count).toBe(20); // (1+1) * 10
  });

  it('핸들러 에러 시 이전 payload를 유지한다', async () => {
    const runner = createHookRunner<{ value: string }>('test', 'modifying');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    runner.tap((p) => ({ value: p.value + '-a' }));
    runner.tap(() => {
      throw new Error('boom');
    });
    runner.tap((p) => ({ value: p.value + '-c' }));

    const result = await runner.fire({ value: 'start' });
    // 두 번째 핸들러 에러 → 'start-a' 유지 → 세 번째 핸들러 실행
    expect(result.value).toBe('start-a-c');
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  it('핸들러 없으면 원본 payload 반환', async () => {
    const runner = createHookRunner<{ x: number }>('test', 'modifying');
    const payload = { x: 42 };
    const result = await runner.fire(payload);
    expect(result).toBe(payload);
  });
});

describe('createHookRunner — sync 모드', () => {
  it('핸들러를 동기 실행하고 결과 배열을 반환한다', () => {
    const runner = createHookRunner<number>('test', 'sync');

    runner.tap((n) => n * 2);
    runner.tap((n) => n * 3);

    const results = runner.fire(5);
    expect(results).toEqual([10, 15]);
  });

  it('Promise 반환 시 경고를 출력한다', () => {
    const runner = createHookRunner<string>('test', 'sync');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    runner.tap(async () => 'should-warn');

    runner.fire('payload');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('sync handler returned Promise'));

    spy.mockRestore();
  });

  it('핸들러 없으면 빈 배열 반환', () => {
    const runner = createHookRunner<string>('test', 'sync');
    expect(runner.fire('payload')).toEqual([]);
  });
});
