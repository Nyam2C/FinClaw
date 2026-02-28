import type { FinClawLogger } from '@finclaw/infra';
import { describe, it, expect, vi } from 'vitest';
import { ackStage, createTypingController } from '../stages/ack.js';

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

describe('createTypingController', () => {
  it('idle → active → sealed 상태 전이', () => {
    const channel = { sendTyping: vi.fn() };
    const controller = createTypingController(channel, 'ch1', 'chat1');

    expect(controller.state).toBe('idle');

    controller.start();
    expect(controller.state).toBe('active');

    controller.seal();
    expect(controller.state).toBe('sealed');
  });

  it('sealed 상태에서 start()는 무시된다', () => {
    const channel = { sendTyping: vi.fn() };
    const controller = createTypingController(channel, 'ch1', 'chat1');

    controller.start();
    controller.seal();
    controller.start(); // sealed 상태에서 재시작 시도

    expect(controller.state).toBe('sealed');
  });

  it('이미 active인 상태에서 start()는 무시된다', () => {
    const channel = { sendTyping: vi.fn() };
    const controller = createTypingController(channel, 'ch1', 'chat1');

    controller.start();
    controller.start(); // 중복 시작

    expect(controller.state).toBe('active');
  });

  it('TTL 보호로 자동 seal된다', () => {
    vi.useFakeTimers();
    const channel = { sendTyping: vi.fn() };
    const controller = createTypingController(channel, 'ch1', 'chat1', { ttlMs: 100 });

    controller.start();
    expect(controller.state).toBe('active');

    vi.advanceTimersByTime(150);
    expect(controller.state).toBe('sealed');
  });
});

describe('ackStage', () => {
  it('ACK 활성화 시 addReaction을 호출한다', async () => {
    const channel = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn(),
    };
    const logger = makeLogger();

    const result = await ackStage(channel, 'msg1', 'ch1', 'chat1', true, logger);

    expect(channel.addReaction).toHaveBeenCalledWith('msg1', '👀');
    expect(result.action).toBe('continue');
    if (result.action !== 'continue') {
      return;
    }
    expect(result.data.typing.state).toBe('active');
  });

  it('ACK 비활성화 시 addReaction을 호출하지 않는다', async () => {
    const channel = {
      addReaction: vi.fn(),
      sendTyping: vi.fn(),
    };
    const logger = makeLogger();

    await ackStage(channel, 'msg1', 'ch1', 'chat1', false, logger);

    expect(channel.addReaction).not.toHaveBeenCalled();
  });

  it('addReaction 실패 시 warn 로깅 후 계속 진행한다', async () => {
    const channel = {
      addReaction: vi.fn().mockRejectedValue(new Error('reaction failed')),
      sendTyping: vi.fn(),
    };
    const logger = makeLogger();

    const result = await ackStage(channel, 'msg1', 'ch1', 'chat1', true, logger);

    expect(logger.warn).toHaveBeenCalled();
    expect(result.action).toBe('continue');
  });
});
