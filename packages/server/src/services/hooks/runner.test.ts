// packages/server/src/services/hooks/runner.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { HookEvent } from './types.js';
import { HookRegistry } from './registry.js';
import { createServiceHookRunner } from './runner.js';

function makeEvent(type = 'agent', action = 'bootstrap'): HookEvent {
  return { type: type as HookEvent['type'], action, timestamp: Date.now(), context: {} };
}

describe('createServiceHookRunner', () => {
  describe('parallel 모드', () => {
    it('모든 핸들러를 동시 실행한다', async () => {
      const registry = new HookRegistry();
      const calls: number[] = [];

      registry.register({
        id: 'h1',
        name: 'h1',
        source: 'system',
        events: ['agent:bootstrap'],
        enabled: true,
        handler: async () => {
          calls.push(1);
        },
      });
      registry.register({
        id: 'h2',
        name: 'h2',
        source: 'plugin',
        events: ['agent:bootstrap'],
        enabled: true,
        handler: async () => {
          calls.push(2);
        },
      });

      const runner = createServiceHookRunner(registry, { mode: 'parallel' });
      await runner.trigger(makeEvent());

      expect(calls).toHaveLength(2);
    });

    it('에러가 발생해도 모든 핸들러가 실행된다', async () => {
      const registry = new HookRegistry();
      const onError = vi.fn();

      registry.register({
        id: 'fail',
        name: 'fail',
        source: 'system',
        events: ['agent:bootstrap'],
        enabled: true,
        handler: () => {
          throw new Error('fail');
        },
      });
      registry.register({
        id: 'ok',
        name: 'ok',
        source: 'system',
        events: ['agent:bootstrap'],
        enabled: true,
        priority: 1,
        handler: vi.fn(),
      });

      const runner = createServiceHookRunner(registry, { mode: 'parallel', onError });
      await runner.trigger(makeEvent());

      expect(onError).toHaveBeenCalledOnce();
    });
  });

  describe('sequential 모드', () => {
    it('순차 실행하며 에러 격리한다', async () => {
      const registry = new HookRegistry();
      const order: string[] = [];

      registry.register({
        id: 'h1',
        name: 'h1',
        source: 'system',
        events: ['agent:bootstrap'],
        enabled: true,
        handler: () => {
          order.push('h1');
          throw new Error('fail');
        },
      });
      registry.register({
        id: 'h2',
        name: 'h2',
        source: 'system',
        events: ['agent:bootstrap'],
        enabled: true,
        priority: 1,
        handler: () => {
          order.push('h2');
        },
      });

      const runner = createServiceHookRunner(registry, { mode: 'sequential', onError: vi.fn() });
      await runner.trigger(makeEvent());

      expect(order).toEqual(['h1', 'h2']);
    });
  });

  describe('sync 모드', () => {
    it('동기적으로 실행한다', async () => {
      const registry = new HookRegistry();
      const handler = vi.fn();

      registry.register({
        id: 'h1',
        name: 'h1',
        source: 'system',
        events: ['agent:bootstrap'],
        enabled: true,
        handler,
      });

      const runner = createServiceHookRunner(registry, { mode: 'sync' });
      await runner.trigger(makeEvent());

      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('타임아웃', () => {
    it('핸들러가 타임아웃을 초과하면 에러를 발생시킨다', async () => {
      const registry = new HookRegistry();
      const onError = vi.fn();

      registry.register({
        id: 'slow',
        name: 'slow',
        source: 'system',
        events: ['agent:bootstrap'],
        enabled: true,
        handler: () => new Promise((resolve) => setTimeout(resolve, 500)),
      });

      const runner = createServiceHookRunner(registry, {
        mode: 'parallel',
        timeoutMs: 50,
        onError,
      });
      await runner.trigger(makeEvent());

      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0].message).toContain('timeout');
    });
  });
});
