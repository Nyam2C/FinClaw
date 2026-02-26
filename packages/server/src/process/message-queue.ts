// packages/server/src/process/message-queue.ts
import type { SessionKey, Timestamp } from '@finclaw/types';
import type { InboundMessage } from '@finclaw/types';

/**
 * 큐 모드 — OpenClaw QueueMode 대응
 *
 * Phase 4 구현: queue, followup, interrupt, collect (4종)
 * Phase 8 추가: steer, steer-backlog (2종)
 */
export type QueueMode = 'queue' | 'followup' | 'interrupt' | 'collect' | 'steer' | 'steer-backlog';

/** 큐 가득 찰 때의 드롭 정책 */
export type QueueDropPolicy = 'old' | 'new';

export interface QueueEntry {
  id: string;
  message: InboundMessage;
  sessionKey: SessionKey;
  enqueuedAt: Timestamp;
  priority: number;
}

export interface MessageQueueConfig {
  mode?: QueueMode;
  maxSize?: number; // 기본: 50
  collectWindowMs?: number; // collect 모드 시간 윈도우 (ms, 기본: 2000)
  dropPolicy?: QueueDropPolicy; // 기본: 'old'
}

const DEFAULT_MAX_SIZE = 50;

/**
 * 세션별 메시지 큐
 *
 * - 세션별 독립 큐
 * - QueueMode에 따른 처리 전략 (4종)
 * - drain 시 순차적 소비
 * - 처리 중 상태 추적
 */
export class MessageQueue {
  private queues = new Map<string, QueueEntry[]>();
  private processing = new Set<string>();
  private lastActivity = new Map<string, number>();
  private collectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private config: Required<MessageQueueConfig>;

  constructor(config: MessageQueueConfig = {}) {
    this.config = {
      mode: config.mode ?? 'queue',
      maxSize: config.maxSize ?? DEFAULT_MAX_SIZE,
      collectWindowMs: config.collectWindowMs ?? 2000,
      dropPolicy: config.dropPolicy ?? 'old',
    };
  }

  /**
   * 메시지를 큐에 삽입
   * @returns true: 즉시 처리 가능, false: 큐에 대기, 'interrupt': 진행 중 취소 필요
   */
  enqueue(entry: QueueEntry): boolean | 'interrupt' {
    const key = entry.sessionKey as string;
    let queue = this.queues.get(key);

    if (!queue) {
      queue = [];
      this.queues.set(key, queue);
    }

    this.lastActivity.set(key, Date.now());

    // MAX 크기 제한
    if (queue.length >= this.config.maxSize) {
      if (this.config.dropPolicy === 'old') {
        queue.shift(); // 가장 오래된 것 제거
      } else {
        return false; // 새 메시지 드롭
      }
    }

    // 우선순위 정렬 유지를 위한 삽입 (높은 것 먼저). O(n) — maxSize 50 기준 무시 가능.
    const insertIdx = queue.findIndex((e) => e.priority < entry.priority);
    if (insertIdx === -1) {
      queue.push(entry);
    } else {
      queue.splice(insertIdx, 0, entry);
    }

    // collect 모드: 시간 윈도우 내 메시지를 모아서 처리
    if (this.config.mode === 'collect') {
      // 기존 타이머를 리셋하여 윈도우 연장
      clearTimeout(this.collectTimers.get(key));
      this.collectTimers.set(
        key,
        setTimeout(() => {
          this.collectTimers.delete(key);
          // TODO(Phase 8): collect 윈도우 만료 시 콜백/이벤트로 MessageRouter에 알림.
          // 현재 isCollectReady() 폴링만 가능하나, MessageRouter에 폴링 로직 미구현.
        }, this.config.collectWindowMs),
      );
      return false; // collect 모드에서는 즉시 처리하지 않음
    }

    // interrupt 모드: 처리 중이면 취소 시그널 반환
    if (this.config.mode === 'interrupt' && this.processing.has(key)) {
      return 'interrupt';
    }

    // 현재 처리 중이 아니면 즉시 처리 가능
    return !this.processing.has(key);
  }

  /** 다음 처리할 메시지를 꺼냄 */
  dequeue(sessionKey: SessionKey): QueueEntry | undefined {
    const key = sessionKey as string;
    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    return queue.shift();
  }

  /**
   * collect 모드: 큐의 모든 메시지를 한 번에 꺼냄
   * (시간 윈도우 종료 후 호출)
   */
  dequeueAll(sessionKey: SessionKey): QueueEntry[] {
    const key = sessionKey as string;
    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) {
      return [];
    }
    const all = [...queue];
    queue.length = 0;
    return all;
  }

  /**
   * followup 모드: 현재 처리 완료 후 후속 메시지가 있으면 꺼냄
   */
  dequeueFollowup(sessionKey: SessionKey): QueueEntry | undefined {
    if (this.config.mode !== 'followup') {
      return undefined;
    }
    return this.dequeue(sessionKey);
  }

  /** collect 모드의 윈도우 타이머가 만료되었는지 확인 */
  isCollectReady(sessionKey: SessionKey): boolean {
    const key = sessionKey as string;
    return (
      this.config.mode === 'collect' &&
      !this.collectTimers.has(key) &&
      this.pendingCount(sessionKey) > 0
    );
  }

  markProcessing(sessionKey: SessionKey): void {
    this.processing.add(sessionKey as string);
  }

  markDone(sessionKey: SessionKey): boolean {
    const key = sessionKey as string;
    this.processing.delete(key);
    this.lastActivity.set(key, Date.now());
    const queue = this.queues.get(key);
    return (queue?.length ?? 0) > 0;
  }

  isProcessing(sessionKey: SessionKey): boolean {
    return this.processing.has(sessionKey as string);
  }

  pendingCount(sessionKey: SessionKey): number {
    return this.queues.get(sessionKey as string)?.length ?? 0;
  }

  clear(sessionKey: SessionKey): void {
    const key = sessionKey as string;
    this.queues.delete(key);
    this.processing.delete(key);
    this.lastActivity.delete(key);
    clearTimeout(this.collectTimers.get(key));
    this.collectTimers.delete(key);
  }

  /**
   * 비활성 세션 정리 — thresholdMs 이상 활동 없는 세션 큐 제거
   * @returns 정리된 세션 수
   */
  purgeIdle(thresholdMs: number): number {
    const now = Date.now();
    let purged = 0;

    for (const [key, lastTime] of this.lastActivity) {
      if (now - lastTime > thresholdMs && !this.processing.has(key)) {
        this.queues.delete(key);
        this.lastActivity.delete(key);
        clearTimeout(this.collectTimers.get(key));
        this.collectTimers.delete(key);
        purged++;
      }
    }

    return purged;
  }

  stats(): { totalQueued: number; totalProcessing: number; sessionCount: number } {
    let totalQueued = 0;
    for (const queue of this.queues.values()) {
      totalQueued += queue.length;
    }
    return {
      totalQueued,
      totalProcessing: this.processing.size,
      sessionCount: this.queues.size,
    };
  }
}
