# Phase 5: 채널 추상화 & 플러그인 시스템

> 복잡도: **L** | 소스 파일: ~17 | 테스트 파일: ~11 | 합계: **~28 파일**

---

## 1. 목표

채널(Discord, Slack 등) 연동과 플러그인 확장을 위한 **이중 계층(Two-Tier) 아키텍처**를 구현한다.

- **ChannelDock**: 경량 메타데이터 계층. Phase 1 정의(`packages/types/src/channel.ts`)의 `ChannelDock` 인터페이스 기반으로 채널별 기능과 제약을 선언적으로 기술하며 플러그인 로딩 없이 동작한다.
- **ChannelPlugin**: Phase 1 정의(`packages/types/src/channel.ts`)의 옵셔널 어댑터 인터페이스. 메시지 수신/발신, 리액션, 타이핑 등 채널별 행위를 캡슐화한다.
- **PluginRegistry**: Phase 1 기존 6슬롯 + 2개 추가(routes, diagnostics) = **8슬롯** 중앙 레지스트리. `globalThis` Symbol 싱글턴 + 함수형 API + `freeze()` 메커니즘으로 안전한 전역 접근을 보장한다.
- **Plugin Loader**: **5단계 파이프라인**(Discovery → Security → Manifest → Load → Register) + **3-tier fallback**(ESM → 네이티브 TS → jiti)로 플러그인을 안전하게 적재한다.
- **Hook System**: `createHookRunner()`로 3가지 모드(void=병렬, modifying=순차, sync=동기)의 훅 실행을 지원한다. **priority 기반 정렬**, modifying 에러 격리, sync Promise 경고를 포함한다.
- **Gating Pipeline**: `composeGates()`로 mention-gating, command-gating, allowlist-match를 합성하는 순수 함수 기반 메시지 필터링 파이프라인.
- **보안 검증**: 3단계(path traversal, 확장자, world-writable) 보안 체크로 플러그인 경로 탈출 공격 방지.
- **Graceful Degradation**: 개별 플러그인 실패가 전체 시스템에 전파되지 않도록 `PluginDiagnostic` 기반 격리.

---

## 2. OpenClaw 참조

| 참조 문서 경로                                             | 적용할 패턴                                                                |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| `openclaw_review/docs/08.채널-추상화와-플러그인-시스템.md` | Two-Tier(Dock + Plugin) 아키텍처, 채널 capabilities, 8-slot PluginRegistry |
| `openclaw_review/deep-dive/08-channels-core.md`            | globalThis Symbol 싱글턴, 정적 DOCKS Record 패턴, jiti 동적 로딩           |
| `openclaw_review/docs/13.데몬-크론-훅-프로세스-보안.md`    | createHookRunner() 3모드, 훅 타입 정의, priority 정렬                      |
| `openclaw_review/deep-dive/13-daemon-cron-hooks.md`        | priority 정렬 직접 구현, modifying merge, sync Promise 감지                |
| `openclaw_review/docs/07.자동-응답-파이프라인.md`          | 게이팅 패턴: mention-gating, command-gating, allowlist                     |

**OpenClaw 대비 FinClaw 간소화 사항:**

- 80+ 파일 → ~28 파일로 핵심만 추출
- 채널 타입을 Discord + HTTP Webhook 2종으로 초기 제한
- 13슬롯 → 8슬롯 (YAGNI 원칙)
- 14훅 → 9훅 (Phase 스코프 외 항목 제거)
- ChannelDockBuilder 클래스 → `createChannelDock()` 팩토리 함수 (OpenClaw 패턴)

---

## 3. 생성할 파일

### 소스 파일 (17개)

```
packages/server/src/channels/
├── index.ts                    # 채널 모듈 barrel export
├── dock.ts                     # createChannelDock() 팩토리 + CORE_DOCKS
├── registry.ts                 # 채널 레지스트리 (등록/조회, built-in + plugin merge)
├── chat-type.ts                # ChatType 정규화 유틸
├── typing.ts                   # 타이핑 인디케이터 관리
└── gating/
    ├── pipeline.ts             # composeGates() 파이프라인 합성
    ├── mention-gating.ts       # 멘션 기반 게이팅 (순수 함수)
    ├── command-gating.ts       # 커맨드 게이팅 (순수 함수)
    └── allowlist.ts            # 화이트리스트 매칭 (순수 함수)

packages/server/src/plugins/
├── index.ts                    # 플러그인 모듈 barrel export
├── discovery.ts                # 플러그인 탐색 + 3단계 보안 검증
├── loader.ts                   # 5-stage 파이프라인 + 3-tier fallback 로더
├── registry.ts                 # 8-slot PluginRegistry + globalThis 싱글턴 + freeze()
├── hooks.ts                    # createHookRunner() 3모드 + priority 정렬
├── hook-types.ts               # HookPayloadMap + HookModeMap (타입 안전성)
├── manifest.ts                 # Zod v4 매니페스트 파싱/검증 + toJSONSchema
├── errors.ts                   # PluginLoadError, PluginSecurityError, RegistryFrozenError
└── event-bridge.ts             # Hook ↔ EventBus 단방향 브릿지
```

### 테스트 파일 (11개)

