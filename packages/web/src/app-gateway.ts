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
      for (const pending of pendingRequests.values()) {
        pending.reject(new Error(reason));
      }
      pendingRequests.clear();
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
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * reconnect.multiplier, reconnect.maxDelayMs);
    reconnectTimer = setTimeout(() => {
      doConnect();
    }, delay);
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

// ─────────────────────────────────────────────────────────────────────
// Phase 23: typed RPC clients for finance.* / agent.*
// ─────────────────────────────────────────────────────────────────────

export interface FinanceQuote {
  readonly symbol: string;
  readonly price: number;
  readonly change: number;
  readonly changePercent: number;
  readonly timestamp: number;
}

export interface FinanceNewsArticle {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly source: string;
  readonly publishedAt: number;
  readonly summary?: string;
  readonly symbols: readonly string[];
  readonly sentiment?: { readonly label: string; readonly score: number };
}

export interface FinanceAlert {
  readonly id: string;
  readonly symbol: string;
  readonly condition: string;
  readonly threshold?: number;
  readonly keyword?: string;
  readonly enabled: boolean;
  readonly cooldownMs: number;
  readonly createdAt: number;
  readonly triggerCount: number;
}

export type TransactionAction = 'buy' | 'sell' | 'dividend' | 'fee' | 'split';
export type TransactionSource = 'manual' | 'import';

export interface Transaction {
  readonly id: string;
  readonly portfolioId: string;
  readonly symbol: string;
  readonly action: TransactionAction;
  readonly quantity: number;
  readonly price?: number;
  readonly fee: number;
  readonly currency: string;
  readonly executedAt: number;
  readonly source: TransactionSource;
  readonly note?: string;
  readonly createdAt: number;
}

export interface UpdatedHolding {
  readonly symbol: string;
  readonly quantity: number;
  readonly averageCost: number;
}

export interface PortfolioSnapshot {
  readonly portfolioId?: string;
  readonly name?: string;
  readonly holdings: ReadonlyArray<{
    readonly symbol: string;
    readonly quantity: number;
    readonly avgPrice: number;
    readonly currency: string;
  }>;
  readonly summary: {
    readonly currency: string;
    readonly totalHoldings?: number;
  };
  readonly recentTransactions?: readonly Transaction[];
}

export type AlertConditionId = 'price_above' | 'price_below' | 'change_percent' | 'news_match';

export interface TransactionAddParams {
  readonly portfolioId?: string;
  readonly symbol: string;
  readonly action: TransactionAction;
  readonly quantity: number;
  readonly price?: number;
  readonly fee?: number;
  readonly currency: string;
  readonly executedAt: number;
  readonly note?: string;
}

export interface TransactionAddResult {
  readonly transactionId: string;
  readonly createdAt: number;
  readonly updatedHoldings: readonly UpdatedHolding[];
}

export interface TransactionUpdateParams {
  readonly transactionId: string;
  readonly portfolioId?: string;
  readonly symbol?: string;
  readonly action?: TransactionAction;
  readonly quantity?: number;
  readonly price?: number | null;
  readonly fee?: number;
  readonly currency?: string;
  readonly executedAt?: number;
  readonly note?: string | null;
}

export interface FinanceClient {
  quote(params: { symbol: string }): Promise<FinanceQuote>;
  news(params: {
    query?: string;
    symbols?: string[];
    limit?: number;
  }): Promise<{ articles: readonly FinanceNewsArticle[]; total: number }>;
  alertCreate(params: {
    symbol: string;
    condition: AlertConditionId;
    threshold?: number;
    keyword?: string;
    cooldownMs?: number;
  }): Promise<{ alertId: string; createdAt: number; immediateTrigger: boolean }>;
  alertList(params?: {
    symbol?: string;
  }): Promise<{ alerts: readonly FinanceAlert[]; total: number }>;
  portfolioGet(): Promise<PortfolioSnapshot>;
  transactionAdd(params: TransactionAddParams): Promise<TransactionAddResult>;
  transactionList(params?: {
    portfolioId?: string;
    symbol?: string;
    from?: number;
    to?: number;
    limit?: number;
  }): Promise<{ transactions: readonly Transaction[] }>;
  transactionUpdate(
    params: TransactionUpdateParams,
  ): Promise<{ updatedHoldings: readonly UpdatedHolding[] }>;
  transactionDelete(params: {
    transactionId: string;
  }): Promise<{ deleted: boolean; updatedHoldings: readonly UpdatedHolding[] }>;
}

export interface AgentInfo {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly toolCount: number;
}

export interface AgentClient {
  list(): Promise<{ agents: readonly AgentInfo[] }>;
  status(agentId: string): Promise<{
    agentId: string;
    name: string;
    status: 'idle' | 'busy';
    activeRuns: number;
    totalCalls: number;
    lastCallAt: number | null;
    lastError: string | null;
    health: string;
  }>;
  run(params: { agentId: string; prompt: string; timeoutMs?: number }): Promise<{
    agentId: string;
    output: string;
    toolCalls: readonly unknown[];
    tokenUsage: { input: number; output: number };
    durationMs: number;
    stopReason: string;
    turns: number;
  }>;
}

