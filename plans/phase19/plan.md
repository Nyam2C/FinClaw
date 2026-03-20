# Phase 19: TUI & 웹 컨트롤 패널

## 1. 목표

터미널 UI(TUI)와 웹 기반 컨트롤 패널을 구현하여 FinClaw 플랫폼의 두 가지 프론트엔드 인터페이스를 제공한다. 구체적으로:

1. **TUI (Terminal UI)**: Ink v6 (React for CLI) 기반 터미널 채팅 클라이언트. `packages/tui` 패키지로 독립 구성. AI 에이전트와 대화하고, 시장 데이터/포트폴리오/알림 상태를 실시간으로 모니터링한다.
2. **웹 UI (Web Control Panel)**: Lit 3 기반 웹 컴포넌트로 구현된 브라우저 대시보드. `packages/web` 패키지로 독립 구성. 채팅 인터페이스, 시장 대시보드, 포트폴리오 뷰, 알림 관리, 설정 편집 기능을 탭 네비게이션으로 제공한다.
3. **공유 백엔드 프로토콜**: 양쪽 프론트엔드 모두 Phase 10-11의 Gateway WebSocket 서버에 동일한 JSON-RPC 2.0 프로토콜로 연결한다. 서버는 `JsonRpcNotification` (`{jsonrpc:'2.0', method, params}`) 형식으로 스트리밍 응답, 실시간 시장 데이터, 알림 이벤트를 WebSocket으로 푸시한다.
4. **Vite 개발 서버**: 웹 UI를 위한 HMR(Hot Module Replacement) 지원 개발 환경을 제공한다.

OpenClaw의 TUI(37파일, 4,938줄) + UI(100파일, 16,609줄) 대비 FinClaw는 핵심 기능에 집중하여 약 28개 파일, ~3,200줄 규모로 구현한다.

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

1. **TUI Ink v6**: React for CLI. `<Static>` 기반 채팅 로그(깜박임 없는 스트리밍), 함수형 컴포넌트 + hooks로 상태 관리. tsconfig에 `react-jsx` 설정.
2. **UI Module Delegation**: OpenClaw의 `app.ts` + `app-*.ts` 위임 패턴을 축소 적용. 단일 LitElement가 중앙 상태를 관리하되, 기능별 로직은 별도 모듈로 분리.
3. **Shadow DOM 비사용**: OpenClaw과 동일하게 `createRenderRoot() { return this; }`로 글로벌 CSS 직접 사용. FinClaw UI가 페이지 전체를 점유하므로 CSS 충돌 위험 없음.
4. **스트림 어셈블러**: 서버가 `chat.stream.delta` notification으로 증분 텍스트 조각을 전송. 클라이언트는 `currentStreamText += delta`로 누적 조립. (OpenClaw의 전체 텍스트 교체 방식과 다름)
5. **Gateway 재연결**: 지수 백오프(800ms 초기, 1.7배 증가, 15초 상한)로 WebSocket 자동 재연결.

### OpenClaw ↔ FinClaw 번역 테이블

> **주의:** OpenClaw 코드를 그대로 복사하면 작동하지 않는 항목들. 반드시 FinClaw 서버 구현에 맞게 변환할 것.

| OpenClaw 용어 / 패턴                | FinClaw 서버 실제                                              | 근거                                           |
| ----------------------------------- | -------------------------------------------------------------- | ---------------------------------------------- |
| `EventFrame { event, payload }`     | `JsonRpcNotification { jsonrpc:'2.0', method, params }`        | `rpc/types.ts:53-57`, `broadcaster.ts:108-112` |
| `sessionKey`                        | `sessionId` (`chat.start` 반환값)                              | `chat.ts:8,38`, `session.ts:8,12`              |
| `market.quote` + `{ ticker }`       | `finance.quote` + `{ symbol }`                                 | `finance.ts:8-12`, `types/gateway.ts:16`       |
| `session.info`                      | `session.get`                                                  | `session.ts:9`, `types/gateway.ts:6`           |
| delta 전체 텍스트 교체 (`!==` 비교) | 증분 delta 누적 (`+=`)                                         | `broadcaster.ts:68-97` (bufferDelta)           |
| `{ id, method, params }`            | `{ jsonrpc:'2.0', id, method, params }`                        | `types/gateway.ts:30-35` (RpcRequest)          |
| `event.event === 'chat'` 분기       | method 기반: `chat.stream.delta/end/error/tool_start/tool_end` | `broadcaster.ts:33-66`                         |

