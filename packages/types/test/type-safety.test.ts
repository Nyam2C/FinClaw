import type {
  Timestamp,
  SessionKey,
  AgentId,
  ChannelId,
  Result,
  FinClawError,
  ErrorReason,
} from '@finclaw/types';
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

describe('Result 타입', () => {
  it('ok: true일 때 value를 갖는다', () => {
    const success: Result<number> = { ok: true, value: 42 };
    expectTypeOf(success).toMatchTypeOf<Result<number>>();
  });

  it('ok: false일 때 error를 갖는다', () => {
    const failure: Result<number> = { ok: false, error: new Error('fail') };
    expectTypeOf(failure).toMatchTypeOf<Result<number>>();
  });

  it('FinClawError를 에러 타입으로 사용할 수 있다', () => {
    expectTypeOf<Result<string, FinClawError>>().not.toBeAny();
  });
});

describe('ErrorReason', () => {
  it('정의된 7가지 값 중 하나이다', () => {
    expectTypeOf<'CONFIG_INVALID'>().toMatchTypeOf<ErrorReason>();
    expectTypeOf<'CHANNEL_OFFLINE'>().toMatchTypeOf<ErrorReason>();
    expectTypeOf<'AGENT_TIMEOUT'>().toMatchTypeOf<ErrorReason>();
    expectTypeOf<'STORAGE_FAILURE'>().toMatchTypeOf<ErrorReason>();
    expectTypeOf<'RATE_LIMITED'>().toMatchTypeOf<ErrorReason>();
    expectTypeOf<'AUTH_FAILURE'>().toMatchTypeOf<ErrorReason>();
    expectTypeOf<'INTERNAL'>().toMatchTypeOf<ErrorReason>();
  });

  it('정의되지 않은 값은 할당 불가하다', () => {
    expectTypeOf<'UNKNOWN'>().not.toMatchTypeOf<ErrorReason>();
  });
});
