# Phase 19: TUI & 웹 컨트롤 패널

## 1. 목표

터미널 UI(TUI)와 웹 기반 컨트롤 패널을 구현하여 FinClaw 플랫폼의 두 가지 프론트엔드 인터페이스를 제공한다. 구체적으로:

1. **TUI (Terminal UI)**: 터미널에서 AI 에이전트와 대화하고, 시장 데이터/포트폴리오/알림 상태를 실시간으로 모니터링할 수 있는 채팅 클라이언트. 함수형 팩토리 패턴으로 5개 핸들러 모듈을 조합한다.
2. **웹 UI (Web Control Panel)**: Lit 3 기반 웹 컴포넌트로 구현된 브라우저 대시보드. 채팅 인터페이스, 시장 대시보드, 포트폴리오 뷰, 알림 관리, 설정 편집 기능을 탭 네비게이션으로 제공한다.
3. **공유 백엔드 프로토콜**: 양쪽 프론트엔드 모두 Phase 10-11의 Gateway WebSocket 서버에 동일한 JSON-RPC 프로토콜로 연결한다. 스트리밍 응답, 실시간 시장 데이터, 알림 이벤트를 WebSocket으로 수신한다.
4. **Vite 개발 서버**: 웹 UI를 위한 HMR(Hot Module Replacement) 지원 개발 환경을 제공한다.

OpenClaw의 TUI(37파일, 4,938줄) + UI(100파일, 16,609줄) 대비 FinClaw는 핵심 기능에 집중하여 약 20개 파일, 3,500줄 규모로 구현한다.

---

## 2. OpenClaw 참조

| 참조 문서          | 경로                                              | 적용할 패턴                                                                   |
| ------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| TUI & UI 아키텍처  | `openclaw_review/docs/15.TUI와-웹-컨트롤-패널.md` | TUI 함수형 팩토리 패턴 5개 핸들러, UI 모놀리식 LitElement + Module Delegation |
| TUI & UI Deep Dive | `openclaw_review/deep-dive/15-tui-ui.md`          | Gateway 프로토콜 v3 공유, TUI 위젯 트리, Lit 3 @state 반응형, StreamAssembler |
| Gateway 프로토콜   | `openclaw_review/docs/03.게이트웨이-서버.md`      | WebSocket JSON-RPC 프레임(RequestFrame, ResponseFrame, EventFrame)            |
| OpenClaw TUI 소스  | `openclaw/src/tui/tui.ts`                         | `runTui()` 진입점, `createEditorSubmitHandler()`, `createCommandHandlers()`   |
| OpenClaw UI 소스   | `openclaw/ui/src/ui/app.ts`                       | `OpenClawApp` LitElement, TAB_GROUPS 네비게이션, @state 관리                  |

**핵심 적용 패턴:**

1. **TUI 함수형 팩토리**: OpenClaw의 `createCommandHandlers()`, `createEventHandlers()`, `createSessionActions()` 패턴을 채택. context 파라미터로 의존성 주입, 클로저 내 상태 캡슐화. 테스트 시 context 모킹으로 Pi-TUI 없이 단위 테스트 가능.
2. **UI Module Delegation**: OpenClaw의 `app.ts` + `app-*.ts` 위임 패턴을 축소 적용. 단일 LitElement가 중앙 상태를 관리하되, 기능별 로직은 별도 모듈로 분리.
3. **Shadow DOM 비사용**: OpenClaw과 동일하게 `createRenderRoot() { return this; }`로 글로벌 CSS 직접 사용. FinClaw UI가 페이지 전체를 점유하므로 CSS 충돌 위험 없음.
4. **스트림 어셈블러**: OpenClaw의 `TuiStreamAssembler.ingestDelta()` 패턴으로 LLM 스트리밍 응답을 효율적으로 조립. 변경 없는 delta는 렌더 스킵.
5. **Gateway 재연결**: 지수 백오프(800ms 초기, 1.7배 증가, 15초 상한)로 WebSocket 자동 재연결.

---

## 3. 생성할 파일