---

## 3. 생성할 파일

### 패키지 설정 (4개)

| #   | 파일 경로                    | 설명                                                | 예상 LOC |
| --- | ---------------------------- | --------------------------------------------------- | -------- |
| 1   | `packages/tui/package.json`  | TUI 패키지 — ink, react, ws, @finclaw/types         | ~20      |
| 2   | `packages/tui/tsconfig.json` | react-jsx, 프로젝트 참조 (types)                    | ~15      |
| 3   | `packages/web/package.json`  | Web 패키지 — lit, marked, dompurify, @finclaw/types | ~20      |
| 4   | `packages/web/tsconfig.json` | DOM lib, 프로젝트 참조 (types)                      | ~15      |

### TUI 소스 파일 (6개) — `packages/tui/src/`

| #   | 파일 경로                            | 설명                                        | 예상 LOC |
| --- | ------------------------------------ | ------------------------------------------- | -------- |
| 5   | `packages/tui/src/index.ts`          | Ink render 진입점 + `runTui()` 함수         | ~50      |
| 6   | `packages/tui/src/App.tsx`           | Ink 루트 컴포넌트, 패널 라우팅              | ~120     |
| 7   | `packages/tui/src/ChatView.tsx`      | `<Static>` 기반 채팅 (깜박임 없는 스트리밍) | ~150     |
| 8   | `packages/tui/src/DashboardView.tsx` | 시장/포트폴리오/알림 요약                   | ~120     |
| 9   | `packages/tui/src/StatusBar.tsx`     | 연결 상태, 모델 정보                        | ~50      |
| 10  | `packages/tui/src/gateway-client.ts` | ws 패키지 기반 WebSocket + JSON-RPC 2.0     | ~200     |

### 웹 UI 소스 파일 (11개) — `packages/web/src/`

| #   | 파일 경로                                  | 설명                                                  | 예상 LOC |
| --- | ------------------------------------------ | ----------------------------------------------------- | -------- |
| 11  | `packages/web/src/index.html`              | HTML 엔트리포인트                                     | ~25      |
| 12  | `packages/web/src/main.ts`                 | 웹 앱 부트스트랩, Gateway 연결 초기화                 | ~50      |
| 13  | `packages/web/src/app.ts`                  | FinClawApp LitElement, 중앙 상태 관리, 탭 라우팅      | ~250     |
| 14  | `packages/web/src/app-gateway.ts`          | Gateway WebSocket 연결/이벤트 위임 모듈               | ~150     |
| 15  | `packages/web/src/app-chat.ts`             | 채팅 메시지 송수신/큐 관리 위임 모듈                  | ~130     |
| 16  | `packages/web/src/markdown.ts`             | marked + DOMPurify (AI 응답 표/목록 렌더링, XSS 방어) | ~60      |
| 17  | `packages/web/src/views/market-view.ts`    | 시장 대시보드 뷰 (시세 테이블, 워치리스트)            | ~150     |
| 18  | `packages/web/src/views/portfolio-view.ts` | 포트폴리오 뷰 (보유 종목, P&L 요약)                   | ~120     |
| 19  | `packages/web/src/views/alerts-view.ts`    | 알림 관리 뷰 (생성/편집/삭제, 이력)                   | ~130     |
| 20  | `packages/web/src/views/settings-view.ts`  | 설정 패널 뷰 (API 키, 모델 선택, 테마)                | ~100     |
| 21  | `packages/web/src/styles/theme.css`        | CSS 테마 변수, 다크/라이트 모드, 금융 도메인 색상     | ~140     |

### 공유 타입 (1개)

| #   | 파일 경로                            | 설명                                                                  | 예상 LOC |
| --- | ------------------------------------ | --------------------------------------------------------------------- | -------- |
| 22  | `packages/types/src/notification.ts` | JsonRpcNotification, Stream params, BroadcastChannel (공유 타입 추출) | ~40      |

