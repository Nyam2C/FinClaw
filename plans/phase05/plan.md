# Phase 5: 채널 추상화 & 플러그인 시스템

> 복잡도: **XL** | 소스 파일: ~14 | 테스트 파일: ~8 | 합계: **~22 파일**

---

## 1. 목표

채널(Discord, Slack 등) 연동과 플러그인 확장을 위한 **이중 계층(Two-Tier) 아키텍처**를 구현한다.

- **ChannelDock**: 경량 메타데이터 계층. 각 채널의 기능(capabilities), 게이팅 규칙, 채팅 타입을 선언적으로 기술하며 플러그인 로딩 없이 동작한다.
- **ChannelPlugin**: 실제 채널 동작을 구현하는 20+ 옵셔널 어댑터 인터페이스. 메시지 수신/발신, 리액션, 타이핑 표시 등 채널별 행위를 캡슐화한다.
- **PluginRegistry**: 13개 배열 기반 슬롯(tools, channels, hooks, services, CLI commands, HTTP routes 등)으로 구성된 중앙 레지스트리. `globalThis` Symbol 싱글턴으로 프로세스 전역에서 단일 인스턴스를 보장한다.
- **Plugin Loader**: 4단계 파이프라인(Discovery -> Manifest -> jiti load -> Registry registration)으로 플러그인을 안전하게 적재한다.
- **Hook System**: `createHookRunner()`로 3가지 모드(void=병렬, modifying=순차, sync=동기)의 훅 실행을 지원한다.
- **Gating Modules**: mention-gating, command-gating, allowlist-match, chat-type normalization 등 메시지 필터링 로직.

FinClaw는 금융 도메인 특화이므로, 채널 추상화 위에 **금융 알림 채널 타입**(market-alert, portfolio-update, trade-signal)을 추가 정의한다.

---

## 2. OpenClaw 참조

| 참조 문서 경로                               | 적용할 패턴                                              |
| -------------------------------------------- | -------------------------------------------------------- |
| `openclaw_review/docs/channels/`             | Two-Tier(Dock + Plugin) 아키텍처, 채널 capabilities 선언 |
| `openclaw_review/docs/plugins/`              | 13-slot PluginRegistry, 4-stage loader pipeline          |
| `openclaw_review/deep-dive/plugin-system.md` | globalThis Symbol 싱글턴, jiti 동적 로딩                 |
| `openclaw_review/deep-dive/hook-system.md`   | createHookRunner() 3모드 패턴, 훅 타입 정의              |
| `openclaw_review/docs/channels/gating/`      | mention-gating, command-gating, allowlist 패턴           |

**OpenClaw 대비 FinClaw 간소화 사항:**

- 80+ 파일 -> ~22 파일로 핵심만 추출
- 채널 타입을 Discord + HTTP Webhook 2종으로 초기 제한
- Plugin SDK는 최소 re-export만 제공 (374+ -> ~40 re-exports)
- 금융 도메인 전용 채널 이벤트 타입 추가 (market-alert 등)

---

## 3. 생성할 파일

### 소스 파일 (14개)

```
src/channels/
├── index.ts                  # 채널 모듈 public API
├── dock.ts                   # ChannelDock - 경량 메타데이터 계층
├── plugin.ts                 # ChannelPlugin 인터페이스 구현체 기반
├── registry.ts               # 채널 레지스트리 (등록/조회)
├── chat-type.ts              # ChatType 열거형 + 정규화 로직
├── gating/
│   ├── mention-gating.ts     # 멘션 기반 게이팅
│   ├── command-gating.ts     # 명령어 접두사 게이팅
│   └── allowlist.ts          # 화이트리스트 매칭
└── typing.ts                 # 타이핑 인디케이터 관리

src/plugins/
├── index.ts                  # 플러그인 모듈 public API
├── discovery.ts              # 플러그인 탐색 (파일시스템 스캔)
├── loader.ts                 # 4-stage 플러그인 로더
├── registry.ts               # 13-slot PluginRegistry + globalThis 싱글턴
├── hooks.ts                  # createHookRunner() + 훅 타입 정의
└── manifest.ts               # PluginManifest 파싱/검증

src/plugin-sdk/
└── index.ts                  # 확장 개발자용 타입 re-export
```

