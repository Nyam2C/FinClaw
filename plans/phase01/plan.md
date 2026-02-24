# Phase 1: 핵심 타입 & 도메인 모델

## 1. 목표

FinClaw 전체 시스템의 계약(contract)을 정의하는 TypeScript 인터페이스/타입 모듈을 구축한다. OpenClaw에서 23개 이상의 타입 파일(config 30개 + agents + channels 등)에 분산된 타입 정의를 FinClaw의 단일 `packages/types/src/` 디렉토리에 응집시키고, 금융 도메인(시장 데이터, 뉴스, 알림, 포트폴리오) 전용 타입을 추가한다.

이 Phase의 산출물은 이후 모든 Phase에서 import되는 기반이므로, **인터페이스 안정성**이 최우선이다. 구현 코드 없이 순수 타입만 정의하여, 변경 시 런타임 영향이 없도록 설계한다.

---

## 2. OpenClaw 참조

| 참조 문서                                                  | 적용할 패턴                                                 |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| `openclaw_review/docs/02.설정-시스템.md`                   | OpenClawConfig 루트 타입 구조, 29개 서브타입 모듈 패턴      |
| `openclaw_review/deep-dive/02-config-state.md`             | ConfigIoDeps DI 인터페이스, ConfigFileSnapshot, 세션 타입   |
| `openclaw_review/deep-dive/08-channels-core.md`            | ChannelPlugin, ChannelCapabilities, ChannelDock 타입 구조   |
| `openclaw_review/docs/08.채널-추상화와-플러그인-시스템.md` | Two-Tier Abstraction 타입, 13-Slot PluginRegistry 슬롯 정의 |
| `openclaw_review/deep-dive/07-auto-reply.md`               | MsgContext(60+ 필드), GetReplyOptions, ReplyPayload 타입    |
| `openclaw_review/docs/06.에이전트-모델-인증-세션.md`       | 모델/인증/세션 타입                                         |
| `openclaw_review/docs/03.게이트웨이-서버.md`               | RPC 메서드, WebSocket 이벤트 타입                           |

**적용 원칙:**

- OpenClaw의 `.passthrough()` Zod 스키마는 FinClaw에서 strict 스키마로 전환
- OpenClaw의 29개 config 서브타입을 FinClaw에서 10개 미만으로 축소 (금융 관련만)
- `ChannelPlugin<ResolvedAccount>` 제네릭 패턴은 유지하되 어댑터 수를 20+ → 8로 축소

---

## 2.1 현재 상태 및 잔여 작업

### 구현 완료 파일 (10개)

Phase 0에서 모노레포 전환 시 아래 소스 파일이 이미 구현되었다.

| 파일                            | LOC     | 상태   |
| ------------------------------- | ------- | ------ |
| `packages/types/src/common.ts`  | 54      | 구현됨 |
| `packages/types/src/config.ts`  | 163     | 구현됨 |
| `packages/types/src/message.ts` | 94      | 구현됨 |
| `packages/types/src/agent.ts`   | 89      | 구현됨 |
| `packages/types/src/channel.ts` | 56      | 구현됨 |
| `packages/types/src/skill.ts`   | 64      | 구현됨 |
| `packages/types/src/storage.ts` | 53      | 구현됨 |
| `packages/types/src/plugin.ts`  | 65      | 구현됨 |
| `packages/types/src/gateway.ts` | 109     | 구현됨 |
| `packages/types/src/finance.ts` | 211     | 구현됨 |
| **합계**                        | **958** |        |

`index.ts`는 현재 스텁 (`export type TODO = 'stub'`) 상태.

### 잔여 작업

| #   | 작업                                                  | 관련 섹션 |
| --- | ----------------------------------------------------- | --------- |
| R1  | `index.ts` barrel export 구현                         | §5.1      |
| R2  | `common.ts`: `AsyncDisposable` → `CleanupFn` 리네이밍 | §4.1      |
| R3  | `common.ts`: `ErrorReason`, `FinClawError` 추가       | §4.1      |
| R4  | `config.ts`: `ConfigIoDeps` DI 인터페이스 추가        | §4.2      |
| R5  | `channel.ts`: `CleanupFn` import 반영                 | §4.5      |
| R6  | 테스트 파일 4개 작성                                  | §3, §7    |
| R7  | typecheck / build / lint / test 검증                  | §7        |

### 패키지 디렉토리 구조

```
packages/types/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts          ← barrel (스텁 → 구현 필요)
│   ├── common.ts
│   ├── config.ts
│   ├── message.ts
│   ├── agent.ts
│   ├── channel.ts
│   ├── skill.ts
│   ├── storage.ts
│   ├── plugin.ts
│   ├── gateway.ts
│   └── finance.ts
└── test/
    ├── config.test.ts    ← 신규
    ├── message.test.ts   ← 신규
    ├── finance.test.ts   ← 신규
    └── type-safety.test.ts ← 신규
```

### 패키지 의존성 DAG

```
types (이 패키지, 순수 타입)
  ↑
  ├── config
  ├── storage
  ├── agent
  ├── channel-discord
  ├── skills-finance
  └── server (모든 패키지 의존)
```

---

## 3. 생성할 파일

### 소스 파일 (11개)

