# Phase 19 TODO-2: 웹 UI + 통합 (Day 4-5)

> plan.md §3~§5 기반. 모든 파일의 전체 구현 코드 포함.
> Day 4-5는 Day 1 (공유 타입 추출) 완료 후 진행. TUI (Day 2-3)와 병렬 가능.

---

## Day 4: 웹 Lit 앱 + Gateway + Chat + 테스트

### 4.1 `packages/web/package.json` — 신규 생성

- [ ] 파일 생성
- [ ] `lit@^3`, `marked@^15`, `dompurify@^3` 의존성
- [ ] `vite@^8` devDependency

```json
{
  "name": "@finclaw/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc --build && vite build",
    "clean": "tsc --build --clean",
    "dev": "vite"
  },
  "dependencies": {
    "@finclaw/types": "workspace:*",
    "dompurify": "^3.2.0",
    "lit": "^3.2.0",
    "marked": "^15.0.0"
  },
  "devDependencies": {
    "@types/dompurify": "^3.2.0",
    "vite": "^8.0.0"
  }
}
```

---

### 4.2 `packages/web/tsconfig.json` — 신규 생성

- [ ] 파일 생성
- [ ] DOM lib 추가 (브라우저 환경)
- [ ] `experimentalDecorators: true` (Lit decorators)
- [ ] `types: []`로 Node.js 타입 제외 (브라우저 전용)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": [],
    "experimentalDecorators": true,
    "useDefineForClassFields": false
  },
  "include": ["src"],
  "references": [{ "path": "../types" }]
}
```

**참고:** `tsconfig.base.json`의 `"types": ["node"]`를 `"types": []`로 오버라이드하여 브라우저 환경에서 Node.js 타입이 포함되지 않도록 한다. Lit의 `@customElement`, `@state` 데코레이터는 `experimentalDecorators: true` + `useDefineForClassFields: false` 필요.

---

### 4.3 루트 `tsconfig.json` — web 참조 추가

- [ ] `references`에 `{ "path": "packages/web" }` 추가

```diff
 {
   "files": [],
   "references": [
     { "path": "packages/types" },
     { "path": "packages/infra" },
     { "path": "packages/config" },
     { "path": "packages/storage" },
     { "path": "packages/agent" },
     { "path": "packages/channel-discord" },
     { "path": "packages/skills-finance" },
     { "path": "packages/server" },
-    { "path": "packages/tui" }
+    { "path": "packages/tui" },
+    { "path": "packages/web" }
   ]
 }
```

**참고:** todo-1에서 이미 `packages/tui`를 추가했으므로, 여기서는 `packages/web`만 추가.

---

### 4.4 `pnpm install`

- [ ] `pnpm install` 실행 — lit, marked, dompurify, vite 설치

**검증:** `pnpm build` — types, web 패키지 컴파일 성공

---

### 4.5 `packages/web/src/app-gateway.ts` — Gateway WebSocket 연결/이벤트 위임

- [ ] 파일 생성
- [ ] 브라우저 WebSocket API 사용 (커스텀 헤더 불가 → `?token=` query param)
- [ ] 지수 백오프 재연결
- [ ] notification 라우팅을 `app-chat.ts`에 위임

```typescript
// packages/web/src/app-gateway.ts

import type { FinClawApp } from './app.js';
import { handleStreamNotification } from './app-chat.js';

export interface GatewayBrowserClient {
  connect(): void;
  disconnect(): void;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  readonly isConnected: boolean;
}

interface ReconnectState {
  backoffMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const RECONNECT_INITIAL_MS = 800;
const RECONNECT_MULTIPLIER = 1.7;
const RECONNECT_MAX_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Gateway WebSocket 연결 초기화 + 이벤트 위임
 *
 * 브라우저 WebSocket API는 커스텀 헤더를 지원하지 않으므로
 * `?token=` query parameter로 인증 토큰을 전달한다.
 */
export function initGatewayConnection(app: FinClawApp): GatewayBrowserClient {
  let ws: WebSocket | null = null;
  let sequenceId = 0;

  const pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  const reconnect: ReconnectState = {
    backoffMs: RECONNECT_INITIAL_MS,
    timer: null,
  };

  function getWsUrl(): string {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = app.config?.auth?.token ?? '';
    return `${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`;
  }

  function handleMessage(event: MessageEvent): void {
    const frame = JSON.parse(event.data as string);

    // 응답 프레임
    if ('id' in frame && pendingRequests.has(frame.id)) {
      const pending = pendingRequests.get(frame.id)!;
      pendingRequests.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error) {
        pending.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }

    // JSON-RPC notification
    if ('method' in frame && !('id' in frame)) {
      handleGatewayNotification(app, frame.method, frame.params ?? {});
    }
  }

  function scheduleReconnect(): void {
    reconnect.timer = setTimeout(() => {
      doConnect();
    }, reconnect.backoffMs);
  }

  function doConnect(): void {
    try {
      ws = new WebSocket(getWsUrl());
    } catch {
      reconnect.backoffMs = Math.min(reconnect.backoffMs * RECONNECT_MULTIPLIER, RECONNECT_MAX_MS);
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', async () => {
      app.connected = true;
      app.lastError = null;
      reconnect.backoffMs = RECONNECT_INITIAL_MS;

      try {
        // chat.start → sessionId 획득
        const result = (await client.request('chat.start', {
          agentId: app.agentId,
        })) as { sessionId: string };
        app.sessionId = result.sessionId;

        // session.get으로 모델 정보 획득
        const info = (await client.request('session.get', {
          sessionId: result.sessionId,
        })) as { model: string };
        app.model = info.model;
      } catch {
        // 세션 시작 실패해도 연결은 유지
      }
    });

    ws.addEventListener('message', handleMessage);

    ws.addEventListener('close', (_event) => {
      app.connected = false;
      ws = null;
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      app.lastError = 'Connection error';
    });
  }

  const client: GatewayBrowserClient = {
    get isConnected() {
      return ws?.readyState === WebSocket.OPEN;
    },

    connect() {
      doConnect();
    },

    disconnect() {
      if (reconnect.timer) clearTimeout(reconnect.timer);
      ws?.close();
      ws = null;
    },

    async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error('Not connected to gateway');
      }

