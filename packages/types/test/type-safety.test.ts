import type { Timestamp, SessionKey, AgentId, ChannelId } from '@finclaw/types';
import { createTimestamp, createSessionKey, createAgentId, createChannelId } from '@finclaw/types';
import { describe, it, expectTypeOf } from 'vitest';

describe('Brand 타입 안전성', () => {
  it('팩토리 함수가 올바른 Brand 타입을 반환한다', () => {
    expectTypeOf(createTimestamp(0)).toMatchTypeOf<Timestamp>();
    expectTypeOf(createSessionKey('')).toMatchTypeOf<SessionKey>();
    expectTypeOf(createAgentId('')).toMatchTypeOf<AgentId>();
    expectTypeOf(createChannelId('')).toMatchTypeOf<ChannelId>();
  });

  it('plain number는 Timestamp에 할당 불가하다', () => {
    // @ts-expect-error -- plain number는 Brand 타입에 할당 불가
    const _ts: Timestamp = 42;
  });

  it('plain string은 SessionKey에 할당 불가하다', () => {
    // @ts-expect-error -- plain string은 Brand 타입에 할당 불가
    const _sk: SessionKey = 'key';
  });

  it('서로 다른 Brand 타입은 호환되지 않는다', () => {
    expectTypeOf<SessionKey>().not.toMatchTypeOf<AgentId>();
    expectTypeOf<AgentId>().not.toMatchTypeOf<ChannelId>();
    expectTypeOf<ChannelId>().not.toMatchTypeOf<SessionKey>();
  });
});