```
packages/server/test/channels/
├── dock.test.ts                # createChannelDock(), CORE_DOCKS, Object.freeze 불변성
├── chat-type.test.ts           # ChatType 정규화 테스트
├── gating.test.ts              # 게이팅 파이프라인 통합 (composeGates, early exit, DM bypass)
└── channel-registry.test.ts    # 채널 등록/조회, built-in + plugin merge

packages/server/test/plugins/
├── discovery.test.ts           # 보안 검증 (path traversal, 확장자, world-writable)
├── loader.test.ts              # 5-stage 로더, 3-tier fallback, register/activate alias
├── registry.test.ts            # 8-slot PluginRegistry, globalThis 격리, freeze
├── hooks.test.ts               # void(병렬), modifying(순차+에러격리), sync(동기+Promise경고)
├── hooks-typed.test.ts         # HookPayloadMap, priority 정렬, registeredAt 보조 정렬
├── manifest.test.ts            # Zod v4 유효/무효 매니페스트, toJSONSchema 출력
└── diagnostics.test.ts         # Diagnostics 슬롯, 실패 기록, severity 필터링
```

### 타입 확장 (Phase 1 패키지 수정)

```
packages/types/src/plugin.ts    # PluginRegistry에 routes/diagnostics 슬롯 추가
                                # PluginHookName에 onPluginLoaded/onPluginUnloaded 추가
                                # PluginManifest에 slots/config/configSchema 추가
```

---

## 4. 핵심 인터페이스/타입

### 4.1 Phase 1 기정의 타입 참조 (재정의하지 않음)

아래 타입은 `packages/types/src/`에 이미 정의되어 있다. Phase 5는 이들을 **import하여 사용**하며, 재정의하지 않는다.

**`packages/types/src/channel.ts`에서 참조:**

- `ChannelPlugin<TAccount>` — id(`ChannelId`), meta(`ChannelMeta`), capabilities, setup?, onMessage?, send?, sendTyping?, addReaction?
- `ChannelMeta` — name, displayName, icon?, color?, website?
- `ChannelCapabilities` — supportsMarkdown, supportsImages, supportsAudio, supportsVideo, supportsButtons, supportsThreads, supportsReactions, supportsEditing, maxMessageLength, maxMediaSize?
- `ChannelDock` — id(`ChannelId`), meta, capabilities, defaultChatType(`'direct'|'group'`), threadingMode(`'none'|'native'|'emulated'`), outboundLimits(`OutboundLimits`)
- `OutboundLimits` — maxChunkLength, maxMediaPerMessage, rateLimitPerMinute

**`packages/types/src/message.ts`에서 참조:**

- `ChatType = 'direct' | 'group' | 'channel'` (3종)
- `InboundMessage` — id, channelId, chatType, senderId, senderName?, body, rawBody?, timestamp, threadId?, replyToId?, media?, metadata?
- `OutboundMessage` — channelId, targetId, payloads, replyToMessageId?, threadId?

**`packages/types/src/plugin.ts`에서 참조:**

- `PluginManifest` — name, version, description?, author?, main, type, dependencies?
- `PluginRegistry` — plugins, tools, channels, hooks, services, commands (6슬롯)
- `RegisteredPlugin` — manifest, status, error?, loadedAt
- `PluginHook` — name, **priority**, handler, pluginName
- `PluginHookName` — 7종 (camelCase): beforeMessageProcess, afterMessageProcess, beforeAgentRun, afterAgentRun, onConfigChange, onGatewayStart, onGatewayStop
- `PluginService` — name, start(), stop()
- `PluginCommand` — name, description, handler, pluginName

### 4.2 PluginRegistry 확장 (6 → 8슬롯)

Phase 1의 6슬롯에 2개를 **additive하게** 추가한다. 기존 슬롯 정의를 변경하지 않는다.

```typescript
// packages/types/src/plugin.ts — Phase 5에서 추가할 필드

/** HTTP 라우트 등록 */
export interface RouteRegistration {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  handler: (req: unknown, res: unknown) => Promise<void>;
  pluginName: string;
}

/** 플러그인 진단 정보 */
export interface PluginDiagnostic {
  pluginName: string;
  timestamp: number;
  severity: 'info' | 'warn' | 'error';
  phase: 'discovery' | 'manifest' | 'load' | 'register' | 'runtime';
  message: string;
  error?: { code: string; stack?: string };
}

export interface PluginRegistry {
  plugins: RegisteredPlugin[]; // Phase 1 기존
  tools: ToolDefinition[]; // Phase 1 기존
  channels: ChannelPlugin[]; // Phase 1 기존
  hooks: PluginHook[]; // Phase 1 기존
  services: PluginService[]; // Phase 1 기존
  commands: PluginCommand[]; // Phase 1 기존
  routes: RouteRegistration[]; // ← Phase 5 추가 (Phase 6 게이트웨이용)
  diagnostics: PluginDiagnostic[]; // ← Phase 5 추가 (Graceful Degradation)
}
```

**13슬롯 → 8슬롯 축소 근거:**