| 파일 경로                       | 역할                                                          | 예상 LOC |
| ------------------------------- | ------------------------------------------------------------- | -------- |
| `packages/types/src/index.ts`   | Barrel export -- 모든 타입 모듈의 공개 API 진입점             | ~30      |
| `packages/types/src/common.ts`  | 공유 유틸리티 타입 (Brand, Opaque, DeepPartial, Result 등)    | ~80      |
| `packages/types/src/config.ts`  | FinClawConfig 루트 타입 및 하위 설정 타입                     | ~150     |
| `packages/types/src/message.ts` | Message, MsgContext, ChatType, ReplyPayload                   | ~120     |
| `packages/types/src/agent.ts`   | AgentProfile, ModelRef, AuthProfile, AgentRunParams           | ~100     |
| `packages/types/src/channel.ts` | ChannelPlugin, ChannelDock, ChannelCapabilities               | ~120     |
| `packages/types/src/skill.ts`   | SkillDefinition, SkillContext, SkillResult                    | ~80      |
| `packages/types/src/storage.ts` | StorageAdapter, MemoryEntry, SearchResult, ConversationRecord | ~90      |
| `packages/types/src/plugin.ts`  | PluginManifest, PluginRegistry, PluginHook, PluginSlot        | ~80      |
| `packages/types/src/gateway.ts` | RpcMethod, RpcRequest, RpcResponse, WsEvent                   | ~100     |
| `packages/types/src/finance.ts` | MarketData, NewsItem, Alert, Portfolio, FinancialInstrument   | ~150     |

### 테스트 파일 (4개)

| 파일 경로                                 | 검증 대상                                               | 예상 LOC |
| ----------------------------------------- | ------------------------------------------------------- | -------- |
| `packages/types/test/config.test.ts`      | 설정 타입의 구조적 호환성, 필수 필드 검증               | ~80      |
| `packages/types/test/message.test.ts`     | 메시지 타입의 ChatType 열거형, MsgContext 필드 검증     | ~60      |
| `packages/types/test/finance.test.ts`     | 금융 도메인 타입의 브랜드 타입 안전성, 단위 변환        | ~80      |
| `packages/types/test/type-safety.test.ts` | Brand 타입 안전성, `expectTypeOf` 활용 컴파일 타임 검증 | ~60      |

**총 파일 수:** 15개 (소스 11 + 테스트 4)

---

## 4. 핵심 인터페이스/타입

### 4.1 공통 유틸리티 타입 (`common.ts`)

```typescript
// packages/types/src/common.ts

/** 브랜드 타입 -- 원시 타입에 의미론적 구분 부여 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/** 불투명 타입 -- 내부 표현을 숨기고 타입 안전성 보장 */
export type Opaque<T, K extends string> = T & { readonly __opaque: K };

/** 결과 타입 -- 에러 핸들링의 명시적 표현 */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

/** 깊은 부분 타입 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/** 깊은 읽기 전용 */
export type DeepReadonly<T> = {
  readonly [P in keyof T]: T[P] extends object ? DeepReadonly<T[P]> : T[P];
};

/** 타임스탬프 (밀리초 Unix epoch) */
export type Timestamp = Brand<number, 'Timestamp'>;

/** 세션 키 */
export type SessionKey = Brand<string, 'SessionKey'>;

/** 에이전트 ID */
export type AgentId = Brand<string, 'AgentId'>;

/** 채널 ID */
export type ChannelId = Brand<string, 'ChannelId'>;

/**
 * 비동기 정리 함수 -- TC39 `Symbol.asyncDispose`와 이름 충돌 방지를 위해
 * `AsyncDisposable` 대신 `CleanupFn`으로 명명.
 */
export type CleanupFn = () => Promise<void>;

/** 로그 레벨 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

// ─── 에러 타입 ───

/** 에러 분류 -- FinClaw 시스템 전역에서 사용 */
export type ErrorReason =
  | 'CONFIG_INVALID' // 설정 파싱/검증 실패
  | 'CHANNEL_OFFLINE' // 채널 연결 불가
  | 'AGENT_TIMEOUT' // 에이전트 응답 초과
  | 'STORAGE_FAILURE' // 스토리지 읽기/쓰기 실패
  | 'RATE_LIMITED' // 외부 API 속도 제한
  | 'AUTH_FAILURE' // 인증/인가 실패
  | 'INTERNAL'; // 분류 불가 내부 에러

/** 구조화된 에러 인터페이스 */
export interface FinClawError {
  reason: ErrorReason;
  message: string;
  cause?: unknown;
  timestamp: Timestamp;
}
```

### 4.2 설정 타입 (`config.ts`)

