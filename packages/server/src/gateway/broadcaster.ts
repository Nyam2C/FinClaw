// packages/server/src/gateway/broadcaster.ts
import type { WsConnection, JsonRpcNotification } from './rpc/types.js';

/**
 * GatewayBroadcaster (스텁)
 * Part 3에서 150ms delta 배치, slow consumer 보호 포함하여 완성.
 */
export class GatewayBroadcaster {
  send(_conn: WsConnection, _sessionId: string, _event: unknown): void {
    // Part 3에서 StreamEvent 기반 구현
  }

  broadcastShutdown(connections: Map<string, WsConnection>): void {
    for (const conn of connections.values()) {
      if (conn.ws.readyState === conn.ws.OPEN) {
        const notification: JsonRpcNotification = {
          jsonrpc: '2.0',
          method: 'system.shutdown',
          params: { reason: 'Server shutting down' },
        };
        conn.ws.send(JSON.stringify(notification));
      }
    }
  }
}