### 테스트 파일 (8개)

```
src/channels/__tests__/
├── dock.test.ts              # ChannelDock 단위 테스트
├── chat-type.test.ts         # ChatType 정규화 테스트
├── gating.test.ts            # 게이팅 모듈 통합 테스트
└── registry.test.ts          # 채널 레지스트리 테스트

src/plugins/__tests__/
├── discovery.test.ts         # 플러그인 탐색 테스트
├── loader.test.ts            # 4-stage 로더 파이프라인 테스트
├── registry.test.ts          # PluginRegistry 슬롯 테스트
└── hooks.test.ts             # 훅 러너 3모드 테스트
```

---

## 4. 핵심 인터페이스/타입

### 4.1 ChannelDock & ChannelPlugin

```typescript
// src/types/ 에 정의될 채널 관련 타입 (Phase 1 산출물에 추가)

/** 채널이 지원하는 기능 플래그 */
export interface ChannelCapabilities {
  readonly supportsThreads: boolean;
  readonly supportsReactions: boolean;
  readonly supportsEditing: boolean;
  readonly supportsEmbeds: boolean;
  readonly supportsAttachments: boolean;
  readonly maxMessageLength: number;
  /** 금융 특화: 실시간 시세 업데이트 지원 여부 */
  readonly supportsLiveQuotes: boolean;
  /** 금융 특화: 차트 이미지 렌더링 지원 여부 */
  readonly supportsChartRendering: boolean;
}

/** 채팅 유형 열거형 */
export type ChatType =
  | 'direct-message'
  | 'group-chat'
  | 'channel-public'
  | 'channel-private'
  | 'thread'
  | 'webhook';

/** 경량 채널 메타데이터 (플러그인 로딩 없이 동작) */
export interface ChannelDock {
  readonly id: string;
  readonly name: string;
  readonly type: string; // 'discord' | 'http-webhook' | ...
  readonly capabilities: ChannelCapabilities;
  readonly gatingRules: GatingRuleSet;
  readonly chatTypeNormalizer: (raw: unknown) => ChatType;
}

/** 게이팅 규칙 집합 */
export interface GatingRuleSet {
  readonly mentionRequired: boolean;
  readonly commandPrefix: string | null;
  readonly allowlist: AllowlistConfig | null;
  readonly denylist: string[];
}

/** 화이트리스트 설정 */
export interface AllowlistConfig {
  readonly userIds: readonly string[];
  readonly roleIds: readonly string[];
  readonly channelIds: readonly string[];
}

/** 채널 플러그인 - 실제 채널 동작 구현 */
export interface ChannelPlugin<TAccount = unknown> {
  readonly dock: ChannelDock;

  // --- 라이프사이클 ---
  initialize(config: Record<string, unknown>): Promise<void>;
  shutdown(): Promise<void>;

  // --- 메시지 수신 ---
  onMessage?(handler: MessageHandler): Unsubscribe;
  onReaction?(handler: ReactionHandler): Unsubscribe;

  // --- 메시지 발신 ---
  sendMessage(channelId: string, content: OutboundMessage): Promise<SentMessage>;
  editMessage?(messageId: string, content: OutboundMessage): Promise<void>;
  deleteMessage?(messageId: string): Promise<void>;

  // --- UI 피드백 ---
  setTyping?(channelId: string, active: boolean): Promise<void>;
  addReaction?(messageId: string, emoji: string): Promise<void>;

  // --- 계정 해석 ---
  resolveAccount?(userId: string): Promise<TAccount>;
}

export type MessageHandler = (msg: InboundMessage) => Promise<void>;
export type ReactionHandler = (reaction: InboundReaction) => Promise<void>;
export type Unsubscribe = () => void;

/** 인바운드 메시지 표준 형식 */
export interface InboundMessage {
  readonly id: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly content: string;
  readonly chatType: ChatType;
  readonly timestamp: Date;
  readonly threadId?: string;
  readonly replyToId?: string;
  readonly attachments: readonly Attachment[];
  readonly raw: unknown; // 채널 원본 데이터
}

/** 아웃바운드 메시지 표준 형식 */
export interface OutboundMessage {
  readonly content: string;
  readonly embeds?: readonly Embed[];
  readonly attachments?: readonly Attachment[];
  readonly replyToId?: string;
  readonly threadId?: string;
}

export interface SentMessage {
  readonly id: string;
  readonly channelId: string;
  readonly timestamp: Date;
}
```