```typescript
// packages/types/src/config.ts
import type { AgentId, ChannelId, LogLevel, DeepPartial } from './common.js';

/** FinClaw 루트 설정 타입 -- OpenClaw의 OpenClawConfig 대응 */
export interface FinClawConfig {
  /** 게이트웨이 서버 설정 */
  gateway?: GatewayConfig;
  /** 에이전트 설정 */
  agents?: AgentsConfig;
  /** 채널별 설정 */
  channels?: ChannelsConfig;
  /** 세션 설정 */
  session?: SessionConfig;
  /** 로깅 설정 */
  logging?: LoggingConfig;
  /** 모델 설정 */
  models?: ModelsConfig;
  /** 플러그인 설정 */
  plugins?: PluginsConfig;
  /** 금융 도메인 설정 */
  finance?: FinanceConfig;
  /** 메타 정보 (자동 스탬핑) */
  meta?: ConfigMeta;
}

export interface GatewayConfig {
  port?: number; // 기본 18789
  host?: string; // 기본 'localhost'
  tls?: boolean; // 기본 true
  corsOrigins?: string[];
}

export interface AgentsConfig {
  defaults?: AgentDefaultsConfig;
  entries?: Record<string, AgentEntry>;
}

export interface AgentEntry {
  agentDir?: string;
  model?: string;
  provider?: string;
  maxConcurrent?: number;
  systemPrompt?: string;
  skills?: string[];
}

export interface AgentDefaultsConfig {
  model?: string;
  provider?: string;
  maxConcurrent?: number;
  maxTokens?: number;
  temperature?: number;
}

export interface ChannelsConfig {
  discord?: DiscordChannelConfig;
  cli?: CliChannelConfig;
  web?: WebChannelConfig;
}

export interface DiscordChannelConfig {
  botToken?: string;
  applicationId?: string;
  guildIds?: string[];
}

export interface CliChannelConfig {
  enabled?: boolean;
}

export interface WebChannelConfig {
  enabled?: boolean;
  port?: number;
}

export interface SessionConfig {
  mainKey?: string; // 기본 'main'
  resetPolicy?: 'daily' | 'idle' | 'never';
  idleTimeoutMs?: number; // 기본 1800000 (30분)
}

export interface LoggingConfig {
  level?: LogLevel; // 기본 'info'
  file?: boolean; // JSON 파일 로깅
  redactSensitive?: boolean; // 민감 정보 마스킹
}

export interface ModelsConfig {
  definitions?: Record<string, ModelDefinition>;
  aliases?: Record<string, string>;
}

export interface ModelDefinition {
  provider: string;
  model: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  costPer1kInput?: number;
  costPer1kOutput?: number;
}

export interface PluginsConfig {
  enabled?: string[];
  disabled?: string[];
}

export interface FinanceConfig {
  dataProviders?: DataProviderConfig[];
  newsFeeds?: NewsFeedConfig[];
  alertDefaults?: AlertDefaultsConfig;
  portfolios?: Record<string, PortfolioConfig>;
}

export interface DataProviderConfig {
  name: string;
  apiKey?: string;
  baseUrl?: string;
  rateLimit?: number; // 요청/분
}

export interface NewsFeedConfig {
  name: string;
  url: string;
  refreshIntervalMs?: number;
}

export interface AlertDefaultsConfig {
  cooldownMs?: number; // 동일 알림 재발송 쿨다운
  maxActiveAlerts?: number;
}

export interface PortfolioConfig {
  name: string;
  holdings: HoldingConfig[];
}

export interface HoldingConfig {
  symbol: string;
  quantity: number;
  avgCost?: number;
  currency?: string;
}

export interface ConfigMeta {
  lastTouchedVersion?: string;
  lastTouchedAt?: string;
}

/** 설정 파일 스냅샷 -- OpenClaw의 ConfigFileSnapshot 대응 */
export interface ConfigFileSnapshot {
  path: string;
  exists: boolean;
  raw?: string;
  parsed?: unknown;
  valid: boolean;
  config: FinClawConfig;
  hash?: string;
  issues: ConfigValidationIssue[];
}

export interface ConfigValidationIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

/** 설정 변경 이벤트 */
export type ConfigChangeEvent = {
  previous: FinClawConfig;
  current: FinClawConfig;
  changedPaths: string[];
};

/** 설정 I/O 의존성 -- OpenClaw ConfigIoDeps 축소판 (DI용) */
export interface ConfigIoDeps {
  /** 설정 파일 읽기 */
  readFile(path: string): Promise<string>;
  /** 설정 파일 쓰기 */
  writeFile(path: string, content: string): Promise<void>;
  /** 파일 존재 여부 확인 */
  exists(path: string): Promise<boolean>;
  /** 환경 변수 조회 */
  env(key: string): string | undefined;
  /** 로그 출력 */
  log(level: import('./common.js').LogLevel, message: string): void;
}
```

### 4.3 메시지 타입 (`message.ts`)

```typescript
// packages/types/src/message.ts
import type { ChannelId, SessionKey, Timestamp, AgentId } from './common.js';

/** 정규화된 채팅 유형 -- OpenClaw의 NormalizedChatType 대응 */
export type ChatType = 'direct' | 'group' | 'channel';

/** 인바운드 메시지 -- 채널에서 수신한 원시 메시지 */
export interface InboundMessage {
  id: string;
  channelId: ChannelId;
  chatType: ChatType;
  senderId: string;
  senderName?: string;
  body: string;
  rawBody?: string;
  timestamp: Timestamp;
  threadId?: string;
  replyToId?: string;
  media?: MediaAttachment[];
  metadata?: Record<string, unknown>;
}

/** 미디어 첨부 */
export interface MediaAttachment {
  type: 'image' | 'audio' | 'video' | 'document';
  url?: string;
  path?: string;
  mimeType?: string;
  size?: number;
  filename?: string;
}

/** 메시지 컨텍스트 -- OpenClaw MsgContext(60+ 필드)의 축소판 */
export interface MsgContext {
  // 본문 계열
  body: string;
  bodyForAgent: string;
  rawBody: string;
  commandBody?: string;

  // 발신자 계열
  from: string;
  senderId: string;
  senderName: string;
  senderUsername?: string;

  // 채널 계열
  provider: string;
  channelId: ChannelId;
  chatType: ChatType;

  // 세션 계열
  sessionKey: SessionKey;
  parentSessionKey?: SessionKey;
  accountId: string;

  // 그룹 계열
  groupSubject?: string;
  groupMembers?: number;

  // 스레드 계열
  messageThreadId?: string;
  isForum?: boolean;

  // 미디어 계열
  media?: MediaAttachment[];

  // 메타데이터
  timestamp: Timestamp;
  isHeartbeat?: boolean;
  isCommand?: boolean;
  commandAuthorized?: boolean;
}

/** 응답 페이로드 -- OpenClaw ReplyPayload 대응 */
export interface ReplyPayload {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  isError?: boolean;
  channelData?: Record<string, unknown>;
}

/** 응답 생성 옵션 -- OpenClaw GetReplyOptions 대응 */
export interface GetReplyOptions {
  runId: string;
  abortSignal?: AbortSignal;
  onPartialReply?: (text: string) => void;
  onModelSelected?: (model: string, provider: string) => void;
  onToolResult?: (toolName: string, result: unknown) => void;
  blockReplyTimeoutMs?: number;
}

/** 아웃바운드 메시지 -- 채널로 전송할 메시지 */
export interface OutboundMessage {
  channelId: ChannelId;
  targetId: string;
  payloads: ReplyPayload[];
  replyToMessageId?: string;
  threadId?: string;
}
```

