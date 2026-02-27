// packages/server/src/channels/registry.ts
import type { ChannelDock, ChannelId } from '@finclaw/types';

// TODO(review): CORE_DOCKS(dock.ts)를 부팅 시 자동 등록하는 코드 필요. initChannels() 등에서 호출.
const docks = new Map<string, ChannelDock>();

/** 채널 도크 등록 — 중복 시 에러 */
export function registerChannelDock(dock: ChannelDock): void {
  const key = dock.id as string;
  if (docks.has(key)) {
    throw new Error(`Channel dock '${key}' is already registered`);
  }
  docks.set(key, dock);
}

/** 채널 도크 조회 — 없으면 undefined */
export function getChannelDock(id: ChannelId | string): ChannelDock | undefined {
  const key = typeof id === 'string' ? id : (id as string);
  return docks.get(key);
}

/** 채널 도크 존재 여부 */
export function hasChannelDock(id: ChannelId | string): boolean {
  const key = typeof id === 'string' ? id : (id as string);
  return docks.has(key);
}

/** 등록된 모든 채널 도크 반환 */
export function getAllChannelDocks(): ReadonlyArray<ChannelDock> {
  return [...docks.values()];
}

/** 레지스트리 초기화 (테스트 격리용) */
export function resetChannelRegistry(): void {
  docks.clear();
}
