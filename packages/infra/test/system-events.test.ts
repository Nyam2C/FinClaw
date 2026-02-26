import { createSessionKey, createTimestamp } from '@finclaw/types';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  pushSystemEvent,
  drainSystemEvents,
  peekSystemEvents,
  clearSystemEvents,
  onContextKeyChange,
  resetForTest,
} from '../src/system-events.js';

const sk = createSessionKey('test-session');

function makeEvent(type: string, payload: unknown = null) {
  return { type, sessionKey: sk, payload, timestamp: createTimestamp(Date.now()) };
}

describe('system-events', () => {
  beforeEach(() => {
    resetForTest();
  });

  it('이벤트를 추가하고 peek으로 조회한다', () => {
    pushSystemEvent(makeEvent('test'));
    const events = peekSystemEvents(sk);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('test');
  });

  it('drain은 소비적이다 (큐를 비운다)', () => {
    pushSystemEvent(makeEvent('a'));
    pushSystemEvent(makeEvent('b'));
    const drained = drainSystemEvents(sk);
    expect(drained).toHaveLength(2);
    expect(peekSystemEvents(sk)).toHaveLength(0);
  });

  it('MAX 20개 제한을 초과하면 오래된 것이 삭제된다', () => {
    for (let i = 0; i < 25; i++) {
      pushSystemEvent(makeEvent(`event-${i}`, i));
    }
    const events = peekSystemEvents(sk);
    expect(events).toHaveLength(20);
    expect(events[0].type).toBe('event-5'); // 0-4 삭제됨
  });

  it('연속 중복 이벤트를 스킵한다', () => {
    pushSystemEvent(makeEvent('dup', 'same'));
    pushSystemEvent(makeEvent('dup', 'same'));
    pushSystemEvent(makeEvent('dup', 'same'));
    expect(peekSystemEvents(sk)).toHaveLength(1);
  });

  it('같은 type이라도 payload가 다르면 추가한다', () => {
    pushSystemEvent(makeEvent('dup', 'a'));
    pushSystemEvent(makeEvent('dup', 'b'));
    expect(peekSystemEvents(sk)).toHaveLength(2);
  });

  it('clearSystemEvents로 세션 큐를 삭제한다', () => {
    pushSystemEvent(makeEvent('test'));
    clearSystemEvents(sk);
    expect(peekSystemEvents(sk)).toHaveLength(0);
  });

  it('onContextKeyChange가 이전 세션을 정리한다', () => {
    pushSystemEvent(makeEvent('test'));
    const newSk = createSessionKey('new-session');
    onContextKeyChange(sk, newSk);
    expect(peekSystemEvents(sk)).toHaveLength(0);
  });

  it('빈 세션의 drain은 빈 배열을 반환한다', () => {
    const emptySk = createSessionKey('empty');
    expect(drainSystemEvents(emptySk)).toEqual([]);
  });
});