### 4.4 에이전트 타입 (`agent.ts`)

```typescript
// packages/types/src/agent.ts
import type { AgentId, SessionKey } from './common.js';

/** 에이전트 프로필 */
export interface AgentProfile {
  id: AgentId;
  name: string;
  systemPrompt: string;
  model: ModelRef;
  skills: string[];
  maxConcurrent: number;
  agentDir?: string;
}

/** 모델 참조 */
export interface ModelRef {
  provider: string; // 'anthropic' | 'openai' | ...
  model: string; // 'claude-sonnet-4-20250514' | 'gpt-4o' | ...
  contextWindow: number;
  maxOutputTokens: number;
}

/** 인증 프로필 */
export interface AuthProfile {
  provider: string;
  apiKey: string;
  organizationId?: string;
  baseUrl?: string;
  rotationIndex?: number; // 다중 키 로테이션
}

/** 에이전트 실행 파라미터 */
export interface AgentRunParams {
  agentId: AgentId;
  sessionKey: SessionKey;
  model: ModelRef;
  systemPrompt: string;
  messages: ConversationMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  abortSignal?: AbortSignal;
}

/** 대화 메시지 (LLM API용) */
export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  toolCallId?: string;
  name?: string;
}

/** 콘텐츠 블록 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; mimeType?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

/** 도구 정의 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

/** 에이전트 실행 결과 */
export interface AgentRunResult {
  text: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
  model: string;
  finishReason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop';
}

/** 도구 호출 */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** 토큰 사용량 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
```

### 4.5 채널 타입 (`channel.ts`)

```typescript
// packages/types/src/channel.ts
import type { ChannelId, CleanupFn } from './common.js';
import type { InboundMessage, OutboundMessage, ReplyPayload } from './message.js';

/** 채널 플러그인 -- OpenClaw ChannelPlugin<ResolvedAccount> 대응 */
export interface ChannelPlugin<TAccount = unknown> {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;

  /** 채널 초기화 */
  setup?(config: TAccount): Promise<CleanupFn>;

  /** 메시지 수신 핸들러 등록 */
  onMessage?(handler: (msg: InboundMessage) => Promise<void>): CleanupFn;

  /** 메시지 전송 */
  send?(msg: OutboundMessage): Promise<void>;

  /** 타이핑 인디케이터 */
  sendTyping?(channelId: string, chatId: string): Promise<void>;

  /** 리액션 추가 */
  addReaction?(messageId: string, emoji: string): Promise<void>;
}

/** 채널 메타데이터 */
export interface ChannelMeta {
  name: string;
  displayName: string;
  icon?: string;
  color?: string;
  website?: string;
}

/** 채널 기능 -- OpenClaw의 ChannelCapabilities(12필드) 축소 */
export interface ChannelCapabilities {
  supportsMarkdown: boolean;
  supportsImages: boolean;
  supportsAudio: boolean;
  supportsVideo: boolean;
  supportsButtons: boolean;
  supportsThreads: boolean;
  supportsReactions: boolean;
  supportsEditing: boolean;
  maxMessageLength: number;
  maxMediaSize?: number;
}

/** 경량 채널 Dock -- OpenClaw dock.ts 대응 */
export interface ChannelDock {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  defaultChatType: 'direct' | 'group';
  threadingMode: 'none' | 'native' | 'emulated';
  outboundLimits: OutboundLimits;
}

/** 아웃바운드 제한 */
export interface OutboundLimits {
  maxChunkLength: number; // 기본 4000
  maxMediaPerMessage: number; // 기본 10
  rateLimitPerMinute: number; // 기본 30
}
```

### 4.6 스킬 타입 (`skill.ts`)