### TUI 소스 파일 (6개)

| #   | 파일 경로                   | 설명                                                             | 예상 LOC |
| --- | --------------------------- | ---------------------------------------------------------------- | -------- |
| 1   | `src/tui/index.ts`          | TUI 진입점, `runTui()` 함수, 위젯 트리 구성                      | ~150     |
| 2   | `src/tui/chat.ts`           | 채팅 뷰 (메시지 이력, 입력, 스트리밍 표시)                       | ~180     |
| 3   | `src/tui/dashboard.ts`      | 대시보드 뷰 (시장 개요, 포트폴리오 요약, 활성 알림)              | ~150     |
| 4   | `src/tui/status.ts`         | 상태 바 (연결 상태, 활성 모델, 토큰 사용량)                      | ~60      |
| 5   | `src/tui/navigation.ts`     | 탭 기반 패널 전환 (chat, market, portfolio, alerts, settings)    | ~80      |
| 6   | `src/tui/gateway-client.ts` | Gateway WebSocket 클라이언트 (Node.js ws, 재연결, 이벤트 핸들링) | ~200     |

### 웹 UI 소스 파일 (10개)

| #   | 파일 경로                         | 설명                                             | 예상 LOC |
| --- | --------------------------------- | ------------------------------------------------ | -------- |
| 7   | `src/web/index.html`              | HTML 엔트리포인트                                | ~25      |
| 8   | `src/web/main.ts`                 | 웹 앱 부트스트랩, Gateway 연결 초기화            | ~50      |
| 9   | `src/web/app.ts`                  | FinClawApp LitElement, 중앙 상태 관리, 탭 라우팅 | ~250     |
| 10  | `src/web/app-gateway.ts`          | Gateway WebSocket 연결/이벤트 위임 모듈          | ~150     |
| 11  | `src/web/app-chat.ts`             | 채팅 메시지 송수신/큐 관리 위임 모듈             | ~130     |
| 12  | `src/web/views/market-view.ts`    | 시장 대시보드 뷰 (시세 테이블, 워치리스트)       | ~150     |
| 13  | `src/web/views/portfolio-view.ts` | 포트폴리오 뷰 (보유 종목, P&L 요약)              | ~120     |
| 14  | `src/web/views/alerts-view.ts`    | 알림 관리 뷰 (생성/편집/삭제, 이력)              | ~130     |
| 15  | `src/web/views/settings-view.ts`  | 설정 패널 뷰 (API 키, 모델 선택, 테마)           | ~100     |
| 16  | `src/web/styles/theme.css`        | CSS 테마 변수, 다크/라이트 모드                  | ~120     |

### 설정 파일 (1개)

| #   | 파일 경로                | 설명                              | 예상 LOC |
| --- | ------------------------ | --------------------------------- | -------- |
| 17  | `src/web/vite.config.ts` | Vite 개발 서버 설정 (프록시, HMR) | ~30      |

### 테스트 파일 (4개)

| #   | 파일 경로                                  | 테스트 대상                                      | 예상 LOC |
| --- | ------------------------------------------ | ------------------------------------------------ | -------- |
| 18  | `src/tui/__tests__/chat.test.ts`           | TUI 채팅 핸들러 (메시지 라우팅, 스트림 어셈블리) | ~130     |
| 19  | `src/tui/__tests__/gateway-client.test.ts` | Gateway 클라이언트 (연결, 재연결, 이벤트)        | ~120     |
| 20  | `src/web/__tests__/app-gateway.test.ts`    | 웹 Gateway 연결/이벤트 핸들링                    | ~100     |
| 21  | `src/web/__tests__/app-chat.test.ts`       | 웹 채팅 큐잉/스트리밍 처리                       | ~100     |

**합계: 소스 17개 + 테스트 4개 = 21개 파일, 예상 ~2,500 LOC**

---

## 4. 핵심 인터페이스/타입

### 4.1 공유 Gateway 프로토콜 타입