### 설정 파일 (1개)

| #   | 파일 경로                     | 설명                                  | 예상 LOC |
| --- | ----------------------------- | ------------------------------------- | -------- |
| 23  | `packages/web/vite.config.ts` | Vite 8.0 개발 서버 설정 (프록시, HMR) | ~35      |

### CLI 서브커맨드 (1개)

| #   | 파일 경로                                 | 설명                          | 예상 LOC |
| --- | ----------------------------------------- | ----------------------------- | -------- |
| 24  | `packages/server/src/cli/commands/tui.ts` | `finclaw tui` 서브커맨드 등록 | ~30      |

### 테스트 파일 (4개)

| #   | 파일 경로                                           | 테스트 대상                                      | 예상 LOC |
| --- | --------------------------------------------------- | ------------------------------------------------ | -------- |
| 25  | `packages/tui/src/__tests__/chat.test.ts`           | TUI 채팅 핸들러 (메시지 라우팅, 스트림 어셈블리) | ~130     |
| 26  | `packages/tui/src/__tests__/gateway-client.test.ts` | Gateway 클라이언트 (연결, 재연결, 이벤트)        | ~120     |
| 27  | `packages/web/src/__tests__/app-gateway.test.ts`    | 웹 Gateway 연결/이벤트 핸들링                    | ~100     |
| 28  | `packages/web/src/__tests__/app-chat.test.ts`       | 웹 채팅 큐잉/스트리밍 처리                       | ~100     |

**합계: 패키지설정 4 + 소스 20 + 테스트 4 = 28개 파일, 예상 ~3,200 LOC**

---

## 4. 핵심 인터페이스/타입

### 4.1 공유 Gateway 프로토콜 타입

> **설계 원칙:** 서버의 `@finclaw/types/gateway.ts`에 이미 `RpcRequest`, `RpcResponse`, `RpcError`가 정의되어 있다. 이를 재정의하지 않고 import하여 사용한다. `JsonRpcNotification`은 현재 `packages/server/src/gateway/rpc/types.ts`에만 존재하므로, `@finclaw/types/notification.ts`로 추출하여 TUI/Web에서도 공유한다.

```typescript
// packages/types/src/notification.ts — 신규 생성

/** JSON-RPC 2.0 알림 (서버 → 클라이언트, id 없음) */
export interface JsonRpcNotification<T = Record<string, unknown>> {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: T;
}

// ─── 채팅 스트리밍 notification params ───

/** chat.stream.delta — 증분 텍스트 조각 */
export interface ChatStreamDeltaParams {
  readonly sessionId: string;
  readonly delta: string; // 증분 텍스트 (전체가 아님, += 로 누적)
}

/** chat.stream.end — 스트리밍 완료 */
export interface ChatStreamEndParams {
  readonly sessionId: string;
  readonly result: unknown;
}

/** chat.stream.error — 스트리밍 에러 */
export interface ChatStreamErrorParams {
  readonly sessionId: string;
  readonly error: string;
}

/** chat.stream.tool_start — 도구 호출 시작 */
export interface ChatStreamToolStartParams {
  readonly sessionId: string;
  readonly toolCall: { readonly name: string; readonly input: unknown };
}

/** chat.stream.tool_end — 도구 호출 결과 */
export interface ChatStreamToolEndParams {
  readonly sessionId: string;
  readonly result: unknown;
}

/** 브로드캐스트 채널 (서버 rpc/types.ts의 BroadcastChannel과 동일) */
export type BroadcastChannel = 'config.updated' | 'session.event' | 'system.status' | 'market.tick';
```

### 4.2 TUI 타입