```typescript
// packages/types/src/skill.ts
import type { MsgContext } from './message.js';

/** 스킬 정의 */
export interface SkillDefinition {
  name: string;
  description: string;
  version: string;
  category: SkillCategory;
  commands: SkillCommand[];
  tools?: SkillTool[];
}

export type SkillCategory = 'finance' | 'utility' | 'system' | 'custom';

/** 스킬 커맨드 */
export interface SkillCommand {
  name: string;
  aliases?: string[];
  description: string;
  args?: SkillArgDef[];
  handler: string; // 핸들러 함수 경로
}

/** 스킬 인자 정의 */
export interface SkillArgDef {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  description?: string;
  default?: unknown;
}

/** 스킬 도구 (LLM function calling용) */
export interface SkillTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: string;
}

/** 스킬 실행 컨텍스트 */
export interface SkillContext {
  msg: MsgContext;
  args: Record<string, unknown>;
  config: Record<string, unknown>;
}

/** 스킬 실행 결과 */
export interface SkillResult {
  text?: string;
  data?: unknown;
  media?: SkillMedia[];
  error?: string;
}

/** 스킬 미디어 산출물 */
export interface SkillMedia {
  type: 'image' | 'chart' | 'table' | 'file';
  url?: string;
  content?: string;
  mimeType?: string;
  title?: string;
}
```

### 4.7 스토리지 타입 (`storage.ts`)

```typescript
// packages/types/src/storage.ts
import type { SessionKey, Timestamp, AgentId } from './common.js';
import type { ConversationMessage } from './agent.js';

/** 스토리지 어댑터 인터페이스 */
export interface StorageAdapter {
  /** 대화 이력 저장 */
  saveConversation(record: ConversationRecord): Promise<void>;

  /** 대화 이력 조회 */
  getConversation(sessionKey: SessionKey): Promise<ConversationRecord | null>;

  /** 대화 이력 검색 */
  searchConversations(query: SearchQuery): Promise<SearchResult[]>;

  /** 메모리 엔트리 저장 */
  saveMemory(entry: MemoryEntry): Promise<void>;

  /** 메모리 검색 */
  searchMemory(query: string, limit?: number): Promise<MemoryEntry[]>;

  /** 초기화 */
  initialize(): Promise<void>;

  /** 정리 */
  close(): Promise<void>;
}

/** 대화 레코드 */
export interface ConversationRecord {
  sessionKey: SessionKey;
  agentId: AgentId;
  messages: ConversationMessage[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
  metadata?: Record<string, unknown>;
}

/** 메모리 엔트리 */
export interface MemoryEntry {
  id: string;
  sessionKey: SessionKey;
  content: string;
  embedding?: number[];
  type: 'fact' | 'preference' | 'summary' | 'financial';
  createdAt: Timestamp;
  metadata?: Record<string, unknown>;
}

/** 검색 쿼리 */
export interface SearchQuery {
  text?: string;
  sessionKey?: SessionKey;
  agentId?: AgentId;
  fromDate?: Timestamp;
  toDate?: Timestamp;
  limit?: number;
  offset?: number;
}

/** 검색 결과 */
export interface SearchResult {
  record: ConversationRecord;
  score: number; // 관련도 점수 0~1
  matchedContent?: string;
}
```

### 4.8 플러그인 타입 (`plugin.ts`)

```typescript
// packages/types/src/plugin.ts
import type { ChannelPlugin } from './channel.js';
import type { ToolDefinition } from './agent.js';

/** 플러그인 매니페스트 */
export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  main: string; // 진입점 파일 경로
  type: 'channel' | 'skill' | 'tool' | 'service';
  dependencies?: string[];
}

/** 플러그인 레지스트리 -- OpenClaw의 13-Slot PluginRegistry 축소 */
export interface PluginRegistry {
  plugins: RegisteredPlugin[];
  tools: ToolDefinition[];
  channels: ChannelPlugin[];
  hooks: PluginHook[];
  services: PluginService[];
  commands: PluginCommand[];
}

/** 등록된 플러그인 */
export interface RegisteredPlugin {
  manifest: PluginManifest;
  status: 'active' | 'disabled' | 'error';
  error?: string;
  loadedAt: number;
}

/** 플러그인 훅 */
export interface PluginHook {
  name: PluginHookName;
  priority: number;
  handler: (...args: unknown[]) => Promise<unknown>;
  pluginName: string;
}

/** 훅 이름 열거 */
export type PluginHookName =
  | 'beforeMessageProcess'
  | 'afterMessageProcess'
  | 'beforeAgentRun'
  | 'afterAgentRun'
  | 'onConfigChange'
  | 'onGatewayStart'
  | 'onGatewayStop';

/** 플러그인 서비스 */
export interface PluginService {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** 플러그인 커맨드 */
export interface PluginCommand {
  name: string;
  description: string;
  handler: (args: string[]) => Promise<string>;
  pluginName: string;
}
```

### 4.9 게이트웨이 타입 (`gateway.ts`)

