# Phase 5 todo-a: 기반 레이어 — 타입 확장 + 레지스트리 + 훅 (세션 1-2)

> **소스 5 + 테스트 3 + 설정 1 = 9파일**

## 선행조건

```bash
# Phase 4 완료 확인
pnpm typecheck   # 에러 0
pnpm test        # 전체 통과
```

---

# 세션 1: Step 1 — 타입 확장 + 에러 + 훅 타입 + 패키지 설정 (소스 3 + 설정 1 = 4파일)

## 1-1. packages/types/src/plugin.ts 수정 — PluginRegistry 8슬롯 + PluginHookName 9종 + PluginManifest 확장

**의존:** 없음 (기존 파일 additive 수정)

> 기존 6슬롯/7훅을 유지하면서 2슬롯(routes, diagnostics) + 2훅(onPluginLoaded, onPluginUnloaded) + 3필드(slots, config, configSchema)를 추가한다.

```typescript
// packages/types/src/plugin.ts
import type { ToolDefinition } from './agent.js';
import type { ChannelPlugin } from './channel.js';

/** 플러그인 매니페스트 */
export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  main: string;
  type: 'channel' | 'skill' | 'tool' | 'service';
  dependencies?: string[];
  // Phase 5 추가
  slots?: string[];
  config?: Record<string, unknown>;
  configSchema?: unknown;
}

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

/** 플러그인 레지스트리 (6 → 8슬롯) */
export interface PluginRegistry {
  plugins: RegisteredPlugin[];
  tools: ToolDefinition[];
  channels: ChannelPlugin[];
  hooks: PluginHook[];
  services: PluginService[];
  commands: PluginCommand[];
  routes: RouteRegistration[];
  diagnostics: PluginDiagnostic[];
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

/** 훅 이름 열거 (7 → 9종) */
export type PluginHookName =
  | 'beforeMessageProcess'
  | 'afterMessageProcess'
  | 'beforeAgentRun'
  | 'afterAgentRun'
  | 'onConfigChange'
  | 'onGatewayStart'
  | 'onGatewayStop'
  | 'onPluginLoaded'
  | 'onPluginUnloaded';

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

## 1-2. packages/server/package.json — jiti + zod 추가

**의존:** 없음

> jiti는 3-tier 플러그인 로더(todo-b)에서 사용. zod는 매니페스트 검증(todo-b)에서 사용. 미리 추가하여 `pnpm install` 한 번으로 해결.

```jsonc
{
  "name": "@finclaw/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@finclaw/agent": "workspace:*",
    "@finclaw/channel-discord": "workspace:*",
    "@finclaw/config": "workspace:*",
    "@finclaw/infra": "workspace:*",
    "@finclaw/skills-finance": "workspace:*",
    "@finclaw/storage": "workspace:*",
    "@finclaw/types": "workspace:*",
    "jiti": "^2.6.0",
    "zod": "^4.0.0",
  },
}
```

```bash
# 검증
pnpm install
```

## 1-3. packages/server/src/plugins/errors.ts 생성

**의존:** `@finclaw/infra` (FinClawError)

```typescript
// packages/server/src/plugins/errors.ts
import { FinClawError } from '@finclaw/infra';

/** 플러그인 로딩 실패 */
export class PluginLoadError extends FinClawError {
  constructor(pluginName: string, phase: string, cause: Error) {
    super(`Plugin '${pluginName}' failed at ${phase}`, 'PLUGIN_LOAD_ERROR', {
      cause,
      details: { pluginName, phase },
    });
    this.name = 'PluginLoadError';
  }
}

/** 플러그인 보안 검증 실패 */
export class PluginSecurityError extends FinClawError {
  constructor(message: string) {
    super(message, 'PLUGIN_SECURITY_ERROR', { statusCode: 403 });
    this.name = 'PluginSecurityError';
  }
}