```typescript
// packages/tui/src/App.tsx

/** TUI 패널 식별자 */
export type TuiPanel = 'chat' | 'market' | 'portfolio' | 'alerts' | 'settings';

/** TUI 상태 */
export interface TuiState {
  activePanel: TuiPanel;
  connected: boolean;
  lastError: string | null;
  agentId: string;
  sessionId: string; // chat.start 반환값, 초기 ''
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
  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void;
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
  readonly streamHandlers: {
    /** method 기반 notification 라우팅 */
    handleStreamNotification(method: string, params: Record<string, unknown>): void;
  };
  readonly sessionActions: {
    startSession(agentId: string): Promise<string>; // sessionId 반환
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
// packages/web/src/app.ts

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
  chatStream: string | null; // 스트리밍 중인 응답 텍스트 (증분 누적)
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
  sessionId: string; // chat.start 반환값, 초기 ''
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
  readonly symbol: string; // finance.quote의 symbol 파라미터와 일치
  readonly name: string;
  readonly price: number;
  readonly change: number;
  readonly changePercent: number;
  readonly updatedAt: Date;
}
```

---

## 5. 구현 상세

### 5.1 TUI 진입점 및 Ink 컴포넌트 트리

```typescript
// packages/tui/src/index.ts

import { render } from 'ink';
import React from 'react';
import { App } from './App.js';

/**
 * TUI 진입점 -- Ink v6 render
 */
export async function runTui(options: {
  gatewayUrl: string;
  token: string;
  agentId?: string;
}): Promise<void> {
  const { gatewayUrl, token, agentId = 'default' } = options;

  const { waitUntilExit } = render(React.createElement(App, { gatewayUrl, token, agentId }));

  await waitUntilExit();
}
```

```typescript
// packages/tui/src/App.tsx — Ink 루트 컴포넌트 스케치

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { createGatewayClient } from './gateway-client.js';
import { ChatView } from './ChatView.js';
import { DashboardView } from './DashboardView.js';
import { StatusBar } from './StatusBar.js';

interface AppProps {
  gatewayUrl: string;
  token: string;
  agentId: string;
}

export function App({ gatewayUrl, token, agentId }: AppProps) {
  const { exit } = useApp();
  const [panel, setPanel] = useState<TuiPanel>('chat');
  const [connected, setConnected] = useState(false);
  const [sessionId, setSessionId] = useState(''); // chat.start 호출 후 동적 획득
  const [model, setModel] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamText, setStreamText] = useState('');

  // Gateway 클라이언트 (한 번만 생성)
  const [client] = useState(() =>
    createGatewayClient({
      reconnectOptions: { initialDelayMs: 800, multiplier: 1.7, maxDelayMs: 15_000 },
    }),
  );

  // 연결 + 세션 시작
  useEffect(() => {
    (async () => {
      client.onConnected(async () => {
        setConnected(true);
        // chat.start → sessionId 획득
        const result = await client.request('chat.start', { agentId }) as { sessionId: string };
        setSessionId(result.sessionId);

        // session.get으로 모델 정보 획득
        const info = await client.request('session.get', { sessionId: result.sessionId }) as SessionInfo;
        setModel(info.model);
      });

      client.onDisconnected(() => setConnected(false));

      // notification 라우팅 (method 기반)
      client.onNotification((method, params) => {
        switch (method) {
          case 'chat.stream.delta':
            // 증분 누적
            setStreamText((prev) => prev + (params as ChatStreamDeltaParams).delta);
            break;
          case 'chat.stream.end':
            setMessages((prev) => [...prev, { role: 'assistant', content: streamText /* finalize */ }]);
            setStreamText('');
            break;
          case 'chat.stream.error':
            setMessages((prev) => [...prev, { role: 'system', content: `[Error] ${(params as ChatStreamErrorParams).error}` }]);
            setStreamText('');
            break;
          case 'chat.stream.tool_start':
            setMessages((prev) => [...prev, { role: 'system', content: `[Tool] ${(params as ChatStreamToolStartParams).toolCall.name}` }]);
            break;
          case 'chat.stream.tool_end':
            setMessages((prev) => [...prev, { role: 'tool', content: JSON.stringify((params as ChatStreamToolEndParams).result) }]);
            break;
        }
      });

      await client.connect(gatewayUrl, token);
    })();

    return () => client.disconnect();
  }, []);

  // 키보드 단축키
  useInput((input, key) => {
    if (key.tab) {
      const panels: TuiPanel[] = ['chat', 'market', 'portfolio', 'alerts', 'settings'];
      setPanel((prev) => panels[(panels.indexOf(prev) + 1) % panels.length]);
    }
    if (input === 'q' && key.ctrl) exit();
  });

  // 메시지 전송
  const sendMessage = async (text: string) => {
    if (!sessionId) return;
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    await client.request('chat.send', {
      sessionId,
      message: text,
      idempotencyKey: crypto.randomUUID(),
    });
  };

  return (
    <Box flexDirection="column" height="100%">
      <StatusBar connected={connected} model={model} panel={panel} />
      {panel === 'chat'
        ? <ChatView messages={messages} streamText={streamText} onSend={sendMessage} />
        : <DashboardView panel={panel} client={client} />}
    </Box>
  );
}
```