```typescript
// packages/types/src/gateway.ts

/** RPC 메서드 이름 */
export type RpcMethod =
  | 'agent.run'
  | 'agent.list'
  | 'agent.status'
  | 'session.get'
  | 'session.reset'
  | 'session.list'
  | 'config.get'
  | 'config.update'
  | 'channel.list'
  | 'channel.status'
  | 'health.check'
  | 'skill.execute'
  | 'finance.quote'
  | 'finance.news'
  | 'finance.alert.create'
  | 'finance.alert.list'
  | 'finance.portfolio.get';

/** JSON-RPC 2.0 요청 */
export interface RpcRequest<T = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  method: RpcMethod;
  params?: T;
}

/** JSON-RPC 2.0 응답 */
export interface RpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  result?: T;
  error?: RpcError;
}

/** JSON-RPC 2.0 에러 */
export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** 표준 RPC 에러 코드 */
export const RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // 커스텀 코드
  UNAUTHORIZED: -32001,
  RATE_LIMITED: -32002,
  SESSION_NOT_FOUND: -32003,
  AGENT_BUSY: -32004,
} as const;

/** WebSocket 이벤트 */
export type WsEvent =
  | WsMessageEvent
  | WsTypingEvent
  | WsAgentStatusEvent
  | WsAlertEvent
  | WsErrorEvent;

export interface WsMessageEvent {
  type: 'message';
  channelId: string;
  senderId: string;
  text: string;
  timestamp: number;
}

export interface WsTypingEvent {
  type: 'typing';
  channelId: string;
  agentId: string;
  isTyping: boolean;
}

export interface WsAgentStatusEvent {
  type: 'agent.status';
  agentId: string;
  status: 'idle' | 'running' | 'error';
}

export interface WsAlertEvent {
  type: 'alert';
  alertId: string;
  symbol: string;
  condition: string;
  currentValue: number;
  triggeredAt: number;
}

export interface WsErrorEvent {
  type: 'error';
  code: number;
  message: string;
}

/** 게이트웨이 상태 */
export interface GatewayStatus {
  uptime: number;
  connections: number;
  activeAgents: number;
  activeSessions: number;
  version: string;
}
```

### 4.10 금융 도메인 타입 (`finance.ts`)

```typescript
// packages/types/src/finance.ts
import type { Brand, Timestamp } from './common.js';

// ─── 금융 상품 식별 ───

/** 티커 심볼 (e.g., 'AAPL', 'BTC-USD', '005930.KS') */
export type TickerSymbol = Brand<string, 'TickerSymbol'>;

/** 통화 코드 (ISO 4217) */
export type CurrencyCode = Brand<string, 'CurrencyCode'>;

/** 금융 상품 유형 */
export type InstrumentType =
  | 'stock' // 주식
  | 'etf' // ETF
  | 'crypto' // 암호화폐
  | 'forex' // 외환
  | 'index' // 지수
  | 'bond' // 채권
  | 'commodity'; // 상품

/** 금융 상품 */
export interface FinancialInstrument {
  symbol: TickerSymbol;
  name: string;
  type: InstrumentType;
  exchange?: string;
  currency: CurrencyCode;
  sector?: string;
  industry?: string;
}

// ─── 시장 데이터 ───

/** 실시간 시세 */
export interface MarketQuote {
  symbol: TickerSymbol;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
  marketCap?: number;
  timestamp: Timestamp;
}

/** OHLCV 캔들 */
export interface OHLCVCandle {
  timestamp: Timestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 시계열 간격 */
export type TimeInterval = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w' | '1M';

/** 시장 데이터 요청 */
export interface MarketDataRequest {
  symbols: TickerSymbol[];
  interval?: TimeInterval;
  from?: Timestamp;
  to?: Timestamp;
  limit?: number;
}

/** 시장 데이터 응답 */
export interface MarketDataResponse {
  symbol: TickerSymbol;
  candles: OHLCVCandle[];
  quote?: MarketQuote;
  fetchedAt: Timestamp;
}

// ─── 기술 분석 ───

/** 기술 지표 유형 */
export type TechnicalIndicator =
  | 'sma' // 단순이동평균
  | 'ema' // 지수이동평균
  | 'rsi' // 상대강도지수
  | 'macd' // MACD
  | 'bollinger' // 볼린저 밴드
  | 'atr' // ATR
  | 'vwap'; // VWAP

/** 기술 분석 결과 */
export interface TechnicalAnalysisResult {
  indicator: TechnicalIndicator;
  symbol: TickerSymbol;
  values: IndicatorValue[];
  signal?: 'buy' | 'sell' | 'neutral';
  summary?: string;
}

export interface IndicatorValue {
  timestamp: Timestamp;
  value: number;
  upperBand?: number; // 볼린저 상단
  lowerBand?: number; // 볼린저 하단
  signal?: number; // MACD 시그널
  histogram?: number; // MACD 히스토그램
}

// ─── 뉴스 ───

/** 뉴스 아이템 */
export interface NewsItem {
  id: string;
  title: string;
  summary?: string;
  content?: string;
  url: string;
  source: string;
  publishedAt: Timestamp;
  symbols?: TickerSymbol[];
  sentiment?: NewsSentiment;
  categories?: string[];
  imageUrl?: string;
}

/** 뉴스 감성 분석 */
export interface NewsSentiment {
  score: number; // -1.0 (매우 부정) ~ 1.0 (매우 긍정)
  label: 'very_negative' | 'negative' | 'neutral' | 'positive' | 'very_positive';
  confidence: number; // 0~1
}

// ─── 알림 ───

/** 알림 정의 */
export interface Alert {
  id: string;
  name?: string;
  symbol: TickerSymbol;
  condition: AlertCondition;
  enabled: boolean;
  channelId?: string;
  createdAt: Timestamp;
  lastTriggeredAt?: Timestamp;
  triggerCount: number;
  cooldownMs: number;
}

/** 알림 조건 */
export interface AlertCondition {
  type: AlertConditionType;
  value: number;
  /** 비교 대상 필드 (기본: 'price') */
  field?: 'price' | 'changePercent' | 'volume' | 'rsi';
}

export type AlertConditionType =
  | 'above' // field > value
  | 'below' // field < value
  | 'crosses_above' // field가 value를 상향 돌파
  | 'crosses_below' // field가 value를 하향 돌파
  | 'change_percent'; // 변동률 초과

/** 알림 트리거 이벤트 */
export interface AlertTrigger {
  alertId: string;
  symbol: TickerSymbol;
  condition: AlertCondition;
  currentValue: number;
  previousValue?: number;
  triggeredAt: Timestamp;
  message: string;
}

// ─── 포트폴리오 ───

/** 포트폴리오 */
export interface Portfolio {
  id: string;
  name: string;
  holdings: PortfolioHolding[];
  totalValue?: number;
  totalCost?: number;
  totalPnL?: number;
  totalPnLPercent?: number;
  currency: CurrencyCode;
  updatedAt: Timestamp;
}

/** 포트폴리오 보유 종목 */
export interface PortfolioHolding {
  symbol: TickerSymbol;
  instrument?: FinancialInstrument;
  quantity: number;
  averageCost: number;
  currentPrice?: number;
  marketValue?: number;
  pnl?: number;
  pnlPercent?: number;
  weight?: number; // 비중 0~1
}

/** 포트폴리오 요약 */
export interface PortfolioSummary {
  portfolio: Portfolio;
  topGainers: PortfolioHolding[];
  topLosers: PortfolioHolding[];
  sectorAllocation: Record<string, number>;
  dailyChange: number;
  dailyChangePercent: number;
}
```

