// packages/server/src/plugins/event-bridge.ts
import { getEventBus } from '@finclaw/infra';
import type { HookPayloadMap } from './hook-types.js';
import type { VoidHookRunner } from './hooks.js';

/**
 * Hook → EventBus 단방향 브릿지.
 *
 * 훅 이벤트를 EventBus로 전달하여 시스템 전체에서 관찰할 수 있게 함.
 * 훅 실행 자체에는 영향을 주지 않으며 부수적 알림 용도.
 */
export function bridgeHooksToEventBus(hooks: {
  afterAgentRun: VoidHookRunner<HookPayloadMap['afterAgentRun']>;
  onConfigChange: VoidHookRunner<HookPayloadMap['onConfigChange']>;
  onGatewayStart: VoidHookRunner<HookPayloadMap['onGatewayStart']>;
  onGatewayStop: VoidHookRunner<HookPayloadMap['onGatewayStop']>;
}): void {
  const bus = getEventBus();

  // TODO(review): durationMs=0 하드코딩. payload에 durationMs 필드 추가 후 전달 필요.
  hooks.afterAgentRun.tap(
    (payload) => {
      bus.emit('agent:run:end', payload.agentId, payload.sessionKey, 0);
    },
    { pluginName: 'event-bridge' },
  );

  hooks.onConfigChange.tap(
    (payload) => {
      bus.emit('config:change', payload.changedPaths);
    },
    { pluginName: 'event-bridge' },
  );

  hooks.onGatewayStart.tap(
    () => {
      bus.emit('system:ready');
    },
    { pluginName: 'event-bridge' },
  );

  hooks.onGatewayStop.tap(
    () => {
      bus.emit('system:shutdown', 'gateway-stop');
    },
    { pluginName: 'event-bridge' },
  );
}
