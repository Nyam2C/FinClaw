import type { AgentEvent } from '@finclaw/agent';
// packages/server/src/gateway/broadcaster.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GatewayBroadcaster } from './broadcaster.js';
import type { WsConnection } from './rpc/types.js';

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DONE: AgentEvent = {
  type: 'done',
  runId: 'run-1',
  cliSessionId: 'c',
  text: 'final',
  usage: ZERO,
  durationMs: 100,
  numTurns: 1,
};
const ERROR: AgentEvent = {
  type: 'error',
  runId: 'run-1',
  reason: 'unknown',
  message: 'something broke',
};

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
    auth: { level: 'token' as const },
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

      broadcaster.send(conn, 'sess-1', 'run-1', { type: 'text_delta', text: 'Hello' });
      broadcaster.send(conn, 'sess-1', 'run-1', { type: 'text_delta', text: ' World' });

      // 아직 전송되지 않음
      expect(conn.ws.send).not.toHaveBeenCalled();

      // 150ms 경과
      vi.advanceTimersByTime(150);

      expect(conn.ws.send).toHaveBeenCalledTimes(1);
      const msg = JSON.parse((conn.ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(msg.method).toBe('chat.stream.delta');
      expect(msg.params).toEqual({ sessionId: 'sess-1', runId: 'run-1', delta: 'Hello World' });
    });

    it('flushes remaining delta on done event', () => {
      const conn = createMockConn();

      broadcaster.send(conn, 'sess-1', 'run-1', { type: 'text_delta', text: 'partial' });
      broadcaster.send(conn, 'sess-1', 'run-1', DONE);

      // delta flush + done = 2 messages
      expect(conn.ws.send).toHaveBeenCalledTimes(2);
      const deltaMsg = JSON.parse((conn.ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(deltaMsg.method).toBe('chat.stream.delta');
      expect(deltaMsg.params.delta).toBe('partial');

      const doneMsg = JSON.parse((conn.ws.send as ReturnType<typeof vi.fn>).mock.calls[1][0]);
      expect(doneMsg.method).toBe('chat.stream.end');
      expect(doneMsg.params.runId).toBe('run-1');
      expect(doneMsg.params.result.text).toBe('final');
    });

    it('start 이벤트는 아무것도 보내지 않는다', () => {
      const conn = createMockConn();
      broadcaster.send(conn, 'sess-1', 'run-1', {
        type: 'start',
        runId: 'run-1',
        cliSessionId: 'c',
        model: 'm',
      });
      expect(conn.ws.send).not.toHaveBeenCalled();
    });
  });

  describe('immediate events', () => {
    it('sends error immediately with flush', () => {
      const conn = createMockConn();
      broadcaster.send(conn, 'sess-1', 'run-1', { type: 'text_delta', text: 'buf' });
      broadcaster.send(conn, 'sess-1', 'run-1', ERROR);

      // delta flush + error = 2
      expect(conn.ws.send).toHaveBeenCalledTimes(2);
      const errMsg = JSON.parse((conn.ws.send as ReturnType<typeof vi.fn>).mock.calls[1][0]);
      expect(errMsg.method).toBe('chat.stream.error');
      expect(errMsg.params.error).toBe('something broke');
      expect(errMsg.params.reason).toBe('unknown');
    });
  });

  describe('slow consumer protection', () => {
    it('skips send when bufferedAmount > 1MB', () => {
      const conn = createMockConn();
      Object.defineProperty(conn.ws, 'bufferedAmount', { value: 2 * 1024 * 1024 });

      broadcaster.send(conn, 'sess-1', 'run-1', ERROR);

      expect(conn.ws.send).not.toHaveBeenCalled();
    });

    it('skips send when connection is not OPEN', () => {
      const conn = createMockConn();
      Object.defineProperty(conn.ws, 'readyState', { value: 3 }); // CLOSED

      broadcaster.send(conn, 'sess-1', 'run-1', ERROR);

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

    it('버퍼 1MB 초과 연결은 건너뛴다', () => {
      const connections = new Map<string, WsConnection>();
      const c1 = createMockConn('c1');
      c1.subscriptions.add('portfolio.changed');
      Object.defineProperty(c1.ws, 'bufferedAmount', { value: 2 * 1024 * 1024 });
      connections.set('c1', c1);

      const sent = broadcaster.broadcastToChannel(connections, 'portfolio.changed', {});
      expect(sent).toBe(0);
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
  describe('tool events (M6)', () => {
    it('tool_use → start, tool_result → end (같은 toolCallId·name, isError)', () => {
      const conn = createMockConn();
      broadcaster.send(conn, 'sess-1', 'run-1', { type: 'text_delta', text: '확인해 볼게요' });
      broadcaster.send(conn, 'sess-1', 'run-1', {
        type: 'tool_use',
        id: 't1',
        name: 'mcp__finclaw__route_task',
        input: { intent: 'price_lookup' },
      });
      broadcaster.send(conn, 'sess-1', 'run-1', { type: 'tool_result', id: 't1', isError: true });
      const msgs = (conn.ws.send as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
        JSON.parse(c[0] as string),
      );
      expect(msgs.map((m) => m.method)).toEqual([
        'chat.stream.delta',
        'chat.stream.tool',
        'chat.stream.tool',
      ]);
      expect(msgs[1].params).toEqual({
        sessionId: 'sess-1',
        runId: 'run-1',
        toolCallId: 't1',
        name: 'mcp__finclaw__route_task',
        phase: 'start',
      });
      expect(msgs[2].params).toEqual({
        sessionId: 'sess-1',
        runId: 'run-1',
        toolCallId: 't1',
        name: 'mcp__finclaw__route_task',
        phase: 'end',
        isError: true,
      });
      expect(JSON.stringify(msgs)).not.toContain('price_lookup'); // 입력 내용 미포함 (S14)
    });
  });
});
