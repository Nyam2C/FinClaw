import type { InboundMessage } from '@finclaw/types';
import { createChannelId, createTimestamp } from '@finclaw/types';
// packages/server/test/channels/gating.test.ts
import { describe, it, expect } from 'vitest';
import { createAllowlistGate } from '../../src/channels/gating/allowlist.js';
import { createCommandGate } from '../../src/channels/gating/command-gating.js';
import { createMentionGate } from '../../src/channels/gating/mention-gating.js';
import { composeGates } from '../../src/channels/gating/pipeline.js';

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'msg-1',
    channelId: createChannelId('test'),
    chatType: 'group',
    senderId: 'user-1',
    body: 'hello',
    timestamp: createTimestamp(Date.now()),
    ...overrides,
  };
}

describe('composeGates', () => {
  it('게이트가 없으면 true를 반환한다', async () => {
    const pipeline = composeGates();
    expect(await pipeline(makeMsg())).toBe(true);
  });

  it('모든 게이트가 통과하면 true', async () => {
    const pipeline = composeGates(
      () => true,
      () => true,
    );
    expect(await pipeline(makeMsg())).toBe(true);
  });

  it('하나라도 실패하면 false', async () => {
    const pipeline = composeGates(
      () => true,
      () => false,
    );
    expect(await pipeline(makeMsg())).toBe(false);
  });

  it('실패한 게이트 이후는 실행하지 않는다', async () => {
    let thirdCalled = false;
    const pipeline = composeGates(
      () => true,
      () => false,
      () => {
        thirdCalled = true;
        return true;
      },
    );
    await pipeline(makeMsg());
    expect(thirdCalled).toBe(false);
  });

  it('비동기 게이트를 지원한다', async () => {
    const pipeline = composeGates(async () => true);
    expect(await pipeline(makeMsg())).toBe(true);
  });
});

describe('createMentionGate', () => {
  const gate = createMentionGate('@bot');

  it('DM은 멘션 없이도 통과한다', () => {
    expect(gate(makeMsg({ chatType: 'direct', body: 'hi' }))).toBe(true);
  });

  it('group에서 멘션이 있으면 통과한다', () => {
    expect(gate(makeMsg({ chatType: 'group', body: 'hey @bot help' }))).toBe(true);
  });

  it('group에서 멘션이 없으면 차단한다', () => {
    expect(gate(makeMsg({ chatType: 'group', body: 'hey help' }))).toBe(false);
  });

  it('channel에서 멘션이 없으면 차단한다', () => {
    expect(gate(makeMsg({ chatType: 'channel', body: 'no mention' }))).toBe(false);
  });
});

describe('createCommandGate', () => {
  const gate = createCommandGate('!');

  it('접두사로 시작하면 통과한다', () => {
    expect(gate(makeMsg({ body: '!help' }))).toBe(true);
  });

  it('접두사가 없으면 차단한다', () => {
    expect(gate(makeMsg({ body: 'help' }))).toBe(false);
  });

  it('접두사가 중간에 있으면 차단한다', () => {
    expect(gate(makeMsg({ body: 'say !help' }))).toBe(false);
  });
});

describe('createAllowlistGate', () => {
  const gate = createAllowlistGate(['admin-1', 'admin-2']);

  it('허용 목록에 있는 발신자는 통과한다', () => {
    expect(gate(makeMsg({ senderId: 'admin-1' }))).toBe(true);
  });

  it('허용 목록에 없는 발신자는 차단한다', () => {
    expect(gate(makeMsg({ senderId: 'stranger' }))).toBe(false);
  });

  it('빈 허용 목록은 모든 메시지를 차단한다', () => {
    const emptyGate = createAllowlistGate([]);
    expect(emptyGate(makeMsg({ senderId: 'anyone' }))).toBe(false);
  });
});

describe('게이트 합성 통합 테스트', () => {
  it('멘션 + 커맨드 게이트를 합성한다', async () => {
    const pipeline = composeGates(createMentionGate('@bot'), createCommandGate('!'));

    // DM + 커맨드 접두사 → 통과
    expect(await pipeline(makeMsg({ chatType: 'direct', body: '!status' }))).toBe(true);

    // DM + 접두사 없음 → 차단 (커맨드 게이트)
    expect(await pipeline(makeMsg({ chatType: 'direct', body: 'status' }))).toBe(false);

    // group + 멘션 + 접두사 → 통과
    expect(await pipeline(makeMsg({ chatType: 'group', body: '!status @bot' }))).toBe(true);

    // group + 멘션 없음 → 차단 (멘션 게이트)
    expect(await pipeline(makeMsg({ chatType: 'group', body: '!status' }))).toBe(false);
  });
});