```typescript
// src/tui/gateway-client.ts (TUI) / src/web/app-gateway.ts (Web) 에서 공유

/** Gateway JSON-RPC 요청 프레임 */
export interface RequestFrame {
  readonly id: number; // 요청 시퀀스 번호 (응답 매칭)
  readonly method: string; // RPC 메서드 (예: "chat.send", "market.quote")
  readonly params?: Record<string, unknown>;
}

/** Gateway JSON-RPC 응답 프레임 */
export interface ResponseFrame {
  readonly id: number; // 요청과 매칭되는 시퀀스 번호
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

/** Gateway 서버 이벤트 프레임 */
export interface EventFrame {
  readonly event: string; // 이벤트 타입
  readonly payload: unknown;
}

/** 채팅 이벤트 페이로드 */
export interface ChatEventPayload {
  readonly runId: string;
  readonly state: 'delta' | 'final' | 'error' | 'tool_use' | 'tool_result';
  readonly message?: string;
  readonly toolName?: string;
  readonly toolInput?: unknown;
  readonly toolResult?: unknown;
}

/** 알림 이벤트 페이로드 */
export interface AlertEventPayload {
  readonly type: 'alert.triggered';
  readonly alertId: string;
  readonly name: string;
  readonly message: string;
  readonly currentValue: string;
  readonly triggeredAt: string;
}

/** 시장 데이터 이벤트 페이로드 */
export interface MarketEventPayload {
  readonly type: 'market.update';
  readonly ticker: string;
  readonly price: number;
  readonly change: number;
  readonly changePercent: number;
}
```

### 4.2 TUI 타입

```typescript
// src/tui/index.ts

/** TUI 패널 식별자 */
export type TuiPanel = 'chat' | 'market' | 'portfolio' | 'alerts' | 'settings';

/** TUI 상태 */
export interface TuiState {
  activePanel: TuiPanel;
  connected: boolean;
  lastError: string | null;
  agentId: string;
  sessionKey: string;
  model: string;
  tokenUsage: number;
}

/** TUI 핸들러 컨텍스트 (팩토리 함수에 전달) */
export interface TuiContext {
  readonly state: TuiState;
  readonly client: GatewayClient;
  readonly logger: Logger;
  readonly updateStatus: (text: string) => void;
  readonly appendChat: (role: 'user' | 'assistant' | 'system', text: string) => void;
  readonly updateAssistant: (text: string) => void;
  readonly finalizeAssistant: (text: string) => void;
  readonly setPanel: (panel: TuiPanel) => void;
}

/** TUI Gateway 클라이언트 인터페이스 */
export interface GatewayClient {
  connect(url: string, token: string): Promise<void>;
  disconnect(): void;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(handler: (event: EventFrame) => void): void;
  onConnected(handler: () => void): void;
  onDisconnected(handler: (reason: string) => void): void;
  readonly isConnected: boolean;
}

/** TUI 팩토리 함수 체계 */
export interface TuiHandlers {
  readonly commandHandlers: {
    handleCommand(value: string): Promise<void>;
    sendMessage(value: string): Promise<void>;
  };
  readonly eventHandlers: {
    handleChatEvent(payload: ChatEventPayload): void;
    handleAlertEvent(payload: AlertEventPayload): void;
    handleMarketEvent(payload: MarketEventPayload): void;
  };
  readonly sessionActions: {
    refreshSession(): Promise<void>;
    loadHistory(): Promise<void>;
    switchAgent(agentId: string): Promise<void>;
  };
  readonly dashboardActions: {
    refreshMarket(): Promise<void>;
    refreshPortfolio(): Promise<void>;
    refreshAlerts(): Promise<void>;
  };
}
```

### 4.3 웹 UI 타입