### 4.2 PluginRegistry (13-Slot)

```typescript
// src/plugins/registry.ts

/** 플러그인 레지스트리 슬롯 정의 */
export interface PluginRegistrySlots {
  tools: ToolRegistration[]; // 슬롯 0: AI 도구
  channels: ChannelPlugin[]; // 슬롯 1: 채널 플러그인
  hooks: HookRegistration[]; // 슬롯 2: 라이프사이클 훅
  services: ServiceRegistration[]; // 슬롯 3: 백그라운드 서비스
  commands: CommandRegistration[]; // 슬롯 4: CLI 명령어
  routes: RouteRegistration[]; // 슬롯 5: HTTP 라우트
  middlewares: MiddlewareRegistration[]; // 슬롯 6: 미들웨어
  formatters: FormatterRegistration[]; // 슬롯 7: 응답 포매터
  validators: ValidatorRegistration[]; // 슬롯 8: 입력 검증기
  transformers: TransformerRegistration[]; // 슬롯 9: 데이터 변환기
  schedulers: SchedulerRegistration[]; // 슬롯 10: 스케줄러
  monitors: MonitorRegistration[]; // 슬롯 11: 모니터링
  extensions: ExtensionRegistration[]; // 슬롯 12: 범용 확장
}

export type SlotName = keyof PluginRegistrySlots;

/** 글로벌 레지스트리 싱글턴 키 */
const REGISTRY_KEY = Symbol.for('finclaw.plugin-registry');

export class PluginRegistry {
  private slots: PluginRegistrySlots;

  static getInstance(): PluginRegistry {
    const existing = (globalThis as any)[REGISTRY_KEY];
    if (existing instanceof PluginRegistry) return existing;
    const registry = new PluginRegistry();
    (globalThis as any)[REGISTRY_KEY] = registry;
    return registry;
  }

  register<S extends SlotName>(slot: S, entry: PluginRegistrySlots[S][number]): void;

  getSlot<S extends SlotName>(slot: S): ReadonlyArray<PluginRegistrySlots[S][number]>;

  clear(): void;
}
```

### 4.3 Plugin Manifest & Loader

```typescript
// src/plugins/manifest.ts

/** 플러그인 매니페스트 (package.json의 finclaw 필드 또는 별도 manifest.json) */
export interface PluginManifest {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly entry: string; // 진입점 파일 경로
  readonly slots: SlotName[]; // 등록할 슬롯 목록
  readonly dependencies?: string[]; // 의존 플러그인
  readonly config?: Record<string, unknown>; // 플러그인별 설정
  readonly capabilities?: string[]; // 제공 기능 태그
}

// src/plugins/loader.ts

/** 4-stage 플러그인 로더 파이프라인 */
export interface PluginLoaderPipeline {
  /** Stage 1: 파일시스템에서 플러그인 후보 탐색 */
  discover(searchPaths: string[]): Promise<DiscoveredPlugin[]>;

  /** Stage 2: 매니페스트 파싱 및 검증 */
  parseManifest(discovered: DiscoveredPlugin): Promise<PluginManifest>;

  /** Stage 3: jiti를 사용한 TypeScript 플러그인 동적 로딩 */
  load(manifest: PluginManifest): Promise<LoadedPlugin>;

  /** Stage 4: 로드된 플러그인을 PluginRegistry에 등록 */
  register(loaded: LoadedPlugin, registry: PluginRegistry): Promise<void>;
}

export interface DiscoveredPlugin {
  readonly path: string;
  readonly manifestPath: string;
}

export interface LoadedPlugin {
  readonly manifest: PluginManifest;
  readonly module: Record<string, unknown>;
  readonly exports: PluginExports;
}

export interface PluginExports {
  readonly activate?: (ctx: PluginContext) => Promise<void>;
  readonly deactivate?: () => Promise<void>;
}
```

### 4.4 Hook System

