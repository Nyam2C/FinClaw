import { createSessionKey, createChannelId, createTimestamp } from '@finclaw/types';
import { describe, it, expect } from 'vitest';
import { MessageQueue, type QueueEntry } from '../../src/process/message-queue.js';

const sk = createSessionKey('agent:main:discord:direct');

function makeEntry(id: string, priority = 0): QueueEntry {
  return {
    id,
    message: {
      id,
      channelId: createChannelId('discord'),
      chatType: 'direct',
      senderId: 'user1',
      body: `msg-${id}`,
      timestamp: createTimestamp(Date.now()),
    },
    sessionKey: sk,
    enqueuedAt: createTimestamp(Date.now()),
    priority,
  };
}

describe('MessageQueue — queue 모드 (기본)', () => {
  it('빈 큐에 enqueue → 즉시 처리 가능 (true)', () => {
    const mq = new MessageQueue();
    expect(mq.enqueue(makeEntry('1'))).toBe(true);
  });

  it('처리 중이면 enqueue → 대기 (false)', () => {
    const mq = new MessageQueue();
    mq.enqueue(makeEntry('1'));
    mq.dequeue(sk);
    mq.markProcessing(sk);
    expect(mq.enqueue(makeEntry('2'))).toBe(false);
  });

  it('dequeue 순서: 우선순위 높은 것 먼저', () => {
    const mq = new MessageQueue();
    mq.enqueue(makeEntry('low', 0));
    mq.enqueue(makeEntry('high', 10));
    const entry = mq.dequeue(sk);
    expect(entry?.id).toBe('high');
  });

  it('markDone 후 대기 메시지 있으면 true', () => {
    const mq = new MessageQueue();
    mq.enqueue(makeEntry('1'));
    mq.enqueue(makeEntry('2'));
    mq.dequeue(sk);
    mq.markProcessing(sk);
    expect(mq.markDone(sk)).toBe(true);
  });

  it('purgeIdle이 비활성 세션 정리', async () => {
    const mq = new MessageQueue();
    mq.enqueue(makeEntry('1'));
    mq.dequeue(sk);
    mq.markProcessing(sk);
    mq.markDone(sk);
    // 최소 1ms 대기 후 thresholdMs=0으로 정리
    await new Promise((r) => setTimeout(r, 5));
    const purged = mq.purgeIdle(0);
    expect(purged).toBe(1);
  });
});

describe('MessageQueue — interrupt 모드', () => {
  it('처리 중일 때 enqueue → "interrupt" 반환', () => {
    const mq = new MessageQueue({ mode: 'interrupt' });
    mq.enqueue(makeEntry('1'));
    mq.dequeue(sk);
    mq.markProcessing(sk);
    expect(mq.enqueue(makeEntry('2'))).toBe('interrupt');
  });
});

describe('MessageQueue — followup 모드', () => {
  it('dequeueFollowup이 followup 모드에서만 동작', () => {
    const mq = new MessageQueue({ mode: 'followup' });
    mq.enqueue(makeEntry('1'));
    mq.enqueue(makeEntry('2'));
    mq.dequeue(sk);
    mq.markProcessing(sk);
    // 처리 완료 후 followup
    const followup = mq.dequeueFollowup(sk);
    expect(followup?.id).toBe('2');
  });

  it('queue 모드에서 dequeueFollowup은 undefined', () => {
    const mq = new MessageQueue({ mode: 'queue' });
    mq.enqueue(makeEntry('1'));
    mq.enqueue(makeEntry('2'));
    mq.dequeue(sk);
    expect(mq.dequeueFollowup(sk)).toBeUndefined();
  });
});

describe('MessageQueue — collect 모드', () => {
  it('collect 모드에서 enqueue는 항상 false (윈도우 대기)', () => {
    const mq = new MessageQueue({ mode: 'collect', collectWindowMs: 100 });
    expect(mq.enqueue(makeEntry('1'))).toBe(false);
    expect(mq.enqueue(makeEntry('2'))).toBe(false);
    expect(mq.pendingCount(sk)).toBe(2);
  });

  it('dequeueAll이 모든 메시지를 한 번에 반환', () => {
    const mq = new MessageQueue({ mode: 'collect' });
    mq.enqueue(makeEntry('1'));
    mq.enqueue(makeEntry('2'));
    mq.enqueue(makeEntry('3'));
    const all = mq.dequeueAll(sk);
    expect(all).toHaveLength(3);
    expect(mq.pendingCount(sk)).toBe(0);
  });
});

describe('MessageQueue — DropPolicy', () => {
  it('dropPolicy=old: maxSize 초과 시 가장 오래된 것 제거', () => {
    const mq = new MessageQueue({ maxSize: 2, dropPolicy: 'old' });
    mq.enqueue(makeEntry('1'));
    mq.enqueue(makeEntry('2'));
    mq.enqueue(makeEntry('3')); // '1' 제거
    expect(mq.pendingCount(sk)).toBe(2);
    const first = mq.dequeue(sk);
    expect(first?.id).toBe('2');
  });

  it('dropPolicy=new: maxSize 초과 시 새 메시지 드롭 (false)', () => {
    const mq = new MessageQueue({ maxSize: 2, dropPolicy: 'new' });
    mq.enqueue(makeEntry('1'));
    mq.enqueue(makeEntry('2'));
    expect(mq.enqueue(makeEntry('3'))).toBe(false);
    expect(mq.pendingCount(sk)).toBe(2);
  });
});

describe('MessageQueue — stats & clear', () => {
  it('stats가 올바른 집계 반환', () => {
    const mq = new MessageQueue();
    mq.enqueue(makeEntry('1'));
    mq.enqueue(makeEntry('2'));
    mq.dequeue(sk);
    mq.markProcessing(sk);
    const s = mq.stats();
    expect(s.totalQueued).toBe(1);
    expect(s.totalProcessing).toBe(1);
  });

  it('clear가 세션 큐 완전 정리', () => {
    const mq = new MessageQueue();
    mq.enqueue(makeEntry('1'));
    mq.markProcessing(sk);
    mq.clear(sk);
    expect(mq.pendingCount(sk)).toBe(0);
    expect(mq.isProcessing(sk)).toBe(false);
  });
});