```typescript
// src/web/app.ts

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';

/** 웹 UI 탭 그룹 */
export const TAB_GROUPS = [
  { label: 'Chat', tabs: ['chat'] as const },
  { label: 'Market', tabs: ['market', 'portfolio'] as const },
  { label: 'Alerts', tabs: ['alerts'] as const },
  { label: 'Settings', tabs: ['settings'] as const },
] as const;

export type WebTab = 'chat' | 'market' | 'portfolio' | 'alerts' | 'settings';

/** 웹 앱 뷰 상태 (Lit @state 관리) */
export interface AppViewState {
  // 연결 상태
  connected: boolean;
  lastError: string | null;
  reconnecting: boolean;

  // 탭 상태
  activeTab: WebTab;

  // 채팅 상태
  chatMessages: ChatMessage[];
  chatStream: string | null; // 스트리밍 중인 응답 텍스트
  chatSending: boolean;
  chatQueue: string[]; // 대기 중인 메시지 큐

  // 시장 상태
  watchlist: WatchlistItem[];
  marketLastUpdated: Date | null;

  // 포트폴리오 상태
  portfolioSummary: PortfolioSummary | null;

  // 알림 상태
  alerts: AlertDefinition[];
  alertHistory: AlertHistory[];

  // 설정 상태
  config: AppConfig;

  // 에이전트 상태
  agentId: string;
  sessionKey: string;
  model: string;
  tokenUsage: number;
}

export interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
  readonly timestamp: Date;
  readonly toolName?: string;
}

export interface WatchlistItem {
  readonly ticker: string;
  readonly name: string;
  readonly price: number;
  readonly change: number;
  readonly changePercent: number;
  readonly updatedAt: Date;
}
```

---

## 5. 구현 상세

### 5.1 TUI 진입점 및 위젯 트리

```typescript
// src/tui/index.ts

import { createGatewayClient } from './gateway-client.js';
import { createChatHandlers } from './chat.js';
import { createDashboardHandlers } from './dashboard.js';
import { createStatusBar } from './status.js';
import { createNavigation } from './navigation.js';

/**
 * TUI 진입점 -- 위젯 트리 구성 및 핸들러 초기화
 *
 * OpenClaw의 runTui() 패턴을 참조:
 * - 함수형 팩토리로 핸들러 생성 (context 주입)
 * - 위젯 트리: header + chatLog + statusBar + footer + input
 */
export async function runTui(options: {
  gatewayUrl: string;
  token: string;
  agentId?: string;
}): Promise<void> {
  const { gatewayUrl, token, agentId = 'default' } = options;

  // 1. 터미널 초기화 (raw mode)
  const term = setupTerminal();

  // 2. 상태 초기화
  const state: TuiState = {
    activePanel: 'chat',
    connected: false,
    lastError: null,
    agentId,
    sessionKey: 'main',
    model: 'unknown',
    tokenUsage: 0,
  };

  // 3. Gateway 클라이언트 생성
  const client = createGatewayClient({
    reconnectOptions: {
      initialDelayMs: 800,
      multiplier: 1.7,
      maxDelayMs: 15_000,
    },
  });

  // 4. 위젯 트리 구성
  const header = createHeader(state);
  const chatArea = createChatArea();
  const statusBar = createStatusBar(state);
  const footer = createFooter(state);
  const input = createInput();

  // 5. TUI 컨텍스트 구성 (팩토리 함수에 주입)
  const context: TuiContext = {
    state,
    client,
    logger: createTuiLogger(),
    updateStatus: (text) => statusBar.update(text),
    appendChat: (role, text) => chatArea.append(role, text),
    updateAssistant: (text) => chatArea.updateLast(text),
    finalizeAssistant: (text) => chatArea.finalizeLast(text),
    setPanel: (panel) => {
      state.activePanel = panel;
      navigation.setActive(panel);
      refreshPanel(panel);
    },
  };

  // 6. 팩토리 함수로 핸들러 생성
  const chatHandlers = createChatHandlers(context);
  const dashboardHandlers = createDashboardHandlers(context);
  const navigation = createNavigation(context);

  // 7. 이벤트 바인딩
  client.onEvent((event) => {
    if (event.event === 'chat') {
      chatHandlers.eventHandlers.handleChatEvent(event.payload as ChatEventPayload);
    } else if (event.event === 'alert.triggered') {
      chatHandlers.eventHandlers.handleAlertEvent(event.payload as AlertEventPayload);
    } else if (event.event === 'market.update') {
      dashboardHandlers.handleMarketEvent(event.payload as MarketEventPayload);
    }
  });

  client.onConnected(() => {
    state.connected = true;
    state.lastError = null;
    statusBar.update('Connected');
    chatHandlers.sessionActions.refreshSession();
  });

  client.onDisconnected((reason) => {
    state.connected = false;
    state.lastError = reason;
    statusBar.update(`Disconnected: ${reason}`);
  });

  // 8. 입력 핸들러 -- OpenClaw의 createEditorSubmitHandler 패턴
  input.onSubmit(async (text: string) => {
    if (text.startsWith('/')) {
      await chatHandlers.commandHandlers.handleCommand(text);
    } else {
      await chatHandlers.commandHandlers.sendMessage(text);
    }
  });

  // 9. 키보드 단축키
  term.onKey((key: string) => {
    if (key === 'tab') navigation.nextPanel();
    if (key === 'q' && term.isCtrl) shutdown();
  });

  // 10. Gateway 연결
  await client.connect(gatewayUrl, token);

  // 11. 초기 데이터 로드
  await chatHandlers.sessionActions.loadHistory();
}
```