```typescript
// src/plugins/hooks.ts

/** 훅 실행 모드 */
export type HookMode = 'void' | 'modifying' | 'sync';

/** 훅 정의 */
export interface HookDefinition<TPayload = unknown, TResult = void> {
  readonly name: string;
  readonly mode: HookMode;
}

/** 훅 핸들러 타입 */
export type VoidHookHandler<T> = (payload: T) => Promise<void>;
export type ModifyingHookHandler<T> = (payload: T) => Promise<T>;
export type SyncHookHandler<T, R> = (payload: T) => R;

/** 훅 러너 팩토리 */
export function createHookRunner<TPayload>(
  definition: HookDefinition<TPayload, void> & { mode: 'void' },
): VoidHookRunner<TPayload>;

export function createHookRunner<TPayload>(
  definition: HookDefinition<TPayload, TPayload> & { mode: 'modifying' },
): ModifyingHookRunner<TPayload>;

export function createHookRunner<TPayload, TResult>(
  definition: HookDefinition<TPayload, TResult> & { mode: 'sync' },
): SyncHookRunner<TPayload, TResult>;

/** void 훅 러너: 모든 핸들러를 병렬 실행 */
export interface VoidHookRunner<T> {
  tap(handler: VoidHookHandler<T>): Unsubscribe;
  fire(payload: T): Promise<void>;
}

/** modifying 훅 러너: 핸들러를 순차 실행하며 payload를 변형 */
export interface ModifyingHookRunner<T> {
  tap(handler: ModifyingHookHandler<T>): Unsubscribe;
  fire(payload: T): Promise<T>;
}

/** sync 훅 러너: 핸들러를 동기적으로 실행 */
export interface SyncHookRunner<T, R> {
  tap(handler: SyncHookHandler<T, R>): Unsubscribe;
  fire(payload: T): R[];
}

/** FinClaw 내장 훅 목록 (14종) */
export const BUILT_IN_HOOKS = {
  'message:before-process': { mode: 'modifying' as const },
  'message:after-process': { mode: 'void' as const },
  'message:before-send': { mode: 'modifying' as const },
  'message:after-send': { mode: 'void' as const },
  'tool:before-execute': { mode: 'modifying' as const },
  'tool:after-execute': { mode: 'void' as const },
  'session:created': { mode: 'void' as const },
  'session:destroyed': { mode: 'void' as const },
  'plugin:loaded': { mode: 'void' as const },
  'plugin:unloaded': { mode: 'void' as const },
  'agent:model-selected': { mode: 'void' as const },
  'agent:context-compacted': { mode: 'void' as const },
  'finance:quote-received': { mode: 'void' as const },
  'finance:alert-triggered': { mode: 'modifying' as const },
} as const;
```

---

## 5. 구현 상세

### 5.1 ChannelDock: 경량 메타데이터 계층

```typescript
// src/channels/dock.ts

import type { ChannelCapabilities, ChannelDock, ChatType, GatingRuleSet } from './types.js';

/** ChannelDock 빌더 - 선언적 채널 메타데이터 구성 */
export class ChannelDockBuilder {
  private _id: string = '';
  private _name: string = '';
  private _type: string = '';
  private _capabilities: Partial<ChannelCapabilities> = {};
  private _gatingRules: Partial<GatingRuleSet> = {};
  private _chatTypeNormalizer: ((raw: unknown) => ChatType) | null = null;

  id(id: string): this {
    this._id = id;
    return this;
  }
  name(name: string): this {
    this._name = name;
    return this;
  }
  type(type: string): this {
    this._type = type;
    return this;
  }

  capabilities(caps: Partial<ChannelCapabilities>): this {
    this._capabilities = { ...this._capabilities, ...caps };
    return this;
  }

  gating(rules: Partial<GatingRuleSet>): this {
    this._gatingRules = { ...this._gatingRules, ...rules };
    return this;
  }

  chatTypeNormalizer(fn: (raw: unknown) => ChatType): this {
    this._chatTypeNormalizer = fn;
    return this;
  }

  build(): ChannelDock {
    // 필수 필드 검증
    if (!this._id || !this._name || !this._type) {
      throw new Error('ChannelDock requires id, name, and type');
    }

    const defaultCapabilities: ChannelCapabilities = {
      supportsThreads: false,
      supportsReactions: false,
      supportsEditing: false,
      supportsEmbeds: false,
      supportsAttachments: false,
      maxMessageLength: 2000,
      supportsLiveQuotes: false,
      supportsChartRendering: false,
    };

    return Object.freeze({
      id: this._id,
      name: this._name,
      type: this._type,
      capabilities: { ...defaultCapabilities, ...this._capabilities },
      gatingRules: {
        mentionRequired: this._gatingRules.mentionRequired ?? false,
        commandPrefix: this._gatingRules.commandPrefix ?? null,
        allowlist: this._gatingRules.allowlist ?? null,
        denylist: this._gatingRules.denylist ?? [],
      },
      chatTypeNormalizer: this._chatTypeNormalizer ?? (() => 'channel-public' as ChatType),
    });
  }
}

export function createDock(): ChannelDockBuilder {
  return new ChannelDockBuilder();
}
```

