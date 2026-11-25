import { createSessionKey, createChannelId, createTimestamp } from '@finclaw/types';
import { describe, it, expect } from 'vitest';
import { MessageQueue, type QueueEntry } from '../../src/process/message-queue.js';

const sk = createSessionKey('agent:main:discord:direct');

function makeEntry(id: string): QueueEntry {
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
  };
}

describe('MessageQueue', () => {
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

  it('dequeue 순서: FIFO', () => {
    const mq = new MessageQueue();
    mq.enqueue(makeEntry('a'));
    mq.enqueue(makeEntry('b'));
    expect(mq.dequeue(sk)?.id).toBe('a');
    expect(mq.dequeue(sk)?.id).toBe('b');
    expect(mq.dequeue(sk)).toBeUndefined();
  });

  it('markDone 후 대기 메시지 있으면 true, 없으면 false', () => {
    const mq = new MessageQueue();
    mq.enqueue(makeEntry('1'));
    mq.enqueue(makeEntry('2'));
    mq.dequeue(sk);
    mq.markProcessing(sk);
    expect(mq.markDone(sk)).toBe(true);
    mq.dequeue(sk);
    expect(mq.markDone(sk)).toBe(false);
  });

  it('50개 초과 시 가장 오래된 것 제거', () => {
    const mq = new MessageQueue();
    for (let i = 1; i <= 51; i++) {
      mq.enqueue(makeEntry(String(i)));
    }
    expect(mq.dequeue(sk)?.id).toBe('2');
  });
});