### 5.2 TUI 채팅 핸들러 (method 기반 notification 라우팅)

```typescript
// packages/tui/src/ChatView.tsx

/**
 * 채팅 뷰 — Ink <Static> 기반 (확정된 메시지는 재렌더 없음)
 *
 * notification 라우팅은 App.tsx에서 method 기반으로 처리:
 * - 'chat.stream.delta' → currentStreamText += delta (증분 누적)
 * - 'chat.stream.end' → finalize (메시지 확정)
 * - 'chat.stream.tool_start' → 도구 호출 표시
 * - 'chat.stream.tool_end' → 도구 결과 표시
 * - 'chat.stream.error' → 에러 표시
 */

import React, { useState } from 'react';
import { Box, Text, Static, TextInput } from 'ink';

interface ChatViewProps {
  messages: ChatMessage[];
  streamText: string;
  onSend: (text: string) => Promise<void>;
}

export function ChatView({ messages, streamText, onSend }: ChatViewProps) {
  const [input, setInput] = useState('');

  const handleSubmit = async (value: string) => {
    if (!value.trim()) return;
    if (value.startsWith('/')) {
      // 슬래시 명령어 처리
      handleCommand(value);
    } else {
      await onSend(value);
    }
    setInput('');
  };

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* 확정된 메시지 (재렌더 없음) */}
      <Static items={messages}>
        {(msg, i) => (
          <Box key={i}>
            <Text color={msg.role === 'user' ? 'blue' : msg.role === 'assistant' ? 'green' : 'gray'}>
              [{msg.role}] {msg.content}
            </Text>
          </Box>
        )}
      </Static>

      {/* 스트리밍 중인 응답 */}
      {streamText && (
        <Box>
          <Text color="green" dimColor>[assistant] {streamText}▊</Text>
        </Box>
      )}

      {/* 입력 */}
      <Box>
        <Text color="cyan">&gt; </Text>
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
      </Box>
    </Box>
  );
}
```

### 5.3 Gateway WebSocket 클라이언트 (TUI용)

```typescript
// packages/tui/src/gateway-client.ts

import WebSocket from 'ws'; // Node.js WebSocket — 커스텀 헤더(Authorization) 필요
import type { RpcRequest } from '@finclaw/types';
import type { JsonRpcNotification } from '@finclaw/types/notification.js';

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
  const notificationHandlers: Array<(method: string, params: Record<string, unknown>) => void> = [];
  const connectedHandlers: Array<() => void> = [];
  const disconnectedHandlers: Array<(reason: string) => void> = [];

  let url = '';
  let token = '';

  function handleMessage(data: string): void {
    const frame = JSON.parse(data);

    // 응답 프레임: id가 있고 pending request에 매칭
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
      const frame: RpcRequest = { jsonrpc: '2.0', id, method: method as any, params };

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
```

### 5.4 웹 UI Lit 3 애플리케이션

```typescript
// packages/web/src/app.ts

import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { initGatewayConnection, handleGatewayNotification } from './app-gateway.js';
import { handleSendChat, handleStreamNotification, flushChatQueue } from './app-chat.js';
import { renderMarkdown } from './markdown.js';

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
  @state() chatStream: string | null = null; // 증분 누적 텍스트
  @state() chatSending = false;
  @state() chatQueue: string[] = [];

  @state() watchlist: WatchlistItem[] = [];
  @state() portfolioSummary: PortfolioSummary | null = null;
  @state() alerts: AlertDefinition[] = [];

  @state() agentId = 'default';
  @state() sessionId = ''; // chat.start 반환값, 초기 비어있음
  @state() model = '';
  @state() tokenUsage = 0;

  client: GatewayBrowserClient | null = null;

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
                <span class="content"
                  >${msg.role === 'assistant'
                    ? renderMarkdown(msg.content) // finalized 메시지만 Markdown 렌더링
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

### 5.5 웹 채팅 큐잉 (method 기반 notification 라우팅)

```typescript
// packages/web/src/app-chat.ts

