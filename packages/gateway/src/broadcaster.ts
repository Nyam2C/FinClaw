// packages/server/src/gateway/broadcaster.ts
import type { AgentEvent } from '@finclaw/agent';
import type {
  ChatStreamDeltaParams,
  ChatStreamEndParams,
  ChatStreamErrorParams,
  ChatStreamToolParams,
} from '@finclaw/types';
import type { WsConnection, JsonRpcNotification } from './rpc/types.js';

/**
 * GatewayBroadcaster — AgentEvent → WebSocket 알림 변환
 *
 * | AgentEvent.type | WS method         | 전송 정책                      |
 * |-----------------|-------------------|--------------------------------|
 * | text_delta      | chat.stream.delta | 150ms 배치                     |
 * | done            | chat.stream.end   | 즉시 (남은 delta flush 후)     |
 * | error           | chat.stream.error | 즉시 (남은 delta flush 후)     |
 * | tool_use/result | chat.stream.tool  | 즉시 (남은 delta flush 후)     |
 * | start           | (전송 안 함)      |                                |
 */
export class GatewayBroadcaster {
  private readonly deltaBuffers = new Map<
    string,
    { runId: string; text: string; timer: ReturnType<typeof setTimeout> }
  >();
  private static readonly BATCH_INTERVAL_MS = 150;
  // ponytail: tool_result 가 오지 않은 채 끝난 run(abort) 의 항목은 남는다 — 엔트리당 수십 바이트, 프로세스 수명 동안 무시 가능.
  private readonly toolNames = new Map<string, string>();

  /** slow consumer 임계값 (bytes) */
  private static readonly MAX_BUFFER = 1024 * 1024;

  /** AgentEvent 를 연결에 전송 (모든 chat.stream.* 에 runId). */
  send(conn: WsConnection, sessionId: string, runId: string, event: AgentEvent): void {
    switch (event.type) {
      case 'text_delta':
        this.bufferDelta(conn, sessionId, runId, event.text);
        break;
      case 'done':
        this.flushDelta(conn.id, sessionId, conn);
        this.sendImmediate(conn, 'chat.stream.end', {
          sessionId,
          runId,
          result: { text: event.text, usage: event.usage },
        } satisfies ChatStreamEndParams);
        break;
      case 'error':
        this.flushDelta(conn.id, sessionId, conn);
        this.sendImmediate(conn, 'chat.stream.error', {
          sessionId,
          runId,
          error: event.message,
          reason: event.reason,
        } satisfies ChatStreamErrorParams);
        break;
      case 'tool_use':
        this.flushDelta(conn.id, sessionId, conn); // 순서 보존: 앞선 서술 delta 를 먼저
        this.toolNames.set(event.id, event.name);
        this.sendImmediate(conn, 'chat.stream.tool', {
          sessionId,
          runId,
          toolCallId: event.id,
          name: event.name,
          phase: 'start',
        } satisfies ChatStreamToolParams);
        break;
      case 'tool_result':
        this.flushDelta(conn.id, sessionId, conn);
        this.sendImmediate(conn, 'chat.stream.tool', {
          sessionId,
          runId,
          toolCallId: event.id,
          name: this.toolNames.get(event.id) ?? '',
          phase: 'end',
          isError: event.isError,
        } satisfies ChatStreamToolParams);
        this.toolNames.delete(event.id);
        break;
      default:
        break; // start 는 WS 로 보내지 않음 (plan §3-7)
    }
  }

  /** text_delta 150ms 배치 */
  private bufferDelta(conn: WsConnection, sessionId: string, runId: string, delta: string): void {
    const key = `${conn.id}:${sessionId}`;
    const existing = this.deltaBuffers.get(key);
    if (existing) {
      existing.text += delta;
      return;
    }

    this.deltaBuffers.set(key, {
      runId,
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
    // slow consumer 보호: delta 만 버린다 — end.result.text 가 화면을 확정하므로 유실돼도 복구된다
    if (buf.text.length > 0 && conn.ws.bufferedAmount <= GatewayBroadcaster.MAX_BUFFER) {
      this.sendImmediate(conn, 'chat.stream.delta', {
        sessionId,
        runId: buf.runId,
        delta: buf.text,
      } satisfies ChatStreamDeltaParams);
    }
  }

  /** 즉시 전송 (end/error/tool 은 임계와 무관하게 — 종료 신호 유실 시 클라이언트가 영구 대기) */
  private sendImmediate(conn: WsConnection, method: string, params: Record<string, unknown>): void {
    if (conn.ws.readyState !== conn.ws.OPEN) {
      return;
    }

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    conn.ws.send(JSON.stringify(notification));
  }

  /**
   * 특정 채널 구독자에게 JSON-RPC notification을 팬아웃한다.
   * @returns 전송 성공 수
   */
  broadcastToChannel(
    connections: Map<string, WsConnection>,
    channel: string,
    data: unknown,
  ): number {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method: `notification.${channel}`,
      params: { data, timestamp: Date.now() },
    } satisfies JsonRpcNotification);

    let sent = 0;

    for (const conn of connections.values()) {
      if (!conn.subscriptions.has(channel)) {
        continue;
      }
      if (conn.ws.readyState !== conn.ws.OPEN) {
        continue;
      }
      if (conn.ws.bufferedAmount > GatewayBroadcaster.MAX_BUFFER) {
        continue;
      }

      conn.ws.send(payload);
      sent++;
    }
    return sent;
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