### 5.2 TUI 채팅 핸들러 (팩토리 패턴)

```typescript
// src/tui/chat.ts

/**
 * 채팅 핸들러 팩토리 -- OpenClaw의 createCommandHandlers + createEventHandlers 패턴
 * context를 클로저로 캡슐화하여 테스트 시 모킹 용이
 */
export function createChatHandlers(context: TuiContext) {
  // 스트림 어셈블러: delta 이벤트를 조립하여 변경 시에만 렌더
  let currentStreamText = '';
  let currentRunId = '';

  const commandHandlers = {
    /** 슬래시 명령어 처리 */
    async handleCommand(value: string): Promise<void> {
      const [cmd, ...args] = value.slice(1).split(' ');
      switch (cmd) {
        case 'help':
          context.appendChat('system', formatHelpText());
          break;
        case 'market':
          context.setPanel('market');
          break;
        case 'portfolio':
          context.setPanel('portfolio');
          break;
        case 'alerts':
          context.setPanel('alerts');
          break;
        case 'model':
          await switchModel(args[0]);
          break;
        case 'quit':
        case 'exit':
          process.exit(0);
          break;
        default:
          context.appendChat(
            'system',
            `Unknown command: /${cmd}. Type /help for available commands.`,
          );
      }
    },

    /** 일반 메시지 전송 */
    async sendMessage(value: string): Promise<void> {
      context.appendChat('user', value);
      context.updateStatus('Thinking...');

      try {
        await context.client.request('chat.send', {
          sessionKey: context.state.sessionKey,
          message: value,
          idempotencyKey: crypto.randomUUID(),
        });
      } catch (error) {
        context.appendChat(
          'system',
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
        context.updateStatus('Ready');
      }
    },
  };

  const eventHandlers = {
    /** 채팅 이벤트 처리 -- OpenClaw StreamAssembler 패턴 */
    handleChatEvent(payload: ChatEventPayload): void {
      switch (payload.state) {
        case 'delta':
          if (payload.runId !== currentRunId) {
            currentRunId = payload.runId;
            currentStreamText = '';
          }
          if (payload.message && payload.message !== currentStreamText) {
            currentStreamText = payload.message;
            context.updateAssistant(currentStreamText);
          }
          break;

        case 'final':
          context.finalizeAssistant(payload.message ?? currentStreamText);
          currentStreamText = '';
          currentRunId = '';
          context.updateStatus('Ready');
          break;

        case 'tool_use':
          context.appendChat(
            'system',
            `[Tool] ${payload.toolName}(${JSON.stringify(payload.toolInput)})`,
          );
          break;

        case 'tool_result':
          context.appendChat('tool', `[Result] ${JSON.stringify(payload.toolResult)}`);
          break;

        case 'error':
          context.appendChat('system', `[Error] ${payload.message}`);
          context.updateStatus('Ready');
          break;
      }
    },

    /** 알림 이벤트 처리 */
    handleAlertEvent(payload: AlertEventPayload): void {
      context.appendChat('system', `[Alert] ${payload.name}: ${payload.message}`);
    },

    /** 시장 데이터 이벤트 처리 */
    handleMarketEvent(payload: MarketEventPayload): void {
      // 대시보드 패널이 활성일 때만 업데이트
      if (context.state.activePanel === 'market') {
        // dashboard.updateTicker(payload) -- dashboard 모듈에서 처리
      }
    },
  };

  const sessionActions = {
    async refreshSession(): Promise<void> {
      const info = (await context.client.request('session.info', {
        sessionKey: context.state.sessionKey,
      })) as SessionInfo;
      context.state.model = info.model;
      context.state.tokenUsage = info.tokenUsage;
    },

    async loadHistory(): Promise<void> {
      const history = (await context.client.request('chat.history', {
        sessionKey: context.state.sessionKey,
        limit: 50,
      })) as ChatMessage[];
      for (const msg of history) {
        context.appendChat(msg.role, msg.content);
      }
    },

    async switchAgent(agentId: string): Promise<void> {
      context.state.agentId = agentId;
      await context.client.request('session.switchAgent', { agentId });
      await this.refreshSession();
    },
  };

  return { commandHandlers, eventHandlers, sessionActions };
}
```