| 제거 슬롯      | 대체                              | 근거                          |
| -------------- | --------------------------------- | ----------------------------- |
| `middlewares`  | `routes` 슬롯에 통합              | 라우트와 미들웨어 분리 불필요 |
| `formatters`   | `OutboundMessage`에서 직접 포매팅 | 사용처 없음                   |
| `validators`   | Zod v4가 모든 검증 담당           | Phase 3에서 이미 구축         |
| `transformers` | hooks의 modifying 모드로 대체     | 훅이 변환 역할 수행           |
| `schedulers`   | `services` 슬롯으로 대체          | 별도 슬롯 불필요              |
| `monitors`     | `diagnostics` 슬롯으로 대체       | 진단과 모니터링 통합          |
| `extensions`   | 모든 슬롯이 확장점                | 범용 확장 슬롯 불필요         |

### 4.3 PluginManifest 확장

Phase 1 기존 7필드 유지 + 선택적 필드 3개 추가:

```typescript
// packages/types/src/plugin.ts — Phase 5 확장

export interface PluginManifest {
  // Phase 1 기존 7개 필드 유지
  name: string;
  version: string;
  description?: string;
  author?: string;
  main: string;
  type: 'channel' | 'skill' | 'tool' | 'service';
  dependencies?: string[];
  // Phase 5 추가
  slots?: string[]; // 등록할 슬롯 목록
  config?: Record<string, unknown>; // 플러그인별 설정
  configSchema?: unknown; // Zod v4 스키마 (Phase 3 호환)
}
```

**PluginExports — register || activate 양쪽 지원:**

```typescript
// packages/server/src/plugins/loader.ts 내부

export interface PluginExports {
  readonly register?: (api: PluginBuildApi) => void;
  readonly activate?: (api: PluginBuildApi) => void; // register의 호환성 alias
  readonly deactivate?: () => Promise<void>;
}

// 해석 우선순위: register > activate
const registerFn = mod.register ?? mod.activate;
```

### 4.4 Hook System 타입

**PluginHookName 확장 (7 → 9종, camelCase 유지):**

```typescript
// packages/types/src/plugin.ts — Phase 5 확장

export type PluginHookName =
  | 'beforeMessageProcess'
  | 'afterMessageProcess' // Phase 1 기존
  | 'beforeAgentRun'
  | 'afterAgentRun' // Phase 1 기존
  | 'onConfigChange'
  | 'onGatewayStart'
  | 'onGatewayStop' // Phase 1 기존
  | 'onPluginLoaded'
  | 'onPluginUnloaded'; // Phase 5 추가
```

> **camelCase 유지 근거:** Phase 1이 이미 camelCase로 확정. plan.md의 colon-separated(`message:before-process`) 스타일은 채택하지 않는다. 마이그레이션 비용 불필요.

**HookPayloadMap + HookModeMap (컴파일 타임 안전성):**

```typescript
// packages/server/src/plugins/hook-types.ts
import type { InboundMessage } from '@finclaw/types';

export interface HookPayloadMap {
  beforeMessageProcess: InboundMessage;
  afterMessageProcess: InboundMessage;
  beforeAgentRun: { agentId: string; sessionKey: string };
  afterAgentRun: { agentId: string; sessionKey: string; result: unknown };
  onConfigChange: { changedPaths: string[] };
  onGatewayStart: void;
  onGatewayStop: void;
  onPluginLoaded: { pluginName: string; slots: string[] };
  onPluginUnloaded: { pluginName: string };
}

export interface HookModeMap {
  beforeMessageProcess: 'modifying';
  afterMessageProcess: 'void';
  beforeAgentRun: 'modifying';
  afterAgentRun: 'void';
  onConfigChange: 'void';
  onGatewayStart: 'void';
  onGatewayStop: 'void';
  onPluginLoaded: 'void';
  onPluginUnloaded: 'void';
}
```

---

## 5. 구현 상세

### 5.1 ChannelDock: createChannelDock() 팩토리 + CORE_DOCKS

OpenClaw `dock.ts`는 정적 `DOCKS` Record를 사용하며 빌더 클래스가 없다. 동일 패턴을 적용한다.

```typescript
// packages/server/src/channels/dock.ts
import type {
  ChannelDock,
  ChannelCapabilities,
  OutboundLimits,
  ChannelMeta,
  ChannelId,
} from '@finclaw/types';

const DEFAULT_CAPABILITIES: ChannelCapabilities = {
  supportsMarkdown: false,
  supportsImages: false,
  supportsAudio: false,
  supportsVideo: false,
  supportsButtons: false,
  supportsThreads: false,
  supportsReactions: false,
  supportsEditing: false,
  maxMessageLength: 2000,
};

const DEFAULT_LIMITS: OutboundLimits = {
  maxChunkLength: 2000,
  maxMediaPerMessage: 0,
  rateLimitPerMinute: 60,
};

export function createChannelDock(params: {
  id: string;
  meta: ChannelMeta;
  capabilities?: Partial<ChannelCapabilities>;
  defaultChatType?: 'direct' | 'group';
  threadingMode?: 'none' | 'native' | 'emulated';
  outboundLimits?: Partial<OutboundLimits>;
}): Readonly<ChannelDock> {
  return Object.freeze({
    id: params.id as ChannelId,
    meta: params.meta,
    capabilities: { ...DEFAULT_CAPABILITIES, ...params.capabilities },
    defaultChatType: params.defaultChatType ?? 'group',
    threadingMode: params.threadingMode ?? 'none',
    outboundLimits: { ...DEFAULT_LIMITS, ...params.outboundLimits },
  });
}

/** 코어 채널 Dock 상수 (플러그인 로딩 없이 사용 가능) */
export const CORE_DOCKS: ReadonlyMap<string, ChannelDock> = new Map([
  [
    'discord',
    createChannelDock({
      id: 'discord',
      meta: { name: 'discord', displayName: 'Discord' },
      capabilities: {
        supportsThreads: true,
        supportsReactions: true,
        supportsEditing: true,
        supportsMarkdown: true,
        supportsImages: true,
        maxMessageLength: 2000,
      },
      defaultChatType: 'group',
      threadingMode: 'native',
      outboundLimits: { maxChunkLength: 2000, maxMediaPerMessage: 10, rateLimitPerMinute: 50 },
    }),
  ],
  [
    'http-webhook',
    createChannelDock({
      id: 'http-webhook',
      meta: { name: 'http-webhook', displayName: 'HTTP Webhook' },
      capabilities: { maxMessageLength: 65535 },
      defaultChatType: 'direct',
      threadingMode: 'none',
      outboundLimits: { maxChunkLength: 65535, maxMediaPerMessage: 0, rateLimitPerMinute: 100 },
    }),
  ],
]);
```