### 5.2 PluginRegistry: globalThis Symbol 싱글턴

핵심 알고리즘:

1. `Symbol.for('finclaw.plugin-registry')`를 키로 `globalThis`에 레지스트리 인스턴스를 저장
2. 여러 모듈/패키지에서 `import`해도 동일한 인스턴스를 반환
3. 13개 슬롯은 `Map<SlotName, unknown[]>`으로 내부 관리
4. `register()`는 슬롯 이름 검증 후 배열에 push
5. `getSlot()`은 `Object.freeze()` 래핑된 읽기 전용 배열 반환

```typescript
// src/plugins/registry.ts

const REGISTRY_KEY = Symbol.for('finclaw.plugin-registry');
const VALID_SLOTS: readonly SlotName[] = [
  'tools',
  'channels',
  'hooks',
  'services',
  'commands',
  'routes',
  'middlewares',
  'formatters',
  'validators',
  'transformers',
  'schedulers',
  'monitors',
  'extensions',
] as const;

export class PluginRegistry {
  private readonly slots = new Map<SlotName, unknown[]>();

  private constructor() {
    for (const slot of VALID_SLOTS) {
      this.slots.set(slot, []);
    }
  }

  static getInstance(): PluginRegistry {
    const g = globalThis as Record<symbol, unknown>;
    if (g[REGISTRY_KEY] instanceof PluginRegistry) {
      return g[REGISTRY_KEY];
    }
    const registry = new PluginRegistry();
    g[REGISTRY_KEY] = registry;
    return registry;
  }

  register<S extends SlotName>(slot: S, entry: PluginRegistrySlots[S][number]): void {
    const arr = this.slots.get(slot);
    if (!arr) throw new Error(`Invalid plugin slot: ${String(slot)}`);
    arr.push(entry);
  }

  getSlot<S extends SlotName>(slot: S): ReadonlyArray<PluginRegistrySlots[S][number]> {
    const arr = this.slots.get(slot);
    if (!arr) throw new Error(`Invalid plugin slot: ${String(slot)}`);
    return Object.freeze([...arr]) as ReadonlyArray<PluginRegistrySlots[S][number]>;
  }

  /** 특정 슬롯 내에서 조건에 맞는 항목 검색 */
  findInSlot<S extends SlotName>(
    slot: S,
    predicate: (entry: PluginRegistrySlots[S][number]) => boolean,
  ): PluginRegistrySlots[S][number] | undefined {
    const arr = this.slots.get(slot) as PluginRegistrySlots[S][number][];
    return arr.find(predicate);
  }

  /** 모든 슬롯 초기화 (테스트용) */
  clear(): void {
    for (const arr of this.slots.values()) {
      arr.length = 0;
    }
  }

  /** 등록된 총 항목 수 */
  get totalRegistrations(): number {
    let count = 0;
    for (const arr of this.slots.values()) count += arr.length;
    return count;
  }
}
```

### 5.3 Plugin Loader: 4-Stage Pipeline

데이터 흐름: `searchPaths[] -> DiscoveredPlugin[] -> PluginManifest -> LoadedPlugin -> Registry`

