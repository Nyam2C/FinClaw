// packages/server/src/services/hooks/registry.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { HookEvent, HookRegistration } from './types.js';
import { HookRegistry } from './registry.js';

function makeEvent(type: string, action: string): HookEvent {
  return { type: type as HookEvent['type'], action, timestamp: Date.now(), context: {} };
}

function makeHook(
  overrides: Partial<HookRegistration> & { id: string; handler: HookRegistration['handler'] },
): HookRegistration {
  return {
    name: overrides.id,
    source: 'system',
    events: ['agent:bootstrap'],
    enabled: true,
    ...overrides,
  };
}

describe('HookRegistry', () => {
  it('등록된 핸들러가 이벤트 발행 시 호출된다', async () => {
    const registry = new HookRegistry();
    const handler = vi.fn();

    registry.register(makeHook({ id: 'h1', handler, events: ['agent:bootstrap'] }));
    await registry.trigger(makeEvent('agent', 'bootstrap'));

    expect(handler).toHaveBeenCalledOnce();
  });

  it('type 키와 type:action 키 양쪽 핸들러가 호출된다', async () => {
    const registry = new HookRegistry();
    const typeHandler = vi.fn();
    const actionHandler = vi.fn();

    registry.register(makeHook({ id: 'h1', handler: typeHandler, events: ['agent'] }));
    registry.register(makeHook({ id: 'h2', handler: actionHandler, events: ['agent:bootstrap'] }));

    await registry.trigger(makeEvent('agent', 'bootstrap'));

    expect(typeHandler).toHaveBeenCalledOnce();
    expect(actionHandler).toHaveBeenCalledOnce();
  });

  it('우선순위 오름차순으로 실행된다 (system=0 > plugin=100 > user=300)', async () => {
    const registry = new HookRegistry();
    const order: string[] = [];

    registry.register(
      makeHook({
        id: 'user',
        handler: () => {
          order.push('user');
        },
        source: 'user',
        events: ['agent:bootstrap'],
      }),
    );
    registry.register(
      makeHook({
        id: 'system',
        handler: () => {
          order.push('system');
        },
        source: 'system',
        events: ['agent:bootstrap'],
      }),
    );
    registry.register(
      makeHook({
        id: 'plugin',
        handler: () => {
          order.push('plugin');
        },
        source: 'plugin',
        events: ['agent:bootstrap'],
      }),
    );

    await registry.trigger(makeEvent('agent', 'bootstrap'));

    expect(order).toEqual(['system', 'plugin', 'user']);
  });

  it('에러가 발생해도 나머지 핸들러가 실행된다', async () => {
    const registry = new HookRegistry();
    const secondHandler = vi.fn();

    registry.register(
      makeHook({
        id: 'h1',
        handler: () => {
          throw new Error('boom');
        },
        events: ['agent:bootstrap'],
        priority: 0,
      }),
    );
    registry.register(
      makeHook({
        id: 'h2',
        handler: secondHandler,
        events: ['agent:bootstrap'],
        priority: 1,
      }),
    );

    await registry.trigger(makeEvent('agent', 'bootstrap'));

    expect(secondHandler).toHaveBeenCalledOnce();
  });

  it('disabled 핸들러는 실행되지 않는다', async () => {
    const registry = new HookRegistry();
    const handler = vi.fn();

    registry.register(makeHook({ id: 'h1', handler, enabled: false, events: ['agent:bootstrap'] }));

    await registry.trigger(makeEvent('agent', 'bootstrap'));

    expect(handler).not.toHaveBeenCalled();
  });

  it('unregister로 훅을 제거할 수 있다', () => {
    const registry = new HookRegistry();
    registry.register(makeHook({ id: 'h1', handler: vi.fn(), events: ['agent:bootstrap'] }));

    expect(registry.unregister('h1')).toBe(true);
    expect(registry.getHandlers('agent:bootstrap')).toHaveLength(0);
  });

  it('listAll은 중복 없이 모든 훅을 반환한다', () => {
    const registry = new HookRegistry();
    const handler = vi.fn();

    // 같은 훅이 2개 이벤트에 등록
    registry.register(makeHook({ id: 'h1', handler, events: ['agent', 'agent:bootstrap'] }));

    expect(registry.listAll()).toHaveLength(1);
  });
});