### 5.2 PluginRegistry: 함수형 API + globalThis Symbol + freeze()

OpenClaw `runtime.ts`는 `setActivePluginRegistry()`/`getActivePluginRegistry()` 함수 패턴을 사용한다. class 대신 함수형 API를 채택한다.

```typescript
// packages/server/src/plugins/registry.ts
import type { PluginRegistry } from '@finclaw/types';
import { RegistryFrozenError } from './errors.js';

const REGISTRY_KEY = Symbol.for('finclaw.plugin-registry');

interface RegistryState {
  registry: PluginRegistry;
  frozen: boolean;
}

function createEmptyRegistry(): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    channels: [],
    hooks: [],
    services: [],
    commands: [],
    routes: [],
    diagnostics: [],
  };
}

// 모듈 레벨 IIFE — globalThis 싱글턴 초기화
const state: RegistryState = (() => {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[REGISTRY_KEY]) {
    g[REGISTRY_KEY] = { registry: createEmptyRegistry(), frozen: false };
  }
  return g[REGISTRY_KEY] as RegistryState;
})();

export type SlotName = keyof PluginRegistry;

export function getPluginRegistry(): PluginRegistry {
  return state.registry;
}

export function setPluginRegistry(registry: PluginRegistry): void {
  state.registry = registry;
  state.frozen = false;
}

export function freezeRegistry(): void {
  state.frozen = true;
}

export function registerToSlot<S extends SlotName>(
  slot: S,
  entry: PluginRegistry[S][number],
): void {
  if (state.frozen) throw new RegistryFrozenError(slot);
  (state.registry[slot] as unknown[]).push(entry);
}

export function getSlot<S extends SlotName>(slot: S): ReadonlyArray<PluginRegistry[S][number]> {
  return Object.freeze([...state.registry[slot]]) as ReadonlyArray<PluginRegistry[S][number]>;
}

export { createEmptyRegistry };
```

### 5.3 Plugin Loader: 5-Stage Pipeline + 3-Tier Fallback

데이터 흐름: `searchPaths[] → DiscoveredPlugin[] → (보안 검증) → PluginManifest → LoadedModule → Registry`

**5-Stage 파이프라인:**

```
Stage 1: Discovery       — searchPaths 스캔 + 보안 검증 (validatePluginPath)
Stage 2: Manifest Parse  — Zod v4 스키마 검증
Stage 3: Dependency Sort — 활성화 상태 결정
Stage 4: Load            — 모듈 로딩 (3-tier fallback)
Stage 5: Register        — createPluginBuildApi() 주입, register()||activate() 호출
```

**3-Tier Fallback 로더 (Stage 4):**

```typescript
// packages/server/src/plugins/loader.ts
import { getNodeMajorVersion } from '@finclaw/infra';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

async function loadPluginModule(entryPath: string): Promise<Record<string, unknown>> {
  const ext = path.extname(entryPath);

  // Tier 1: ESM 네이티브 import (컴파일된 .js/.mjs — 제로 오버헤드)
  if (ext === '.js' || ext === '.mjs') {
    return await import(pathToFileURL(entryPath).href);
  }

  // Tier 2: Node.js 24+ 네이티브 TS strip (stable)
  if (getNodeMajorVersion() >= 24) {
    try {
      return await import(pathToFileURL(entryPath).href);
    } catch {
      /* fallthrough to jiti */
    }
  }

  // Tier 3: jiti 동적 로딩 (최후 수단)
  const jiti = getOrCreateJiti();
  return (await jiti.import(entryPath)) as Record<string, unknown>;
}
```

**jiti Lazy 싱글턴 (OpenClaw loader.ts 417–439줄 패턴):**

```typescript
import { createJiti } from 'jiti';

let jitiLoader: ReturnType<typeof createJiti> | null = null;

function getOrCreateJiti(): ReturnType<typeof createJiti> {
  if (jitiLoader) return jitiLoader;
  jitiLoader = createJiti(import.meta.url, {
    interopDefault: true,
    extensions: ['.ts', '.mts', '.js', '.mjs', '.json'],
  });
  return jitiLoader;
}
```

**createPluginBuildApi() — 격리된 등록 API (OpenClaw createApi() 패턴):**

