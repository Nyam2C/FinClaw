// packages/server/src/process/message-queue.ts
import type { SessionKey } from '@finclaw/types';
import type { InboundMessage } from '@finclaw/types';

export interface QueueEntry {
  id: string;
  message: InboundMessage;
  sessionKey: SessionKey;
}

const MAX_SIZE = 50;

/**
 * 세션별 FIFO 메시지 큐
 *
 * - 세션별 독립 큐, 세션당 한 번에 하나만 처리
 * - MAX_SIZE 초과 시 가장 오래된 메시지 제거
 */
export class MessageQueue {
  private queues = new Map<string, QueueEntry[]>();
  private processing = new Set<string>();

  /**
   * 메시지를 큐에 삽입
   * @returns true: 즉시 처리 가능, false: 처리 중이라 대기
   */
  enqueue(entry: QueueEntry): boolean {
    const key = entry.sessionKey as string;
    let queue = this.queues.get(key);

    if (!queue) {
      queue = [];
      this.queues.set(key, queue);
    }

    if (queue.length >= MAX_SIZE) {
      queue.shift();
    }
    queue.push(entry);

    return !this.processing.has(key);
  }

  /** 다음 처리할 메시지를 꺼냄 */
  dequeue(sessionKey: SessionKey): QueueEntry | undefined {
    return this.queues.get(sessionKey as string)?.shift();
  }

  markProcessing(sessionKey: SessionKey): void {
    this.processing.add(sessionKey as string);
  }

  /** @returns 대기 메시지가 남아 있으면 true */
  markDone(sessionKey: SessionKey): boolean {
    const key = sessionKey as string;
    this.processing.delete(key);
    return (this.queues.get(key)?.length ?? 0) > 0;
  }
}
