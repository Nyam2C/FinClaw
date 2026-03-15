import type { FinClawLogger } from '@finclaw/infra';
import { describe, it, expect, vi } from 'vitest';
import type { AlertDefinition, ConditionEvaluation } from '../types.js';
import {
  formatAlertMessage,
  createDiscordDeliveryHandler,
  createWebSocketDeliveryHandler,
  createLogDeliveryHandler,
  createDeliveryDispatcher,
} from '../delivery.js';

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

describe('WebSocketDeliveryHandler', () => {
  it('broadcastToChannel 호출, userId 포함', async () => {
    const broadcastToChannel = vi.fn().mockReturnValue(1);
    const connections = new Map();
    const handler = createWebSocketDeliveryHandler({
      broadcaster: { broadcastToChannel },
      connections,
    });

    await handler.deliver(mockAlert(), mockEvaluation);
    expect(broadcastToChannel).toHaveBeenCalledWith(
      connections,
      'alerts',
      expect.objectContaining({
        type: 'alert.triggered',
        userId: 'user-1',
        alertId: 'alert-1',
      }),
    );
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