```typescript
// packages/server/src/plugins/loader.ts

export interface PluginBuildApi {
  readonly pluginName: string;
  registerChannel(channel: ChannelPlugin): void;
  registerHook(hookName: PluginHookName, handler: HookHandler, opts?: { priority?: number }): void;
  registerService(service: PluginService): void;
  registerCommand(command: PluginCommand): void;
  registerRoute(route: Omit<RouteRegistration, 'pluginName'>): void;
  addDiagnostic(diagnostic: Omit<PluginDiagnostic, 'pluginName'>): void;
}

function createPluginBuildApi(pluginName: string): PluginBuildApi {
  return {
    pluginName,
    registerChannel(ch) {
      registerToSlot('channels', ch);
    },
    registerHook(name, handler, opts) {
      registerToSlot('hooks', { name, handler, pluginName, priority: opts?.priority ?? 0 });
    },
    registerService(svc) {
      registerToSlot('services', svc);
    },
    registerCommand(cmd) {
      registerToSlot('commands', { ...cmd, pluginName });
    },
    registerRoute(route) {
      registerToSlot('routes', { ...route, pluginName });
    },
    addDiagnostic(diag) {
      registerToSlot('diagnostics', { ...diag, pluginName });
    },
  };
}
```

**register() Promise 감지 경고 (OpenClaw 650–658줄 패턴):**

```typescript
const registerFn = mod.register ?? mod.activate;
if (registerFn) {
  const result = registerFn(api);
  if (result && typeof (result as any).then === 'function') {
    registerToSlot('diagnostics', {
      pluginName: manifest.name,
      timestamp: Date.now(),
      severity: 'warn',
      phase: 'register',
      message: 'register() returned a Promise; async registration is ignored',
    });
  }
}
```

### 5.4 Hook System: createHookRunner() + priority 정렬

핵심 알고리즘:

- **void 모드**: `Promise.allSettled(sorted.map(h => h(payload)))` — 병렬 실행, 실패 격리
- **modifying 모드**: `for (const h of sorted) try { payload = await h(payload) } catch { keep previous }` — 순차 실행, 에러 격리
- **sync 모드**: `sorted.map(h => h(payload))` — 동기 실행, Promise 반환 감지 경고

**priority 기반 정렬 (Phase 1의 PluginHook.priority 활용):**

```typescript
const sorted = [...handlers].toSorted((a, b) => {
  const diff = (b.priority ?? 0) - (a.priority ?? 0); // 높은 priority 우선
  return diff !== 0 ? diff : a.registeredAt - b.registeredAt; // 동점 시 FIFO
});
```

**Modifying 모드 에러 격리 (OpenClaw 236–254줄 패턴):**

```typescript
case 'modifying':
  return {
    tap,
    async fire(payload: T): Promise<T> {
      let current = payload;
      for (const h of sorted) {
        try {
          current = await h.handler(current);
        } catch (err) {
          console.error(`[Hook:${name}] modifying handler error, keeping previous payload:`, err);
        }
      }
      return current;
    },
  };
```

**Sync 모드 Promise 반환 감지 (OpenClaw 486–494줄 패턴):**

```typescript
case 'sync':
  return {
    tap,
    fire(payload: T): R[] {
      return sorted.map((h) => {
        const result = h.handler(payload);
        if (result && typeof (result as any).then === 'function') {
          console.warn(`[Hook:${name}] sync handler returned Promise — ignored`);
        }
        return result;
      });
    },
  };
```

### 5.5 Gating Pipeline: composeGates()

OpenClaw은 게이팅을 별도 모듈에서 조합한다. FinClaw은 composable gates 패턴으로 간소화:

```typescript
// packages/server/src/channels/gating/pipeline.ts
import type { InboundMessage, ChannelDock } from '@finclaw/types';

export type GatingResult = { allowed: true } | { allowed: false; reason: string };
export type GateFunction = (
  msg: InboundMessage,
  dock: ChannelDock,
  ctx: GatingContext,
) => GatingResult;

export interface GatingContext {
  botUserId: string;
  commandPrefix: string | null;
}

export function composeGates(...gates: GateFunction[]): GateFunction {
  return (msg, dock, ctx) => {
    for (const gate of gates) {
      const result = gate(msg, dock, ctx);
      if (!result.allowed) return result; // Early exit
    }
    return { allowed: true };
  };
}
```

모든 게이팅 함수는 **순수 함수**로 유지 — mocking 없이 테스트 가능.

---

## 6. 보안 검증 레이어

OpenClaw `loader.ts` 514–529줄의 `isPathInsideWithRealpath()` 패턴을 적용한다.

```typescript
// packages/server/src/plugins/discovery.ts (보안 검증 부분)
import { PluginSecurityError } from './errors.js';

function validatePluginPath(pluginPath: string, allowedRoots: string[]): void {
  const resolved = path.resolve(pluginPath);

  // 1. Path traversal 방지 (realpath로 심볼릭 링크 해석 후 검증)
  const realPath = fs.realpathSync(resolved);
  const isAllowed = allowedRoots.some((root) => realPath.startsWith(path.resolve(root)));
  if (!isAllowed) throw new PluginSecurityError(`Path outside allowed roots: ${resolved}`);

  // 2. 확장자 필터
  const ALLOWED_EXT = new Set(['.ts', '.mts', '.js', '.mjs']);
  if (!ALLOWED_EXT.has(path.extname(resolved)))
    throw new PluginSecurityError(`Invalid extension: ${path.extname(resolved)}`);

  // 3. World-writable 검사 (Unix only — WSL/Windows는 skip)
  if (process.platform !== 'win32') {
    const stat = fs.statSync(resolved);
    if ((stat.mode & 0o002) !== 0)
      throw new PluginSecurityError(`World-writable plugin file: ${pluginPath}`);
  }
}
```