/** 레지스트리 동결 후 등록 시도 */
export class RegistryFrozenError extends FinClawError {
  constructor(slot: string) {
    super(`Cannot register to '${slot}' after initialization complete`, 'REGISTRY_FROZEN');
    this.name = 'RegistryFrozenError';
  }
}
```

## 1-4. packages/server/src/plugins/hook-types.ts 생성

**의존:** `@finclaw/types` (InboundMessage)

> HookPayloadMap: 각 훅의 payload 타입을 컴파일 타임에 보장.
> HookModeMap: 각 훅의 실행 모드를 타입 레벨에서 기술.

```typescript
// packages/server/src/plugins/hook-types.ts
import type { InboundMessage } from '@finclaw/types';

/** 훅 이름 → payload 타입 매핑 */
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

/** 훅 이름 → 실행 모드 매핑 */
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

### 세션 1 검증

```bash
pnpm typecheck  # 에러 0
```

---

# 세션 2: Steps 2-3 — PluginRegistry + Hook System (소스 2 + 테스트 3 = 5파일)

## 2-1. packages/server/src/plugins/registry.ts 생성

**의존:** `@finclaw/types` (PluginRegistry), `./errors.js` (RegistryFrozenError)

> globalThis Symbol 싱글턴 — 모듈 중복 로드 시에도 단일 인스턴스 보장.
> 함수형 API — class 없이 get/set/register/freeze 함수로 조작.

```typescript
// packages/server/src/plugins/registry.ts
import type { PluginRegistry } from '@finclaw/types';
import { RegistryFrozenError } from './errors.js';

const REGISTRY_KEY = Symbol.for('finclaw.plugin-registry');

interface RegistryState {
  registry: PluginRegistry;
  frozen: boolean;
}

export function createEmptyRegistry(): PluginRegistry {
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

// globalThis 싱글턴 초기화 (IIFE)
const state: RegistryState = (() => {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[REGISTRY_KEY]) {
    g[REGISTRY_KEY] = { registry: createEmptyRegistry(), frozen: false };
  }
  return g[REGISTRY_KEY] as RegistryState;
})();

export type SlotName = keyof PluginRegistry;

/** 현재 레지스트리 반환 */
export function getPluginRegistry(): PluginRegistry {
  return state.registry;
}

/** 레지스트리 교체 (테스트 격리용) + frozen 해제 */
export function setPluginRegistry(registry: PluginRegistry): void {
  state.registry = registry;
  state.frozen = false;
}

/** 레지스트리 동결 — 이후 registerToSlot 호출 시 RegistryFrozenError */
export function freezeRegistry(): void {
  state.frozen = true;
}

/** 레지스트리 동결 여부 */
export function isRegistryFrozen(): boolean {
  return state.frozen;
}

/** 슬롯에 엔트리 등록 */
export function registerToSlot<S extends SlotName>(
  slot: S,
  entry: PluginRegistry[S][number],
): void {
  if (state.frozen) throw new RegistryFrozenError(slot);
  (state.registry[slot] as unknown[]).push(entry);
}

/** 슬롯 조회 (frozen 복사본 반환) */
export function getSlot<S extends SlotName>(slot: S): ReadonlyArray<PluginRegistry[S][number]> {
  return Object.freeze([...state.registry[slot]]) as ReadonlyArray<PluginRegistry[S][number]>;
}
```

## 2-2. packages/server/test/plugins/registry.test.ts 생성

**의존:** `../../src/plugins/registry.js`, `../../src/plugins/errors.js`

