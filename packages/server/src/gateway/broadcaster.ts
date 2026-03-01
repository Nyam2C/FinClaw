// packages/server/src/gateway/broadcaster.ts
import type { StreamEvent } from '@finclaw/agent';
import type { WsConnection, JsonRpcNotification } from './rpc/types.js';

/**
 * GatewayBroadcaster — LLM 스트리밍 → WebSocket 알림 변환
 *
 * 스트리밍 알림 프로토콜:
 * | StreamEvent.type   | WS method                | 전송 정책   |
 * |--------------------|--------------------------|-------------|
 * | text_delta         | chat.stream.delta        | 150ms 배치  |
 * | tool_use_start     | chat.stream.tool_start   | 즉시        |
 * | tool_use_end       | chat.stream.tool_end     | 즉시        |
 * | done               | chat.stream.end          | 즉시        |
 * | error              | chat.stream.error        | 즉시        |
 *
 * 미매핑: state_change, message_complete, usage_update — 내부 FSM/집계용
 */
export class GatewayBroadcaster {
  private readonly deltaBuffers = new Map<
    string,
    { text: string; timer: ReturnType<typeof setTimeout> }
  >();
  private static readonly BATCH_INTERVAL_MS = 150;

  /** StreamEvent를 연결에 전송 */
  send(conn: WsConnection, sessionId: string, event: StreamEvent): void {
    switch (event.type) {
      case 'text_delta':
        this.bufferDelta(conn, sessionId, event.delta);
        break;
      case 'tool_use_start':
        this.sendImmediate(conn, 'chat.stream.tool_start', {
          sessionId,
          toolCall: event.toolCall,
        });
        break;
      case 'tool_use_end':
        this.sendImmediate(conn, 'chat.stream.tool_end', {
          sessionId,
          result: event.result,
        });
        break;
      case 'done':
        this.flushDelta(conn.id, sessionId, conn);
        this.sendImmediate(conn, 'chat.stream.end', {
          sessionId,
          result: event.result,
        });
        break;
      case 'error':
        this.flushDelta(conn.id, sessionId, conn);
        this.sendImmediate(conn, 'chat.stream.error', {
          sessionId,
          error: event.error.message,
        });
        break;
      // state_change, message_complete, usage_update → 무시
    }
  }

  /** text_delta 150ms 배치 */
  private bufferDelta(conn: WsConnection, sessionId: string, delta: string): void {
    const key = `${conn.id}:${sessionId}`;
    const existing = this.deltaBuffers.get(key);
    if (existing) {
      existing.text += delta;
      return;
    }

    this.deltaBuffers.set(key, {
      text: delta,
      timer: setTimeout(
        () => this.flushDelta(conn.id, sessionId, conn),
        GatewayBroadcaster.BATCH_INTERVAL_MS,
      ),
    });
  }

  private flushDelta(connId: string, sessionId: string, conn: WsConnection): void {
    const key = `${connId}:${sessionId}`;
    const buf = this.deltaBuffers.get(key);
    if (!buf) {
      return;
    }
    clearTimeout(buf.timer);
    this.deltaBuffers.delete(key);
    if (buf.text.length > 0) {
      this.sendImmediate(conn, 'chat.stream.delta', { sessionId, delta: buf.text });
    }
  }

  /** 즉시 전송 (slow consumer 보호: 1MB 이상 버퍼링 시 skip) */
  private sendImmediate(conn: WsConnection, method: string, params: Record<string, unknown>): void {
    if (conn.ws.readyState !== conn.ws.OPEN) {
      return;
    }
    if (conn.ws.bufferedAmount > 1024 * 1024) {
      return;
    }

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    conn.ws.send(JSON.stringify(notification));
  }

  /** 종료 알림 broadcast */
  broadcastShutdown(connections: Map<string, WsConnection>): void {
    for (const conn of connections.values()) {
      this.sendImmediate(conn, 'system.shutdown', { reason: 'Server shutting down' });
    }
  }

  /** 모든 delta 버퍼 flush (shutdown 시) */
  flushAll(): void {
    for (const [_key, buf] of this.deltaBuffers) {
      clearTimeout(buf.timer);
    }
    this.deltaBuffers.clear();
  }
}
