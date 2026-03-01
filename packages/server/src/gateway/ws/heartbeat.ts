// packages/server/src/gateway/ws/heartbeat.ts
import type { WebSocketServer, WebSocket } from 'ws';
import type { GatewayServerConfig } from '../rpc/types.js';

type WsConfig = GatewayServerConfig['ws'];

/**
 * WebSocket 하트비트 시작
 *
 * heartbeatIntervalMs 간격으로 모든 연결에 ping 전송.
 * heartbeatTimeoutMs 이내에 pong이 없으면 연결 종료.
 *
 * @returns clearInterval에 사용할 interval ID
 */
export function startHeartbeat(
  wss: WebSocketServer,
  config: WsConfig,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    for (const ws of wss.clients) {
      const socket = ws as WebSocket & { isAlive?: boolean };

      if (socket.isAlive === false) {
        // 이전 ping에 대한 pong이 없음 → 연결 종료
        socket.terminate();
        continue;
      }

      socket.isAlive = false;
      socket.ping();
    }
  }, config.heartbeatIntervalMs);
}

/**
 * 개별 연결에 pong 핸들러 등록
 * (ws/connection.ts에서 호출)
 */
export function attachPongHandler(ws: WebSocket & { isAlive?: boolean }): void {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
}