### 5.3 Gateway WebSocket 클라이언트 (TUI용)

```typescript
// src/tui/gateway-client.ts

import WebSocket from 'ws'; // Node.js WebSocket

interface ReconnectOptions {
  readonly initialDelayMs: number; // 800
  readonly multiplier: number; // 1.7
  readonly maxDelayMs: number; // 15_000
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
  const eventHandlers: Array<(event: EventFrame) => void> = [];
  const connectedHandlers: Array<() => void> = [];
  const disconnectedHandlers: Array<(reason: string) => void> = [];

  let url = '';
  let token = '';

  function handleMessage(data: string): void {
    const frame = JSON.parse(data);

    // 응답 프레임: pending request 해소
    if ('id' in frame && pendingRequests.has(frame.id)) {
      const pending = pendingRequests.get(frame.id)!;
      pendingRequests.delete(frame.id);
      if (frame.error) {
        pending.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }

    // 이벤트 프레임: 등록된 핸들러 호출
    if ('event' in frame) {
      for (const handler of eventHandlers) {
        handler(frame as EventFrame);
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
        for (const handler of connectedHandlers) handler();
        resolve();
      });

      ws.on('message', (data) => handleMessage(data.toString()));

      ws.on('close', (code, reason) => {
        const msg = `disconnected (${code}): ${reason || 'connection lost'}`;
        for (const handler of disconnectedHandlers) handler(msg);
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
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
      ws = null;
    },

    async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error('Not connected to gateway');
      }

      const id = ++sequenceId;
      const frame: RequestFrame = { id, method, params };

      return new Promise((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject });
        ws!.send(JSON.stringify(frame));

        // 30초 타임아웃
        setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id);
            reject(new Error(`Request timeout: ${method}`));
          }
        }, 30_000);
      });
    },

    onEvent(handler) {
      eventHandlers.push(handler);
    },
    onConnected(handler) {
      connectedHandlers.push(handler);
    },
    onDisconnected(handler) {
      disconnectedHandlers.push(handler);
    },
  };
}
```

### 5.4 웹 UI Lit 3 애플리케이션

```typescript
// src/web/app.ts

import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { initGatewayConnection, handleGatewayEvent } from './app-gateway.js';
import { handleSendChat, handleChatEvent, flushChatQueue } from './app-chat.js';

@customElement('finclaw-app')
export class FinClawApp extends LitElement {
  // Shadow DOM 비사용 -- OpenClaw 패턴
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
  @state() alerts: AlertDefinition[] = [];

  @state() agentId = 'default';
  @state() sessionKey = 'main';
  @state() model = '';
  @state() tokenUsage = 0;

  private client: GatewayBrowserClient | null = null;

  // ─── 생명주기 ───

  connectedCallback(): void {
    super.connectedCallback();
    this.client = initGatewayConnection(this);
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
                <span class="content">${msg.content}</span>
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

### 5.5 웹 채팅 큐잉 (OpenClaw 패턴)

```typescript
// src/web/app-chat.ts

