// packages/server/src/services/hooks/bridge.ts
import { getEventBus, type FinClawEventMap } from '@finclaw/infra';
import type { HookRegistry } from './registry.js';
import type { HookEventType } from './types.js';

/**
 * @finclaw/infra EventBus → HookRegistry 브리지.
 * EventBus 이벤트를 HookRegistry 훅 이벤트로 변환·전파한다.
 *
 * 반환: 브리지 해제 함수 (shutdown 시 호출)
 */
export function bridgeEventBusToHooks(registry: HookRegistry): () => void {
  const bus = getEventBus();

  const mappings: Array<{
    busEvent: keyof FinClawEventMap;
    hookType: HookEventType;
    hookAction: string;
  }> = [
    { busEvent: 'agent:run:start', hookType: 'agent', hookAction: 'turn-start' },
    { busEvent: 'agent:run:end', hookType: 'agent', hookAction: 'turn-end' },
    { busEvent: 'agent:run:error', hookType: 'agent', hookAction: 'error' },
    { busEvent: 'gateway:start', hookType: 'gateway', hookAction: 'startup' },
    { busEvent: 'gateway:stop', hookType: 'gateway', hookAction: 'shutdown' },
    { busEvent: 'channel:message', hookType: 'channel', hookAction: 'message-received' },
    { busEvent: 'config:change', hookType: 'gateway', hookAction: 'reload' },
  ];

  const unsubscribers: Array<() => void> = [];

  for (const { busEvent, hookType, hookAction } of mappings) {
    const listener = (...args: unknown[]) => {
      registry
        .trigger({
          type: hookType,
          action: hookAction,
          timestamp: Date.now(),
          context: { args },
        })
        .catch((err) => console.error('[Bridge] hook error:', err));
    };
    bus.on(busEvent, listener as FinClawEventMap[typeof busEvent]);
    unsubscribers.push(() => bus.off(busEvent, listener as FinClawEventMap[typeof busEvent]));
  }

  return () => unsubscribers.forEach((fn) => fn());
}
