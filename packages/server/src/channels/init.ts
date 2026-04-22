// packages/server/src/channels/init.ts
import type { FinClawLogger } from '@finclaw/infra';
import { CORE_DOCKS } from './dock.js';
import { getAllChannelDocks, registerChannelDock } from './registry.js';

/**
 * 부팅 시 1회 호출해 내장 채널 도크(CORE_DOCKS)를 레지스트리에 등록한다.
 * 중복 호출은 registerChannelDock에서 throw.
 */
export function initChannels(logger: FinClawLogger): void {
  for (const dock of CORE_DOCKS) {
    registerChannelDock(dock);
  }
  const ids = getAllChannelDocks().map((d) => d.id as string);
  logger.info(`channels: registered ${ids.length} docks (${ids.join(', ')})`);
}