import type { FinClawApp } from './app.js';
import type {
  ChatStreamDeltaParams,
  ChatStreamEndParams,
  ChatStreamErrorParams,
} from '@finclaw/types/notification.js';

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
  sendChat(app, next);
}
```

### 5.6 Vite 설정

```typescript
// packages/web/vite.config.ts — Vite 8.0

import { defineConfig } from 'vite';

export default defineConfig({
  root: '.', // 패키지 루트 기준
  server: {
    port: 5173,
    strictPort: true,
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
    outDir: 'dist',
    emptyOutDir: true,
  },
});
```

### 5.7 Markdown 렌더링

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

### 5.8 CSS 테마 (금융 도메인 특화)

```css
/* packages/web/src/styles/theme.css */

:root {
  /* 기본 색상 */
  --bg-primary: #0a0e17;
  --bg-secondary: #111827;
  --text-primary: #e5e7eb;
  --text-secondary: #9ca3af;
  --border-color: #1f2937;

  /* 금융 도메인 색상 */
  --color-gain: #10b981; /* 상승 — 녹색 */
  --color-loss: #ef4444; /* 하락 — 적색 */
  --color-neutral: #6b7280; /* 보합 — 회색 */
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
}
```

### 5.9 Gateway 타입 추출

`packages/types/src/notification.ts`에 아래 타입을 정의한다 (§4.1 참조):

- `JsonRpcNotification<T>` — 서버 `rpc/types.ts`에서 추출
- `ChatStreamDeltaParams`, `ChatStreamEndParams`, `ChatStreamErrorParams`, `ChatStreamToolStartParams`, `ChatStreamToolEndParams`
- `BroadcastChannel` — 서버 `rpc/types.ts`에서 추출

`packages/types/src/index.ts`에 `export * from './notification.js'` 추가.

서버의 `rpc/types.ts`는 `JsonRpcNotification`을 `@finclaw/types/notification.js`에서 import하도록 변경. (기존 서버 코드와의 호환성 유지)

### 5.10 CLI 서브커맨드

```typescript
// packages/server/src/cli/commands/tui.ts

import type { Command } from 'commander';
import type { ServerDeps } from '../types.js';

/**
 * finclaw tui 서브커맨드 등록
 * register(program, deps) 패턴 — 기존 CLI 구조와 일관
 */
export function register(program: Command, deps: ServerDeps): void {
  program
    .command('tui')
    .description('터미널 UI 시작')
    .option('--gateway <url>', 'Gateway WebSocket URL', 'ws://localhost:3000/ws')
    .option('--agent <id>', '사용할 에이전트 ID', 'default')
    .action(async (opts) => {
      const { runTui } = await import('@finclaw/tui');
      await runTui({
        gatewayUrl: opts.gateway,
        token: deps.config.auth.token,
        agentId: opts.agent,
      });
    });
}