```typescript
// src/plugins/loader.ts

import { createJiti } from 'jiti';

/** 4-stage 파이프라인 오케스트레이터 */
export async function loadPlugins(
  searchPaths: string[],
  registry: PluginRegistry,
): Promise<PluginLoadResult> {
  const result: PluginLoadResult = { loaded: [], failed: [] };

  // Stage 1: Discovery
  const discovered = await discoverPlugins(searchPaths);

  for (const plugin of discovered) {
    try {
      // Stage 2: Manifest parsing
      const manifest = await parseManifest(plugin.manifestPath);

      // Stage 3: jiti dynamic loading (TypeScript 지원)
      const jiti = createJiti(import.meta.url, {
        interopDefault: true,
        moduleCache: false,
      });
      const mod = (await jiti.import(manifest.entry)) as Record<string, unknown>;

      const loaded: LoadedPlugin = {
        manifest,
        module: mod,
        exports: {
          activate: typeof mod.activate === 'function' ? mod.activate : undefined,
          deactivate: typeof mod.deactivate === 'function' ? mod.deactivate : undefined,
        },
      };

      // Stage 4: Registration
      if (loaded.exports.activate) {
        await loaded.exports.activate({ registry, config: manifest.config ?? {} });
      }

      result.loaded.push(loaded);
    } catch (error) {
      result.failed.push({
        path: plugin.path,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  return result;
}

export interface PluginLoadResult {
  loaded: LoadedPlugin[];
  failed: Array<{ path: string; error: Error }>;
}
```

### 5.4 Hook System: createHookRunner()

핵심 알고리즘:

- **void 모드**: `Promise.allSettled(handlers.map(h => h(payload)))` -- 병렬 실행, 실패 격리
- **modifying 모드**: `for (const h of handlers) payload = await h(payload)` -- 순차 실행, 체이닝
- **sync 모드**: `handlers.map(h => h(payload))` -- 동기 실행, 결과 수집

```typescript
// src/plugins/hooks.ts

export function createHookRunner<T>(
  definition: HookDefinition<T>,
): VoidHookRunner<T> | ModifyingHookRunner<T> | SyncHookRunner<T, unknown> {
  const handlers: Array<(...args: any[]) => any> = [];

  const tap = (handler: (...args: any[]) => any): Unsubscribe => {
    handlers.push(handler);
    return () => {
      const idx = handlers.indexOf(handler);
      if (idx !== -1) handlers.splice(idx, 1);
    };
  };

  switch (definition.mode) {
    case 'void':
      return {
        tap,
        async fire(payload: T): Promise<void> {
          // 병렬 실행 + 에러 격리
          const results = await Promise.allSettled(handlers.map((h) => h(payload)));
          // 실패한 핸들러 로깅 (에러를 throw하지 않음)
          for (const r of results) {
            if (r.status === 'rejected') {
              console.error(`[Hook:${definition.name}] handler failed:`, r.reason);
            }
          }
        },
      };

    case 'modifying':
      return {
        tap,
        async fire(payload: T): Promise<T> {
          let current = payload;
          // 순차 실행 + payload 체이닝
          for (const handler of handlers) {
            current = await handler(current);
          }
          return current;
        },
      };

    case 'sync':
      return {
        tap,
        fire(payload: T): unknown[] {
          return handlers.map((h) => h(payload));
        },
      };
  }
}
```

### 5.5 Gating 모듈

```typescript
// src/channels/gating/mention-gating.ts

/** 멘션 게이팅: 봇이 멘션된 경우에만 응답 허용 */
export function shouldProcessByMention(
  message: InboundMessage,
  dock: ChannelDock,
  botUserId: string,
): GatingResult {
  if (!dock.gatingRules.mentionRequired) {
    return { allowed: true, reason: 'mention-gating-disabled' };
  }
  // DM은 항상 허용
  if (message.chatType === 'direct-message') {
    return { allowed: true, reason: 'direct-message-bypass' };
  }
  // 메시지 내용에서 봇 멘션 탐지
  const mentioned =
    message.content.includes(`<@${botUserId}>`) || message.content.includes(`<@!${botUserId}>`);
  return mentioned
    ? { allowed: true, reason: 'bot-mentioned' }
    : { allowed: false, reason: 'bot-not-mentioned' };
}

export interface GatingResult {
  readonly allowed: boolean;
  readonly reason: string;
}
```

---

## 6. 선행 조건