import type { FinClawApp } from './app.js';

/**
 * 채팅 메시지 전송 -- OpenClaw의 handleSendChat 큐잉 패턴
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
      sessionKey: app.sessionKey,
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

/** 채팅 이벤트 핸들러 -- 스트리밍 응답 처리 */
export function handleChatEvent(app: FinClawApp, payload: ChatEventPayload): void {
  switch (payload.state) {
    case 'delta':
      app.chatStream = payload.message ?? app.chatStream;
      break;

    case 'final':
      app.chatMessages = [
        ...app.chatMessages,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: payload.message ?? app.chatStream ?? '',
          timestamp: new Date(),
        },
      ];
      app.chatStream = null;
      app.chatSending = false;

      // 큐에 대기 중인 메시지 처리
      flushChatQueue(app);
      break;

    case 'error':
      app.chatMessages = [
        ...app.chatMessages,
        {
          id: crypto.randomUUID(),
          role: 'system',
          content: `[Error] ${payload.message}`,
          timestamp: new Date(),
        },
      ];
      app.chatStream = null;
      app.chatSending = false;
      flushChatQueue(app);
      break;
  }
}

/** 큐에 대기 중인 메시지 순차 전송 */
export function flushChatQueue(app: FinClawApp): void {
  if (app.chatQueue.length === 0) return;
  const [next, ...rest] = app.chatQueue;
  app.chatQueue = rest;
  sendChat(app, next);
}
```

### 5.6 Vite 설정

```typescript
// src/web/vite.config.ts

import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  server: {
    port: 5173,
    proxy: {
      // Gateway WebSocket/HTTP API 프록시
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
});
```

---

## 6. 선행 조건

| 선행 Phase                     | 산출물                               | 사용 목적                      |
| ------------------------------ | ------------------------------------ | ------------------------------ |
| **Phase 2** (인프라)           | 로거                                 | TUI/웹 로깅                    |
| **Phase 3** (설정)             | 설정 로더                            | Gateway URL, 토큰 설정         |
| **Phase 10** (게이트웨이 코어) | WebSocket RPC 서버, JSON-RPC 프레임  | 양쪽 프론트엔드의 백엔드       |
| **Phase 11** (게이트웨이 고급) | 인증, 헬스 체크, 이벤트 브로드캐스트 | 연결 인증, 실시간 이벤트       |
| **Phase 12** (Discord)         | Discord 채널 어댑터                  | 알림 전달 채널 (Phase 18 연동) |
| **Phase 13** (CLI)             | Commander.js CLI 진입점              | `finclaw tui` 서브커맨드 등록  |
| **Phase 16** (시장 데이터)     | 시세 API                             | 시장 대시보드 데이터           |
| **Phase 17** (뉴스)            | 뉴스 API                             | 뉴스 피드 표시                 |
| **Phase 18** (알림)            | 알림 CRUD, 이벤트                    | 알림 관리 뷰, 알림 이벤트 표시 |

### 직접 의존 관계

```
Phase 10-11 (게이트웨이) ──┐
Phase 13 (CLI)            ├──→ Phase 19 (TUI & 웹)
Phase 16-18 (금융 스킬)   ──┘
```

---

## 7. 산출물 및 검증

### 기능 검증 체크리스트

| #   | 검증 항목                                                       | 테스트 방법               | 테스트 tier |
| --- | --------------------------------------------------------------- | ------------------------- | ----------- |
| 1   | TUI 채팅 핸들러: 메시지 -> sendMessage 라우팅                   | unit test: context 모킹   | unit        |
| 2   | TUI 채팅 핸들러: `/help` 슬래시 명령어 처리                     | unit test: context 모킹   | unit        |
| 3   | TUI 스트림 어셈블러: delta -> updateAssistant, 변경 없으면 스킵 | unit test                 | unit        |
| 4   | TUI 스트림 어셈블러: final -> finalizeAssistant                 | unit test                 | unit        |
| 5   | Gateway 클라이언트: 요청-응답 시퀀스 ID 매칭                    | unit test: mock WebSocket | unit        |
| 6   | Gateway 클라이언트: 연결 끊김 시 자동 재연결 (지수 백오프)      | unit test: 타이머 mock    | unit        |
| 7   | Gateway 클라이언트: 요청 30초 타임아웃                          | unit test: fake timers    | unit        |
| 8   | 웹 채팅 큐잉: 첫 메시지 응답 전 두 번째 메시지 큐에 추가        | unit test: app state      | unit        |
| 9   | 웹 채팅 큐잉: final 수신 후 큐에서 다음 메시지 자동 전송        | unit test                 | unit        |
| 10  | 웹 Gateway 모듈: 이벤트 라우팅 (chat/alert/market)              | unit test: mock client    | unit        |
| 11  | Vite 개발 서버: HMR + API 프록시 동작                           | 수동 검증                 | manual      |
| 12  | TUI 탭 네비게이션: tab 키로 패널 전환                           | 수동 검증                 | manual      |

### vitest 실행 기대 결과

```bash
# TUI 테스트 (Pi-TUI 의존 없이 context 모킹)
pnpm vitest run src/tui/__tests__/
# 예상: 2 파일, ~18 tests passed