```typescript
// packages/server/test/plugins/registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { PluginHook, PluginService, PluginCommand } from '@finclaw/types';
import {
  createEmptyRegistry,
  getPluginRegistry,
  setPluginRegistry,
  freezeRegistry,
  isRegistryFrozen,
  registerToSlot,
  getSlot,
} from '../../src/plugins/registry.js';
import { RegistryFrozenError } from '../../src/plugins/errors.js';

beforeEach(() => {
  setPluginRegistry(createEmptyRegistry());
});

describe('createEmptyRegistry', () => {
  it('8개 슬롯을 빈 배열로 초기화한다', () => {
    const reg = createEmptyRegistry();
    expect(Object.keys(reg)).toHaveLength(8);
    for (const slot of Object.values(reg)) {
      expect(slot).toEqual([]);
    }
  });
});

describe('globalThis 싱글턴', () => {
  it('getPluginRegistry는 동일 인스턴스를 반환한다', () => {
    const a = getPluginRegistry();
    const b = getPluginRegistry();
    expect(a).toBe(b);
  });

  it('setPluginRegistry로 교체하면 이후 get이 새 인스턴스를 반환한다', () => {
    const prev = getPluginRegistry();
    const next = createEmptyRegistry();
    setPluginRegistry(next);
    expect(getPluginRegistry()).toBe(next);
    expect(getPluginRegistry()).not.toBe(prev);
  });
});

describe('registerToSlot / getSlot', () => {
  it('hooks 슬롯에 등록하고 조회한다', () => {
    const hook: PluginHook = {
      name: 'onConfigChange',
      priority: 0,
      handler: async () => {},
      pluginName: 'test',
    };
    registerToSlot('hooks', hook);
    const hooks = getSlot('hooks');
    expect(hooks).toHaveLength(1);
    expect(hooks[0].pluginName).toBe('test');
  });

  it('services 슬롯에 등록하고 조회한다', () => {
    const svc: PluginService = {
      name: 'test-svc',
      start: async () => {},
      stop: async () => {},
    };
    registerToSlot('services', svc);
    expect(getSlot('services')).toHaveLength(1);
  });

  it('commands 슬롯에 등록하고 조회한다', () => {
    const cmd: PluginCommand = {
      name: 'test-cmd',
      description: 'test',
      handler: async () => 'ok',
      pluginName: 'test',
    };
    registerToSlot('commands', cmd);
    expect(getSlot('commands')).toHaveLength(1);
  });

  it('routes 슬롯에 등록하고 조회한다', () => {
    registerToSlot('routes', {
      method: 'GET',
      path: '/health',
      handler: async () => {},
      pluginName: 'test',
    });
    expect(getSlot('routes')).toHaveLength(1);
  });

  it('diagnostics 슬롯에 등록하고 조회한다', () => {
    registerToSlot('diagnostics', {
      pluginName: 'test',
      timestamp: Date.now(),
      severity: 'info',
      phase: 'runtime',
      message: 'ok',
    });
    expect(getSlot('diagnostics')).toHaveLength(1);
  });

  it('getSlot은 frozen 복사본을 반환한다', () => {
    registerToSlot('hooks', {
      name: 'onGatewayStart',
      priority: 0,
      handler: async () => {},
      pluginName: 'test',
    });
    const hooks = getSlot('hooks');
    expect(Object.isFrozen(hooks)).toBe(true);
  });
});

describe('freezeRegistry', () => {
  it('freeze 후 registerToSlot은 RegistryFrozenError를 던진다', () => {
    freezeRegistry();
    expect(() =>
      registerToSlot('hooks', {
        name: 'onGatewayStart',
        priority: 0,
        handler: async () => {},
        pluginName: 'test',
      }),
    ).toThrow(RegistryFrozenError);
  });

  it('isRegistryFrozen이 상태를 반영한다', () => {
    expect(isRegistryFrozen()).toBe(false);
    freezeRegistry();
    expect(isRegistryFrozen()).toBe(true);
  });

  it('setPluginRegistry로 교체하면 frozen이 해제된다', () => {
    freezeRegistry();
    setPluginRegistry(createEmptyRegistry());
    expect(isRegistryFrozen()).toBe(false);
  });
});
```

## 2-3. packages/server/src/plugins/hooks.ts 생성

**의존:** 없음 (자체 타입 정의)

> 3모드 HookRunner:
>
> - **void**: `Promise.allSettled(sorted.map(...))` — 병렬 실행, 실패 격리
> - **modifying**: `for..of` 순차 + try/catch — 에러 시 이전 payload 유지
> - **sync**: 동기 `.map()` — Promise 반환 감지 경고