// packages/server/src/cli/program.ts 에 추가:
// import { register as registerTui } from './commands/tui.js';
// registerTui(program, deps);
```

### 5.11 브라우저 WS 인증

브라우저 `WebSocket` API는 커스텀 헤더를 지원하지 않으므로, query parameter 폴백이 필요하다.

```typescript
// packages/web/src/app-gateway.ts 에서:
const wsUrl = `${baseUrl}/ws?token=${encodeURIComponent(token)}`;
const ws = new WebSocket(wsUrl);
```

서버 auth 함수 (`packages/server/src/gateway/ws/connection.ts`)에서 query param 토큰 추출 로직이 이미 구현되어 있는지 확인할 것. 미구현 시 다음 패턴으로 추가:

```typescript
// 서버 ws connection 핸들러에서:
function extractToken(req: IncomingMessage): string | null {
  // 1. Authorization 헤더 (TUI)
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);

  // 2. Query param 폴백 (브라우저)
  const url = new URL(req.url ?? '', `http://${req.headers.host}`);
  return url.searchParams.get('token');
}
```

### 5.12 구현 순서

의존성 기반 5일 가이드:

| Day   | 작업                                 | 산출물                                                                                | 의존  |
| ----- | ------------------------------------ | ------------------------------------------------------------------------------------- | ----- |
| **1** | 공유 타입 추출 + 패키지 scaffolding  | `notification.ts`, `packages/tui/package.json`, `packages/web/package.json`, tsconfig | 없음  |
| **2** | TUI gateway-client + 테스트          | `gateway-client.ts`, `gateway-client.test.ts`                                         | Day 1 |
| **3** | TUI Ink 컴포넌트 + 채팅 테스트       | `App.tsx`, `ChatView.tsx`, `DashboardView.tsx`, `StatusBar.tsx`, `chat.test.ts`       | Day 2 |
| **4** | Web Lit 앱 + gateway + chat + 테스트 | `app.ts`, `app-gateway.ts`, `app-chat.ts`, `markdown.ts`, 테스트 2개                  | Day 1 |
| **5** | Web views + CSS + Vite + CLI 커맨드  | views 4개, `theme.css`, `vite.config.ts`, `tui.ts` CLI                                | Day 4 |

Day 2-3 (TUI)와 Day 4 (Web)는 독립적으로 병렬 진행 가능.

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

| #   | 검증 항목                                                                  | 테스트 방법               | 테스트 tier |
| --- | -------------------------------------------------------------------------- | ------------------------- | ----------- |
| 1   | TUI 채팅 핸들러: 메시지 -> sendMessage 라우팅                              | unit test: context 모킹   | unit        |
| 2   | TUI 채팅 핸들러: `/help` 슬래시 명령어 처리                                | unit test: context 모킹   | unit        |
| 3   | TUI 스트림: `chat.stream.delta` → `currentStreamText += delta` (증분 누적) | unit test                 | unit        |
| 4   | TUI 스트림: `chat.stream.end` → finalizeAssistant                          | unit test                 | unit        |
| 5   | Gateway 클라이언트: 요청-응답 시퀀스 ID 매칭                               | unit test: mock WebSocket | unit        |
| 6   | Gateway 클라이언트: 연결 끊김 시 자동 재연결 (지수 백오프)                 | unit test: 타이머 mock    | unit        |
| 7   | Gateway 클라이언트: 요청 30초 타임아웃                                     | unit test: fake timers    | unit        |
| 8   | 웹 채팅 큐잉: 첫 메시지 응답 전 두 번째 메시지 큐에 추가                   | unit test: app state      | unit        |
| 9   | 웹 채팅 큐잉: `chat.stream.end` 수신 후 큐에서 다음 메시지 자동 전송       | unit test                 | unit        |
| 10  | 웹 Gateway 모듈: method 기반 notification 라우팅                           | unit test: mock client    | unit        |
| 11  | Vite 개발 서버: HMR + API 프록시 동작                                      | 수동 검증                 | manual      |
| 12  | TUI 탭 네비게이션: tab 키로 패널 전환                                      | 수동 검증                 | manual      |
| 13  | JSON-RPC 2.0 규격 준수: 모든 요청에 `jsonrpc:'2.0'` 포함                   | unit test: 프레임 검증    | unit        |
| 14  | sessionId 획득 흐름: `chat.start` → sessionId 저장 → 후속 요청에 사용      | unit test                 | unit        |
| 15  | `finance.quote` 파라미터: `{ symbol }` (not `{ ticker }`)                  | unit test                 | unit        |
| 16  | Markdown XSS 방어: `<script>` 태그 제거 확인                               | unit test: DOMPurify      | unit        |
| 17  | 브라우저 WS query param 인증: `?token=` 폴백                               | unit test                 | unit        |
| 18  | `session.get` 호출 (not `session.info`)                                    | unit test: 메서드명 검증  | unit        |

### vitest 실행 기대 결과

```bash
# TUI 테스트
pnpm --filter @finclaw/tui vitest run
# 예상: 2 파일, ~20 tests passed

