// packages/config/src/sessions/types.ts
import type { SessionKey, Timestamp } from '@finclaw/types';

/** 세션 스코프 — 세션이 적용되는 범위 */
export type SessionScope = 'global' | 'channel' | 'user';

/** 세션 엔트리 — 스토어에 저장되는 단위 */
export interface SessionEntry {
  key: SessionKey;
  scope: SessionScope;
  createdAt: Timestamp;
  lastAccessedAt: Timestamp;
  data: Record<string, unknown>;
}

/** 두 엔트리를 병합 (data는 shallow merge, 타임스탬프는 최신 유지) */
export function mergeSessionEntry(
  existing: SessionEntry,
  patch: Partial<Pick<SessionEntry, 'data' | 'lastAccessedAt'>>,
): SessionEntry {
  return {
    ...existing,
    data: { ...existing.data, ...patch.data },
    lastAccessedAt: patch.lastAccessedAt ?? existing.lastAccessedAt,
  };
}
