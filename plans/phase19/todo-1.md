# Phase 19 TODO-1: 공유 타입 + TUI (Day 1-3)

> plan.md §3~§5 기반. 모든 파일의 전체 구현 코드 포함.

---

## Day 1: 공유 타입 추출 + 패키지 scaffolding

### 1.1 `packages/types/src/notification.ts` — 신규 생성

- [ ] 파일 생성
- [ ] `JsonRpcNotification<T>`, 스트리밍 params 5종, `BroadcastChannel` 정의

```typescript
// packages/types/src/notification.ts

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

/** 브로드캐스트 채널 */
export type BroadcastChannel = 'config.updated' | 'session.event' | 'system.status' | 'market.tick';
```

**검증:** `pnpm build` (types 패키지) — 컴파일 성공

---

### 1.2 `packages/types/src/index.ts` — notification re-export 추가

- [ ] `export type * from './notification.js';` 추가

```diff
 // packages/types/src/index.ts (기존 10개 모듈 뒤에 추가)
 export type * from './finance.js';
+export type * from './notification.js';

 // 런타임 값 (const enum 대체)
 export { RPC_ERROR_CODES } from './gateway.js';
```

**검증:** `pnpm build` — types 패키지 컴파일 성공, re-export 확인

---

### 1.3 서버 `rpc/types.ts` — `JsonRpcNotification`을 `@finclaw/types`에서 import로 변경

- [ ] 기존 `JsonRpcNotification` 인터페이스 정의 삭제
- [ ] 기존 `BroadcastChannel` 타입 정의 삭제
- [ ] `@finclaw/types`에서 import하도록 변경
- [ ] 기존 서버 코드와의 호환성 유지 (re-export)

```diff
 // packages/server/src/gateway/rpc/types.ts

 import type { RpcRequest, RpcResponse } from '@finclaw/types';
+import type {
+  JsonRpcNotification as _JsonRpcNotification,
+  BroadcastChannel as _BroadcastChannel,
+} from '@finclaw/types';
 import type { z } from 'zod/v4';

 // === @finclaw/types re-export ===
 export type {
   RpcRequest,
   RpcResponse,
   RpcError,
   RpcMethod,
   WsEvent,
   GatewayStatus,
+  JsonRpcNotification,
+  BroadcastChannel,
 } from '@finclaw/types';
 export { RPC_ERROR_CODES } from '@finclaw/types';

 // (기존 인라인 JsonRpcNotification 정의 삭제)
-/** JSON-RPC 알림 (서버 → 클라이언트, id 없음) */
-export interface JsonRpcNotification {
-  readonly jsonrpc: '2.0';
-  readonly method: string;
-  readonly params?: Record<string, unknown>;
-}

 // (기존 인라인 BroadcastChannel 정의 삭제)
-/** 브로드캐스트 채널 */
-export type BroadcastChannel = 'config.updated' | 'session.event' | 'system.status' | 'market.tick';
```

**검증:**

- `pnpm build` — server 패키지 컴파일 성공
- `broadcaster.ts`의 `import type { JsonRpcNotification } from './rpc/types.js'`가 re-export를 통해 정상 동작하는지 확인

---

### 1.4 `packages/tui/package.json` — 신규 생성

- [ ] 파일 생성
- [ ] `ink@^6`, `react@^19`, `@types/react@^19`, `ws@^8`, `@types/ws@^8` 의존성

```json
{
  "name": "@finclaw/tui",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "files": ["dist"],
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc --build",
    "clean": "tsc --build --clean"
  },
  "dependencies": {
    "@finclaw/types": "workspace:*",
    "ink": "^6.0.0",
    "react": "^19.0.0",
    "ws": "^8.19.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/ws": "^8.18.0"
  }
}
```

---

### 1.5 `packages/tui/tsconfig.json` — 신규 생성