export function createFinanceClient(gateway: AppGateway): FinanceClient {
  return {
    quote: (p) => gateway.send('finance.quote', p) as Promise<FinanceQuote>,
    news: (p) => gateway.send('finance.news', p) as never,
    alertCreate: (p) => gateway.send('finance.alert.create', p) as never,
    alertList: (p = {}) => gateway.send('finance.alert.list', p) as never,
    portfolioGet: () => gateway.send('finance.portfolio.get', {}) as Promise<PortfolioSnapshot>,
    transactionAdd: (p) =>
      gateway.send(
        'finance.transaction.add',
        p as unknown as Record<string, unknown>,
      ) as Promise<TransactionAddResult>,
    transactionList: (p = {}) =>
      gateway.send('finance.transaction.list', p as Record<string, unknown>) as Promise<{
        transactions: readonly Transaction[];
      }>,
    transactionUpdate: (p) =>
      gateway.send(
        'finance.transaction.update',
        p as unknown as Record<string, unknown>,
      ) as Promise<{ updatedHoldings: readonly UpdatedHolding[] }>,
    transactionDelete: (p) =>
      gateway.send('finance.transaction.delete', p) as Promise<{
        deleted: boolean;
        updatedHoldings: readonly UpdatedHolding[];
      }>,
  };
}

