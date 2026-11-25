import type { FinClawLogger } from '@finclaw/infra';
import { describe, it, expect, vi } from 'vitest';
import {
  formatAlertMessage,
  createDiscordDeliveryHandler,
  createLogDeliveryHandler,
  createDeliveryDispatcher,
  createWebSocketDeliveryHandler,
} from '../delivery.js';
import type { AlertDefinition, ConditionEvaluation } from '../types.js';

function mockAlert(overrides?: Partial<AlertDefinition>): AlertDefinition {
  return {
    id: 'alert-1',
    userId: 'user-1',
    name: 'AAPL 가격 알림',
    condition: { type: 'price', ticker: 'AAPL', direction: 'above', threshold: 200 },
    channels: ['log'],
    cooldownMs: 900_000,
    enabled: true,
    triggerCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

const mockEvaluation: ConditionEvaluation = {
  triggered: true,
  currentValue: '210',
  message: 'AAPL 현재가 210이(가) 목표가 200 이상 조건을 충족했습니다.',
};

function mockLogger(): FinClawLogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    flush: vi.fn(),
  } as unknown as FinClawLogger;
}

describe('formatAlertMessage', () => {
  it('이름, 메시지, 현재값 포함', () => {
    const msg = formatAlertMessage(mockAlert(), mockEvaluation);
    expect(msg).toContain('AAPL 가격 알림');
    expect(msg).toContain(mockEvaluation.message);
    expect(msg).toContain('210');
  });
});

describe('DiscordDeliveryHandler', () => {
  it('user.createDM() → send() 호출', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const createDM = vi.fn().mockResolvedValue({ send });
    const fetch = vi.fn().mockResolvedValue({ createDM });
    const handler = createDiscordDeliveryHandler({ client: { users: { fetch } } });

    await handler.deliver(mockAlert(), mockEvaluation);
    expect(fetch).toHaveBeenCalledWith('user-1');
    expect(createDM).toHaveBeenCalled();
    expect(send).toHaveBeenCalled();
  });
});

describe('LogDeliveryHandler', () => {
  it('logger.info(ALERT TRIGGERED, ...) 호출', async () => {
    const logger = mockLogger();
    const handler = createLogDeliveryHandler({ logger });

    await handler.deliver(mockAlert(), mockEvaluation);
    expect(logger.info).toHaveBeenCalledWith(
      'ALERT TRIGGERED',
      expect.objectContaining({
        alertId: 'alert-1',
        name: 'AAPL 가격 알림',
      }),
    );
  });
});

describe('DeliveryDispatcher', () => {
  it('전체 성공', async () => {
    const logger = mockLogger();
    const handler = { channel: 'log' as const, deliver: vi.fn().mockResolvedValue(undefined) };
    const dispatcher = createDeliveryDispatcher({ handlers: [handler], logger });

    const results = await dispatcher.dispatch(mockAlert({ channels: ['log'] }), mockEvaluation);
    expect(results).toHaveLength(1);
    expect(results[0]?.success).toBe(true);
    expect(results[0]?.channel).toBe('log');
  });

  it('부분 실패 격리', async () => {
    const logger = mockLogger();
    const failHandler = {
      channel: 'discord' as const,
      deliver: vi.fn().mockRejectedValue(new Error('fail')),
    };
    const okHandler = { channel: 'log' as const, deliver: vi.fn().mockResolvedValue(undefined) };
    const dispatcher = createDeliveryDispatcher({ handlers: [failHandler, okHandler], logger });

    const results = await dispatcher.dispatch(
      mockAlert({ channels: ['discord', 'log'] }),
      mockEvaluation,
    );
    expect(results).toHaveLength(2);
    expect(results[0]?.success).toBe(false);
    expect(results[0]?.error).toContain('fail');
    expect(results[1]?.success).toBe(true);
  });
});

describe('WebSocketDeliveryHandler (phase47)', () => {
  it('바인딩된 broadcast 에 AlertTriggeredData shape 로 호출 (userId·type 없음)', async () => {
    const broadcast = vi.fn().mockReturnValue(1);
    const handler = createWebSocketDeliveryHandler({ getBroadcast: () => broadcast });
    await handler.deliver(mockAlert(), mockEvaluation);
    expect(handler.channel).toBe('websocket');
    expect(broadcast).toHaveBeenCalledWith({
      alertId: 'alert-1',
      name: 'AAPL 가격 알림',
      message: mockEvaluation.message,
      currentValue: '210',
      triggeredAt: expect.any(Number),
    });
  });

  it('받은 연결 0 → reject', async () => {
    const handler = createWebSocketDeliveryHandler({ getBroadcast: () => () => 0 });
    await expect(handler.deliver(mockAlert(), mockEvaluation)).rejects.toThrow(
      'no websocket subscribers',
    );
  });

  it('바인딩 전 → reject', async () => {
    const handler = createWebSocketDeliveryHandler({ getBroadcast: () => undefined });
    await expect(handler.deliver(mockAlert(), mockEvaluation)).rejects.toThrow(
      'websocket broadcast not bound',
    );
  });

  it('dispatcher 결과에 websocket 실패가 success:false 로 남는다 (log 는 성공)', async () => {
    const dispatcher = createDeliveryDispatcher({
      handlers: [
        createLogDeliveryHandler({ logger: mockLogger() }),
        createWebSocketDeliveryHandler({ getBroadcast: () => undefined }),
      ],
      logger: mockLogger(),
    });
    const results = await dispatcher.dispatch(
      mockAlert({ channels: ['log', 'websocket'] }),
      mockEvaluation,
    );
    expect(results.map((r) => [r.channel, r.success])).toEqual([
      ['log', true],
      ['websocket', false],
    ]);
    expect(results[1]?.error).toContain('websocket broadcast not bound');
  });
});