# 웹 UI 테스트
pnpm vitest run src/web/__tests__/
# 예상: 2 파일, ~14 tests passed

# 총 32 tests
```

---

## 8. 복잡도 및 예상 파일 수

| 항목                     | 값                                                      |
| ------------------------ | ------------------------------------------------------- |
| **복잡도**               | **L** (Large)                                           |
| **소스 파일**            | 17개 (TUI 6 + Web 10 + config 1)                        |
| **테스트 파일**          | 4개                                                     |
| **총 파일 수**           | **21개**                                                |
| **예상 LOC**             | ~2,500                                                  |
| **예상 소요 기간**       | 4-5일                                                   |
| **새 외부 의존성**       | `lit` (웹 UI), `vite` (개발 서버), `ws` (TUI WebSocket) |
| **OpenClaw 대비 축소율** | ~12% (21K LOC -> 2.5K LOC)                              |

### 복잡도 근거 (L 판정)

- **이중 프론트엔드**: TUI(Node.js 터미널)와 Web(브라우저) 두 가지 전혀 다른 런타임 환경
- **WebSocket 프로토콜 구현**: 요청-응답 매칭, 이벤트 라우팅, 재연결 로직
- **스트리밍 처리**: LLM 응답의 delta/final 이벤트 조립, 변경 감지 최적화
- **큐잉 메커니즘**: 동시 메시지 전송 시 순서 보장
- **다중 뷰**: 5개 탭(chat, market, portfolio, alerts, settings) 각각의 렌더링 로직
- **외부 의존성 3개**: lit, vite, ws를 프로젝트에 처음 도입

### OpenClaw 대비 축소 범위

| OpenClaw 기능              | FinClaw 포함 여부 | 비고                                |
| -------------------------- | ----------------- | ----------------------------------- |
| Pi-TUI 위젯 트리           | 단순화            | 커스텀 위젯 대신 기본 터미널 출력   |
| Lit 3 웹 컴포넌트          | 포함              | 5개 탭으로 축소 (OpenClaw: 10개 탭) |
| Ed25519 디바이스 인증      | 제외              | 토큰 기반 인증만                    |
| 130개 @state               | ~15개             | 핵심 상태만                         |
| Canvas Host                | 제외              | 내장 웹 콘텐츠 불필요               |
| 다국어 지원                | 제외              | 한국어/영어만                       |
| Playwright 브라우저 테스트 | 제외              | Vitest Node.js 테스트만             |