---

## 7. 에러 타입 (Discriminated Union)

Phase 2의 `FinClawError` 기반 클래스(`packages/infra/src/errors.ts`)를 상속하여 플러그인 전용 에러를 정의한다.

```typescript
// packages/server/src/plugins/errors.ts
import { FinClawError } from '@finclaw/infra';

export class PluginLoadError extends FinClawError {
  constructor(pluginName: string, phase: string, cause: Error) {
    super(`Plugin '${pluginName}' failed at ${phase}`, 'PLUGIN_LOAD_ERROR', {
      cause,
      details: { pluginName, phase },
    });
  }
}

export class PluginSecurityError extends FinClawError {
  constructor(message: string) {
    super(message, 'PLUGIN_SECURITY_ERROR', { statusCode: 403 });
  }
}

export class RegistryFrozenError extends FinClawError {
  constructor(slot: string) {
    super(`Cannot register to '${slot}' after initialization complete`, 'REGISTRY_FROZEN');
  }
}
```

---

## 8. Graceful Degradation + Diagnostics

### 에러 전파 원칙

| 상황                     | 동작                                              | 전파        |
| ------------------------ | ------------------------------------------------- | ----------- |
| Discovery 실패           | 경고 로그 + diagnostics 기록 + 다음 플러그인 계속 | 격리        |
| Manifest 파싱 실패       | PluginLoadError + diagnostics + skip              | 격리        |
| 보안 검증 실패           | PluginSecurityError + diagnostics + skip          | 격리        |
| jiti 로딩 실패           | PluginLoadError + diagnostics + skip              | 격리        |
| register() 실패          | diagnostics 기록 + skip                           | 격리        |
| void 훅 핸들러 예외      | `Promise.allSettled` — 개별 격리                  | 로그만      |
| modifying 훅 핸들러 예외 | 이전 payload 유지 + 경고                          | 체이닝 계속 |
| sync 훅 핸들러 예외      | throw (호출자가 판단)                             | 전파        |

### PluginDiagnostic 구조

```typescript
// packages/types/src/plugin.ts에 정의 (§4.2 참조)
export interface PluginDiagnostic {
  pluginName: string;
  timestamp: number;
  severity: 'info' | 'warn' | 'error';
  phase: 'discovery' | 'manifest' | 'load' | 'register' | 'runtime';
  message: string;
  error?: { code: string; stack?: string };
}
```

---

## 9. 매니페스트 검증 (Zod v4)

Phase 3 `packages/config/package.json`에 `"zod": "^4.0.0"` 의존성이 이미 존재한다.

```typescript
// packages/server/src/plugins/manifest.ts
import { z } from 'zod/v4';

export const PluginManifestSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  description: z.string().optional(),
  author: z.string().optional(),
  main: z.string(),
  type: z.enum(['channel', 'skill', 'tool', 'service']),
  dependencies: z.array(z.string()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  configSchema: z.unknown().optional(),
  slots: z.array(z.string()).optional(),
});

// JSON Schema 자동 생성 (Phase 7 Tool System에서 활용)
export const manifestJsonSchema = z.toJSONSchema(PluginManifestSchema, { target: 'draft-2020-12' });
```

---

## 10. Phase 2 인프라 재활용 매핑

Phase 5가 반드시 활용해야 할 기존 인프라 (`packages/infra/src/index.ts` barrel export 확인 완료):

| Phase 2 산출물                                   | Phase 5 활용처             | 모듈 경로                          |
| ------------------------------------------------ | -------------------------- | ---------------------------------- |
| `FinClawError`, `wrapError()`                    | 에러 서브클래스 기반       | `infra/src/errors.ts`              |
| `createLogger()`, `FinClawLogger`                | 플러그인 로더/훅 로깅      | `infra/src/logger.ts`              |
| `getEventBus()`, `TypedEmitter<FinClawEventMap>` | Hook ↔ EventBus 브릿지     | `infra/src/events.ts`              |
| `runWithContext()`, `getContext()`               | 테스트 격리, 컨텍스트 전파 | `infra/src/context.ts`             |
| `CircuitBreaker`, `createCircuitBreaker()`       | 채널 연결 실패 격리        | `infra/src/circuit-breaker.ts`     |
| `retry()`, `computeBackoff()`                    | 채널 재연결                | `infra/src/retry.ts`, `backoff.ts` |
| `getNodeMajorVersion()`                          | 3-tier 로더 분기           | `infra/src/runtime-guard.ts`       |

### EventBus ↔ Hook 브릿지

두 시스템은 **연결하되 결합하지 않는다**:

```typescript
// packages/server/src/plugins/event-bridge.ts
// Hook 실행 완료 → EventBus에 알림 (단방향)
// void 훅만 브릿지 — modifying 훅의 변형 결과는 EventBus에 전파하지 않음
```

