// packages/tui/src/gateway-client.ts

import type { RpcRequest } from '@finclaw/types';
import WebSocket from 'ws';

export interface ReconnectOptions {
  readonly initialDelayMs: number; // 800
  readonly multiplier: number; // 1.7
  readonly maxDelayMs: number; // 15_000
}

export interface GatewayClient {
  connect(url: string, token: string): Promise<void>;
  disconnect(): void;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void;
  onConnected(handler: () => void): void;
  onDisconnected(handler: (reason: string) => void): void;
  readonly isConnected: boolean;
}

export function createGatewayClient(options: {
  reconnectOptions: ReconnectOptions;
}): GatewayClient {
  let ws: WebSocket | null = null;
  let sequenceId = 0;
  let backoffMs = options.reconnectOptions.initialDelayMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // 콜백 레지스트리
  const pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  const notificationHandlers: Array<(method: string, params: Record<string, unknown>) => void> = [];
  const connectedHandlers: Array<() => void> = [];
  const disconnectedHandlers: Array<(reason: string) => void> = [];

  let url = '';
  let token = '';

  function handleMessage(data: string): void {
    const frame = JSON.parse(data);

    // 응답 프레임: id가 있고 pending request에 매칭
    if ('id' in frame && pendingRequests.has(frame.id)) {
      const pending = pendingRequests.get(frame.id);
      if (!pending) {
        return;
      }
      pendingRequests.delete(frame.id);
      if (frame.error) {
        pending.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }

    // JSON-RPC notification: method가 있고 id가 없음
    if ('method' in frame && !('id' in frame)) {
      for (const handler of notificationHandlers) {
        handler(frame.method, frame.params ?? {});
      }
    }
  }

  function scheduleReconnect(): void {
    reconnectTimer = setTimeout(async () => {
      try {
        await doConnect();
        backoffMs = options.reconnectOptions.initialDelayMs; // 성공 시 리셋
      } catch {
        backoffMs = Math.min(
          backoffMs * options.reconnectOptions.multiplier,
          options.reconnectOptions.maxDelayMs,
        );
        scheduleReconnect();
      }
    }, backoffMs);
  }

  async function doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      ws.on('open', () => {
        for (const handler of connectedHandlers) {
          handler();
        }
        resolve();
      });

      ws.on('message', (data) => handleMessage(data.toString()));

      ws.on('close', (code, reason) => {
        const msg = `disconnected (${code}): ${reason || 'connection lost'}`;
        for (const handler of disconnectedHandlers) {
          handler(msg);
        }
        scheduleReconnect();
      });

      ws.on('error', (err) => {
        reject(err);
      });
    });
  }

  return {
    get isConnected() {
      return ws?.readyState === WebSocket.OPEN;
    },

    async connect(gatewayUrl: string, authToken: string): Promise<void> {
      url = gatewayUrl;
      token = authToken;
      await doConnect();
    },

    disconnect(): void {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      ws?.close();
      ws = null;
    },

    async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error('Not connected to gateway');
      }

      const id = ++sequenceId;
      const frame: RpcRequest = {
        jsonrpc: '2.0',
        id,
        method: method as RpcRequest['method'],
        params,
      };

      return new Promise((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject });
        ws?.send(JSON.stringify(frame));

        // 30초 타임아웃
        setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id);
            reject(new Error(`Request timeout: ${method}`));
          }
        }, 30_000);
      });
    },

    onNotification(handler) {
      notificationHandlers.push(handler);
    },
    onConnected(handler) {
      connectedHandlers.push(handler);
    },
    onDisconnected(handler) {
      disconnectedHandlers.push(handler);
    },
  };
}