---

## 5. 구현 상세

### 5.1 Barrel Export 패턴

`packages/types/src/index.ts`는 OpenClaw의 `config.ts`(14줄) barrel과 동일한 패턴을 따른다. 모든 외부 모듈은 이 단일 진입점만 import한다.

```typescript
// packages/types/src/index.ts
export type * from './common.js';
export type * from './config.js';
export type * from './message.js';
export type * from './agent.js';
export type * from './channel.js';
export type * from './skill.js';
export type * from './storage.js';
export type * from './plugin.js';
export type * from './gateway.js';
export type * from './finance.js';

// 런타임 값 (const enum 대체)
export { RPC_ERROR_CODES } from './gateway.js';

// 브랜드 팩토리 함수
export { createTimestamp, createSessionKey, createAgentId, createChannelId } from './common.js';

export { createTickerSymbol, createCurrencyCode } from './finance.js';
```

> **폴백:** `export type *` 구문이 tsgo에서 문제를 일으킬 경우, 각 모듈에서 명시적으로 re-export한다:
>
> ```typescript
> export type { Brand, Opaque, Result, ... } from './common.js';
> export type { FinClawConfig, GatewayConfig, ... } from './config.js';
> // ...
> ```

### 5.2 Brand 타입 팩토리 함수

`common.ts`에 브랜드 타입 생성 헬퍼를 포함한다. 런타임에서 타입 안전성을 강제하기 위한 유일한 런타임 코드이다.

```typescript
// packages/types/src/common.ts (추가)

/** 브랜드 타입 팩토리 */
export function createTimestamp(ms: number): Timestamp {
  return ms as Timestamp;
}

export function createSessionKey(key: string): SessionKey {
  return key as SessionKey;
}

export function createAgentId(id: string): AgentId {
  return id as AgentId;
}

export function createChannelId(id: string): ChannelId {
  return id as ChannelId;
}
```

### 5.3 금융 타입 헬퍼 함수

`finance.ts`에 브랜드 타입 생성 및 유효성 검증 함수를 포함한다.

```typescript
// packages/types/src/finance.ts (추가)

/** 티커 심볼 생성 (대문자 정규화) */
export function createTickerSymbol(symbol: string): TickerSymbol {
  return symbol.toUpperCase().trim() as TickerSymbol;
}

/** 통화 코드 생성 (ISO 4217 3글자 검증) */
export function createCurrencyCode(code: string): CurrencyCode {
  const normalized = code.toUpperCase().trim();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error(`Invalid currency code: ${code}`);
  }
  return normalized as CurrencyCode;
}
```

### 5.4 데이터 흐름

```
[외부] ──InboundMessage──> [채널 플러그인]
                               │
                         MsgContext 생성
                               │
                    ┌──────────┴──────────┐
                    │                     │
               [명령어 처리]         [에이전트 실행]
                    │                     │
               SkillContext          AgentRunParams
                    │                     │
               SkillResult           AgentRunResult
                    │                     │
                    └──────────┬──────────┘
                               │
                          ReplyPayload
                               │
                    ┌──────────┴──────────┐
                    │                     │
            OutboundMessage          WsEvent
                    │                     │
              [채널 전송]          [WebSocket 클라이언트]
```

### 5.5 `Result<T, E>` 사용 가이드라인

- **내부 코드** (storage, config loader 등): `Result<T, FinClawError>` 반환으로 명시적 에러 전파
- **외부 프로토콜** (JSON-RPC, WebSocket): 기존 `RpcError`, `isError` 필드 유지 (프로토콜 호환)
- `Result`를 반환하는 함수는 `throw`하지 않는다. 반대로 `throw`하는 함수는 `Result`를 반환하지 않는다. 혼용 금지.

### 5.6 TypeScript 호환 규칙

| 규칙                              | 이유                                    |
| --------------------------------- | --------------------------------------- |
| `target: "es2023"`                | Node.js 22 기본 지원 범위               |
| import 경로에 `.js` 확장자 사용   | ESM 필수, tsc/tsgo 모두 호환            |
| `const enum` 미사용               | `--isolatedModules` 비호환, tsgo 미지원 |
| `namespace` 미사용                | 번들러 tree-shaking 불가                |
| `declare module` 전역 확장 미사용 | 모듈 경계 침범 방지                     |

---