---

## 11. 선행 조건

| Phase            | 구체적 산출물                                                                                                                         | 필요 이유                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Phase 1 (타입)   | `ChannelPlugin`, `ChannelDock`, `PluginManifest`, `PluginRegistry`(6슬롯), `PluginHookName`(7종), `InboundMessage`, `OutboundMessage` | 모든 인터페이스의 타입 기반           |
| Phase 2 (인프라) | `FinClawError`+`wrapError()`, `createLogger()`, `getEventBus()`, `runWithContext()`, `getNodeMajorVersion()`                          | 에러/로깅/이벤트/컨텍스트/런타임 분기 |
| Phase 3 (설정)   | `zod@^4.0.0` 의존성, config 스키마 패턴                                                                                               | Zod v4 매니페스트 검증, 플러그인 설정 |
| Phase 4 (라우팅) | `packages/server/src/process/` 구조, `MessageRouter`, 테스트 패턴(`packages/server/test/process/`)                                    | 서버 패키지 구조/테스트 관례의 기준점 |

---

## 12. 구현 순서 (7단계)

### Step 1: 타입 확장 + 에러 정의 + 패키지 인프라 (0.5일)

```
1. packages/types/src/plugin.ts — PluginRegistry에 routes/diagnostics 슬롯 추가
2. packages/types/src/plugin.ts — PluginHookName 확장 (+2종 camelCase)
3. packages/types/src/plugin.ts — PluginManifest 확장 (slots, config, configSchema)
4. packages/server/package.json — deps에 jiti@^2.6 추가
5. packages/server/src/plugins/errors.ts — PluginLoadError, PluginSecurityError, RegistryFrozenError
6. packages/server/src/plugins/hook-types.ts — HookPayloadMap, HookModeMap
→ 검증: pnpm typecheck (에러 0)
```

### Step 2: PluginRegistry 8-slot + freeze + 함수형 API (0.5일)

```
1. packages/server/src/plugins/registry.ts — 8슬롯, globalThis Symbol, freeze(), 함수형 API
2. packages/server/test/plugins/registry.test.ts — withIsolatedRegistry, 등록/조회/freeze
→ 검증: pnpm test -- registry.test.ts
```

### Step 3: Hook System + priority 정렬 (0.5일)

```
1. packages/server/src/plugins/hooks.ts — 3모드 + priority + registeredAt + sync Promise 경고
2. packages/server/test/plugins/hooks.test.ts — void(병렬), modifying(순차+에러격리), sync(경고)
3. packages/server/test/plugins/hooks-typed.test.ts — priority 정렬, 타입 안전성
→ 검증: hooks*.test.ts 통과
```

### Step 4: 매니페스트 + Discovery + 보안 + 로더 (1일)

```
1. packages/server/src/plugins/manifest.ts — Zod v4 스키마 + toJSONSchema
2. packages/server/src/plugins/discovery.ts — searchPaths 스캔 + 3단계 보안 검증
3. packages/server/src/plugins/loader.ts — 5-stage + 3-tier fallback + lazy jiti + createPluginBuildApi
4. packages/server/test/plugins/discovery.test.ts — 보안 검증
5. packages/server/test/plugins/loader.test.ts — 5-stage, register/activate alias
6. packages/server/test/plugins/manifest.test.ts — Zod 유효/무효
7. packages/server/test/plugins/diagnostics.test.ts — 실패 기록, severity 필터링
→ 검증: 전체 플러그인 테스트 통과
```

### Step 5: Channel Dock + Registry (0.5일)

```
1. packages/server/src/channels/dock.ts — createChannelDock() + CORE_DOCKS
2. packages/server/src/channels/registry.ts — 채널 등록/조회 (built-in + plugin merge)
3. packages/server/src/channels/chat-type.ts — ChatType 정규화
4. packages/server/test/channels/dock.test.ts
5. packages/server/test/channels/chat-type.test.ts
6. packages/server/test/channels/channel-registry.test.ts
→ 검증: 채널 테스트 통과
```

### Step 6: Gating 파이프라인 + Typing (0.5일)

```
1. packages/server/src/channels/gating/pipeline.ts — composeGates()
2. packages/server/src/channels/gating/mention-gating.ts
3. packages/server/src/channels/gating/command-gating.ts
4. packages/server/src/channels/gating/allowlist.ts
5. packages/server/src/channels/typing.ts
6. packages/server/test/channels/gating.test.ts — 조합 테스트, early exit
→ 검증: 게이팅 테스트 통과
```

### Step 7: Barrel Export + Event Bridge + 최종 검증 (0.5일)

```
1. packages/server/src/channels/index.ts — barrel export
2. packages/server/src/plugins/index.ts — barrel export
3. packages/server/src/plugins/event-bridge.ts — Hook ↔ EventBus 브릿지
→ 검증: pnpm typecheck && pnpm lint && pnpm test && pnpm build (전체 통과)
```

---

## 13. 산출물 및 검증

### 테스트 가능한 결과물