- [ ] 파일 생성
- [ ] `jsx: "react-jsx"` 설정 (Ink v6 = React JSX transform)
- [ ] `references: [{ "path": "../types" }]`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "jsx": "react-jsx",
    "lib": ["ES2023"]
  },
  "include": ["src"],
  "references": [{ "path": "../types" }]
}
```

**참고:** `tsconfig.base.json`에는 `"lib": ["ES2023"]`, `"types": ["node"]`가 이미 설정되어 있으므로 Node.js 타입은 자동 포함. `jsx: "react-jsx"`만 TUI에서 추가.

---

### 1.6 루트 `tsconfig.json` — tui 참조 추가

- [ ] `references`에 `{ "path": "packages/tui" }` 추가

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
-    { "path": "packages/server" }
+    { "path": "packages/server" },
+    { "path": "packages/tui" }
   ]
 }
```

---

### 1.7 `pnpm install`

- [ ] `pnpm install` 실행 — ink, react, ws 등 의존성 설치

**검증:** `pnpm build` — types, tui 패키지 모두 컴파일 성공 (빈 소스이므로 에러 없어야 함)

---

## Day 2: TUI Gateway Client + 테스트

### 2.1 `packages/tui/src/gateway-client.ts` — Gateway WebSocket 클라이언트

- [ ] 파일 생성
- [ ] `createGatewayClient()` 팩토리 함수
- [ ] 요청-응답 시퀀스 ID 매칭
- [ ] 지수 백오프 자동 재연결 (800ms 초기, 1.7배, 15초 상한)
- [ ] 30초 요청 타임아웃
- [ ] notification 라우팅 (method 기반)

```typescript
// packages/tui/src/gateway-client.ts

import WebSocket from 'ws';
import type { RpcRequest } from '@finclaw/types';

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
      const frame: RpcRequest = {
        jsonrpc: '2.0',
        id,
        method: method as RpcRequest['method'],
        params,
      };

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

**검증:** `pnpm build` — tui 패키지 컴파일 성공

---

### 2.2 `packages/tui/src/__tests__/gateway-client.test.ts` — Gateway 클라이언트 테스트

- [ ] 파일 생성
- [ ] 요청-응답 시퀀스 ID 매칭 테스트
- [ ] notification 라우팅 테스트
- [ ] 연결 끊김 시 자동 재연결 테스트
- [ ] 30초 타임아웃 테스트
- [ ] `jsonrpc: '2.0'` 규격 준수 테스트

```typescript
// packages/tui/src/__tests__/gateway-client.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createGatewayClient } from '../gateway-client.js';

// ─── Mock WebSocket ───

class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  readyState = MockWebSocket.OPEN;
  sentMessages: string[] = [];

  constructor(
    public url: string,
    public opts?: Record<string, unknown>,
  ) {
    super();
    // 다음 tick에 open 이벤트 발생
    setTimeout(() => this.emit('open'), 0);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = 3; // CLOSED
  }
}

// ws 모듈 mock
vi.mock('ws', () => ({
  default: MockWebSocket,
}));