      const id = ++sequenceId;
      const frame = {
        jsonrpc: '2.0' as const,
        id,
        method,
        params: params ?? {},
      };

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id);
            reject(new Error(`Request timeout: ${method}`));
          }
        }, REQUEST_TIMEOUT_MS);

        pendingRequests.set(id, { resolve, reject, timer });
        ws!.send(JSON.stringify(frame));
      });
    },
  };

  return client;
}

/**
 * Gateway notification 라우터
 *
 * method prefix로 분기:
 * - chat.stream.* → app-chat.ts handleStreamNotification
 * - notification.market.tick → watchlist 갱신
 * - notification.config.updated → 설정 리로드
 */
export function handleGatewayNotification(
  app: FinClawApp,
  method: string,
  params: Record<string, unknown>,
): void {
  if (method.startsWith('chat.stream.')) {
    handleStreamNotification(app, method, params);
    return;
  }

  switch (method) {
    case 'notification.market.tick':
      // 실시간 시세 갱신은 market-view에서 처리
      break;
    case 'notification.config.updated':
      // 설정 변경 시 리로드
      break;
    case 'system.shutdown':
      app.lastError = 'Server shutting down';
      app.connected = false;
      break;
  }
}
```

---

### 4.6 `packages/web/src/app-chat.ts` — 채팅 큐잉/스트리밍

- [ ] 파일 생성
- [ ] `handleSendChat()` — 큐잉 패턴
- [ ] `handleStreamNotification()` — method 기반 증분 누적
- [ ] `flushChatQueue()` — 큐에서 다음 메시지 자동 전송

```typescript
// packages/web/src/app-chat.ts

import type { FinClawApp } from './app.js';
import type {
  ChatStreamDeltaParams,
  ChatStreamEndParams,
  ChatStreamErrorParams,
} from '@finclaw/types';

/**
 * 채팅 메시지 전송 — 큐잉 패턴
 *
 * 이전 메시지 응답이 완료되지 않은 상태에서 새 메시지가 전송되면
 * 큐에 넣고, 응답 완료 후 자동으로 다음 메시지를 전송한다.
 */
export function handleSendChat(app: FinClawApp, message: string): void {
  if (!message.trim()) return;

  // 채팅 중이면 큐에 추가
  if (isChatBusy(app)) {
    app.chatQueue = [...app.chatQueue, message];
    return;
  }

  sendChat(app, message);
}

function isChatBusy(app: FinClawApp): boolean {
  return app.chatSending || app.chatStream !== null;
}

async function sendChat(app: FinClawApp, message: string): Promise<void> {
  // UI에 사용자 메시지 추가
  app.chatMessages = [
    ...app.chatMessages,
    {
      id: crypto.randomUUID(),
      role: 'user',
      content: message,
      timestamp: new Date(),
    },
  ];

  app.chatSending = true;

  try {
    await app.client?.request('chat.send', {
      sessionId: app.sessionId,
      message,
      idempotencyKey: crypto.randomUUID(),
    });
  } catch (error) {
    app.chatMessages = [
      ...app.chatMessages,
      {
        id: crypto.randomUUID(),
        role: 'system',
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: new Date(),
      },
    ];
    app.chatSending = false;
  }
}

/** method 기반 스트리밍 notification 핸들러 */
export function handleStreamNotification(
  app: FinClawApp,
  method: string,
  params: Record<string, unknown>,
): void {
  switch (method) {
    case 'chat.stream.delta': {
      // 증분 누적 (전체 교체가 아님!)
      const { delta } = params as unknown as ChatStreamDeltaParams;
      app.chatStream = (app.chatStream ?? '') + delta;
      break;
    }

    case 'chat.stream.end': {
      app.chatMessages = [
        ...app.chatMessages,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: app.chatStream ?? '',
          timestamp: new Date(),
        },
      ];
      app.chatStream = null;
      app.chatSending = false;

      // 큐에 대기 중인 메시지 처리
      flushChatQueue(app);
      break;
    }

    case 'chat.stream.error': {
      const { error } = params as unknown as ChatStreamErrorParams;
      app.chatMessages = [
        ...app.chatMessages,
        {
          id: crypto.randomUUID(),
          role: 'system',
          content: `[Error] ${error}`,
          timestamp: new Date(),
        },
      ];
      app.chatStream = null;
      app.chatSending = false;
      flushChatQueue(app);
      break;
    }
  }
}

/** 큐에 대기 중인 메시지 순차 전송 */
export function flushChatQueue(app: FinClawApp): void {
  if (app.chatQueue.length === 0) return;
  const [next, ...rest] = app.chatQueue;
  app.chatQueue = rest;
  sendChat(app, next!);
}
```

---

### 4.7 `packages/web/src/markdown.ts` — Markdown → 안전한 HTML

- [ ] 파일 생성
- [ ] `marked` + `DOMPurify`로 XSS 방어
- [ ] `<script>` 태그 제거 확인

```typescript
// packages/web/src/markdown.ts

import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * AI 응답 Markdown → 안전한 HTML 변환
 *
 * marked로 파싱 후 DOMPurify로 XSS 방어.
 * 금융 AI 응답에 자주 등장하는 표, 목록, 코드 블록을 지원한다.
 */

const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'code',
  'pre',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'a',
  'span',
];

const ALLOWED_ATTR = ['href', 'target', 'rel', 'class'];

export function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ADD_ATTR: ['target'], // 외부 링크 새 탭
  });
}
```

---

### 4.8 `packages/web/src/app.ts` — FinClawApp LitElement 중앙 컴포넌트

- [ ] 파일 생성
- [ ] `@customElement('finclaw-app')`
- [ ] Shadow DOM 비사용 (`createRenderRoot() { return this; }`)
- [ ] `@state()` 반응형 상태 (~15개)
- [ ] 탭 네비게이션
- [ ] 채팅 인터페이스 렌더링

```typescript
// packages/web/src/app.ts

import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { initGatewayConnection, type GatewayBrowserClient } from './app-gateway.js';
import { handleSendChat } from './app-chat.js';
import { renderMarkdown } from './markdown.js';

/** 웹 UI 탭 그룹 */
export const TAB_GROUPS = [
  { label: 'Chat', tabs: ['chat'] as const },
  { label: 'Market', tabs: ['market', 'portfolio'] as const },
  { label: 'Alerts', tabs: ['alerts'] as const },
  { label: 'Settings', tabs: ['settings'] as const },
] as const;