# 웹 UI 테스트
pnpm --filter @finclaw/web vitest run
# 예상: 2 파일, ~16 tests passed

# 총 ~36 tests
```

---

## 8. 복잡도 및 예상 파일 수

| 항목                     | 값                                                                           |
| ------------------------ | ---------------------------------------------------------------------------- |
| **복잡도**               | **L** (Large)                                                                |
| **소스 파일**            | 20개 (TUI 6 + Web 11 + 공유타입 1 + CLI 1 + Vite 1)                          |
| **패키지 설정**          | 4개 (packages/tui, packages/web의 package.json + tsconfig.json)              |
| **테스트 파일**          | 4개                                                                          |
| **총 파일 수**           | **28개**                                                                     |
| **예상 LOC**             | ~3,200                                                                       |
| **예상 소요 기간**       | 5일                                                                          |
| **새 외부 의존성**       | TUI: `ink`, `react`, `ws` / Web: `lit`, `vite@^8.0.0`, `marked`, `dompurify` |
| **OpenClaw 대비 축소율** | ~15% (21K LOC → 3.2K LOC)                                                    |

### 루트 프로젝트 설정 변경

- `tsconfig.json`: `references`에 `packages/tui`, `packages/web` 추가
- `packages/server/tsconfig.json`: `references`에 `../tui`, `../web` 추가 (TUI CLI 커맨드)
- `pnpm-workspace.yaml`: 이미 `packages/*` glob이므로 변경 불필요

### 복잡도 근거 (L 판정)

- **이중 프론트엔드**: TUI(Node.js 터미널, Ink/React)와 Web(브라우저, Lit) 두 가지 전혀 다른 런타임 환경
- **WebSocket 프로토콜 구현**: JSON-RPC 2.0 요청-응답 매칭, notification 라우팅, 재연결 로직
- **스트리밍 처리**: 서버의 150ms 배치 delta를 증분 누적(`+=`)으로 조립
- **큐잉 메커니즘**: 동시 메시지 전송 시 순서 보장
- **다중 뷰**: 5개 탭(chat, market, portfolio, alerts, settings) 각각의 렌더링 로직
- **외부 의존성 7개**: ink, react, ws, lit, vite, marked, dompurify를 프로젝트에 처음 도입

### OpenClaw 대비 축소 범위

| OpenClaw 기능              | FinClaw 포함 여부 | 비고                                |
| -------------------------- | ----------------- | ----------------------------------- |
| Pi-TUI 위젯 트리           | Ink v6 대체       | React for CLI, 더 간결한 API        |
| Lit 3 웹 컴포넌트          | 포함              | 5개 탭으로 축소 (OpenClaw: 10개 탭) |
| Ed25519 디바이스 인증      | 제외              | 토큰 기반 인증만                    |
| 130개 @state               | ~15개             | 핵심 상태만                         |
| Canvas Host                | 제외              | 내장 웹 콘텐츠 불필요               |
| 다국어 지원                | 제외              | 한국어/영어만                       |
| Playwright 브라우저 테스트 | 제외              | Vitest Node.js 테스트만             |

### 명시적 제외 사항 (과잉 엔지니어링 방지)

다음 항목은 Phase 19 범위에서 **의도적으로 제외**한다. 필요 시 후속 Phase에서 추가.

- **Ed25519 디바이스 인증** — 토큰 인증으로 충분
- **Canvas Host** (내장 웹 콘텐츠 렌더링) — 불필요
- **Playwright E2E 테스트** — Vitest 단위 테스트로 커버
- **PWA (Service Worker, 오프라인)** — 서버 항시 연결 전제
- **CSS-in-JS** — 글로벌 CSS + Shadow DOM 비사용으로 충분
- **i18n 프레임워크** — 하드코딩 한국어/영어
- **WebSocket 메시지 압축 (permessage-deflate)** — 메시지 크기가 작아 불필요
- **커스텀 TUI 위젯 라이브러리** — Ink 내장 컴포넌트로 충분