```typescript
// packages/server/src/plugins/hooks.ts

export type HookMode = 'void' | 'modifying' | 'sync';

export interface HookTapOptions {
  priority?: number;
  pluginName?: string;
}

interface HookEntry<T> {
  handler: (payload: T) => unknown;
  priority: number;
  registeredAt: number;
  pluginName: string;
}

export interface VoidHookRunner<T> {
  tap(handler: (payload: T) => unknown, opts?: HookTapOptions): void;
  fire(payload: T): Promise<PromiseSettledResult<unknown>[]>;
}

export interface ModifyingHookRunner<T> {
  tap(handler: (payload: T) => T | Promise<T>, opts?: HookTapOptions): void;
  fire(payload: T): Promise<T>;
}

export interface SyncHookRunner<T> {
  tap(handler: (payload: T) => unknown, opts?: HookTapOptions): void;
  fire(payload: T): unknown[];
}

function sortEntries<T>(entries: HookEntry<T>[]): HookEntry<T>[] {
  return entries.toSorted((a, b) => {
    const diff = b.priority - a.priority; // 높은 priority 우선
    return diff !== 0 ? diff : a.registeredAt - b.registeredAt; // 동점 시 FIFO
  });
}

export function createHookRunner<T>(name: string, mode: 'void'): VoidHookRunner<T>;
export function createHookRunner<T>(name: string, mode: 'modifying'): ModifyingHookRunner<T>;
export function createHookRunner<T>(name: string, mode: 'sync'): SyncHookRunner<T>;
export function createHookRunner<T>(
  name: string,
  mode: HookMode,
): VoidHookRunner<T> | ModifyingHookRunner<T> | SyncHookRunner<T> {
  const entries: HookEntry<T>[] = [];
  let counter = 0;

  function tap(handler: (payload: T) => unknown, opts?: HookTapOptions): void {
    entries.push({
      handler,
      priority: opts?.priority ?? 0,
      registeredAt: counter++,
      pluginName: opts?.pluginName ?? 'unknown',
    });
  }

  switch (mode) {
    case 'void':
      return {
        tap,
        async fire(payload: T): Promise<PromiseSettledResult<unknown>[]> {
          const sorted = sortEntries(entries);
          return Promise.allSettled(sorted.map((e) => Promise.resolve(e.handler(payload))));
        },
      };

    case 'modifying':
      return {
        tap: tap as ModifyingHookRunner<T>['tap'],
        async fire(payload: T): Promise<T> {
          const sorted = sortEntries(entries);
          let current = payload;
          for (const e of sorted) {
            try {
              current = (await e.handler(current)) as T;
            } catch (err) {
              console.error(
                `[Hook:${name}] modifying handler error, keeping previous payload:`,
                err,
              );
            }
          }
          return current;
        },
      };

    case 'sync':
      return {
        tap,
        fire(payload: T): unknown[] {
          const sorted = sortEntries(entries);
          return sorted.map((e) => {
            const result = e.handler(payload);
            if (result && typeof (result as Record<string, unknown>).then === 'function') {
              console.warn(`[Hook:${name}] sync handler returned Promise — ignored`);
            }
            return result;
          });
        },
      };
  }
}
```

## 2-4. packages/server/test/plugins/hooks.test.ts 생성

**의존:** `../../src/plugins/hooks.js`

