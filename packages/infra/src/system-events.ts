// packages/infra/src/system-events.ts
import type { SessionKey, Timestamp } from '@finclaw/types';

const MAX_EVENTS_PER_SESSION = 20;

export interface SystemEvent {
  type: string;
  sessionKey: SessionKey;
  payload: unknown;
  timestamp: Timestamp;
}

/** 세션별 이벤트 큐 저장소 */
const queues = new Map<string, SystemEvent[]>();

/**
 * 이벤트 추가
 *
 * - MAX 20 제한, 초과 시 가장 오래된 것 삭제 (shift)
 * - 연속 중복 자동 스킵
 */
export function pushSystemEvent(event: SystemEvent): void {
  const key = event.sessionKey as string;
  let queue = queues.get(key);
  if (!queue) {
    queue = [];
    queues.set(key, queue);
  }

  // 연속 중복 스킵
  const last = queue[queue.length - 1];
  if (last && last.type === event.type && last.payload === event.payload) {
    return;
  }

  queue.push(event);

  // MAX 제한
  while (queue.length > MAX_EVENTS_PER_SESSION) {
    queue.shift();
  }
}

/** 큐를 비우며 모든 이벤트 반환 (소비적) */
export function drainSystemEvents(sessionKey: SessionKey): SystemEvent[] {
  const key = sessionKey as string;
  const queue = queues.get(key);
  if (!queue || queue.length === 0) {
    return [];
  }
  const events = [...queue];
  queue.length = 0;
  return events;
}

/** 큐를 비우지 않고 조회 */
export function peekSystemEvents(sessionKey: SessionKey): readonly SystemEvent[] {
  return queues.get(sessionKey as string) ?? [];
}

/** 특정 세션의 큐 삭제 */
export function clearSystemEvents(sessionKey: SessionKey): void {
  queues.delete(sessionKey as string);
}

/** contextKey 변경 감지 — 키가 바뀌면 이전 세션 큐 정리 */
export function onContextKeyChange(oldKey: SessionKey, newKey: SessionKey): void {
  if (oldKey !== newKey) {
    clearSystemEvents(oldKey);
  }
}

/** 테스트용 전체 상태 초기화 */
export function resetForTest(): void {
  queues.clear();
}
