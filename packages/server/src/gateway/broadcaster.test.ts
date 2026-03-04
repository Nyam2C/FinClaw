import type { StreamEvent } from '@finclaw/agent';
// packages/server/src/gateway/broadcaster.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WsConnection } from './rpc/types.js';
import { GatewayBroadcaster } from './broadcaster.js';

function createMockConn(id: string = 'conn-1'): WsConnection {
  const sent: string[] = [];
  return {
    id,
    ws: {
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 0,
      send: vi.fn((data: string) => sent.push(data)),
    } as unknown as WsConnection['ws'],
    auth: { level: 'token' as const, permissions: [] },
    connectedAt: Date.now(),
    lastPongAt: Date.now(),
    subscriptions: new Set(),
    // 테스트 헬퍼
    get sentMessages() {
      return sent;
    },
  } as WsConnection & { sentMessages: string[] };
}

describe('GatewayBroadcaster', () => {
  let broadcaster: GatewayBroadcaster;

  beforeEach(() => {
    broadcaster = new GatewayBroadcaster();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('text_delta batching (150ms)', () => {
    it('batches multiple deltas within 150ms window', async () => {
      vi.useFakeTimers();
      const conn = createMockConn();

      broadcaster.send(conn, 'sess-1', { type: 'text_delta', delta: 'Hello' });
      broadcaster.send(conn, 'sess-1', { type: 'text_delta', delta: ' World' });

      // 아직 전송되지 않음
      expect(conn.ws.send).not.toHaveBeenCalled();

      // 150ms 경과
      vi.advanceTimersByTime(150);

      expect(conn.ws.send).toHaveBeenCalledTimes(1);
      const msg = JSON.parse((conn.ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(msg.method).toBe('chat.stream.delta');
      expect(msg.params.delta).toBe('Hello World');
    });

    it('flushes remaining delta on done event', () => {
      const conn = createMockConn();

      broadcaster.send(conn, 'sess-1', { type: 'text_delta', delta: 'partial' });
      broadcaster.send(conn, 'sess-1', {
        type: 'done',
        result: {
          status: 'completed',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          turns: 1,
          durationMs: 100,
        },
      } as StreamEvent);

      // delta flush + done = 2 messages
      expect(conn.ws.send).toHaveBeenCalledTimes(2);
      const deltaMsg = JSON.parse((conn.ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(deltaMsg.method).toBe('chat.stream.delta');
      expect(deltaMsg.params.delta).toBe('partial');

      const doneMsg = JSON.parse((conn.ws.send as ReturnType<typeof vi.fn>).mock.calls[1][0]);
      expect(doneMsg.method).toBe('chat.stream.end');
    });
  });

  describe('immediate events', () => {
    it('sends tool_use_start immediately', () => {
      const conn = createMockConn();
      broadcaster.send(conn, 'sess-1', {
        type: 'tool_use_start',
        toolCall: { id: 'tc-1', name: 'search', input: {} },
      } as StreamEvent);

      expect(conn.ws.send).toHaveBeenCalledTimes(1);
      const msg = JSON.parse((conn.ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(msg.method).toBe('chat.stream.tool_start');
    });

    it('sends tool_use_end immediately', () => {
      const conn = createMockConn();
      broadcaster.send(conn, 'sess-1', {
        type: 'tool_use_end',
        result: { toolUseId: 'tc-1', content: 'result', isError: false },
      } as StreamEvent);

      expect(conn.ws.send).toHaveBeenCalledTimes(1);
      const msg = JSON.parse((conn.ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(msg.method).toBe('chat.stream.tool_end');
    });

    it('sends error immediately with flush', () => {
      const conn = createMockConn();
      broadcaster.send(conn, 'sess-1', { type: 'text_delta', delta: 'buf' });
      broadcaster.send(conn, 'sess-1', {
        type: 'error',
        error: new Error('something broke'),
      } as StreamEvent);

      // delta flush + error = 2
      expect(conn.ws.send).toHaveBeenCalledTimes(2);
      const errMsg = JSON.parse((conn.ws.send as ReturnType<typeof vi.fn>).mock.calls[1][0]);
      expect(errMsg.method).toBe('chat.stream.error');
      expect(errMsg.params.error).toBe('something broke');
    });
  });

  describe('ignored events', () => {
    it('ignores state_change events', () => {
      const conn = createMockConn();
      broadcaster.send(conn, 'sess-1', {
        type: 'state_change',
        from: 'idle',
        to: 'streaming',
      } as StreamEvent);
      expect(conn.ws.send).not.toHaveBeenCalled();
    });

    it('ignores usage_update events', () => {
      const conn = createMockConn();
      broadcaster.send(conn, 'sess-1', {
        type: 'usage_update',
        usage: { inputTokens: 10, outputTokens: 5 },
      } as StreamEvent);
      expect(conn.ws.send).not.toHaveBeenCalled();
    });
  });

  describe('slow consumer protection', () => {
    it('skips send when bufferedAmount > 1MB', () => {
      const conn = createMockConn();
      Object.defineProperty(conn.ws, 'bufferedAmount', { value: 2 * 1024 * 1024 });

      broadcaster.send(conn, 'sess-1', {
        type: 'tool_use_start',
        toolCall: { id: 'tc-1', name: 'x', input: {} },
      } as StreamEvent);

      expect(conn.ws.send).not.toHaveBeenCalled();
    });

    it('skips send when connection is not OPEN', () => {
      const conn = createMockConn();
      Object.defineProperty(conn.ws, 'readyState', { value: 3 }); // CLOSED

      broadcaster.send(conn, 'sess-1', {
        type: 'tool_use_start',
        toolCall: { id: 'tc-1', name: 'x', input: {} },
      } as StreamEvent);

      expect(conn.ws.send).not.toHaveBeenCalled();
    });
  });

  describe('broadcastToChannel', () => {
    it('구독자에게만 전송', () => {
      const connections = new Map<string, WsConnection>();
      const c1 = createMockConn('c1');
      c1.subscriptions.add('config.updated');
      const c2 = createMockConn('c2');
      connections.set('c1', c1);
      connections.set('c2', c2);

      const sent = broadcaster.broadcastToChannel(connections, 'config.updated', { key: 'value' });

      expect(sent).toBe(1);
      expect(c1.ws.send).toHaveBeenCalledTimes(1);
      expect(c2.ws.send).not.toHaveBeenCalled();

      const payload = JSON.parse((c1.ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(payload.method).toBe('notification.config.updated');
      expect(payload.params.data).toEqual({ key: 'value' });
    });

    it('OPEN 아닌 연결 skip', () => {
      const connections = new Map<string, WsConnection>();
      const c1 = createMockConn('c1');
      c1.subscriptions.add('config.updated');
      Object.defineProperty(c1.ws, 'readyState', { value: 3 });
      connections.set('c1', c1);

      const sent = broadcaster.broadcastToChannel(connections, 'config.updated', {});
      expect(sent).toBe(0);
    });

    it('market.tick 채널은 256KB 임계값 적용', () => {
      const connections = new Map<string, WsConnection>();
      const c1 = createMockConn('c1');
      c1.subscriptions.add('market.tick');
      Object.defineProperty(c1.ws, 'bufferedAmount', { value: 300 * 1024 });
      connections.set('c1', c1);

      const sent = broadcaster.broadcastToChannel(connections, 'market.tick', {});
      expect(sent).toBe(0);
    });
  });

  describe('subscribe / unsubscribe', () => {
    it('구독 추가 성공', () => {
      const connections = new Map<string, WsConnection>();
      connections.set('c1', createMockConn('c1'));

      expect(broadcaster.subscribe('c1', 'config.updated', connections)).toBe(true);
      expect(connections.get('c1')?.subscriptions.has('config.updated')).toBe(true);
    });

    it('존재하지 않는 연결 → false', () => {
      const connections = new Map<string, WsConnection>();

      expect(broadcaster.subscribe('nope', 'config.updated', connections)).toBe(false);
    });

    it('구독 해제 성공', () => {
      const connections = new Map<string, WsConnection>();
      const c1 = createMockConn('c1');
      c1.subscriptions.add('config.updated');
      connections.set('c1', c1);

      expect(broadcaster.unsubscribe('c1', 'config.updated', connections)).toBe(true);
      expect(connections.get('c1')?.subscriptions.has('config.updated')).toBe(false);
    });
  });

  describe('broadcastShutdown', () => {
    it('sends system.shutdown to all open connections', () => {
      const connections = new Map<string, WsConnection>();
      const c1 = createMockConn('c1');
      const c2 = createMockConn('c2');
      connections.set('c1', c1);
      connections.set('c2', c2);

      broadcaster.broadcastShutdown(connections);

      expect(c1.ws.send).toHaveBeenCalledTimes(1);
      expect(c2.ws.send).toHaveBeenCalledTimes(1);
      const msg = JSON.parse((c1.ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(msg.method).toBe('system.shutdown');
    });
  });
});
