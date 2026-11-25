// packages/server/src/channels/registry.ts
import type { ChannelDock } from '@finclaw/types';

const docks = new Map<string, ChannelDock>();

/** 채널 도크 등록 — 중복 시 에러 */
export function registerChannelDock(dock: ChannelDock): void {
  const key = dock.id as string;
  if (docks.has(key)) {
    throw new Error(`Channel dock '${key}' is already registered`);
  }
  docks.set(key, dock);
}

/** 등록된 모든 채널 도크 반환 */
export function getAllChannelDocks(): ReadonlyArray<ChannelDock> {
  return [...docks.values()];
}
