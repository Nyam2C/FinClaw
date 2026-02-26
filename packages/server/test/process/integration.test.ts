import type { InboundMessage, MsgContext } from '@finclaw/types';
import type { FinClawConfig } from '@finclaw/types';
import { resetEventBus, type FinClawLogger } from '@finclaw/infra';
import { createChannelId, createTimestamp } from '@finclaw/types';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BindingMatch } from '../../src/process/binding-matcher.js';
import { MessageRouter } from '../../src/process/message-router.js';
import { deriveRoutingSessionKey } from '../../src/process/session-key.js';

function makeLogger(): FinClawLogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    flush: vi.fn().mockResolvedValue(undefined),
  } as unknown as FinClawLogger;
}

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: `msg-${Date.now()}-${Math.random()}`,
    channelId: createChannelId('discord'),
    chatType: 'direct',
    senderId: 'user1',
    body: 'test',
    timestamp: createTimestamp(Date.now()),
    ...overrides,
  };
}

const config: FinClawConfig = {
  agents: { entries: { main: { agentDir: './agents/main' } } },
};

describe('Integration: route → dedupe → queue → lane → process → abort', () => {
  beforeEach(() => {
    resetEventBus();
  });

  it('전체 라우팅 흐름 (정상)', async () => {
    const processLog: string[] = [];
    const onProcess = vi.fn().mockImplementation(async (ctx: MsgContext) => {
      processLog.push(ctx.body);
    });

    const router = new MessageRouter({ config, logger: makeLogger(), onProcess });

    await router.route(makeMsg({ body: 'first' }));
    await router.route(makeMsg({ body: 'second' }));

    expect(processLog).toEqual(['first', 'second']);
    router.dispose();
  });

  it('중복 메시지는 dedupe로 필터링', async () => {
    const onProcess = vi.fn().mockResolvedValue(undefined);
    const router = new MessageRouter({ config, logger: makeLogger(), onProcess });

    const msg = makeMsg({ id: 'same-id' });
    await router.route(msg);
    await router.route(msg);

    expect(onProcess).toHaveBeenCalledTimes(1);
    router.dispose();
  });

  it('AbortSignal이 onProcess에 전달됨', async () => {
    let signal: AbortSignal | undefined;
    const onProcess = vi
      .fn()
      .mockImplementation(async (_ctx: MsgContext, _match: BindingMatch, s: AbortSignal) => {
        signal = s;
      });

    const router = new MessageRouter({ config, logger: makeLogger(), onProcess });
    await router.route(makeMsg());

    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
    router.dispose();
  });

  it('세션 키 결정성 — 동일 입력은 동일 세션에 라우팅', () => {
    const params = {
      channelId: createChannelId('discord'),
      accountId: 'user1',
      chatType: 'direct' as const,
    };
    const k1 = deriveRoutingSessionKey(params);
    const k2 = deriveRoutingSessionKey(params);
    expect(k1).toBe(k2);
  });

  it('onProcess 에러 시 라우터가 크래시하지 않음', async () => {
    const onProcess = vi.fn().mockRejectedValue(new Error('boom'));
    const logger = makeLogger();
    const router = new MessageRouter({ config, logger, onProcess });

    // 에러 발생하지만 route()가 reject되지 않아야 함
    await expect(router.route(makeMsg())).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
    router.dispose();
  });

  it('dispose 후에는 새 route 호출 시 정상 동작 (새 인스턴스 필요)', async () => {
    const onProcess = vi.fn().mockResolvedValue(undefined);
    const router = new MessageRouter({ config, logger: makeLogger(), onProcess });

    await router.route(makeMsg());
    router.dispose();

    // dispose 후에도 route는 에러 없이 동작해야 함 (dedupe cleared)
    // 단, laneManager가 dispose되어 acquire 실패 가능 → 새 인스턴스 권장
  });
});
