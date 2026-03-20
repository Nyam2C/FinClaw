// packages/web/src/app-gateway.ts
// Browser WebSocket gateway client with ?token= auth + reconnect + notification routing

export interface ReconnectOptions {
  readonly initialDelayMs: number;
  readonly multiplier: number;
  readonly maxDelayMs: number;
}

export interface AppGateway {
  connect(url: string, token: string): void;
  disconnect(): void;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onNotification(handler: NotificationHandler): void;
  offNotification(handler: NotificationHandler): void;
  onConnected(handler: () => void): void;
  onDisconnected(handler: (reason: string) => void): void;
  readonly isConnected: boolean;
}

export type NotificationHandler = (method: string, params: Record<string, unknown>) => void;

const DEFAULT_RECONNECT: ReconnectOptions = {
  initialDelayMs: 800,
  multiplier: 1.7,
  maxDelayMs: 15_000,
};

export function createAppGateway(
  options: { reconnect?: Partial<ReconnectOptions> } = {},
): AppGateway {
  const reconnect: ReconnectOptions = { ...DEFAULT_RECONNECT, ...options.reconnect };

  let ws: WebSocket | null = null;
  let sequenceId = 0;
  let backoffMs = reconnect.initialDelayMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let gatewayUrl = '';
  let authToken = '';
  let intentionalClose = false;

  const pendingRequests = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  const notificationHandlers = new Set<NotificationHandler>();
  const connectedHandlers = new Set<() => void>();
  const disconnectedHandlers = new Set<(reason: string) => void>();

  function buildUrl(base: string, token: string): string {
    const url = new URL(base);
    // ws:// → upgrade scheme for browser WebSocket
    if (url.protocol === 'http:') {
      url.protocol = 'ws:';
    }
    if (url.protocol === 'https:') {
      url.protocol = 'wss:';
    }
    url.searchParams.set('token', token);
    return url.toString();
  }

  function handleMessage(data: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }

    // Response frame
    if ('id' in frame && typeof frame['id'] === 'number') {
      const pending = pendingRequests.get(frame['id']);
      if (pending) {
        pendingRequests.delete(frame['id']);
        if (frame['error']) {
          const err = frame['error'] as { code?: number; message?: string };
          pending.reject(new Error(`${err.code ?? -1}: ${err.message ?? 'Unknown error'}`));
        } else {
          pending.resolve(frame['result']);
        }
        return;
      }
    }

    // Notification frame
    if ('method' in frame && !('id' in frame)) {
      const method = frame['method'] as string;
      const params = (frame['params'] as Record<string, unknown>) ?? {};
      for (const handler of notificationHandlers) {
        handler(method, params);
      }
    }
  }

  function doConnect(): void {
    const url = buildUrl(gatewayUrl, authToken);
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      backoffMs = reconnect.initialDelayMs;
      for (const handler of connectedHandlers) {
        handler();
      }
    });

    ws.addEventListener('message', (event) => {
      handleMessage(typeof event.data === 'string' ? event.data : String(event.data));
    });

    ws.addEventListener('close', (event) => {
      const reason = `disconnected (${event.code}): ${event.reason || 'connection lost'}`;
      for (const handler of disconnectedHandlers) {
        handler(reason);
      }
      if (!intentionalClose) {
        scheduleReconnect();
      }
    });

    ws.addEventListener('error', () => {
      // error event always followed by close event, so reconnect is handled there
    });
  }

  function scheduleReconnect(): void {
    reconnectTimer = setTimeout(() => {
      doConnect();
      backoffMs = Math.min(backoffMs * reconnect.multiplier, reconnect.maxDelayMs);
    }, backoffMs);
  }

  return {
    get isConnected() {
      return ws?.readyState === WebSocket.OPEN;
    },

    connect(url: string, token: string): void {
      intentionalClose = false;
      gatewayUrl = url;
      authToken = token;
      doConnect();
    },

    disconnect(): void {
      intentionalClose = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws?.close();
      ws = null;
    },

    async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error('Not connected to gateway');
      }

      const id = ++sequenceId;
      const frame = {
        jsonrpc: '2.0' as const,
        id,
        method,
        params,
      };

      return new Promise((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject });
        ws?.send(JSON.stringify(frame));

        setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id);
            reject(new Error(`Request timeout: ${method}`));
          }
        }, 30_000);
      });
    },

    onNotification(handler: NotificationHandler): void {
      notificationHandlers.add(handler);
    },

    offNotification(handler: NotificationHandler): void {
      notificationHandlers.delete(handler);
    },

    onConnected(handler: () => void): void {
      connectedHandlers.add(handler);
    },

    onDisconnected(handler: (reason: string) => void): void {
      disconnectedHandlers.add(handler);
    },
  };
}