```typescript
// packages/server/test/plugins/hooks.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createHookRunner } from '../../src/plugins/hooks.js';

describe('createHookRunner — void 모드', () => {
  it('등록된 핸들러를 병렬 실행한다', async () => {
    const runner = createHookRunner<string>('test', 'void');
    const order: number[] = [];

    runner.tap(async () => {
      order.push(1);
    });
    runner.tap(async () => {
      order.push(2);
    });

    const results = await runner.fire('payload');
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(order).toContain(1);
    expect(order).toContain(2);
  });

  it('개별 핸들러 예외를 격리한다 (allSettled)', async () => {
    const runner = createHookRunner<string>('test', 'void');

    runner.tap(() => {
      throw new Error('fail');
    });
    runner.tap(async () => 'ok');

    const results = await runner.fire('payload');
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
  });

  it('핸들러 없으면 빈 배열 반환', async () => {
    const runner = createHookRunner<string>('test', 'void');
    const results = await runner.fire('payload');
    expect(results).toEqual([]);
  });
});

describe('createHookRunner — modifying 모드', () => {
  it('핸들러를 순차 실행하여 payload를 변형한다', async () => {
    const runner = createHookRunner<{ count: number }>('test', 'modifying');

    runner.tap((p) => ({ count: p.count + 1 }));
    runner.tap((p) => ({ count: p.count * 10 }));

    const result = await runner.fire({ count: 1 });
    expect(result.count).toBe(20); // (1+1) * 10
  });

  it('핸들러 에러 시 이전 payload를 유지한다', async () => {
    const runner = createHookRunner<{ value: string }>('test', 'modifying');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    runner.tap((p) => ({ value: p.value + '-a' }));
    runner.tap(() => {
      throw new Error('boom');
    });
    runner.tap((p) => ({ value: p.value + '-c' }));

    const result = await runner.fire({ value: 'start' });
    // 두 번째 핸들러 에러 → 'start-a' 유지 → 세 번째 핸들러 실행
    expect(result.value).toBe('start-a-c');
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  it('핸들러 없으면 원본 payload 반환', async () => {
    const runner = createHookRunner<{ x: number }>('test', 'modifying');
    const payload = { x: 42 };
    const result = await runner.fire(payload);
    expect(result).toBe(payload);
  });
});

describe('createHookRunner — sync 모드', () => {
  it('핸들러를 동기 실행하고 결과 배열을 반환한다', () => {
    const runner = createHookRunner<number>('test', 'sync');

    runner.tap((n) => n * 2);
    runner.tap((n) => n * 3);

    const results = runner.fire(5);
    expect(results).toEqual([10, 15]);
  });

  it('Promise 반환 시 경고를 출력한다', () => {
    const runner = createHookRunner<string>('test', 'sync');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    runner.tap(async () => 'should-warn');

    runner.fire('payload');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('sync handler returned Promise'));

    spy.mockRestore();
  });

  it('핸들러 없으면 빈 배열 반환', () => {
    const runner = createHookRunner<string>('test', 'sync');
    expect(runner.fire('payload')).toEqual([]);
  });
});
```

## 2-5. packages/server/test/plugins/hooks-typed.test.ts 생성

**의존:** `../../src/plugins/hooks.js`, `../../src/plugins/hook-types.js`

> priority 정렬 + registeredAt 보조 정렬 + HookPayloadMap 타입 안전성 테스트.