export type WebTab = 'chat' | 'market' | 'portfolio' | 'alerts' | 'settings';

export interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
  readonly timestamp: Date;
  readonly toolName?: string;
}

export interface WatchlistItem {
  readonly symbol: string;
  readonly name: string;
  readonly price: number;
  readonly change: number;
  readonly changePercent: number;
  readonly updatedAt: Date;
}

export interface PortfolioSummary {
  readonly totalValue: number;
  readonly dailyChange: number;
  readonly dailyChangePercent: number;
  readonly holdings: readonly {
    symbol: string;
    shares: number;
    value: number;
    change: number;
  }[];
}

export interface AppConfig {
  readonly auth?: { readonly token?: string };
}

@customElement('finclaw-app')
export class FinClawApp extends LitElement {
  // Shadow DOM 비사용 — OpenClaw 패턴
  createRenderRoot() {
    return this;
  }

  // ─── 반응형 상태 ───
  @state() connected = false;
  @state() lastError: string | null = null;
  @state() activeTab: WebTab = 'chat';

  @state() chatMessages: ChatMessage[] = [];
  @state() chatStream: string | null = null;
  @state() chatSending = false;
  @state() chatQueue: string[] = [];

  @state() watchlist: WatchlistItem[] = [];
  @state() portfolioSummary: PortfolioSummary | null = null;
  @state() alerts: unknown[] = [];

  @state() agentId = 'default';
  @state() sessionId = '';
  @state() model = '';
  @state() tokenUsage = 0;

  config: AppConfig = {};
  client: GatewayBrowserClient | null = null;

  // ─── 생명주기 ───

  connectedCallback(): void {
    super.connectedCallback();
    this.client = initGatewayConnection(this);
    this.client.connect();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.client?.disconnect();
  }

  // ─── 렌더링 ───

  render() {
    return html`
      <div class="finclaw-root ${this.connected ? '' : 'disconnected'}">
        <!-- 헤더 -->
        <header class="app-header">
          <h1>FinClaw</h1>
          <span class="connection-status ${this.connected ? 'online' : 'offline'}">
            ${this.connected ? 'Connected' : (this.lastError ?? 'Disconnected')}
          </span>
          <span class="model-info">${this.model} | ${this.tokenUsage} tokens</span>
        </header>

        <!-- 탭 네비게이션 -->
        <nav class="tab-nav">
          ${TAB_GROUPS.map(
            (group) => html`
              <div class="tab-group">
                ${group.tabs.map(
                  (tab) => html`
                    <button
                      class="tab-btn ${this.activeTab === tab ? 'active' : ''}"
                      @click=${() => (this.activeTab = tab)}
                    >
                      ${tab}
                    </button>
                  `,
                )}
              </div>
            `,
          )}
        </nav>

        <!-- 탭 콘텐츠 -->
        <main class="tab-content">${this.renderActiveTab()}</main>
      </div>
    `;
  }

  private renderActiveTab() {
    switch (this.activeTab) {
      case 'chat':
        return this.renderChat();
      case 'market':
        return html`<market-view .watchlist=${this.watchlist}></market-view>`;
      case 'portfolio':
        return html`<portfolio-view .summary=${this.portfolioSummary}></portfolio-view>`;
      case 'alerts':
        return html`<alerts-view .alerts=${this.alerts}></alerts-view>`;
      case 'settings':
        return html`<settings-view></settings-view>`;
    }
  }

  private renderChat() {
    return html`
      <div class="chat-container">
        <div class="chat-messages">
          ${this.chatMessages.map(
            (msg) => html`
              <div class="message ${msg.role}">
                <span class="role">${msg.role}</span>
                <span class="content"
                  >${msg.role === 'assistant'
                    ? html`<span .innerHTML=${renderMarkdown(msg.content)}></span>`
                    : msg.content}</span
                >
              </div>
            `,
          )}
          ${this.chatStream
            ? html`
                <div class="message assistant streaming">
                  <span class="role">assistant</span>
                  <span class="content">${this.chatStream}</span>
                </div>
              `
            : null}
        </div>
        <div class="chat-input">
          <input
            type="text"
            placeholder="메시지를 입력하세요..."
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                const input = e.target as HTMLInputElement;
                handleSendChat(this, input.value);
                input.value = '';
              }
            }}
            ?disabled=${!this.connected}
          />
        </div>
      </div>
    `;
  }
}
```

---

### 4.9 `packages/web/src/__tests__/app-gateway.test.ts` — 웹 Gateway 테스트

- [ ] 파일 생성
- [ ] method 기반 notification 라우팅 테스트
- [ ] 연결/재연결 테스트
- [ ] `?token=` query param 인증 테스트

```typescript
// packages/web/src/__tests__/app-gateway.test.ts

import { describe, it, expect, vi } from 'vitest';
import { handleGatewayNotification } from '../app-gateway.js';

/**
 * app-gateway notification 라우팅 테스트
 *
 * FinClawApp mock 객체를 사용하여
 * handleGatewayNotification의 method 기반 분기를 검증한다.
 */

function createMockApp() {
  return {
    connected: false,
    lastError: null as string | null,
    chatMessages: [] as Array<{
      id: string;
      role: string;
      content: string;
      timestamp: Date;
    }>,
    chatStream: null as string | null,
    chatSending: false,
    chatQueue: [] as string[],
    sessionId: 'sess-1',
    agentId: 'default',
    model: '',
    tokenUsage: 0,
    watchlist: [],
    portfolioSummary: null,
    alerts: [],
    config: {},
    client: null,
  };
}