## 6. 선행 조건

| 조건                          | 상태 | 비고                                  |
| ----------------------------- | ---- | ------------------------------------- |
| Phase 0: 프로젝트 스캐폴딩    | 완료 | tsc, tsgo, vitest, oxlint 설정됨      |
| `packages/types/src/` 소스    | 완료 | 10개 소스 파일 구현됨 (~958 LOC)      |
| TypeScript strict mode        | 완료 | tsconfig.base.json에 `"strict": true` |
| ESM 모듈 시스템               | 완료 | `"type": "module"` in package.json    |
| Node.js 22+                   | 완료 | `"engines": { "node": ">=22.0.0" }`   |
| 도구: TS 5.9.3 + tsgo 7.0-dev | 완료 | tsc (빌드/선언), tsgo (빠른 타입체크) |

**외부 의존성:** 없음. 이 Phase는 순수 TypeScript 타입 정의만 포함하며 런타임 의존성이 불필요하다.

---

## 7. 산출물 및 검증

### 산출물 목록

| #   | 산출물                                     | 검증 방법                                                         |
| --- | ------------------------------------------ | ----------------------------------------------------------------- |
| 1   | `packages/types/src/` 디렉토리 (11개 파일) | `pnpm typecheck` 통과                                             |
| 2   | 모든 타입의 barrel export                  | `import type { ... } from '@finclaw/types'`가 모든 타입 접근 가능 |
| 3   | Brand 타입 팩토리 함수                     | 단위 테스트에서 타입 안전성 검증                                  |
| 4   | 금융 도메인 타입                           | `finance.test.ts`에서 TickerSymbol, CurrencyCode 생성/검증        |
| 5   | 테스트 파일 (4개)                          | `pnpm test` 통과                                                  |

### 검증 기준

```bash
# 1. 타입 체크 (tsgo -- 빠른 검증)
pnpm typecheck       # tsgo --noEmit: 에러 0

# 2. 빌드 (tsc -- .d.ts 생성 + 크로스 검증)
pnpm build           # tsc --build: dist/ 에 .d.ts 생성 확인

# 3. tsgo/tsc 크로스 검증
# tsgo와 tsc 모두 에러 0인지 확인 (동작 차이 조기 발견)

# 4. 단위 테스트 통과
pnpm test            # vitest: 4개 테스트 파일 전체 통과

# 5. 린트 통과
pnpm lint            # oxlint: 경고/에러 0

# 6. 순환 의존 없음
# 모든 import가 단방향 DAG 구조 유지
```

### 테스트 예시

```typescript
// packages/types/test/finance.test.ts
import { describe, it, expect } from 'vitest';
import { createTickerSymbol, createCurrencyCode } from '@finclaw/types';

describe('TickerSymbol', () => {
  it('대문자로 정규화한다', () => {
    const symbol = createTickerSymbol('aapl');
    expect(symbol).toBe('AAPL');
  });

  it('앞뒤 공백을 제거한다', () => {
    const symbol = createTickerSymbol('  BTC-USD  ');
    expect(symbol).toBe('BTC-USD');
  });
});

describe('CurrencyCode', () => {
  it('유효한 ISO 4217 코드를 생성한다', () => {
    const code = createCurrencyCode('usd');
    expect(code).toBe('USD');
  });

  it('잘못된 코드에 에러를 던진다', () => {
    expect(() => createCurrencyCode('ABCD')).toThrow('Invalid currency code');
    expect(() => createCurrencyCode('US')).toThrow('Invalid currency code');
  });
});
```

```typescript
// packages/types/test/type-safety.test.ts
import { describe, it, expectTypeOf } from 'vitest';
import type { Timestamp, SessionKey, AgentId, ChannelId } from '@finclaw/types';
import { createTimestamp, createSessionKey } from '@finclaw/types';

describe('Brand 타입 안전성', () => {
  it('Timestamp는 number에 할당 불가', () => {
    const ts = createTimestamp(Date.now());
    expectTypeOf(ts).toMatchTypeOf<Timestamp>();
    // @ts-expect-error -- Brand 타입은 plain number에 할당 불가
    const n: number = ts; // 컴파일 에러 확인용
  });

  it('서로 다른 Brand 타입은 호환되지 않는다', () => {
    expectTypeOf<SessionKey>().not.toMatchTypeOf<AgentId>();
    expectTypeOf<AgentId>().not.toMatchTypeOf<ChannelId>();
  });
});
```

---

## 8. 복잡도 및 예상 파일 수

| 항목              | 값                                     |
| ----------------- | -------------------------------------- |
| **복잡도**        | **M (Medium)**                         |
| 소스 파일         | 11개 (10개 구현 완료, barrel 1개 잔여) |
| 테스트 파일       | 4개                                    |
| **총 파일 수**    | **15개**                               |
| 현재 LOC (소스)   | ~958줄 (구현됨) + ~75줄 (보강 예정)    |
| 예상 LOC (테스트) | ~280줄                                 |
| 잔여 작업 시간    | 1-1.5시간 (보강 + 테스트만)            |
| 런타임 의존성     | 0개                                    |
| 난이도            | 낮음 (순수 타입 정의)                  |

**위험 요소:**

- 타입 설계가 후속 Phase에서 대규모 변경을 유발할 수 있음 → OpenClaw 참조로 안정성 확보
- 금융 도메인 타입이 과도하게 상세할 수 있음 → Phase 16-18에서 점진적 확장 가능하도록 설계