```typescript
// packages/server/test/plugins/hooks-typed.test.ts
import { describe, it, expect } from 'vitest';
import { createHookRunner } from '../../src/plugins/hooks.js';
import type { HookPayloadMap, HookModeMap } from '../../src/plugins/hook-types.js';

describe('priority 정렬', () => {
  it('높은 priority 핸들러가 먼저 실행된다', async () => {
    const runner = createHookRunner<{ order: string[] }>('test', 'modifying');

    runner.tap((p) => ({ order: [...p.order, 'low'] }), { priority: 1 });
    runner.tap((p) => ({ order: [...p.order, 'high'] }), { priority: 10 });
    runner.tap((p) => ({ order: [...p.order, 'mid'] }), { priority: 5 });

    const result = await runner.fire({ order: [] });
    expect(result.order).toEqual(['high', 'mid', 'low']);
  });

  it('동일 priority에서는 FIFO (registeredAt) 순서', async () => {
    const runner = createHookRunner<{ order: string[] }>('test', 'modifying');

    runner.tap((p) => ({ order: [...p.order, 'first'] }), { priority: 5 });
    runner.tap((p) => ({ order: [...p.order, 'second'] }), { priority: 5 });
    runner.tap((p) => ({ order: [...p.order, 'third'] }), { priority: 5 });

    const result = await runner.fire({ order: [] });
    expect(result.order).toEqual(['first', 'second', 'third']);
  });

  it('void 모드에서도 priority 순서가 적용된다', async () => {
    const runner = createHookRunner<void>('test', 'void');
    const order: string[] = [];

    runner.tap(
      () => {
        order.push('low');
      },
      { priority: 1 },
    );
    runner.tap(
      () => {
        order.push('high');
      },
      { priority: 10 },
    );

    await runner.fire(undefined as void);
    // allSettled는 병렬이지만 동기 핸들러는 map 순서대로 시작
    expect(order[0]).toBe('high');
  });

  it('sync 모드에서도 priority 순서가 적용된다', () => {
    const runner = createHookRunner<number>('test', 'sync');

    runner.tap((n) => n + 100, { priority: 1 });
    runner.tap((n) => n + 200, { priority: 10 });

    const results = runner.fire(0);
    // priority 10이 먼저 → [200, 100]
    expect(results).toEqual([200, 100]);
  });
});

describe('HookPayloadMap 타입 호환성', () => {
  it('beforeMessageProcess는 modifying + InboundMessage 타입', async () => {
    type Payload = HookPayloadMap['beforeMessageProcess'];
    type Mode = HookModeMap['beforeMessageProcess']; // 'modifying'

    const runner = createHookRunner<Payload>('beforeMessageProcess', 'modifying' satisfies Mode);

    runner.tap((msg) => {
      // msg는 InboundMessage 타입 — body 필드 접근 가능
      return { ...msg, body: msg.body.toUpperCase() };
    });

    // 타입 에러 없이 컴파일되면 성공
    expect(runner).toBeDefined();
  });

  it('onPluginLoaded는 void + { pluginName, slots } 타입', () => {
    type Payload = HookPayloadMap['onPluginLoaded'];
    type Mode = HookModeMap['onPluginLoaded']; // 'void'

    const runner = createHookRunner<Payload>('onPluginLoaded', 'void' satisfies Mode);

    runner.tap((p) => {
      // p는 { pluginName: string; slots: string[] }
      expect(typeof p.pluginName).toBe('string');
    });

    expect(runner).toBeDefined();
  });

  it('onConfigChange는 void + { changedPaths } 타입', () => {
    type Payload = HookPayloadMap['onConfigChange'];
    type Mode = HookModeMap['onConfigChange']; // 'void'

    const runner = createHookRunner<Payload>('onConfigChange', 'void' satisfies Mode);

    runner.tap((p) => {
      // p는 { changedPaths: string[] }
      expect(Array.isArray(p.changedPaths)).toBe(true);
    });

    expect(runner).toBeDefined();
  });
});
```

### 세션 2 완료 검증

```bash
pnpm typecheck                                                   # 에러 0
pnpm vitest run packages/server/test/plugins/registry.test.ts    # 통과
pnpm vitest run packages/server/test/plugins/hooks.test.ts       # 통과
pnpm vitest run packages/server/test/plugins/hooks-typed.test.ts # 통과
```

---

## 의존성 그래프

```
1-1 types/plugin.ts ─────────────────────────────────────────┐
                                                              │
1-2 server/package.json (jiti + zod)                          │
                                                              │
1-3 errors.ts ──────────┬─ RegistryFrozenError ──→ 2-1       │
                        │                                     │
1-4 hook-types.ts ──────│──────────────────────→ 2-5          │
                        │                                     │
                        ├──────────────────────→ 2-1 registry.ts ──→ 2-2 registry.test.ts
                        │
                        └──────────────────────→ 2-3 hooks.ts ─┬─→ 2-4 hooks.test.ts
                                                               └─→ 2-5 hooks-typed.test.ts
```