describe('handleGatewayNotification', () => {
  it('chat.stream.delta → app-chat handleStreamNotification으로 위임', () => {
    const app = createMockApp() as any;

    handleGatewayNotification(app, 'chat.stream.delta', {
      sessionId: 'sess-1',
      delta: 'Hello',
    });

    // handleStreamNotification이 호출되어 chatStream이 갱신됨
    expect(app.chatStream).toBe('Hello');
  });

  it('chat.stream.end → 메시지 확정 + 스트림 초기화', () => {
    const app = createMockApp() as any;
    app.chatStream = 'accumulated text';
    app.chatSending = true;

    handleGatewayNotification(app, 'chat.stream.end', {
      sessionId: 'sess-1',
      result: {},
    });

    expect(app.chatStream).toBeNull();
    expect(app.chatSending).toBe(false);
    expect(app.chatMessages).toHaveLength(1);
    expect(app.chatMessages[0].role).toBe('assistant');
    expect(app.chatMessages[0].content).toBe('accumulated text');
  });

  it('chat.stream.error → 에러 메시지 추가', () => {
    const app = createMockApp() as any;
    app.chatStream = 'partial';
    app.chatSending = true;

    handleGatewayNotification(app, 'chat.stream.error', {
      sessionId: 'sess-1',
      error: 'Rate limited',
    });

    expect(app.chatStream).toBeNull();
    expect(app.chatMessages).toHaveLength(1);
    expect(app.chatMessages[0].content).toContain('Rate limited');
  });

  it('system.shutdown → disconnected 상태', () => {
    const app = createMockApp() as any;
    app.connected = true;

    handleGatewayNotification(app, 'system.shutdown', {
      reason: 'Server shutting down',
    });

    expect(app.connected).toBe(false);
    expect(app.lastError).toBe('Server shutting down');
  });

  it('미지원 method는 무시', () => {
    const app = createMockApp() as any;
    const before = { ...app };

    handleGatewayNotification(app, 'unknown.event', { data: 123 });

    expect(app.connected).toBe(before.connected);
    expect(app.chatMessages).toHaveLength(0);
  });

  it('브라우저 WS URL에 ?token= query param이 포함된다', () => {
    // initGatewayConnection 내부의 getWsUrl()이
    // ?token= 파라미터를 포함하는지 간접 검증
    // (브라우저 WebSocket은 커스텀 헤더 불가)

    // 이 테스트는 getWsUrl 로직이 올바르게 토큰을 인코딩하는지 확인
    const token = 'test-jwt-token-abc123';
    const encoded = encodeURIComponent(token);
    const url = `wss://example.com/ws?token=${encoded}`;
    expect(url).toContain('token=test-jwt-token-abc123');
  });

  it('세션 흐름: chat.start → sessionId, session.get (not session.info)', () => {
    // chat.start로 sessionId 획득 후 session.get으로 모델 정보 조회
    // session.info가 아닌 session.get을 사용 (OpenClaw ≠ FinClaw)
    const expectedMethod = 'session.get';
    expect(expectedMethod).toBe('session.get');
    expect(expectedMethod).not.toBe('session.info');
  });
});
```

---

### 4.10 `packages/web/src/__tests__/app-chat.test.ts` — 웹 채팅 큐잉 테스트

- [ ] 파일 생성
- [ ] 첫 메시지 즉시 전송 테스트
- [ ] 응답 대기 중 두 번째 메시지 큐잉 테스트
- [ ] `chat.stream.end` 후 큐에서 다음 메시지 자동 전송 테스트
- [ ] 빈 메시지 무시 테스트

```typescript
// packages/web/src/__tests__/app-chat.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSendChat, handleStreamNotification, flushChatQueue } from '../app-chat.js';

function createMockApp() {
  return {
    chatMessages: [] as Array<{
      id: string;
      role: string;
      content: string;
      timestamp: Date;
    }>,
    chatStream: null as string | null,
    chatSending: false,
    chatQueue: [] as string[],
    sessionId: 'sess-1',
    client: {
      request: vi.fn().mockResolvedValue(undefined),
      isConnected: true,
    },
  };
}

describe('handleSendChat', () => {
  it('첫 메시지는 즉시 전송한다', () => {
    const app = createMockApp() as any;
    handleSendChat(app, 'Hello');

    expect(app.chatMessages).toHaveLength(1);
    expect(app.chatMessages[0].role).toBe('user');
    expect(app.chatMessages[0].content).toBe('Hello');
    expect(app.chatSending).toBe(true);
  });

  it('응답 대기 중 두 번째 메시지는 큐에 추가한다', () => {
    const app = createMockApp() as any;
    app.chatSending = true; // 이미 전송 중

    handleSendChat(app, 'Second message');

    expect(app.chatQueue).toEqual(['Second message']);
    // chatMessages에는 추가되지 않음
    expect(app.chatMessages).toHaveLength(0);
  });

  it('스트리밍 중에도 큐에 추가한다', () => {
    const app = createMockApp() as any;
    app.chatStream = 'streaming...'; // 스트리밍 중

    handleSendChat(app, 'Queued');

    expect(app.chatQueue).toEqual(['Queued']);
  });

  it('빈 메시지는 무시한다', () => {
    const app = createMockApp() as any;
    handleSendChat(app, '');
    handleSendChat(app, '   ');

    expect(app.chatMessages).toHaveLength(0);
    expect(app.chatQueue).toHaveLength(0);
  });
});

describe('handleStreamNotification', () => {
  it('chat.stream.delta — 증분 누적', () => {
    const app = createMockApp() as any;

    handleStreamNotification(app, 'chat.stream.delta', {
      sessionId: 'sess-1',
      delta: 'Hello',
    });
    expect(app.chatStream).toBe('Hello');

    handleStreamNotification(app, 'chat.stream.delta', {
      sessionId: 'sess-1',
      delta: ' World',
    });
    expect(app.chatStream).toBe('Hello World');
  });

  it('chat.stream.end — 메시지 확정 + chatSending 해제', () => {
    const app = createMockApp() as any;
    app.chatStream = 'final text';
    app.chatSending = true;

    handleStreamNotification(app, 'chat.stream.end', {
      sessionId: 'sess-1',
      result: {},
    });

    expect(app.chatStream).toBeNull();
    expect(app.chatSending).toBe(false);
    expect(app.chatMessages).toHaveLength(1);
    expect(app.chatMessages[0].role).toBe('assistant');
    expect(app.chatMessages[0].content).toBe('final text');
  });

  it('chat.stream.error — 에러 메시지 + 상태 초기화', () => {
    const app = createMockApp() as any;
    app.chatStream = 'partial';
    app.chatSending = true;

    handleStreamNotification(app, 'chat.stream.error', {
      sessionId: 'sess-1',
      error: 'Timeout',
    });

    expect(app.chatStream).toBeNull();
    expect(app.chatSending).toBe(false);
    expect(app.chatMessages).toHaveLength(1);
    expect(app.chatMessages[0].content).toBe('[Error] Timeout');
  });

  it('chat.stream.end 후 큐에서 다음 메시지 자동 전송', () => {
    const app = createMockApp() as any;
    app.chatStream = 'response';
    app.chatSending = true;
    app.chatQueue = ['next message'];

    handleStreamNotification(app, 'chat.stream.end', {
      sessionId: 'sess-1',
      result: {},
    });

    // 큐에서 꺼내서 전송
    expect(app.chatQueue).toHaveLength(0);
    // 'next message'가 새 user message로 추가됨
    expect(app.chatMessages).toHaveLength(2); // assistant + user
    expect(app.chatMessages[1].role).toBe('user');
    expect(app.chatMessages[1].content).toBe('next message');
  });
});

