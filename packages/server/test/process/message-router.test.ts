import type { InboundMessage, MsgContext } from '@finclaw/types';
import type { FinClawConfig } from '@finclaw/types';
import { resetEventBus, getEventBus, type FinClawLogger } from '@finclaw/infra';
import { createChannelId, createTimestamp } from '@finclaw/types';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BindingMatch } from '../../src/process/binding-matcher.js';
import { MessageRouter } from '../../src/process/message-router.js';

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
    body: 'hello',
    timestamp: createTimestamp(Date.now()),
    ...overrides,
  };
}

const config: FinClawConfig = {
  agents: { entries: { main: { agentDir: './agents/main' } } },
};

describe('MessageRouter', () => {
  beforeEach(() => {
    resetEventBus();
  });

  it('메시지를 라우팅하고 onProcess 호출', async () => {
    const onProcess = vi.fn().mockResolvedValue(undefined);
    const router = new MessageRouter({
      config,
      logger: makeLogger(),
      onProcess,
    });

    await router.route(makeMsg());
    expect(onProcess).toHaveBeenCalledTimes(1);

    const [ctx, match, signal] = onProcess.mock.calls[0];
    expect(ctx.body).toBe('hello');
    expect(match.matchTier).toBe('default'); // extractBindingRules creates rules without channelId
    expect(signal).toBeInstanceOf(AbortSignal);

    router.dispose();
  });

  it('동일 id 중복 메시지 필터링 (Dedupe)', async () => {
    const onProcess = vi.fn().mockResolvedValue(undefined);
    const router = new MessageRouter({
      config,
      logger: makeLogger(),
      onProcess,
    });

    const msg = makeMsg({ id: 'dup-1' });
    await router.route(msg);
    await router.route(msg); // 중복

    expect(onProcess).toHaveBeenCalledTimes(1);
    router.dispose();
  });

  it('EventBus에 channel:message 이벤트 발행', async () => {
    const onProcess = vi.fn().mockResolvedValue(undefined);
    const router = new MessageRouter({
      config,
      logger: makeLogger(),
      onProcess,
    });

    const handler = vi.fn();
    getEventBus().on('channel:message', handler);

    await router.route(makeMsg());
    expect(handler).toHaveBeenCalledTimes(1);

    router.dispose();
  });

  it('큐 체인: 처리 중 enqueue된 메시지가 순차 처리됨', async () => {
    const calls: string[] = [];
    const onProcess = vi.fn().mockImplementation(async (ctx: MsgContext) => {
      calls.push(ctx.body);
      await new Promise((r) => setTimeout(r, 20));
    });
    const router = new MessageRouter({
      config,
      logger: makeLogger(),
      onProcess,
    });

    const msg1 = makeMsg({ id: 'chain-1', body: 'first' });
    const msg2 = makeMsg({ id: 'chain-2', body: 'second' });

    const p1 = router.route(msg1);
    // msg1 처리 중에 msg2 enqueue
    await new Promise((r) => setTimeout(r, 5));
    const p2 = router.route(msg2);
    await Promise.all([p1, p2]);
    // 큐 체인에 의해 순차 처리 완료 대기
    await new Promise((r) => setTimeout(r, 50));

    expect(calls).toEqual(['first', 'second']);
    router.dispose();
  });

  it('onProcess 에러 시 다음 메시지 계속 처리', async () => {
    let callCount = 0;
    const onProcess = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('processing failed');
      }
    });
    const router = new MessageRouter({
      config,
      logger: makeLogger(),
      onProcess,
    });

    const msg1 = makeMsg({ id: 'err-1', body: 'fail' });
    const msg2 = makeMsg({ id: 'err-2', body: 'ok' });

    await router.route(msg1);
    await router.route(msg2);
    // 에러 후에도 다음 메시지 처리
    await new Promise((r) => setTimeout(r, 50));

    expect(onProcess).toHaveBeenCalledTimes(2);
    router.dispose();
  });

  it('dispose 시 활성 AbortController abort', async () => {
    let capturedSignal: AbortSignal | undefined;
    const onProcess = vi
      .fn()
      .mockImplementation(async (_ctx: MsgContext, _match: BindingMatch, signal: AbortSignal) => {
        capturedSignal = signal;
        // 처리 중 지연
        await new Promise((r) => setTimeout(r, 100));
      });
    const router = new MessageRouter({
      config,
      logger: makeLogger(),
      onProcess,
    });

    const routePromise = router.route(makeMsg());
    // 즉시 dispose → abort
    await new Promise((r) => setTimeout(r, 10));
    router.dispose();

    await routePromise;
    expect(capturedSignal?.aborted).toBe(true);
  });
});
