// packages/server/test/plugins/hooks-typed.test.ts
import { describe, it, expect } from 'vitest';
import type { HookPayloadMap, HookModeMap } from '../../src/plugins/hook-types.js';
import { createHookRunner } from '../../src/plugins/hooks.js';

describe('priority 정렬', () => {
  it('높은 priority 핸들러가 먼저 실행된다', async () => {
    const runner = createHookRunner<{ order: string[] }>('test', 'modifying');

    runner.tap((p) => ({ order: [...p.order, 'low'] }), { priority: 1 });
    runner.tap((p) => ({ order: [...p.order, 'high'] }), { priority: 10 });
    runner.tap((p) => ({ order: [...p.order, 'mid'] }), { priority: 5 });

    const result = await runner.fire({ order: [] });
    expect(result.order).toEqual(['high', 'mid', 'low']);
  });

  it('동일 priority에서는 FIFO (registeredAt) 순서', async () => {
    const runner = createHookRunner<{ order: string[] }>('test', 'modifying');

    runner.tap((p) => ({ order: [...p.order, 'first'] }), { priority: 5 });
    runner.tap((p) => ({ order: [...p.order, 'second'] }), { priority: 5 });
    runner.tap((p) => ({ order: [...p.order, 'third'] }), { priority: 5 });

    const result = await runner.fire({ order: [] });
    expect(result.order).toEqual(['first', 'second', 'third']);
  });

  it('void 모드에서도 priority 순서가 적용된다', async () => {
    const runner = createHookRunner<void>('test', 'void');
    const order: string[] = [];

    runner.tap(
      () => {
        order.push('low');
      },
      { priority: 1 },
    );
    runner.tap(
      () => {
        order.push('high');
      },
      { priority: 10 },
    );

    await runner.fire(undefined as void);
    // allSettled는 병렬이지만 동기 핸들러는 map 순서대로 시작
    expect(order[0]).toBe('high');
  });

  it('sync 모드에서도 priority 순서가 적용된다', () => {
    const runner = createHookRunner<number>('test', 'sync');

    runner.tap((n) => n + 100, { priority: 1 });
    runner.tap((n) => n + 200, { priority: 10 });

    const results = runner.fire(0);
    // priority 10이 먼저 → [200, 100]
    expect(results).toEqual([200, 100]);
  });
});

describe('HookPayloadMap 타입 호환성', () => {
  it('beforeMessageProcess는 modifying + InboundMessage 타입', async () => {
    type Payload = HookPayloadMap['beforeMessageProcess'];
    type Mode = HookModeMap['beforeMessageProcess']; // 'modifying'

    const runner = createHookRunner<Payload>('beforeMessageProcess', 'modifying' satisfies Mode);

    runner.tap((msg) => {
      // msg는 InboundMessage 타입 — body 필드 접근 가능
      return { ...msg, body: msg.body.toUpperCase() };
    });

    // 타입 에러 없이 컴파일되면 성공
    expect(runner).toBeDefined();
  });

  it('onPluginLoaded는 void + { pluginName, slots } 타입', () => {
    type Payload = HookPayloadMap['onPluginLoaded'];
    type Mode = HookModeMap['onPluginLoaded']; // 'void'

    const runner = createHookRunner<Payload>('onPluginLoaded', 'void' satisfies Mode);

    runner.tap((p) => {
      // p는 { pluginName: string; slots: string[] }
      expect(typeof p.pluginName).toBe('string');
    });

    expect(runner).toBeDefined();
  });

  it('onConfigChange는 void + { changedPaths } 타입', () => {
    type Payload = HookPayloadMap['onConfigChange'];
    type Mode = HookModeMap['onConfigChange']; // 'void'

    const runner = createHookRunner<Payload>('onConfigChange', 'void' satisfies Mode);

    runner.tap((p) => {
      // p는 { changedPaths: string[] }
      expect(Array.isArray(p.changedPaths)).toBe(true);
    });

    expect(runner).toBeDefined();
  });
});