| Phase                   | 구체적 산출물                                                                    | 필요 이유                            |
| ----------------------- | -------------------------------------------------------------------------------- | ------------------------------------ |
| Phase 1 (타입 시스템)   | `ChannelPlugin`, `PluginManifest`, `InboundMessage`, `OutboundMessage` 타입 정의 | 채널/플러그인 인터페이스의 타입 기반 |
| Phase 2 (인프라)        | `Logger` 인스턴스, `FinClawError` 커스텀 에러 클래스                             | 플러그인 로딩 실패 로깅, 에러 처리   |
| Phase 3 (설정)          | `PluginConfig`, `ChannelConfig` zod 스키마, `config.plugins.searchPaths`         | 플러그인 탐색 경로, 채널 설정        |
| Phase 4 (메시지 라우팅) | `MessageRouter` 기본 구조                                                        | 채널에서 수신한 메시지의 라우팅 대상 |

---

## 7. 산출물 및 검증

### 테스트 가능한 결과물

| #   | 산출물                                           | 검증 방법                                                                  |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| 1   | `ChannelDockBuilder`로 Discord/Webhook Dock 생성 | 단위 테스트: 빌더 체이닝, 기본값, 필수값 검증                              |
| 2   | `PluginRegistry` 싱글턴 보장                     | 단위 테스트: 다른 모듈에서 `getInstance()` 호출 시 동일 인스턴스           |
| 3   | 13-slot 등록/조회                                | 단위 테스트: 모든 슬롯에 항목 등록 후 `getSlot()` 일치 확인                |
| 4   | 4-stage 플러그인 로더                            | 통합 테스트: 테스트 플러그인 디렉토리 스캔 -> 로드 -> 레지스트리 등록 확인 |
| 5   | `createHookRunner()` 3모드                       | 단위 테스트: void(병렬 확인), modifying(순차+변형), sync(동기+결과)        |
| 6   | mention-gating                                   | 단위 테스트: 멘션 있음/없음/DM 바이패스 3케이스                            |
| 7   | command-gating                                   | 단위 테스트: 접두사 매칭/불일치/빈 문자열                                  |
| 8   | allowlist 매칭                                   | 단위 테스트: userId/roleId/channelId 매칭 조합                             |
| 9   | ChatType 정규화                                  | 단위 테스트: Discord raw 타입 -> 표준 ChatType 변환                        |
| 10  | Plugin SDK re-export                             | 타입 체크: `import { ChannelPlugin } from 'finclaw/plugin-sdk'` 성공       |

### 검증 명령어

```bash
# 단위 테스트
pnpm test -- --filter='src/channels/**' --filter='src/plugins/**'

# 타입 체크
pnpm typecheck

# 커버리지 (목표: branches 80%+)
pnpm test:coverage -- --filter='src/channels/**' --filter='src/plugins/**'
```

---

## 8. 복잡도 및 예상 파일 수

| 항목            | 값                                                                |
| --------------- | ----------------------------------------------------------------- |
| **복잡도**      | **XL**                                                            |
| **소스 파일**   | 14개 (`src/channels/` 8 + `src/plugins/` 5 + `src/plugin-sdk/` 1) |
| **테스트 파일** | 8개 (`src/channels/__tests__/` 4 + `src/plugins/__tests__/` 4)    |
| **총 파일 수**  | **~22개**                                                         |
| **예상 LOC**    | 소스 ~1,800 / 테스트 ~1,200 / 합계 ~3,000                         |
| **새 의존성**   | `jiti` (TypeScript 동적 로딩)                                     |
| **예상 소요**   | 3-4일                                                             |

### 복잡도 근거 (XL)

- OpenClaw 80+ 파일을 22개로 압축하지만 핵심 패턴(Two-Tier, 13-slot, 4-stage, 3-mode hooks)은 모두 구현
- `globalThis` Symbol 싱글턴은 테스트 격리에 주의 필요 (각 테스트에서 `registry.clear()` 호출)
- jiti 동적 로딩은 ESM/CJS 호환성 이슈 가능성
- Hook 시스템의 3가지 실행 모드는 각각 다른 동시성 모델 적용
- 게이팅 모듈 4종의 조합 테스트 경우의 수가 많음
