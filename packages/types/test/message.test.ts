import type {
  ChatType,
  InboundMessage,
  MsgContext,
  ReplyPayload,
  OutboundMessage,
  GetReplyOptions,
  MediaAttachment,
} from '@finclaw/types';
import { describe, it, expectTypeOf } from 'vitest';

describe('ChatType', () => {
  it('direct, group, channel 중 하나이다', () => {
    expectTypeOf<'direct'>().toMatchTypeOf<ChatType>();
    expectTypeOf<'group'>().toMatchTypeOf<ChatType>();
    expectTypeOf<'channel'>().toMatchTypeOf<ChatType>();
  });

  it('정의되지 않은 값은 할당 불가하다', () => {
    expectTypeOf<'unknown'>().not.toMatchTypeOf<ChatType>();
  });
});

describe('InboundMessage', () => {
  it('필수 필드를 갖는다', () => {
    expectTypeOf<InboundMessage>().toHaveProperty('id');
    expectTypeOf<InboundMessage>().toHaveProperty('channelId');
    expectTypeOf<InboundMessage>().toHaveProperty('chatType');
    expectTypeOf<InboundMessage>().toHaveProperty('senderId');
    expectTypeOf<InboundMessage>().toHaveProperty('body');
    expectTypeOf<InboundMessage>().toHaveProperty('timestamp');
  });
});

describe('MsgContext', () => {
  it('본문 계열 필드를 갖는다', () => {
    expectTypeOf<MsgContext>().toHaveProperty('body');
    expectTypeOf<MsgContext>().toHaveProperty('bodyForAgent');
    expectTypeOf<MsgContext>().toHaveProperty('rawBody');
  });

  it('발신자 계열 필드를 갖는다', () => {
    expectTypeOf<MsgContext>().toHaveProperty('from');
    expectTypeOf<MsgContext>().toHaveProperty('senderId');
    expectTypeOf<MsgContext>().toHaveProperty('senderName');
  });

  it('채널/세션 계열 필드를 갖는다', () => {
    expectTypeOf<MsgContext>().toHaveProperty('provider');
    expectTypeOf<MsgContext>().toHaveProperty('channelId');
    expectTypeOf<MsgContext>().toHaveProperty('sessionKey');
  });
});

describe('ReplyPayload', () => {
  it('모든 필드가 optional이다', () => {
    const empty: ReplyPayload = {};
    expectTypeOf(empty).toMatchTypeOf<ReplyPayload>();
  });
});

describe('OutboundMessage', () => {
  it('필수 필드를 갖는다', () => {
    expectTypeOf<OutboundMessage>().toHaveProperty('channelId');
    expectTypeOf<OutboundMessage>().toHaveProperty('targetId');
    expectTypeOf<OutboundMessage>().toHaveProperty('payloads');
  });
});

describe('MediaAttachment', () => {
  it('type이 4가지 중 하나이다', () => {
    expectTypeOf<'image'>().toMatchTypeOf<MediaAttachment['type']>();
    expectTypeOf<'audio'>().toMatchTypeOf<MediaAttachment['type']>();
    expectTypeOf<'video'>().toMatchTypeOf<MediaAttachment['type']>();
    expectTypeOf<'document'>().toMatchTypeOf<MediaAttachment['type']>();
  });
});

describe('GetReplyOptions', () => {
  it('runId가 필수이다', () => {
    expectTypeOf<GetReplyOptions>().toHaveProperty('runId');
  });
});