export function createAgentClient(gateway: AppGateway): AgentClient {
  return {
    list: () => gateway.send('agent.list', {}) as never,
    status: (agentId) => gateway.send('agent.status', { agentId }) as never,
    run: (p) => gateway.send('agent.run', p) as never,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Phase 30 A12: trace.* client (관찰성 — span tree 조회)
// ─────────────────────────────────────────────────────────────────────

export interface TraceSummary {
  readonly trace_id: string;
  readonly first_ns: number;
  readonly last_ns: number | null;
  readonly root_name: string;
}

export interface TraceClient {
  list(params?: { since?: number; limit?: number }): Promise<{ traces: readonly TraceSummary[] }>;
  get(traceId: string): Promise<{
    traceId: string;
    spans: readonly unknown[];
    tree: readonly unknown[];
    agentRuns: readonly unknown[];
  }>;
}

export function createTraceClient(gateway: AppGateway): TraceClient {
  return {
    list: (params = {}) =>
      gateway.send('trace.list', params as Record<string, unknown>) as Promise<{
        traces: readonly TraceSummary[];
      }>,
    get: (traceId) =>
      gateway.send('trace.get', { traceId }) as Promise<{
        traceId: string;
        spans: readonly unknown[];
        tree: readonly unknown[];
        agentRuns: readonly unknown[];
      }>,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Phase 26 E: memory.* / agent.runs.* clients
// ─────────────────────────────────────────────────────────────────────

export type MemoryType = 'fact' | 'preference' | 'summary' | 'financial';

export interface Memory {
  readonly id: string;
  readonly sessionKey: string;
  readonly content: string;
  readonly type: MemoryType;
  readonly createdAt: number;
}

export interface MemorySearchHit {
  readonly id: string;
  readonly content: string;
  readonly type: MemoryType;
  readonly score: number;
  readonly createdAt: number;
}

export interface MemoryClient {
  list(params?: {
    type?: MemoryType;
    sessionKey?: string;
    limit?: number;
  }): Promise<{ memories: readonly Memory[] }>;
  delete(memoryId: string): Promise<{ deleted: boolean }>;
  search(params: {
    query: string;
    limit?: number;
    types?: readonly MemoryType[];
  }): Promise<{ results: readonly MemorySearchHit[] }>;
}

export function createMemoryClient(gateway: AppGateway): MemoryClient {
  return {
    list: (p = {}) =>
      gateway.send('memory.list', p as Record<string, unknown>) as Promise<{
        memories: readonly Memory[];
      }>,
    delete: (memoryId) =>
      gateway.send('memory.delete', { memoryId }) as Promise<{ deleted: boolean }>,
    search: (p) =>
      gateway.send('memory.search', p as unknown as Record<string, unknown>) as Promise<{
        results: readonly MemorySearchHit[];
      }>,
  };
}

export interface AgentRunSummary {
  readonly id: string;
  readonly agentId: string;
  /** Truncated to 200 chars by server. */
  readonly prompt: string;
  /** Truncated to 500 chars by server. */
  readonly output: string;
  readonly durationMs: number;
  readonly modelUsed?: string;
  readonly role?: string;
  readonly memoryId?: string;
  readonly error?: string;
  readonly createdAt: number;
}

export interface AgentRunFull {
  readonly id: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly output: string;
  readonly toolCalls: readonly unknown[];
  readonly tokensInput: number;
  readonly tokensOutput: number;
  readonly durationMs: number;
  readonly modelUsed?: string;
  readonly role?: string;
  readonly memoryId?: string;
  /** Phase 29 B: RAG 인용 추출 결과 — settings-view 에서 chip 으로 표시 */
  readonly usedMemoryIds?: readonly string[];
  readonly error?: string;
  readonly createdAt: number;
}

export interface AgentRunsClient {
  list(params?: {
    agentId?: string;
    from?: number;
    to?: number;
    limit?: number;
  }): Promise<{ runs: readonly AgentRunSummary[] }>;
  get(runId: string): Promise<{ run: AgentRunFull | null }>;
}

export function createAgentRunsClient(gateway: AppGateway): AgentRunsClient {
  return {
    list: (p = {}) =>
      gateway.send('agent.runs.list', p as Record<string, unknown>) as Promise<{
        runs: readonly AgentRunSummary[];
      }>,
    get: (runId) =>
      gateway.send('agent.runs.get', { runId }) as Promise<{ run: AgentRunFull | null }>,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Phase 28: schedule.* 자동화 클라이언트
// ─────────────────────────────────────────────────────────────────────

export type DeliveryChannel = 'discord' | 'web';
export type ScheduleStatus = 'active' | 'failing' | 'disabled';

export interface ScheduleSummary {
  readonly id: string;
  readonly name: string;
  readonly cron: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly deliveryChannel: DeliveryChannel;
  readonly deliveryTarget: string;
  readonly enabled: boolean;
  readonly timeoutMs?: number;
  readonly status: ScheduleStatus;
  readonly consecutiveFailures: number;
  readonly lastRunAt?: number;
  readonly lastRunId?: string;
  readonly nextRunAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ScheduleHistoryRun {
  readonly id: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly output: string;
  readonly durationMs: number | null;
  readonly modelUsed: string | null;
  readonly role: string | null;
  readonly error: string | null;
  readonly createdAt: number;
}

export interface ScheduleClient {
  list(params?: { enabled?: boolean; limit?: number }): Promise<{
    schedules: readonly ScheduleSummary[];
  }>;
  create(params: {
    name: string;
    cron: string;
    agentId: string;
    prompt: string;
    deliveryChannel: DeliveryChannel;
    deliveryTarget: string;
    timeoutMs?: number;
    enabled?: boolean;
  }): Promise<{ scheduleId: string; nextRunAt: number | null }>;
  update(params: {
    scheduleId: string;
    name?: string;
    cron?: string;
    prompt?: string;
    deliveryChannel?: DeliveryChannel;
    deliveryTarget?: string;
    enabled?: boolean;
    timeoutMs?: number | null;
  }): Promise<{ schedule: ScheduleSummary }>;
  delete(scheduleId: string): Promise<{ deleted: boolean }>;
  runNow(scheduleId: string): Promise<{ runId: string | null }>;
  history(scheduleId: string, limit?: number): Promise<{ runs: readonly ScheduleHistoryRun[] }>;
  disable(scheduleId: string): Promise<{ schedule: ScheduleSummary }>;
  enable(scheduleId: string): Promise<{ schedule: ScheduleSummary }>;
  testCron(expr: string, sampleCount?: number): Promise<{ nextRunsAt: readonly number[] }>;
}

export function createScheduleClient(gateway: AppGateway): ScheduleClient {
  return {
    list: (p = {}) =>
      gateway.send('schedule.list', p as Record<string, unknown>) as Promise<{
        schedules: readonly ScheduleSummary[];
      }>,
    create: (p) =>
      gateway.send('schedule.create', p as unknown as Record<string, unknown>) as Promise<{
        scheduleId: string;
        nextRunAt: number | null;
      }>,
    update: (p) =>
      gateway.send('schedule.update', p as unknown as Record<string, unknown>) as Promise<{
        schedule: ScheduleSummary;
      }>,
    delete: (scheduleId) =>
      gateway.send('schedule.delete', { scheduleId }) as Promise<{ deleted: boolean }>,
    runNow: (scheduleId) =>
      gateway.send('schedule.runNow', { scheduleId }) as Promise<{ runId: string | null }>,
    history: (scheduleId, limit) =>
      gateway.send('schedule.history', { scheduleId, limit }) as Promise<{
        runs: readonly ScheduleHistoryRun[];
      }>,
    disable: (scheduleId) =>
      gateway.send('schedule.disable', { scheduleId }) as Promise<{ schedule: ScheduleSummary }>,
    enable: (scheduleId) =>
      gateway.send('schedule.enable', { scheduleId }) as Promise<{ schedule: ScheduleSummary }>,
    testCron: (expr, sampleCount) =>
      gateway.send('schedule.testCron', { expr, sampleCount }) as Promise<{
        nextRunsAt: readonly number[];
      }>,
  };
}
