import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { getEventBus } from '@finclaw/infra';
// packages/server/src/gateway/ws/connection.ts
import { randomUUID } from 'node:crypto';
import type { GatewayServerContext } from '../context.js';
import type { WsConnection } from '../rpc/types.js';
import { authenticate } from '../auth/index.js';
import { dispatchRpc } from '../rpc/index.js';
import { attachPongHandler } from './heartbeat.js';

/**
 * 새 WebSocket 연결 처리
 *
 * 1. 핸드셰이크 타임아웃 설정 (DoS 방어)
 * 2. 인증 수행
 * 3. WsConnection 생성 + ctx.connections 등록
 * 4. 메시지 → RPC 디스패치
 * 5. pong 핸들러 등록
 * 6. close 시 정리
 */
export async function handleWsConnection(
  ws: WebSocket,
  req: IncomingMessage,
  ctx: GatewayServerContext,
): Promise<void> {
  // 핸드셰이크 타임아웃
  const handshakeTimer = setTimeout(() => {
    ws.close(4008, 'Authentication timeout');
  }, ctx.config.ws.handshakeTimeoutMs);

  // 인증
  const authResult = await authenticate(req, ctx.config.auth);
  clearTimeout(handshakeTimer);

  if (!authResult.ok) {
    ws.close(4001, authResult.error);
    return;
  }

  const conn: WsConnection = {
    id: randomUUID(),
    ws,
    auth: authResult.info,
    connectedAt: Date.now(),
    lastPongAt: Date.now(),
    subscriptions: new Set(),
  };

  // DI 컨테이너에 등록
  ctx.connections.set(conn.id, conn);
  getEventBus().emit('gateway:ws:connect', conn.id, conn.auth.level);

  // pong 핸들러
  attachPongHandler(ws as WebSocket & { isAlive?: boolean });

  // 메시지 수신 → RPC 디스패치
  ws.on('message', async (data: Buffer) => {
    try {
      const request = JSON.parse(data.toString('utf8'));
      const response = await dispatchRpc(
        request,
        {
          auth: conn.auth,
          connectionId: conn.id,
          remoteAddress: req.socket.remoteAddress ?? 'unknown',
        },
        ctx,
      );
      ws.send(JSON.stringify(response));
    } catch {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }),
      );
    }
  });

  // pong 시간 기록
  ws.on('pong', () => {
    conn.lastPongAt = Date.now();
  });

  // 연결 종료 시 정리
  ws.on('close', (code: number) => {
    ctx.connections.delete(conn.id);
    getEventBus().emit('gateway:ws:disconnect', conn.id, code);
  });
}

/** 특정 연결에 알림 전송 */
export function sendNotification(
  ctx: GatewayServerContext,
  connectionId: string,
  method: string,
  params: Record<string, unknown>,
): void {
  const conn = ctx.connections.get(connectionId);
  if (conn && conn.ws.readyState === conn.ws.OPEN) {
    conn.ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
      }),
    );
  }
}
