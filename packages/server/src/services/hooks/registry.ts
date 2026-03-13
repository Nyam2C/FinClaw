// packages/server/src/services/hooks/registry.ts
import type { HookEntry, HookEvent, HookRegistration, HookSource } from './types.js';

/** 훅 우선순위 (source별 기본값) */
const SOURCE_PRIORITY: Record<HookSource, number> = {
  system: 0,
  plugin: 100,
  channel: 200,
  user: 300,
};

export class HookRegistry {
  /** eventKey -> HookEntry[] (우선순위 정렬) */
  private readonly handlers = new Map<string, HookEntry[]>();

  /**
   * 훅을 등록한다.
   * 동일 eventKey에 여러 핸들러 → priority 오름차순 실행 (0 = 최고 우선순위).
   */
  register(entry: HookRegistration): void {
    const priority = entry.priority ?? SOURCE_PRIORITY[entry.source];
    const fullEntry: HookEntry = { ...entry, priority };

    for (const eventKey of entry.events) {
      const existing = this.handlers.get(eventKey) ?? [];
      existing.push(fullEntry);
      existing.sort((a, b) => a.priority - b.priority);
      this.handlers.set(eventKey, existing);
    }
  }

  /** 특정 이벤트 키에 등록된 핸들러 조회 */
  getHandlers(eventKey: string): ReadonlyArray<HookEntry> {
    return this.handlers.get(eventKey) ?? [];
  }

  /**
   * 이벤트 발행.
   * type 키와 type:action 키 양쪽의 핸들러를 수집 후
   * 우선순위순으로 순차 실행 (에러 격리).
   */
  async trigger(event: HookEvent): Promise<void> {
    const typeHandlers = this.getHandlers(event.type);
    const actionHandlers = this.getHandlers(`${event.type}:${event.action}`);

    // TODO(review): 동일 id 훅이 type과 type:action 양쪽에 등록된 경우 중복 실행 가능 — id 기반 dedup 고려
    const allHandlers = [...typeHandlers, ...actionHandlers]
      .filter((h) => h.enabled)
      .toSorted((a, b) => a.priority - b.priority);

    for (const entry of allHandlers) {
      try {
        await entry.handler(event);
      } catch (error) {
        // 에러 격리: 한 핸들러 실패가 나머지를 중단시키지 않음
        console.error(`[Hook Error] ${entry.name}: ${error}`);
      }
    }
  }

  /** 등록된 모든 훅 엔트리 반환 (중복 제거) */
  listAll(): ReadonlyArray<HookEntry> {
    const seen = new Set<string>();
    const result: HookEntry[] = [];
    for (const entries of this.handlers.values()) {
      for (const entry of entries) {
        if (!seen.has(entry.id)) {
          seen.add(entry.id);
          result.push(entry);
        }
      }
    }
    return result;
  }

  /** 특정 훅 제거 */
  unregister(hookId: string): boolean {
    let removed = false;
    for (const [key, entries] of this.handlers) {
      const filtered = entries.filter((e) => e.id !== hookId);
      if (filtered.length !== entries.length) {
        this.handlers.set(key, filtered);
        removed = true;
      }
    }
    return removed;
  }

  /** 모든 핸들러 제거 */
  clear(): void {
    this.handlers.clear();
  }
}