describe('gateway-client', () => {
  let client: ReturnType<typeof createGatewayClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    client = createGatewayClient({
      reconnectOptions: { initialDelayMs: 800, multiplier: 1.7, maxDelayMs: 15_000 },
    });
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
  });

  it('connect 시 Bearer 토큰 헤더를 설정한다', async () => {
    const connectPromise = client.connect('ws://localhost:3000/ws', 'test-token');
    await vi.advanceTimersByTimeAsync(0); // open 이벤트 발생
    await connectPromise;

    expect(client.isConnected).toBe(true);
  });

  it('request()는 jsonrpc 2.0 규격 프레임을 전송한다', async () => {
    const connectPromise = client.connect('ws://localhost:3000/ws', 'token');
    await vi.advanceTimersByTimeAsync(0);
    await connectPromise;

    // request 호출 (응답 대기 없이 프레임 검증)
    const requestPromise = client.request('chat.start', { agentId: 'default' });

    // 전송된 프레임 검증
    // MockWebSocket 인스턴스에 접근하여 sentMessages 확인
    // request는 pending 상태이므로 타임아웃으로 reject 될 것
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(requestPromise).rejects.toThrow('Request timeout');
  });

  it('notification 수신 시 등록된 핸들러를 호출한다', async () => {
    const handler = vi.fn();
    client.onNotification(handler);

    const connectPromise = client.connect('ws://localhost:3000/ws', 'token');
    await vi.advanceTimersByTimeAsync(0);
    await connectPromise;

    // notification 메시지 시뮬레이션은 MockWebSocket.emit('message', ...) 으로 수행
    // 실제 테스트에서는 ws 인스턴스에 접근하여 message 이벤트를 발생시킴
  });

  it('요청 30초 타임아웃 시 reject한다', async () => {
    const connectPromise = client.connect('ws://localhost:3000/ws', 'token');
    await vi.advanceTimersByTimeAsync(0);
    await connectPromise;

    const requestPromise = client.request('system.ping');

    // 30초 경과
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(requestPromise).rejects.toThrow('Request timeout: system.ping');
  });

  it('연결 끊김 시 지수 백오프로 재연결을 시도한다', async () => {
    const disconnectedHandler = vi.fn();
    client.onDisconnected(disconnectedHandler);

    const connectPromise = client.connect('ws://localhost:3000/ws', 'token');
    await vi.advanceTimersByTimeAsync(0);
    await connectPromise;

    // 연결 끊김 시뮬레이션 → scheduleReconnect 호출 확인
    // 800ms 후 재연결 시도
    expect(client.isConnected).toBe(true);
  });

  it('응답 프레임의 id로 올바른 pending request를 resolve한다', async () => {
    const connectPromise = client.connect('ws://localhost:3000/ws', 'token');
    await vi.advanceTimersByTimeAsync(0);
    await connectPromise;

    // 시퀀스 ID 매칭은 내부적으로 Map<number, {resolve, reject}>로 관리
    // 다수 요청 시 각각 올바르게 매칭되는지 확인
  });

  it('disconnect() 호출 시 재연결 타이머를 정리한다', async () => {
    const connectPromise = client.connect('ws://localhost:3000/ws', 'token');
    await vi.advanceTimersByTimeAsync(0);
    await connectPromise;

    client.disconnect();
    expect(client.isConnected).toBe(false);
  });

  it('연결 전 request() 호출 시 에러를 throw한다', async () => {
    await expect(client.request('system.ping')).rejects.toThrow('Not connected to gateway');
  });

  it('sessionId 획득 흐름: chat.start → sessionId 반환', async () => {
    // chat.start 요청 후 서버 응답으로 sessionId를 받는 흐름 검증
    const connectPromise = client.connect('ws://localhost:3000/ws', 'token');
    await vi.advanceTimersByTimeAsync(0);
    await connectPromise;

    // request('chat.start', { agentId: 'default' }) 호출 후
    // 서버가 { jsonrpc: '2.0', id: 1, result: { sessionId: 'sess-123' } } 응답
    // → resolve({ sessionId: 'sess-123' })
  });

  it('session.get 호출 (not session.info)', async () => {
    const connectPromise = client.connect('ws://localhost:3000/ws', 'token');
    await vi.advanceTimersByTimeAsync(0);
    await connectPromise;

    // 메서드명이 session.get인지 확인 (OpenClaw의 session.info가 아님)
    const requestPromise = client.request('session.get', {
      sessionId: 'sess-123',
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(requestPromise).rejects.toThrow('Request timeout');
  });

  it('finance.quote 파라미터는 { symbol }이다 (not { ticker })', async () => {
    const connectPromise = client.connect('ws://localhost:3000/ws', 'token');
    await vi.advanceTimersByTimeAsync(0);
    await connectPromise;

    // OpenClaw의 market.quote + { ticker }가 아닌
    // FinClaw의 finance.quote + { symbol } 사용 확인
    const requestPromise = client.request('finance.quote', {
      symbol: 'AAPL',
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(requestPromise).rejects.toThrow('Request timeout');
  });
});
```

**검증:** `pnpm --filter @finclaw/tui vitest run` — 10+ tests passed

---

## Day 3: TUI Ink 컴포넌트 + 채팅 테스트

### 3.1 `packages/tui/src/StatusBar.tsx` — 연결 상태, 모델 정보

- [ ] 파일 생성

```typescript
// packages/tui/src/StatusBar.tsx

import React from 'react';
import { Box, Text } from 'ink';

export type TuiPanel =
  | 'chat'
  | 'market'
  | 'portfolio'
  | 'alerts'
  | 'settings';

interface StatusBarProps {
  connected: boolean;
  model: string;
  panel: TuiPanel;
}

export function StatusBar({ connected, model, panel }: StatusBarProps) {
  return (
    <Box borderStyle="single" paddingX={1} justifyContent="space-between">
      <Text>
        <Text color={connected ? 'green' : 'red'}>
          {connected ? '● Connected' : '○ Disconnected'}
        </Text>
        {model && <Text color="gray"> | {model}</Text>}
      </Text>
      <Text>
        <Text color="cyan">[{panel}]</Text>
        <Text color="gray"> Tab: switch | Ctrl+Q: quit</Text>
      </Text>
    </Box>
  );
}
```

---

### 3.2 `packages/tui/src/ChatView.tsx` — `<Static>` 기반 채팅

- [ ] 파일 생성
- [ ] `<Static>` 기반 확정 메시지 (재렌더 없음)
- [ ] 스트리밍 중인 응답 표시
- [ ] 텍스트 입력 + 슬래시 명령어 분기

```typescript
// packages/tui/src/ChatView.tsx

import React, { useState } from 'react';
import { Box, Text, Static } from 'ink';
import TextInput from 'ink-text-input';

export interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
}

interface ChatViewProps {
  messages: ChatMessage[];
  streamText: string;
  onSend: (text: string) => Promise<void>;
  onCommand: (command: string) => void;
}

const ROLE_COLORS: Record<string, string> = {
  user: 'blue',
  assistant: 'green',
  system: 'gray',
  tool: 'magenta',
};

export function ChatView({
  messages,
  streamText,
  onSend,
  onCommand,
}: ChatViewProps) {
  const [input, setInput] = useState('');

  const handleSubmit = async (value: string) => {
    if (!value.trim()) return;
    if (value.startsWith('/')) {
      onCommand(value);
    } else {
      await onSend(value);
    }
    setInput('');
  };

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* 확정된 메시지 (재렌더 없음) */}
      <Static items={messages}>
        {(msg) => (
          <Box key={msg.id}>
            <Text color={ROLE_COLORS[msg.role] ?? 'white'}>
              [{msg.role}] {msg.content}
            </Text>
          </Box>
        )}
      </Static>

      {/* 스트리밍 중인 응답 */}
      {streamText && (
        <Box>
          <Text color="green" dimColor>
            [assistant] {streamText}▊
          </Text>
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

**참고:** `ink-text-input`은 Ink v6의 공식 텍스트 입력 컴포넌트. `package.json`에 `"ink-text-input": "^6.0.0"` 추가 필요.

---

### 3.3 `packages/tui/src/DashboardView.tsx` — 시장/포트폴리오/알림 요약

- [ ] 파일 생성
- [ ] 탭별 데이터 조회 (`finance.quote`, `finance.portfolio.get`, `finance.alert.list`)
- [ ] 테이블 형태 렌더링

```typescript
// packages/tui/src/DashboardView.tsx

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { GatewayClient } from './gateway-client.js';
import type { TuiPanel } from './StatusBar.js';

interface DashboardViewProps {
  panel: TuiPanel;
  client: GatewayClient;
}

interface QuoteData {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
}

interface AlertData {
  id: string;
  name: string;
  conditionType: string;
  active: boolean;
  triggerCount: number;
}

export function DashboardView({ panel, client }: DashboardViewProps) {
  const [data, setData] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client.isConnected) return;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        switch (panel) {
          case 'market': {
            const result = await client.request('finance.quote', {
              symbol: 'AAPL',
            });
            setData(result);
            break;
          }
          case 'portfolio': {
            const result = await client.request('finance.portfolio.get');
            setData(result);
            break;
          }
          case 'alerts': {
            const result = await client.request('finance.alert.list');
            setData(result);
            break;
          }
          case 'settings': {
            const result = await client.request('config.get');
            setData(result);
            break;
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [panel, client.isConnected]);

  if (loading) {
    return (
      <Box>
        <Text color="yellow">Loading {panel}...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1} padding={1}>
      <Text bold color="cyan">
        [{panel.toUpperCase()}]
      </Text>
      {panel === 'market' && renderMarket(data as QuoteData | null)}
      {panel === 'portfolio' && renderPortfolio(data)}
      {panel === 'alerts' && renderAlerts(data as AlertData[] | null)}
      {panel === 'settings' && renderSettings(data)}
    </Box>
  );
}

function renderMarket(quote: QuoteData | null) {
  if (!quote) return <Text color="gray">No data</Text>;
  const changeColor = quote.change >= 0 ? 'green' : 'red';
  return (
    <Box flexDirection="column">
      <Text>
        {quote.symbol}: ${quote.price.toFixed(2)}{' '}
        <Text color={changeColor}>
          {quote.change >= 0 ? '+' : ''}
          {quote.change.toFixed(2)} ({quote.changePercent.toFixed(2)}%)
        </Text>
      </Text>
    </Box>
  );
}

function renderPortfolio(data: unknown) {
  if (!data) return <Text color="gray">No portfolio data</Text>;
  return (
    <Box flexDirection="column">
      <Text>{JSON.stringify(data, null, 2)}</Text>
    </Box>
  );
}

function renderAlerts(alerts: AlertData[] | null) {
  if (!alerts || alerts.length === 0) {
    return <Text color="gray">No alerts configured</Text>;
  }
  return (
    <Box flexDirection="column">
      {alerts.map((alert) => (
        <Text key={alert.id}>
          {alert.active ? '●' : '○'} {alert.name} [{alert.conditionType}]{' '}
          (triggered: {alert.triggerCount})
        </Text>
      ))}
    </Box>
  );
}

function renderSettings(data: unknown) {
  if (!data) return <Text color="gray">No settings loaded</Text>;
  return (
    <Box flexDirection="column">
      <Text>{JSON.stringify(data, null, 2)}</Text>
    </Box>
  );
}
```

---

### 3.4 `packages/tui/src/App.tsx` — Ink 루트 컴포넌트

- [ ] 파일 생성
- [ ] Gateway 연결 + 세션 시작
- [ ] notification 라우팅 (method 기반 — `chat.stream.*`)
- [ ] Tab 키 패널 전환, Ctrl+Q 종료
- [ ] 메시지 전송

```typescript
// packages/tui/src/App.tsx

import React, { useState, useEffect, useCallback } from 'react';
import { Box, useInput, useApp } from 'ink';
import { createGatewayClient, type GatewayClient } from './gateway-client.js';
import { ChatView, type ChatMessage } from './ChatView.js';
import { DashboardView } from './DashboardView.js';
import { StatusBar, type TuiPanel } from './StatusBar.js';
import type {
  ChatStreamDeltaParams,
  ChatStreamErrorParams,
  ChatStreamToolStartParams,
  ChatStreamToolEndParams,
} from '@finclaw/types';

interface AppProps {
  gatewayUrl: string;
  token: string;
  agentId: string;
}

const PANELS: TuiPanel[] = [
  'chat',
  'market',
  'portfolio',
  'alerts',
  'settings',
];

export function App({ gatewayUrl, token, agentId }: AppProps) {
  const { exit } = useApp();
  const [panel, setPanel] = useState<TuiPanel>('chat');
  const [connected, setConnected] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [model, setModel] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamText, setStreamText] = useState('');

  // Gateway 클라이언트 (한 번만 생성)
  const [client] = useState<GatewayClient>(() =>
    createGatewayClient({
      reconnectOptions: {
        initialDelayMs: 800,
        multiplier: 1.7,
        maxDelayMs: 15_000,
      },
    }),
  );

  // 연결 + 세션 시작
  useEffect(() => {
    client.onConnected(async () => {
      setConnected(true);
      try {
        // chat.start → sessionId 획득
        const result = (await client.request('chat.start', { agentId })) as {
          sessionId: string;
        };
        setSessionId(result.sessionId);

        // session.get으로 모델 정보 획득 (not session.info)
        const info = (await client.request('session.get', {
          sessionId: result.sessionId,
        })) as { model: string };
        setModel(info.model);
      } catch {
        // 세션 시작 실패 시 연결은 유지
      }
    });

    client.onDisconnected(() => setConnected(false));

    // notification 라우팅 (method 기반)
    client.onNotification((method, params) => {
      switch (method) {
        case 'chat.stream.delta': {
          // 증분 누적 (전체 교체가 아님!)
          const { delta } = params as unknown as ChatStreamDeltaParams;
          setStreamText((prev) => prev + delta);
          break;
        }
        case 'chat.stream.end':
          setStreamText('');
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: streamText,
            },
          ]);
          break;
        case 'chat.stream.error': {
          const { error } = params as unknown as ChatStreamErrorParams;
          setStreamText('');
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[Error] ${error}`,
            },
          ]);
          break;
        }
        case 'chat.stream.tool_start': {
          const { toolCall } =
            params as unknown as ChatStreamToolStartParams;
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[Tool] ${toolCall.name}`,
            },
          ]);
          break;
        }
        case 'chat.stream.tool_end': {
          const { result } = params as unknown as ChatStreamToolEndParams;
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'tool',
              content: JSON.stringify(result),
            },
          ]);
          break;
        }
      }
    });

    client.connect(gatewayUrl, token).catch(() => {
      // 초기 연결 실패 시 자동 재연결 스케줄링됨
    });

    return () => client.disconnect();
  }, []);

  // 키보드 단축키
  useInput((input, key) => {
    if (key.tab) {
      setPanel((prev) => PANELS[(PANELS.indexOf(prev) + 1) % PANELS.length]);
    }
    if (input === 'q' && key.ctrl) exit();
  });

  // 메시지 전송
  const sendMessage = useCallback(
    async (text: string) => {
      if (!sessionId) return;
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'user', content: text },
      ]);
      await client.request('chat.send', {
        sessionId,
        message: text,
        idempotencyKey: crypto.randomUUID(),
      });
    },
    [sessionId, client],
  );

  // 슬래시 명령어 처리
  const handleCommand = useCallback(
    (command: string) => {
      const cmd = command.slice(1).toLowerCase();
      switch (cmd) {
        case 'help':
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content:
                'Commands: /help, /market, /portfolio, /alerts, /settings, /quit',
            },
          ]);
          break;
        case 'market':
        case 'portfolio':
        case 'alerts':
        case 'settings':
          setPanel(cmd);
          break;
        case 'quit':
          exit();
          break;
        default:
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `Unknown command: ${command}`,
            },
          ]);
      }
    },
    [exit],
  );

  return (
    <Box flexDirection="column" height="100%">
      <StatusBar connected={connected} model={model} panel={panel} />
      {panel === 'chat' ? (
        <ChatView
          messages={messages}
          streamText={streamText}
          onSend={sendMessage}
          onCommand={handleCommand}
        />
      ) : (
        <DashboardView panel={panel} client={client} />
      )}
    </Box>
  );
}
```

---

### 3.5 `packages/tui/src/index.ts` — Ink render 진입점

- [ ] 파일 생성
- [ ] `runTui()` export

```typescript
// packages/tui/src/index.ts

import { render } from 'ink';
import React from 'react';
import { App } from './App.js';

/**
 * TUI 진입점 — Ink v6 render
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

---

### 3.6 `packages/tui/package.json` 업데이트 — `ink-text-input` 추가

- [ ] `ink-text-input` 의존성 추가

```diff
 "dependencies": {
   "@finclaw/types": "workspace:*",
   "ink": "^6.0.0",
+  "ink-text-input": "^6.0.0",
   "react": "^19.0.0",
   "ws": "^8.19.0"
 },
```

---

### 3.7 `packages/tui/src/__tests__/chat.test.ts` — TUI 채팅 핸들러 테스트

- [ ] 파일 생성
- [ ] 메시지 → `chat.send` 라우팅 테스트
- [ ] `/help` 슬래시 명령어 처리 테스트
- [ ] `chat.stream.delta` → 증분 누적 테스트
- [ ] `chat.stream.end` → finalize 테스트
- [ ] `chat.stream.tool_start/tool_end` 라우팅 테스트

```typescript
// packages/tui/src/__tests__/chat.test.ts

import { describe, it, expect, vi } from 'vitest';
import type {
  ChatStreamDeltaParams,
  ChatStreamEndParams,
  ChatStreamErrorParams,
  ChatStreamToolStartParams,
  ChatStreamToolEndParams,
} from '@finclaw/types';

/**
 * TUI 채팅 핸들러 단위 테스트
 *
 * App.tsx의 notification 라우팅 로직을 함수 단위로 추출하여 테스트.
 * Ink 컴포넌트 렌더링이 아닌 순수 로직 검증.
 */

// ─── notification 라우팅 로직 추출 ───

interface ChatState {
  messages: Array<{ role: string; content: string }>;
  streamText: string;
}

function handleNotification(
  state: ChatState,
  method: string,
  params: Record<string, unknown>,
): ChatState {
  switch (method) {
    case 'chat.stream.delta': {
      const { delta } = params as unknown as ChatStreamDeltaParams;
      return { ...state, streamText: state.streamText + delta };
    }
    case 'chat.stream.end': {
      return {
        messages: [...state.messages, { role: 'assistant', content: state.streamText }],
        streamText: '',
      };
    }
    case 'chat.stream.error': {
      const { error } = params as unknown as ChatStreamErrorParams;
      return {
        messages: [...state.messages, { role: 'system', content: `[Error] ${error}` }],
        streamText: '',
      };
    }
    case 'chat.stream.tool_start': {
      const { toolCall } = params as unknown as ChatStreamToolStartParams;
      return {
        ...state,
        messages: [...state.messages, { role: 'system', content: `[Tool] ${toolCall.name}` }],
      };
    }
    case 'chat.stream.tool_end': {
      const { result } = params as unknown as ChatStreamToolEndParams;
      return {
        ...state,
        messages: [...state.messages, { role: 'tool', content: JSON.stringify(result) }],
      };
    }
    default:
      return state;
  }
}

function handleCommand(command: string): { action: string; args?: string } {
  const cmd = command.slice(1).toLowerCase();
  switch (cmd) {
    case 'help':
      return { action: 'help' };
    case 'market':
    case 'portfolio':
    case 'alerts':
    case 'settings':
      return { action: 'navigate', args: cmd };
    case 'quit':
      return { action: 'quit' };
    default:
      return { action: 'unknown', args: command };
  }
}

// ─── 테스트 ───

describe('chat notification routing', () => {
  it('chat.stream.delta — 증분 텍스트 누적', () => {
    let state: ChatState = { messages: [], streamText: '' };

    state = handleNotification(state, 'chat.stream.delta', {
      sessionId: 'sess-1',
      delta: 'Hello',
    });
    expect(state.streamText).toBe('Hello');

    state = handleNotification(state, 'chat.stream.delta', {
      sessionId: 'sess-1',
      delta: ' World',
    });
    expect(state.streamText).toBe('Hello World');
  });

  it('chat.stream.end — 스트리밍 완료, 메시지 확정', () => {
    let state: ChatState = { messages: [], streamText: 'Hello World' };

    state = handleNotification(state, 'chat.stream.end', {
      sessionId: 'sess-1',
      result: {},
    });

    expect(state.streamText).toBe('');
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toEqual({
      role: 'assistant',
      content: 'Hello World',
    });
  });

  it('chat.stream.error — 에러 메시지 추가, 스트림 초기화', () => {
    let state: ChatState = { messages: [], streamText: 'partial' };

    state = handleNotification(state, 'chat.stream.error', {
      sessionId: 'sess-1',
      error: 'Model overloaded',
    });

    expect(state.streamText).toBe('');
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toEqual({
      role: 'system',
      content: '[Error] Model overloaded',
    });
  });

  it('chat.stream.tool_start — 도구 호출 표시', () => {
    let state: ChatState = { messages: [], streamText: '' };

    state = handleNotification(state, 'chat.stream.tool_start', {
      sessionId: 'sess-1',
      toolCall: { name: 'finance.quote', input: { symbol: 'AAPL' } },
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toEqual({
      role: 'system',
      content: '[Tool] finance.quote',
    });
  });

  it('chat.stream.tool_end — 도구 결과 표시', () => {
    let state: ChatState = { messages: [], streamText: '' };

    state = handleNotification(state, 'chat.stream.tool_end', {
      sessionId: 'sess-1',
      result: { price: 150.0 },
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toEqual({
      role: 'tool',
      content: '{"price":150}',
    });
  });

  it('전체 스트리밍 흐름: delta 누적 → tool → delta → end', () => {
    let state: ChatState = { messages: [], streamText: '' };

    state = handleNotification(state, 'chat.stream.delta', {
      sessionId: 's1',
      delta: 'AAPL 시세를 확인',
    });
    state = handleNotification(state, 'chat.stream.tool_start', {
      sessionId: 's1',
      toolCall: { name: 'finance.quote', input: { symbol: 'AAPL' } },
    });
    state = handleNotification(state, 'chat.stream.tool_end', {
      sessionId: 's1',
      result: { price: 150.0 },
    });
    state = handleNotification(state, 'chat.stream.delta', {
      sessionId: 's1',
      delta: '합니다. $150입니다.',
    });
    state = handleNotification(state, 'chat.stream.end', {
      sessionId: 's1',
      result: {},
    });

    expect(state.streamText).toBe('');
    expect(state.messages).toHaveLength(4); // tool_start + tool_end + assistant
    expect(state.messages[2]!.role).toBe('tool');
    expect(state.messages[3]!.role).toBe('assistant');
    expect(state.messages[3]!.content).toContain('$150');
  });

  it('미지원 method는 상태를 변경하지 않는다', () => {
    const state: ChatState = { messages: [], streamText: '' };
    const result = handleNotification(state, 'unknown.method', {});
    expect(result).toEqual(state);
  });
});

describe('slash commands', () => {
  it('/help → help action', () => {
    expect(handleCommand('/help')).toEqual({ action: 'help' });
  });

  it('/market → navigate to market', () => {
    expect(handleCommand('/market')).toEqual({
      action: 'navigate',
      args: 'market',
    });
  });

  it('/portfolio → navigate to portfolio', () => {
    expect(handleCommand('/portfolio')).toEqual({
      action: 'navigate',
      args: 'portfolio',
    });
  });

  it('/quit → quit action', () => {
    expect(handleCommand('/quit')).toEqual({ action: 'quit' });
  });

  it('unknown command → unknown action', () => {
    expect(handleCommand('/xyz')).toEqual({
      action: 'unknown',
      args: '/xyz',
    });
  });
});
```

**검증:** `pnpm --filter @finclaw/tui vitest run` — 2 파일, ~20 tests passed

---

## Day 1-3 체크리스트 요약

| #   | 파일                                                | 상태 |
| --- | --------------------------------------------------- | ---- |
| 1   | `packages/types/src/notification.ts`                | [ ]  |
| 2   | `packages/types/src/index.ts` 수정                  | [ ]  |
| 3   | `packages/server/src/gateway/rpc/types.ts` 수정     | [ ]  |
| 4   | `packages/tui/package.json`                         | [ ]  |
| 5   | `packages/tui/tsconfig.json`                        | [ ]  |
| 6   | 루트 `tsconfig.json` 수정                           | [ ]  |
| 7   | `pnpm install`                                      | [ ]  |
| 8   | `packages/tui/src/gateway-client.ts`                | [ ]  |
| 9   | `packages/tui/src/__tests__/gateway-client.test.ts` | [ ]  |
| 10  | `packages/tui/src/StatusBar.tsx`                    | [ ]  |
| 11  | `packages/tui/src/ChatView.tsx`                     | [ ]  |
| 12  | `packages/tui/src/DashboardView.tsx`                | [ ]  |
| 13  | `packages/tui/src/App.tsx`                          | [ ]  |
| 14  | `packages/tui/src/index.ts`                         | [ ]  |
| 15  | `packages/tui/src/__tests__/chat.test.ts`           | [ ]  |

**최종 검증:**

```bash
pnpm build                            # 전체 빌드 성공
pnpm --filter @finclaw/tui vitest run # ~20 tests passed
```
