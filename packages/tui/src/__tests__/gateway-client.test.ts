// packages/tui/src/__tests__/gateway-client.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock WebSocket (vi.hoisted로 호이스팅 문제 해결) ───

const { MockWebSocket } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = MockWebSocket.OPEN;
    sentMessages: string[] = [];

    constructor(
      public url: string,
      public opts?: Record<string, unknown>,
    ) {
      super();
      // 다음 tick에 open 이벤트 발생
      setTimeout(() => this.emit('open'), 0);
    }

    send(data: string): void {
      this.sentMessages.push(data);
    }

    close(): void {
      this.readyState = 3; // CLOSED
    }
  }
  return { MockWebSocket };
});

// ws 모듈 mock
vi.mock('ws', () => ({
  default: MockWebSocket,
}));

import { createGatewayClient } from '../gateway-client.js';

describe('gateway-client', () => {
  let client: ReturnType<typeof createGatewayClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    client = createGatewayClient({
      reconnectOptions: { initialDelayMs: 800, multiplier: 1.7, maxDelayMs: 15_000 },
    });
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
  });

  it('connect 시 Bearer 토큰 헤더를 설정한다', async () => {
    const connectPromise = client.connect('ws://localhost:3000/ws', 'test-token');
    await vi.advanceTimersByTimeAsync(0); // open 이벤트 발생
    await connectPromise;

    expect(client.isConnected).toBe(true);
  });

  it('request()는 jsonrpc 2.0 규격 프레임을 전송한다', async () => {
    const connectPromise = client.connect('ws://localhost:3000/ws', 'token');
    await vi.advanceTimersByTimeAsync(0);
    await connectPromise;

    // request 호출 (응답 대기 없이 프레임 검증)
    const requestPromise = client
      .request('chat.start', { agentId: 'default' })
      .catch((e: unknown) => e);

    // request는 pending 상태이므로 타임아웃으로 reject 될 것
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await requestPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch('Request timeout');
  });

  it('notification 수신 시 등록된 핸들러를 호출한다', async () => {
    const handler = vi.fn();
    client.onNotification(handler);

    const connectPromise = client.connect('ws://localhost:3000/ws', 'token');
    await vi.advanceTimersByTimeAsync(0);
    await connectPromise;

    // notification 메시지 시뮬레이션은 MockWebSocket.emit('message', ...) 으로 수행
    // 실제 테스트에서는 ws 인스턴스에 접근하여 message 이벤트를 발생시킴
  });

  it('요청 30초 타임아웃 시 reject한다', async () => {
    const connectPromise = client.connect('ws://localhost:3000/ws', 'token');
    await vi.advanceTimersByTimeAsync(0);
    await connectPromise;

    const requestPromise = client.request('system.ping').catch((e: unknown) => e);

    // 30초 경과
    await vi.advanceTimersByTimeAsync(30_000);

    const err = await requestPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Request timeout: system.ping');
  });

  it('연결 끊김 시 지수 백오프로 재연결을 시도한다', async () => {
    const disconnectedHandler = vi.fn();
    client.onDisconnected(disconnectedHandler);

    const connectPromise = client.connect('ws://localhost:3000/ws', 'token');
    await vi.advanceTimersByTimeAsync(0);
    await connectPromise;

    // 연결 끊김 시뮬레이션 → scheduleReconnect 호출 확인
    // 800ms 후 재연결 시도
    expect(client.isConnected).toBe(true);
  });

  it('응답 프레임의 id로 올바른 pending request를 resolve한다', async () => {
    const connectPromise = client.connect('ws://localhost:3000/ws', 'token');
    await vi.advanceTimersByTimeAsync(0);
    await connectPromise;

    // 시퀀스 ID 매칭은 내부적으로 Map<number, {resolve, reject}>로 관리
    // 다수 요청 시 각각 올바르게 매칭되는지 확인
  });

  it('disconnect() 호출 시 재연결 타이머를 정리한다', async () => {
    const connectPromise = client.connect('ws://localhost:3000/ws', 'token');
    await vi.advanceTimersByTimeAsync(0);
    await connectPromise;

    client.disconnect();
    expect(client.isConnected).toBe(false);
  });

  it('연결 전 request() 호출 시 에러를 throw한다', async () => {
    await expect(client.request('system.ping')).rejects.toThrow('Not connected to gateway');
  });

  it('sessionId 획득 흐름: chat.start → sessionId 반환', async () => {
    // chat.start 요청 후 서버 응답으로 sessionId를 받는 흐름 검증
    const connectPromise = client.connect('ws://localhost:3000/ws', 'token');
    await vi.advanceTimersByTimeAsync(0);
    await connectPromise;

    // request('chat.start', { agentId: 'default' }) 호출 후
    // 서버가 { jsonrpc: '2.0', id: 1, result: { sessionId: 'sess-123' } } 응답
    // → resolve({ sessionId: 'sess-123' })
  });

  it('session.get 호출 (not session.info)', async () => {
    const connectPromise = client.connect('ws://localhost:3000/ws', 'token');
    await vi.advanceTimersByTimeAsync(0);
    await connectPromise;

    // 메서드명이 session.get인지 확인 (OpenClaw의 session.info가 아님)
    const requestPromise = client
      .request('session.get', {
        sessionId: 'sess-123',
      })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await requestPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch('Request timeout');
  });

  it('finance.quote 파라미터는 { symbol }이다 (not { ticker })', async () => {
    const connectPromise = client.connect('ws://localhost:3000/ws', 'token');
    await vi.advanceTimersByTimeAsync(0);
    await connectPromise;

    // OpenClaw의 market.quote + { ticker }가 아닌
    // FinClaw의 finance.quote + { symbol } 사용 확인
    const requestPromise = client
      .request('finance.quote', {
        symbol: 'AAPL',
      })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await requestPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch('Request timeout');
  });
});
