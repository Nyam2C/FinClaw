import { describe, it, expect, vi } from 'vitest';
import { ackStage, createTypingController } from '../stages/ack.js';

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
  it('타이핑을 시작하고 continue 한다', () => {
    const channel = { sendTyping: vi.fn() };

    const result = ackStage(channel, 'ch1', 'chat1');

    expect(result.action).toBe('continue');
    if (result.action === 'continue') {
      expect(result.data.typing.state).toBe('active');
      result.data.typing.seal();
    }
  });
});