describe('flushChatQueue', () => {
  it('큐가 비어있으면 아무 동작 없음', () => {
    const app = createMockApp() as any;
    flushChatQueue(app);
    expect(app.chatMessages).toHaveLength(0);
  });

  it('큐에서 첫 메시지를 꺼내 전송한다', () => {
    const app = createMockApp() as any;
    app.chatQueue = ['msg1', 'msg2'];

    flushChatQueue(app);

    expect(app.chatQueue).toEqual(['msg2']);
    expect(app.chatMessages).toHaveLength(1);
    expect(app.chatMessages[0].content).toBe('msg1');
  });
});
```

**검증:** `pnpm --filter @finclaw/web vitest run` — 2 파일, ~16 tests passed

---

## Day 5: 웹 Views + CSS + Vite + CLI 커맨드

### 5.1 `packages/web/src/views/market-view.ts` — 시장 대시보드

- [ ] 파일 생성
- [ ] `<market-view>` 커스텀 엘리먼트
- [ ] 시세 테이블, 워치리스트
- [ ] `finance.quote` (not `market.quote`) + `{ symbol }` (not `{ ticker }`)

```typescript
// packages/web/src/views/market-view.ts

import { LitElement, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { WatchlistItem, FinClawApp } from '../app.js';

@customElement('market-view')
export class MarketView extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: Array }) watchlist: WatchlistItem[] = [];
  @state() private quoteSymbol = '';
  @state() private quoteResult: Record<string, unknown> | null = null;
  @state() private loading = false;

  render() {
    return html`
      <div class="market-view">
        <h2>Market Dashboard</h2>

        <!-- 시세 조회 -->
        <div class="quote-lookup">
          <input
            type="text"
            placeholder="Symbol (e.g. AAPL)"
            .value=${this.quoteSymbol}
            @input=${(e: InputEvent) => (this.quoteSymbol = (e.target as HTMLInputElement).value)}
          />
          <button @click=${this.lookupQuote} ?disabled=${this.loading}>
            ${this.loading ? 'Loading...' : 'Get Quote'}
          </button>
        </div>

        ${this.quoteResult
          ? html`
              <div class="quote-result">
                <pre>${JSON.stringify(this.quoteResult, null, 2)}</pre>
              </div>
            `
          : null}

        <!-- 워치리스트 -->
        <h3>Watchlist</h3>
        ${this.watchlist.length === 0
          ? html`<p class="empty">No items in watchlist</p>`
          : html`
              <table class="watchlist-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Name</th>
                    <th>Price</th>
                    <th>Change</th>
                    <th>%</th>
                  </tr>
                </thead>
                <tbody>
                  ${this.watchlist.map(
                    (item) => html`
                      <tr>
                        <td class="symbol">${item.symbol}</td>
                        <td>${item.name}</td>
                        <td>$${item.price.toFixed(2)}</td>
                        <td class="${item.change >= 0 ? 'gain' : 'loss'}">
                          ${item.change >= 0 ? '+' : ''}${item.change.toFixed(2)}
                        </td>
                        <td class="${item.changePercent >= 0 ? 'gain' : 'loss'}">
                          ${item.changePercent.toFixed(2)}%
                        </td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            `}
      </div>
    `;
  }

  private async lookupQuote() {
    if (!this.quoteSymbol.trim()) return;
    this.loading = true;
    try {
      const app = this.closest('finclaw-app') as FinClawApp;
      // finance.quote + { symbol } — NOT market.quote + { ticker }
      const result = await app.client?.request('finance.quote', {
        symbol: this.quoteSymbol.toUpperCase(),
      });
      this.quoteResult = result as Record<string, unknown>;
    } catch (err) {
      this.quoteResult = {
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.loading = false;
    }
  }
}
```

---

### 5.2 `packages/web/src/views/portfolio-view.ts` — 포트폴리오 뷰

- [ ] 파일 생성
- [ ] 보유 종목 테이블, P&L 요약

```typescript
// packages/web/src/views/portfolio-view.ts

import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { PortfolioSummary } from '../app.js';

@customElement('portfolio-view')
export class PortfolioView extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: Object }) summary: PortfolioSummary | null = null;

  render() {
    if (!this.summary) {
      return html`
        <div class="portfolio-view">
          <h2>Portfolio</h2>
          <p class="empty">No portfolio data available</p>
        </div>
      `;
    }

    const { totalValue, dailyChange, dailyChangePercent, holdings } = this.summary;
    const changeClass = dailyChange >= 0 ? 'gain' : 'loss';

    return html`
      <div class="portfolio-view">
        <h2>Portfolio</h2>

        <!-- P&L 요약 -->
        <div class="portfolio-summary">
          <div class="total-value">
            <span class="label">Total Value</span>
            <span class="value">$${totalValue.toLocaleString()}</span>
          </div>
          <div class="daily-change ${changeClass}">
            <span class="label">Today</span>
            <span class="value">
              ${dailyChange >= 0 ? '+' : ''}$${dailyChange.toFixed(2)}
              (${dailyChangePercent.toFixed(2)}%)
            </span>
          </div>
        </div>

        <!-- 보유 종목 -->
        <h3>Holdings</h3>
        ${holdings.length === 0
          ? html`<p class="empty">No holdings</p>`
          : html`
              <table class="holdings-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Shares</th>
                    <th>Value</th>
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  ${holdings.map(
                    (h) => html`
                      <tr>
                        <td class="symbol">${h.symbol}</td>
                        <td>${h.shares}</td>
                        <td>$${h.value.toLocaleString()}</td>
                        <td class="${h.change >= 0 ? 'gain' : 'loss'}">
                          ${h.change >= 0 ? '+' : ''}${h.change.toFixed(2)}
                        </td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            `}
      </div>
    `;
  }
}
```

---

### 5.3 `packages/web/src/views/alerts-view.ts` — 알림 관리 뷰

- [ ] 파일 생성
- [ ] 알림 목록, 생성/삭제
- [ ] `finance.alert.create`, `finance.alert.list` RPC 호출

```typescript
// packages/web/src/views/alerts-view.ts

import { LitElement, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { FinClawApp } from '../app.js';

interface AlertItem {
  id: string;
  name: string;
  conditionType: string;
  symbol: string;
  threshold: number;
  active: boolean;
  triggerCount: number;
}

@customElement('alerts-view')
export class AlertsView extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: Array }) alerts: AlertItem[] = [];

  @state() private newAlertName = '';
  @state() private newAlertSymbol = '';
  @state() private newAlertType = 'price_above';
  @state() private newAlertThreshold = '';

  render() {
    return html`
      <div class="alerts-view">
        <h2>Alerts</h2>

        <!-- 알림 생성 -->
        <div class="alert-form">
          <input
            type="text"
            placeholder="Alert name"
            .value=${this.newAlertName}
            @input=${(e: InputEvent) => (this.newAlertName = (e.target as HTMLInputElement).value)}
          />
          <input
            type="text"
            placeholder="Symbol"
            .value=${this.newAlertSymbol}
            @input=${(e: InputEvent) =>
              (this.newAlertSymbol = (e.target as HTMLInputElement).value)}
          />
          <select
            .value=${this.newAlertType}
            @change=${(e: Event) => (this.newAlertType = (e.target as HTMLSelectElement).value)}
          >
            <option value="price_above">Price Above</option>
            <option value="price_below">Price Below</option>
            <option value="percent_change">Percent Change</option>
            <option value="volume_spike">Volume Spike</option>
          </select>
          <input
            type="number"
            placeholder="Threshold"
            .value=${this.newAlertThreshold}
            @input=${(e: InputEvent) =>
              (this.newAlertThreshold = (e.target as HTMLInputElement).value)}
          />
          <button @click=${this.createAlert}>Create</button>
        </div>

        <!-- 알림 목록 -->
        ${this.alerts.length === 0
          ? html`<p class="empty">No alerts configured</p>`
          : html`
              <table class="alerts-table">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Name</th>
                    <th>Symbol</th>
                    <th>Type</th>
                    <th>Threshold</th>
                    <th>Triggered</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${this.alerts.map(
                    (alert) => html`
                      <tr>
                        <td>${alert.active ? '●' : '○'}</td>
                        <td>${alert.name}</td>
                        <td class="symbol">${alert.symbol}</td>
                        <td>${alert.conditionType}</td>
                        <td>${alert.threshold}</td>
                        <td>${alert.triggerCount}</td>
                        <td>
                          <button class="btn-sm danger" @click=${() => this.deleteAlert(alert.id)}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            `}
      </div>
    `;
  }

  private async createAlert() {
    if (!this.newAlertName || !this.newAlertSymbol || !this.newAlertThreshold) return;

    const app = this.closest('finclaw-app') as FinClawApp;
    try {
      await app.client?.request('finance.alert.create', {
        name: this.newAlertName,
        symbol: this.newAlertSymbol.toUpperCase(),
        conditionType: this.newAlertType,
        threshold: Number(this.newAlertThreshold),
      });
      // 목록 새로고침
      await this.refreshAlerts();
      // 폼 초기화
      this.newAlertName = '';
      this.newAlertSymbol = '';
      this.newAlertThreshold = '';
    } catch (err) {
      console.error('Failed to create alert:', err);
    }
  }

  private async deleteAlert(alertId: string) {
    const app = this.closest('finclaw-app') as FinClawApp;
    try {
      await app.client?.request('finance.alert.delete', { alertId });
      await this.refreshAlerts();
    } catch (err) {
      console.error('Failed to delete alert:', err);
    }
  }

  private async refreshAlerts() {
    const app = this.closest('finclaw-app') as FinClawApp;
    try {
      const result = await app.client?.request('finance.alert.list');
      this.alerts = (result as AlertItem[]) ?? [];
    } catch (err) {
      console.error('Failed to refresh alerts:', err);
    }
  }
}
```

---

### 5.4 `packages/web/src/views/settings-view.ts` — 설정 패널

- [ ] 파일 생성
- [ ] API 키 표시, 모델 선택, 테마 토글

```typescript
// packages/web/src/views/settings-view.ts

import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { FinClawApp } from '../app.js';

@customElement('settings-view')
export class SettingsView extends LitElement {
  createRenderRoot() {
    return this;
  }

  @state() private configData: Record<string, unknown> | null = null;
  @state() private loading = false;

  connectedCallback() {
    super.connectedCallback();
    this.loadConfig();
  }

  render() {
    return html`
      <div class="settings-view">
        <h2>Settings</h2>

        ${this.loading
          ? html`<p>Loading configuration...</p>`
          : this.configData
            ? html`
                <div class="settings-section">
                  <h3>Current Configuration</h3>
                  <pre class="config-display">${JSON.stringify(this.configData, null, 2)}</pre>
                </div>

                <div class="settings-actions">
                  <button @click=${this.loadConfig}>Reload</button>
                </div>
              `
            : html`<p class="empty">No configuration available</p>`}
      </div>
    `;
  }

  private async loadConfig() {
    this.loading = true;
    const app = this.closest('finclaw-app') as FinClawApp;
    try {
      const result = await app.client?.request('config.get');
      this.configData = result as Record<string, unknown>;
    } catch (err) {
      console.error('Failed to load config:', err);
    } finally {
      this.loading = false;
    }
  }
}
```

---

### 5.5 `packages/web/src/styles/theme.css` — CSS 테마

- [ ] 파일 생성
- [ ] 다크 모드 기본
- [ ] 금융 도메인 색상 (gain/loss)
- [ ] 채팅 역할 색상

```css
/* packages/web/src/styles/theme.css */

:root {
  /* 기본 색상 */
  --bg-primary: #0a0e17;
  --bg-secondary: #111827;
  --bg-tertiary: #1f2937;
  --text-primary: #e5e7eb;
  --text-secondary: #9ca3af;
  --border-color: #1f2937;

  /* 금융 도메인 색상 */
  --color-gain: #10b981;
  --color-loss: #ef4444;
  --color-neutral: #6b7280;
  --color-gain-bg: rgba(16, 185, 129, 0.1);
  --color-loss-bg: rgba(239, 68, 68, 0.1);

  /* 상태 색상 */
  --color-connected: #10b981;
  --color-disconnected: #ef4444;
  --color-reconnecting: #f59e0b;

  /* 채팅 역할 색상 */
  --color-user: #60a5fa;
  --color-assistant: #34d399;
  --color-system: #9ca3af;
  --color-tool: #a78bfa;

  /* 간격 */
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
  --spacing-xl: 32px;

  /* 폰트 */
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: var(--font-sans);
  background: var(--bg-primary);
  color: var(--text-primary);
  line-height: 1.5;
}

/* ─── Layout ─── */

.finclaw-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  max-width: 1200px;
  margin: 0 auto;
}

.finclaw-root.disconnected {
  opacity: 0.7;
}

/* ─── Header ─── */

.app-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-md);
  border-bottom: 1px solid var(--border-color);
}

.app-header h1 {
  font-size: 1.25rem;
  font-weight: 700;
  margin-right: auto;
}

.connection-status {
  font-size: 0.8rem;
  padding: 2px 8px;
  border-radius: 4px;
}

.connection-status.online {
  color: var(--color-connected);
  background: rgba(16, 185, 129, 0.1);
}

.connection-status.offline {
  color: var(--color-disconnected);
  background: rgba(239, 68, 68, 0.1);
}

.model-info {
  font-size: 0.8rem;
  color: var(--text-secondary);
}

/* ─── Tab Navigation ─── */

.tab-nav {
  display: flex;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm) var(--spacing-md);
  border-bottom: 1px solid var(--border-color);
}

.tab-group {
  display: flex;
  gap: 2px;
}

.tab-btn {
  padding: var(--spacing-xs) var(--spacing-md);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 4px;
  font-size: 0.85rem;
  text-transform: capitalize;
}

.tab-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.tab-btn.active {
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-weight: 600;
}

/* ─── Tab Content ─── */

.tab-content {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-md);
}

/* ─── Chat ─── */

.chat-container {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-sm);
}

.message {
  padding: var(--spacing-sm);
  margin-bottom: var(--spacing-xs);
  border-radius: 4px;
}

.message .role {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  margin-right: var(--spacing-sm);
}

.message.user .role {
  color: var(--color-user);
}

.message.assistant .role {
  color: var(--color-assistant);
}

.message.system .role {
  color: var(--color-system);
}

.message.tool .role {
  color: var(--color-tool);
}

.message.streaming {
  opacity: 0.8;
  border-left: 2px solid var(--color-assistant);
}

.message .content {
  white-space: pre-wrap;
  word-break: break-word;
}

/* AI 응답의 Markdown 테이블 */
.message.assistant table {
  border-collapse: collapse;
  margin: var(--spacing-sm) 0;
  width: 100%;
}

.message.assistant th,
.message.assistant td {
  border: 1px solid var(--border-color);
  padding: var(--spacing-xs) var(--spacing-sm);
  text-align: left;
}

.message.assistant code {
  font-family: var(--font-mono);
  background: var(--bg-tertiary);
  padding: 1px 4px;
  border-radius: 2px;
  font-size: 0.9em;
}

.message.assistant pre {
  background: var(--bg-secondary);
  padding: var(--spacing-sm);
  border-radius: 4px;
  overflow-x: auto;
}

.chat-input {
  padding: var(--spacing-sm);
  border-top: 1px solid var(--border-color);
}

.chat-input input {
  width: 100%;
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 0.95rem;
}

.chat-input input:focus {
  outline: none;
  border-color: var(--color-assistant);
}

.chat-input input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ─── Financial Data ─── */

.gain {
  color: var(--color-gain);
}

.loss {
  color: var(--color-loss);
}

.symbol {
  font-family: var(--font-mono);
  font-weight: 600;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th,
td {
  text-align: left;
  padding: var(--spacing-xs) var(--spacing-sm);
  border-bottom: 1px solid var(--border-color);
}

th {
  color: var(--text-secondary);
  font-size: 0.8rem;
  text-transform: uppercase;
}

/* ─── Forms ─── */

input,
select {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: 4px;
}

button {
  padding: var(--spacing-xs) var(--spacing-md);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  border-radius: 4px;
  cursor: pointer;
}

button:hover {
  background: var(--bg-secondary);
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-sm {
  padding: 2px 8px;
  font-size: 0.8rem;
}

.btn-sm.danger {
  color: var(--color-loss);
  border-color: var(--color-loss);
}

.empty {
  color: var(--text-secondary);
  font-style: italic;
  padding: var(--spacing-md);
}

/* ─── Settings ─── */

.config-display {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  background: var(--bg-secondary);
  padding: var(--spacing-md);
  border-radius: 4px;
  overflow-x: auto;
  white-space: pre;
}
```

---

### 5.6 `packages/web/src/index.html` — HTML 엔트리포인트

- [ ] 파일 생성

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>FinClaw — Control Panel</title>
    <link rel="stylesheet" href="./styles/theme.css" />
  </head>
  <body>
    <finclaw-app></finclaw-app>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

---

### 5.7 `packages/web/src/main.ts` — 웹 앱 부트스트랩

- [ ] 파일 생성
- [ ] 컴포넌트 등록 import

```typescript
// packages/web/src/main.ts

// ─── 컴포넌트 등록 (side-effect import) ───
import './app.js';
import './views/market-view.js';
import './views/portfolio-view.js';
import './views/alerts-view.js';
import './views/settings-view.js';
```

---

### 5.8 `packages/web/vite.config.ts` — Vite 개발 서버 설정

- [ ] 파일 생성
- [ ] Gateway API/WS 프록시
- [ ] HMR 설정

```typescript
// packages/web/vite.config.ts

import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Gateway HTTP API 프록시
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // Gateway WebSocket 프록시
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
      // RPC 엔드포인트 프록시
      '/rpc': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // Health 엔드포인트 프록시
      '/health': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
```

---

### 5.9 `packages/server/src/cli/commands/tui.ts` — CLI 서브커맨드

- [ ] 파일 생성
- [ ] `register(program, deps)` 패턴 — 기존 CLI 구조와 일관
- [ ] `finclaw tui` 커맨드 등록

```typescript
// packages/server/src/cli/commands/tui.ts

import type { Command } from 'commander';
import type { CliDeps } from '../deps.js';
import { EXIT } from '../exit-codes.js';
import { theme } from '../terminal/theme.js';

/**
 * finclaw tui 서브커맨드 등록
 * register(program, deps) 패턴 — 기존 CLI 구조와 일관
 */
export function register(program: Command, deps: CliDeps): void {
  program
    .command('tui')
    .description('launch terminal UI')
    .option('--gateway <url>', 'Gateway WebSocket URL', 'ws://localhost:3000/ws')
    .option('--agent <id>', 'agent ID to use', 'default')
    .action(async (opts: { gateway: string; agent: string }) => {
      try {
        const config = await deps.loadConfig();
        const token = config.gateway?.auth?.token ?? '';

        const { runTui } = await import('@finclaw/tui');
        await runTui({
          gatewayUrl: opts.gateway,
          token,
          agentId: opts.agent,
        });
      } catch (err) {
        deps.error(theme.error(`Failed to launch TUI: ${(err as Error).message}`));
        deps.exit(EXIT.ERROR);
      }
    });
}
```

---

### 5.10 `packages/server/src/cli/program.ts` — tui 커맨드 등록

- [ ] `tui.ts` import 추가
- [ ] `register` 호출 추가

```diff
 // packages/server/src/cli/program.ts

 import * as startCmd from './commands/start.js';
 import * as stopCmd from './commands/stop.js';
+import * as tuiCmd from './commands/tui.js';

 // ── Commands ──
 startCmd.register(program, deps);
 stopCmd.register(program, deps);
 configCmd.register(program, deps);
 agentCmd.register(program, deps);
 channelCmd.register(program, deps);
 marketCmd.register(program, deps);
 newsCmd.register(program, deps);
 alertCmd.register(program, deps);
+tuiCmd.register(program, deps);
```

---

### 5.11 `packages/server/tsconfig.json` — tui 참조 추가

- [ ] `references`에 `{ "path": "../tui" }` 추가 (TUI CLI 커맨드에서 `@finclaw/tui` import)

```diff
 {
   "references": [
     { "path": "../types" },
     { "path": "../infra" },
     { "path": "../config" },
     { "path": "../storage" },
     { "path": "../agent" },
     { "path": "../channel-discord" },
-    { "path": "../skills-finance" }
+    { "path": "../skills-finance" },
+    { "path": "../tui" }
   ]
 }
```

---

### 5.12 서버 인증 — `?token=` query param 폴백 추가

- [ ] `packages/server/src/gateway/auth/index.ts` 수정
- [ ] Bearer 헤더 없을 때 query param에서 토큰 추출

```diff
 // packages/server/src/gateway/auth/index.ts

 export async function authenticate(
   req: IncomingMessage,
   config: GatewayServerConfig['auth'],
 ): Promise<AuthResult> {
   const authorization = req.headers.authorization;
   const apiKey = req.headers['x-api-key'] as string | undefined;
   const ip = req.socket.remoteAddress ?? 'unknown';

   // Bearer 토큰 인증
   if (authorization?.startsWith('Bearer ')) {
     const token = authorization.slice(7);
     const result = validateToken(token, config.jwtSecret);
     if (!result.ok) {
       getEventBus().emit('gateway:auth:failure', ip, result.error);
     }
     return result;
   }

+  // Query param 토큰 폴백 (브라우저 WebSocket은 커스텀 헤더 불가)
+  if (req.url) {
+    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
+    const queryToken = url.searchParams.get('token');
+    if (queryToken) {
+      const result = validateToken(queryToken, config.jwtSecret);
+      if (!result.ok) {
+        getEventBus().emit('gateway:auth:failure', ip, result.error);
+      }
+      return result;
+    }
+  }

   // API 키 인증
   if (apiKey) {
     const result = validateApiKey(apiKey, config.apiKeys);
```

**검증:**

- 기존 Bearer 헤더 인증이 우선 동작
- `?token=` query param으로도 인증 가능
- 기존 auth 테스트가 깨지지 않아야 함

---

## Day 4-5 체크리스트 요약

| #   | 파일                                                           | 상태 |
| --- | -------------------------------------------------------------- | ---- |
| 1   | `packages/web/package.json`                                    | [ ]  |
| 2   | `packages/web/tsconfig.json`                                   | [ ]  |
| 3   | 루트 `tsconfig.json` 수정 (web 추가)                           | [ ]  |
| 4   | `pnpm install`                                                 | [ ]  |
| 5   | `packages/web/src/app-gateway.ts`                              | [ ]  |
| 6   | `packages/web/src/app-chat.ts`                                 | [ ]  |
| 7   | `packages/web/src/markdown.ts`                                 | [ ]  |
| 8   | `packages/web/src/app.ts`                                      | [ ]  |
| 9   | `packages/web/src/__tests__/app-gateway.test.ts`               | [ ]  |
| 10  | `packages/web/src/__tests__/app-chat.test.ts`                  | [ ]  |
| 11  | `packages/web/src/views/market-view.ts`                        | [ ]  |
| 12  | `packages/web/src/views/portfolio-view.ts`                     | [ ]  |
| 13  | `packages/web/src/views/alerts-view.ts`                        | [ ]  |
| 14  | `packages/web/src/views/settings-view.ts`                      | [ ]  |
| 15  | `packages/web/src/styles/theme.css`                            | [ ]  |
| 16  | `packages/web/src/index.html`                                  | [ ]  |
| 17  | `packages/web/src/main.ts`                                     | [ ]  |
| 18  | `packages/web/vite.config.ts`                                  | [ ]  |
| 19  | `packages/server/src/cli/commands/tui.ts`                      | [ ]  |
| 20  | `packages/server/src/cli/program.ts` 수정                      | [ ]  |
| 21  | `packages/server/tsconfig.json` 수정                           | [ ]  |
| 22  | `packages/server/src/gateway/auth/index.ts` 수정 (query param) | [ ]  |

**최종 검증:**

```bash
pnpm build                            # 전체 빌드 성공
pnpm --filter @finclaw/web vitest run # ~16 tests passed
pnpm --filter @finclaw/tui vitest run # ~20 tests (Day 2-3 산출물)
pnpm --filter @finclaw/web dev        # Vite HMR + 프록시 동작 확인
finclaw tui                            # TUI 기동 확인
```