| #   | 산출물                                            | 검증 방법                                                                      |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | `createChannelDock()`로 Discord/Webhook Dock 생성 | 단위 테스트: 기본값, Object.freeze 불변성, Phase 1 타입 정합                   |
| 2   | PluginRegistry globalThis 싱글턴 보장             | 단위 테스트: `withIsolatedRegistry` 헬퍼, 다른 모듈에서 동일 인스턴스          |
| 3   | 8-slot 등록/조회 + freeze                         | 단위 테스트: 모든 슬롯 등록 후 `getSlot()` 일치, freeze 후 등록 시 에러        |
| 4   | 5-stage 플러그인 로더                             | 통합 테스트: 테스트 플러그인 스캔 → 보안 → 매니페스트 → 로드 → 등록            |
| 5   | 3-tier fallback 로더                              | 단위 테스트: .js(Tier 1), .ts+Node24(Tier 2), .ts+jiti(Tier 3)                 |
| 6   | `createHookRunner()` 3모드                        | 단위 테스트: void(병렬+격리), modifying(순차+에러격리), sync(동기+Promise경고) |
| 7   | priority 기반 정렬                                | 단위 테스트: 높은 priority 우선, 동점 시 FIFO                                  |
| 8   | mention-gating                                    | 단위 테스트: 멘션 있음/없음/DM 바이패스 3케이스                                |
| 9   | command-gating                                    | 단위 테스트: 접두사 매칭/불일치/빈 문자열                                      |
| 10  | `composeGates()` 파이프라인                       | 단위 테스트: 순서 보장, early exit, 전체 통과                                  |
| 11  | 3단계 보안 검증                                   | 단위 테스트: path traversal 차단, 확장자 필터, world-writable 감지             |
| 12  | Zod v4 매니페스트 검증                            | 단위 테스트: 유효/무효 매니페스트, toJSONSchema 출력                           |
| 13  | Diagnostics 슬롯                                  | 단위 테스트: 실패 기록 누적, severity 필터링                                   |

### 검증 명령어

```bash
# 단위 테스트
pnpm test -- --filter='packages/server/test/channels/**' --filter='packages/server/test/plugins/**'

# 타입 체크
pnpm typecheck

# 커버리지 (목표: branches 80%+)
pnpm test:coverage -- --filter='packages/server/test/channels/**' --filter='packages/server/test/plugins/**'
```

---

## 14. 위험 요소 + 완화 전략

| #   | 위험                                                       | 영향도 | 완화                                                                             |
| --- | ---------------------------------------------------------- | :----: | -------------------------------------------------------------------------------- |
| 1   | globalThis Symbol이 Vitest worker forks에서 테스트 간 누수 |   높   | `withIsolatedRegistry()` 헬퍼로 테스트 격리                                      |
| 2   | jiti ESM/CJS 호환성 이슈 (`__dirname` 미정의)              |   중   | `import.meta.url` 전환, `pathToFileURL()` 사용                                   |
| 3   | Node.js 22에서 네이티브 TS strip이 experimental            |   중   | `getNodeMajorVersion() >= 24` 분기로 안전 제어                                   |
| 4   | Phase 1 타입 변경 시 하위 호환성                           |   중   | 기존 6슬롯 유지 + 2개만 additive 추가. Phase 2/3/4는 plugin.ts 미사용            |
| 5   | register() 비동기 반환                                     |   중   | Promise 감지 경고 (OpenClaw 650–658줄 패턴). 비동기 초기화는 registerService()로 |
| 6   | 플러그인 경로 탈출 공격                                    |   높   | `realpathSync` + 허용 루트 검증 (§6)                                             |
| 7   | `z.strictObject()`가 플러그인 config 확장 시 거부          |   중   | `config` 필드는 `z.record(z.unknown())` 유지                                     |
| 8   | Windows에서 world-writable 검사 불가                       |   낮   | `process.platform !== 'win32'` 조건 분기                                         |

---

## 15. 복잡도 및 예상 파일 수

| 항목              | 값                                                                            |
| ----------------- | ----------------------------------------------------------------------------- |
| **복잡도**        | **L (Large)**                                                                 |
| **소스 파일**     | 17개 (`packages/server/src/channels/` 9 + `packages/server/src/plugins/` 8)   |
| **테스트 파일**   | 11개 (`packages/server/test/channels/` 4 + `packages/server/test/plugins/` 7) |
| **타입 확장**     | 1개 (`packages/types/src/plugin.ts` 수정)                                     |
| **총 파일**       | **~29개**                                                                     |
| **예상 LOC**      | 소스 ~1,600 / 테스트 ~1,200 / 합계 ~2,800                                     |
| **Registry 슬롯** | **8** (Phase 1 기존 6 + routes + diagnostics)                                 |
| **내장 훅**       | **9** (Phase 1 기존 7 + onPluginLoaded + onPluginUnloaded)                    |
| **신규 의존성**   | `jiti` (TypeScript 동적 로딩)                                                 |

### 복잡도 근거 (L)

- Phase 1 기존 타입을 재활용하여 재정의 불필요 — 슬롯 13→8, 훅 14→9, 빌더→팩토리로 축소
- Phase 2 인프라(FinClawError, Logger, EventBus, CircuitBreaker)를 직접 활용하여 중복 구현 회피
- Phase 4 `packages/server/` 구조와 테스트 패턴을 그대로 따름
- OpenClaw 80+ 파일 핵심을 28개로 압축하되 보안/진단/타입안전성 강화
- `globalThis` Symbol 싱글턴은 `withIsolatedRegistry()` 헬퍼로 테스트 격리 해결
