// packages/web/src/__tests__/app-gateway.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAppGateway, type AppGateway } from '../app-gateway.js';

// --- WebSocket mock ---

type WsListener = (...args: unknown[]) => void;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;

  private listeners = new Map<string, Set<WsListener>>();
  sentMessages: string[] = [];

  constructor(url: string | URL) {
    this.url = typeof url === 'string' ? url : url.toString();
    // auto-open after microtask
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.emit('open', {});
    });
  }

  addEventListener(event: string, handler: WsListener): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)?.add(handler);
  }

  removeEventListener(event: string, handler: WsListener): void {
    this.listeners.get(event)?.delete(handler);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', { code: 1000, reason: 'normal' });
  }

  // Test helper: emit event to listeners
  emit(event: string, data: unknown): void {
    for (const handler of this.listeners.get(event) ?? []) {
      handler(data);
    }
  }
}

let instances: MockWebSocket[] = [];

beforeEach(() => {
  instances = [];
  vi.stubGlobal(
    'WebSocket',
    Object.assign(
      function WebSocket(url: string | URL) {
        const inst = new MockWebSocket(url);
        instances.push(inst);
        return inst;
      } as unknown as typeof globalThis.WebSocket,
      {
        CONNECTING: 0,
        OPEN: 1,
        CLOSING: 2,
        CLOSED: 3,
      },
    ),
  );
});

// Helper to wait for open
function waitForOpen(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}

describe('createAppGateway', () => {
  let gw: AppGateway;

  beforeEach(() => {
    gw = createAppGateway({ reconnect: { initialDelayMs: 50, multiplier: 1, maxDelayMs: 50 } });
  });

  afterEach(() => {
    // Ensure no reconnect timers leak between tests
    gw.disconnect();
  });

  it('should not be connected initially', () => {
    expect(gw.isConnected).toBe(false);
  });

  it('should connect and fire onConnected', async () => {
    const connected = vi.fn();
    gw.onConnected(connected);
    gw.connect('http://localhost:3000', 'test-token');
    await waitForOpen();
    expect(connected).toHaveBeenCalledTimes(1);
    expect(gw.isConnected).toBe(true);
  });

  it('should include token in URL query', async () => {
    gw.connect('http://localhost:3000', 'my-token');
    await waitForOpen();
    expect(instances[0]?.url).toContain('token=my-token');
  });

  it('should convert http to ws protocol', async () => {
    gw.connect('http://localhost:3000', 'tok');
    await waitForOpen();
    expect(instances[0]?.url).toMatch(/^ws:/);
  });

  it('should convert https to wss protocol', async () => {
    gw.connect('https://localhost:3000', 'tok');
    await waitForOpen();
    expect(instances[0]?.url).toMatch(/^wss:/);
  });

  it('should route notifications to handlers', async () => {
    const handler = vi.fn();
    gw.onNotification(handler);
    gw.connect('http://localhost:3000', 'tok');
    await waitForOpen();

    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'chat.stream.delta',
      params: { sessionId: 's1', delta: 'hello' },
    });
    instances[0]?.emit('message', { data: notification });

    expect(handler).toHaveBeenCalledWith('chat.stream.delta', {
      sessionId: 's1',
      delta: 'hello',
    });
  });

  it('should resolve send() with response result', async () => {
    gw.connect('http://localhost:3000', 'tok');
    await waitForOpen();

    const promise = gw.send('test.method', { foo: 'bar' });

    // Parse sent frame to get ID
    const sent = JSON.parse(instances[0]?.sentMessages[0] ?? '{}') as { id: number };
    // Simulate response
    instances[0]?.emit('message', {
      data: JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { ok: true } }),
    });

    const result = await promise;
    expect(result).toEqual({ ok: true });
  });

  it('should reject send() on error response', async () => {
    gw.connect('http://localhost:3000', 'tok');
    await waitForOpen();

    const promise = gw.send('test.method');
    const sent = JSON.parse(instances[0]?.sentMessages[0] ?? '{}') as { id: number };
    instances[0]?.emit('message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: sent.id,
        error: { code: -32600, message: 'Invalid' },
      }),
    });

    await expect(promise).rejects.toThrow('-32600: Invalid');
  });

  it('should throw when sending while disconnected', () => {
    expect(() => gw.send('test')).rejects.toThrow('Not connected');
  });

  it('should fire onDisconnected when connection closes', async () => {
    const disconnected = vi.fn();
    gw.onDisconnected(disconnected);
    gw.connect('http://localhost:3000', 'tok');
    await waitForOpen();

    instances[0]?.close();
    expect(disconnected).toHaveBeenCalled();
  });

  it('should stop reconnecting after disconnect()', async () => {
    gw.connect('http://localhost:3000', 'tok');
    await waitForOpen();
    gw.disconnect();
    expect(gw.isConnected).toBe(false);
    // No new connections should be attempted after intentional disconnect
    await new Promise((r) => setTimeout(r, 100));
    // Only the initial connection should exist — no reconnect attempts
    expect(instances.length).toBe(1);
  });

  // TODO: 연결 끊김 시 pending request reject 테스트 미작성 (MEDIUM)

  it('should remove notification handler with offNotification', async () => {
    const handler = vi.fn();
    gw.onNotification(handler);
    gw.offNotification(handler);
    gw.connect('http://localhost:3000', 'tok');
    await waitForOpen();

    instances[0]?.emit('message', {
      data: JSON.stringify({ jsonrpc: '2.0', method: 'test', params: {} }),
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
