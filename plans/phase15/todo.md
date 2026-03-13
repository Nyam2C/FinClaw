# Phase 15: Support Services — 상세 구현 계획

Phase 15는 FinClaw의 이벤트 확장(훅), 스케줄링(크론), 보안(감사/리다이렉션) 인프라를 구축한다. 기존 `packages/server/src/plugins/hooks.ts`의 플러그인 훅 러너와는 별개로, **서비스 레벨 이벤트 시스템**을 `packages/server/src/services/` 하위에 구현한다.

## Context

### 핵심 발견사항 (plan.md와 실제 코드 차이)

1. **ConcurrencyLaneManager.acquire(laneId, key)** — plan.md에서 `lanes.acquire('cron')`으로 단순화했으나, 실제 시그니처는 `acquire(laneId: LaneId, key: string)`으로 key 파라미터 필수
2. **기존 hooks.ts** — `packages/server/src/plugins/hooks.ts`에 이미 `createHookRunner()`가 존재. Phase 15의 훅 시스템은 **서비스 이벤트 레지스트리**로 별개 영역
3. **Storage alerts CRUD** — `packages/storage/src/tables/alerts.ts`에 `updateAlertTrigger()`, `getActiveAlerts()` 등 이미 구현됨. 크론 작업에서 재사용 가능
4. **Storage market-cache** — `purgeExpiredCache()` 이미 구현됨. cleanup 작업에서 재사용

---

## Todo 1: 훅 타입 정의 (`hooks/types.ts`)

**파일**: `packages/server/src/services/hooks/types.ts`
**의존**: 없음
**검증**: `tsc --noEmit` 통과

### 구현 코드

```typescript
// packages/server/src/services/hooks/types.ts

/** 훅 이벤트 타입 */
export type HookEventType =
  | 'gateway' // Gateway 라이프사이클 (startup, shutdown, reload)
  | 'agent' // 에이전트 이벤트 (bootstrap, turn-start, turn-end)
  | 'session' // 세션 이벤트 (start, end, new)
  | 'command' // CLI 명령어 이벤트
  | 'market' // 금융: 시장 데이터 이벤트 (update, alert-triggered)
  | 'channel'; // 채널 이벤트 (message-received, message-sent)

/** 훅 이벤트 */
export interface HookEvent {
  readonly type: HookEventType;
  readonly action: string;
  readonly timestamp: number;
  readonly context: Record<string, unknown>;
}

/** 훅 핸들러 함수 */
export type HookHandler = (event: HookEvent) => Promise<void> | void;

/** 훅 소스 계층 (우선순위 순서) */
export type HookSource = 'system' | 'plugin' | 'channel' | 'user';

/** 훅 엔트리 — 레지스트리에 등록되는 단위 */
export interface HookEntry {
  readonly id: string;
  readonly name: string;
  readonly source: HookSource;
  readonly events: string[]; // 구독할 이벤트 키 배열 (예: ['market', 'market:update'])
  readonly handler: HookHandler;
  readonly priority: number; // 0=최고 우선순위, 기본값은 source별 상이
  readonly enabled: boolean;
}

/** 훅 실행 모드 */
export type HookRunMode =
  | 'parallel' // Promise.allSettled 동시 실행
  | 'sequential' // 순차 실행 (에러 격리)
  | 'sync'; // 동기적 순차 실행 (async 무시)

/** 훅 러너 인터페이스 */
export interface HookRunner {
  trigger(event: HookEvent): Promise<void>;
  readonly mode: HookRunMode;
}

/** 훅 러너 옵션 */
export interface HookRunnerOptions {
  readonly mode: HookRunMode;
  readonly timeoutMs?: number; // 핸들러별 타임아웃 (기본 30초)
  readonly onError?: (error: Error, handler: HookEntry) => void;
}

/** 훅 등록 입력 (priority 선택적) */
export type HookRegistration = Omit<HookEntry, 'priority'> & { priority?: number };
```

---

## Todo 2: 훅 레지스트리 (`hooks/registry.ts`)

**파일**: `packages/server/src/services/hooks/registry.ts`
**의존**: `hooks/types.ts`
**검증**: `registry.test.ts` 통과

### 구현 코드

```typescript
// packages/server/src/services/hooks/registry.ts
import type { HookEntry, HookEvent, HookRegistration, HookSource } from './types.js';

/** 훅 우선순위 (source별 기본값) */
const SOURCE_PRIORITY: Record<HookSource, number> = {
  system: 0,
  plugin: 100,
  channel: 200,
  user: 300,
};

export class HookRegistry {
  /** eventKey -> HookEntry[] (우선순위 정렬) */
  private readonly handlers = new Map<string, HookEntry[]>();

  /**
   * 훅을 등록한다.
   * 동일 eventKey에 여러 핸들러 → priority 오름차순 실행 (0 = 최고 우선순위).
   */
  register(entry: HookRegistration): void {
    const priority = entry.priority ?? SOURCE_PRIORITY[entry.source];
    const fullEntry: HookEntry = { ...entry, priority };

    for (const eventKey of entry.events) {
      const existing = this.handlers.get(eventKey) ?? [];
      existing.push(fullEntry);
      existing.sort((a, b) => a.priority - b.priority);
      this.handlers.set(eventKey, existing);
    }
  }

  /** 특정 이벤트 키에 등록된 핸들러 조회 */
  getHandlers(eventKey: string): ReadonlyArray<HookEntry> {
    return this.handlers.get(eventKey) ?? [];
  }

  /**
   * 이벤트 발행.
   * type 키와 type:action 키 양쪽의 핸들러를 수집 후
   * 우선순위순으로 순차 실행 (에러 격리).
   */
  async trigger(event: HookEvent): Promise<void> {
    const typeHandlers = this.getHandlers(event.type);
    const actionHandlers = this.getHandlers(`${event.type}:${event.action}`);

    const allHandlers = [...typeHandlers, ...actionHandlers]
      .filter((h) => h.enabled)
      .sort((a, b) => a.priority - b.priority);

    for (const entry of allHandlers) {
      try {
        await entry.handler(event);
      } catch (error) {
        // 에러 격리: 한 핸들러 실패가 나머지를 중단시키지 않음
        console.error(`[Hook Error] ${entry.name}: ${error}`);
      }
    }
  }

  /** 등록된 모든 훅 엔트리 반환 (중복 제거) */
  listAll(): ReadonlyArray<HookEntry> {
    const seen = new Set<string>();
    const result: HookEntry[] = [];
    for (const entries of this.handlers.values()) {
      for (const entry of entries) {
        if (!seen.has(entry.id)) {
          seen.add(entry.id);
          result.push(entry);
        }
      }
    }
    return result;
  }

  /** 특정 훅 제거 */
  unregister(hookId: string): boolean {
    let removed = false;
    for (const [key, entries] of this.handlers) {
      const filtered = entries.filter((e) => e.id !== hookId);
      if (filtered.length !== entries.length) {
        this.handlers.set(key, filtered);
        removed = true;
      }
    }
    return removed;
  }

  /** 모든 핸들러 제거 */
  clear(): void {
    this.handlers.clear();
  }
}
```

### 테스트 (`hooks/registry.test.ts`)

```typescript
// packages/server/src/services/hooks/registry.test.ts
import { describe, it, expect, vi } from 'vitest';
import { HookRegistry } from './registry.js';
import type { HookEvent, HookRegistration } from './types.js';

function makeEvent(type: string, action: string): HookEvent {
  return { type: type as HookEvent['type'], action, timestamp: Date.now(), context: {} };
}

function makeHook(
  overrides: Partial<HookRegistration> & { id: string; handler: HookRegistration['handler'] },
): HookRegistration {
  return {
    name: overrides.id,
    source: 'system',
    events: ['agent:bootstrap'],
    enabled: true,
    ...overrides,
  };
}

describe('HookRegistry', () => {
  it('등록된 핸들러가 이벤트 발행 시 호출된다', async () => {
    const registry = new HookRegistry();
    const handler = vi.fn();

    registry.register(makeHook({ id: 'h1', handler, events: ['agent:bootstrap'] }));
    await registry.trigger(makeEvent('agent', 'bootstrap'));

    expect(handler).toHaveBeenCalledOnce();
  });

  it('type 키와 type:action 키 양쪽 핸들러가 호출된다', async () => {
    const registry = new HookRegistry();
    const typeHandler = vi.fn();
    const actionHandler = vi.fn();

    registry.register(makeHook({ id: 'h1', handler: typeHandler, events: ['agent'] }));
    registry.register(makeHook({ id: 'h2', handler: actionHandler, events: ['agent:bootstrap'] }));

    await registry.trigger(makeEvent('agent', 'bootstrap'));

    expect(typeHandler).toHaveBeenCalledOnce();
    expect(actionHandler).toHaveBeenCalledOnce();
  });

  it('우선순위 오름차순으로 실행된다 (system=0 > plugin=100 > user=300)', async () => {
    const registry = new HookRegistry();
    const order: string[] = [];

    registry.register(
      makeHook({
        id: 'user',
        handler: () => {
          order.push('user');
        },
        source: 'user',
        events: ['agent:bootstrap'],
      }),
    );
    registry.register(
      makeHook({
        id: 'system',
        handler: () => {
          order.push('system');
        },
        source: 'system',
        events: ['agent:bootstrap'],
      }),
    );
    registry.register(
      makeHook({
        id: 'plugin',
        handler: () => {
          order.push('plugin');
        },
        source: 'plugin',
        events: ['agent:bootstrap'],
      }),
    );

    await registry.trigger(makeEvent('agent', 'bootstrap'));

    expect(order).toEqual(['system', 'plugin', 'user']);
  });

  it('에러가 발생해도 나머지 핸들러가 실행된다', async () => {
    const registry = new HookRegistry();
    const secondHandler = vi.fn();

    registry.register(
      makeHook({
        id: 'h1',
        handler: () => {
          throw new Error('boom');
        },
        events: ['agent:bootstrap'],
        priority: 0,
      }),
    );
    registry.register(
      makeHook({
        id: 'h2',
        handler: secondHandler,
        events: ['agent:bootstrap'],
        priority: 1,
      }),
    );

    await registry.trigger(makeEvent('agent', 'bootstrap'));

    expect(secondHandler).toHaveBeenCalledOnce();
  });

  it('disabled 핸들러는 실행되지 않는다', async () => {
    const registry = new HookRegistry();
    const handler = vi.fn();

    registry.register(makeHook({ id: 'h1', handler, enabled: false, events: ['agent:bootstrap'] }));

    await registry.trigger(makeEvent('agent', 'bootstrap'));

    expect(handler).not.toHaveBeenCalled();
  });

  it('unregister로 훅을 제거할 수 있다', () => {
    const registry = new HookRegistry();
    registry.register(makeHook({ id: 'h1', handler: vi.fn(), events: ['agent:bootstrap'] }));

    expect(registry.unregister('h1')).toBe(true);
    expect(registry.getHandlers('agent:bootstrap')).toHaveLength(0);
  });

  it('listAll은 중복 없이 모든 훅을 반환한다', () => {
    const registry = new HookRegistry();
    const handler = vi.fn();

    // 같은 훅이 2개 이벤트에 등록
    registry.register(makeHook({ id: 'h1', handler, events: ['agent', 'agent:bootstrap'] }));

    expect(registry.listAll()).toHaveLength(1);
  });
});
```

---

## Todo 3: 훅 러너 (`hooks/runner.ts`)

**파일**: `packages/server/src/services/hooks/runner.ts`
**의존**: `hooks/types.ts`, `hooks/registry.ts`
**검증**: `runner.test.ts` 통과

### 구현 코드

```typescript
// packages/server/src/services/hooks/runner.ts
import type { HookEntry, HookEvent, HookRunMode, HookRunner, HookRunnerOptions } from './types.js';
import type { HookRegistry } from './registry.js';

/**
 * 훅 러너 생성.
 *
 * 실행 모드:
 * - parallel: Promise.allSettled로 동시 실행. 빠르지만 순서 보장 없음.
 * - sequential: 순차 실행. 에러 격리.
 * - sync: 동기적 순차 실행. async 핸들러의 Promise는 무시.
 */
export function createServiceHookRunner(
  registry: HookRegistry,
  options: HookRunnerOptions = { mode: 'parallel' },
): HookRunner {
  const { mode, timeoutMs = 30_000, onError } = options;

  function collectHandlers(event: HookEvent): HookEntry[] {
    return [
      ...registry.getHandlers(event.type),
      ...registry.getHandlers(`${event.type}:${event.action}`),
    ].filter((h) => h.enabled);
  }

  return {
    mode,
    async trigger(event: HookEvent): Promise<void> {
      const handlers = collectHandlers(event);

      switch (mode) {
        case 'parallel':
          await runParallel(handlers, event, timeoutMs, onError);
          break;
        case 'sequential':
          await runSequential(handlers, event, timeoutMs, onError);
          break;
        case 'sync':
          runSync(handlers, event, onError);
          break;
      }
    },
  };
}

async function runParallel(
  handlers: HookEntry[],
  event: HookEvent,
  timeoutMs: number,
  onError?: (error: Error, handler: HookEntry) => void,
): Promise<void> {
  const results = await Promise.allSettled(
    handlers.map((h) => withTimeout(h.handler(event), timeoutMs)),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'rejected') {
      const error =
        result.reason instanceof Error ? result.reason : new Error(String(result.reason));
      onError?.(error, handlers[i]);
    }
  }
}

async function runSequential(
  handlers: HookEntry[],
  event: HookEvent,
  timeoutMs: number,
  onError?: (error: Error, handler: HookEntry) => void,
): Promise<void> {
  for (const handler of handlers) {
    try {
      await withTimeout(handler.handler(event), timeoutMs);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      onError?.(error, handler);
    }
  }
}

function runSync(
  handlers: HookEntry[],
  event: HookEvent,
  onError?: (error: Error, handler: HookEntry) => void,
): void {
  for (const handler of handlers) {
    try {
      handler.handler(event); // async 결과 무시
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      onError?.(error, handler);
    }
  }
}

function withTimeout<T>(promise: Promise<T> | T, ms: number): Promise<T> {
  if (!(promise instanceof Promise)) return Promise.resolve(promise);
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Hook timeout after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer!));
}
```

### 테스트 (`hooks/runner.test.ts`)

```typescript
// packages/server/src/services/hooks/runner.test.ts
import { describe, it, expect, vi } from 'vitest';
import { HookRegistry } from './registry.js';
import { createServiceHookRunner } from './runner.js';
import type { HookEvent } from './types.js';

function makeEvent(type = 'agent', action = 'bootstrap'): HookEvent {
  return { type: type as HookEvent['type'], action, timestamp: Date.now(), context: {} };
}

describe('createServiceHookRunner', () => {
  describe('parallel 모드', () => {
    it('모든 핸들러를 동시 실행한다', async () => {
      const registry = new HookRegistry();
      const calls: number[] = [];

      registry.register({
        id: 'h1',
        name: 'h1',
        source: 'system',
        events: ['agent:bootstrap'],
        enabled: true,
        handler: async () => {
          calls.push(1);
        },
      });
      registry.register({
        id: 'h2',
        name: 'h2',
        source: 'plugin',
        events: ['agent:bootstrap'],
        enabled: true,
        handler: async () => {
          calls.push(2);
        },
      });

      const runner = createServiceHookRunner(registry, { mode: 'parallel' });
      await runner.trigger(makeEvent());

      expect(calls).toHaveLength(2);
    });

    it('에러가 발생해도 모든 핸들러가 실행된다', async () => {
      const registry = new HookRegistry();
      const onError = vi.fn();

      registry.register({
        id: 'fail',
        name: 'fail',
        source: 'system',
        events: ['agent:bootstrap'],
        enabled: true,
        handler: () => {
          throw new Error('fail');
        },
      });
      registry.register({
        id: 'ok',
        name: 'ok',
        source: 'system',
        events: ['agent:bootstrap'],
        enabled: true,
        priority: 1,
        handler: vi.fn(),
      });

      const runner = createServiceHookRunner(registry, { mode: 'parallel', onError });
      await runner.trigger(makeEvent());

      expect(onError).toHaveBeenCalledOnce();
    });
  });

  describe('sequential 모드', () => {
    it('순차 실행하며 에러 격리한다', async () => {
      const registry = new HookRegistry();
      const order: string[] = [];

      registry.register({
        id: 'h1',
        name: 'h1',
        source: 'system',
        events: ['agent:bootstrap'],
        enabled: true,
        handler: () => {
          order.push('h1');
          throw new Error('fail');
        },
      });
      registry.register({
        id: 'h2',
        name: 'h2',
        source: 'system',
        events: ['agent:bootstrap'],
        enabled: true,
        priority: 1,
        handler: () => {
          order.push('h2');
        },
      });

      const runner = createServiceHookRunner(registry, { mode: 'sequential', onError: vi.fn() });
      await runner.trigger(makeEvent());

      expect(order).toEqual(['h1', 'h2']);
    });
  });

  describe('sync 모드', () => {
    it('동기적으로 실행한다', async () => {
      const registry = new HookRegistry();
      const handler = vi.fn();

      registry.register({
        id: 'h1',
        name: 'h1',
        source: 'system',
        events: ['agent:bootstrap'],
        enabled: true,
        handler,
      });

      const runner = createServiceHookRunner(registry, { mode: 'sync' });
      await runner.trigger(makeEvent());

      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('타임아웃', () => {
    it('핸들러가 타임아웃을 초과하면 에러를 발생시킨다', async () => {
      const registry = new HookRegistry();
      const onError = vi.fn();

      registry.register({
        id: 'slow',
        name: 'slow',
        source: 'system',
        events: ['agent:bootstrap'],
        enabled: true,
        handler: () => new Promise((resolve) => setTimeout(resolve, 500)),
      });

      const runner = createServiceHookRunner(registry, {
        mode: 'parallel',
        timeoutMs: 50,
        onError,
      });
      await runner.trigger(makeEvent());

      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0].message).toContain('timeout');
    });
  });
});
```

---

## Todo 4: EventBus 브리지 (`hooks/bridge.ts`)

**파일**: `packages/server/src/services/hooks/bridge.ts`
**의존**: `hooks/registry.ts`, `@finclaw/infra` (getEventBus, FinClawEventMap)
**검증**: 단위 테스트 (registry.test.ts에 통합)

### 구현 코드

```typescript
// packages/server/src/services/hooks/bridge.ts
import { getEventBus, type FinClawEventMap } from '@finclaw/infra';
import type { HookRegistry } from './registry.js';
import type { HookEventType } from './types.js';

/**
 * @finclaw/infra EventBus → HookRegistry 브리지.
 * EventBus 이벤트를 HookRegistry 훅 이벤트로 변환·전파한다.
 *
 * 반환: 브리지 해제 함수 (shutdown 시 호출)
 */
export function bridgeEventBusToHooks(registry: HookRegistry): () => void {
  const bus = getEventBus();

  const mappings: Array<{
    busEvent: keyof FinClawEventMap;
    hookType: HookEventType;
    hookAction: string;
  }> = [
    { busEvent: 'agent:run:start', hookType: 'agent', hookAction: 'turn-start' },
    { busEvent: 'agent:run:end', hookType: 'agent', hookAction: 'turn-end' },
    { busEvent: 'agent:run:error', hookType: 'agent', hookAction: 'error' },
    { busEvent: 'gateway:start', hookType: 'gateway', hookAction: 'startup' },
    { busEvent: 'gateway:stop', hookType: 'gateway', hookAction: 'shutdown' },
    { busEvent: 'channel:message', hookType: 'channel', hookAction: 'message-received' },
    { busEvent: 'config:change', hookType: 'gateway', hookAction: 'reload' },
  ];

  const unsubscribers: Array<() => void> = [];

  for (const { busEvent, hookType, hookAction } of mappings) {
    const listener = (...args: unknown[]) => {
      registry.trigger({
        type: hookType,
        action: hookAction,
        timestamp: Date.now(),
        context: { args },
      });
    };
    bus.on(busEvent, listener as FinClawEventMap[typeof busEvent]);
    unsubscribers.push(() => bus.off(busEvent, listener as FinClawEventMap[typeof busEvent]));
  }

  return () => unsubscribers.forEach((fn) => fn());
}
```

---

## Todo 5: 자격 증명 리다이렉션 (`security/redaction.ts`)

**파일**: `packages/server/src/services/security/redaction.ts`
**의존**: 없음
**검증**: `redaction.test.ts` 통과

### 구현 코드

```typescript
// packages/server/src/services/security/redaction.ts

/** 리다이렉션 패턴 정의 */
export interface RedactionPattern {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

/** 금융 API 키를 포함한 13+ 리다이렉션 패턴 */
export const REDACTION_PATTERNS: RedactionPattern[] = [
  // ── 범용 API 키/토큰 ──
  {
    name: 'bearer_token',
    pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    replacement: 'Bearer [REDACTED]',
  },
  {
    name: 'authorization_header',
    pattern: /Authorization:\s*\S+/gi,
    replacement: 'Authorization: [REDACTED]',
  },
  {
    name: 'api_key_param',
    pattern: /[?&](?:api_?key|apikey|access_?token)=[^&\s]+/gi,
    replacement: '?api_key=[REDACTED]',
  },
  {
    name: 'generic_api_key',
    pattern: /(api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9\-._]{20,}["']?/gi,
    replacement: '$1=[REDACTED]',
  },

  // ── Anthropic ──
  {
    name: 'anthropic_api_key',
    pattern: /sk-ant-[A-Za-z0-9\-]{20,}/g,
    replacement: '[REDACTED_ANTHROPIC_KEY]',
  },

  // ── OpenAI ──
  {
    name: 'openai_api_key',
    pattern: /sk-[A-Za-z0-9]{20,}/g,
    replacement: '[REDACTED_OPENAI_KEY]',
  },

  // ── Alpha Vantage (금융) ──
  {
    name: 'alpha_vantage_key',
    pattern:
      /(?:ALPHA_VANTAGE|alphavantage)[_-]?(?:API[_-]?)?KEY\s*[:=]\s*["']?[A-Z0-9]{10,}["']?/gi,
    replacement: 'ALPHA_VANTAGE_KEY=[REDACTED]',
  },

  // ── CoinGecko (금융) ──
  {
    name: 'coingecko_key',
    pattern: /CG-[A-Za-z0-9]{20,}/g,
    replacement: '[REDACTED_COINGECKO_KEY]',
  },

  // ── 거래소 API (금융) ──
  {
    name: 'exchange_api_secret',
    pattern:
      /(binance|upbit|bithumb|coinbase)[_-]?(?:secret|api[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9+/]{20,}["']?/gi,
    replacement: '$1=[REDACTED_EXCHANGE_SECRET]',
  },

  // ── PEM 개인 키 ──
  {
    name: 'pem_private_key',
    pattern:
      /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },

  // ── Discord 봇 토큰 ──
  {
    name: 'discord_token',
    pattern: /[MN][A-Za-z\d]{23,28}\.[A-Za-z\d-_]{6}\.[A-Za-z\d-_]{27,}/g,
    replacement: '[REDACTED_DISCORD_TOKEN]',
  },

  // ── JWT ──
  {
    name: 'jwt_token',
    pattern: /eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g,
    replacement: '[REDACTED_JWT]',
  },

  // ── 환경변수 내 비밀 ──
  {
    name: 'env_secret',
    pattern: /(SECRET|PASSWORD|CREDENTIAL|PRIVATE)(?:_KEY)?\s*=\s*["']?[^\s"']+["']?/gi,
    replacement: '$1=[REDACTED]',
  },
];

/**
 * 텍스트에서 민감한 자격 증명을 마스킹한다.
 * 로그 출력, 에러 메시지, 진단 리포트에서 사용.
 */
export function redactSensitiveText(text: string): string {
  let result = text;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    // RegExp에 g 플래그가 있으면 lastIndex 리셋 필요
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * 객체의 모든 문자열 값에서 민감한 정보를 마스킹한다.
 */
export function redactObject<T>(obj: T): T {
  if (typeof obj === 'string') return redactSensitiveText(obj) as T;
  if (Array.isArray(obj)) return obj.map(redactObject) as T;
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = redactObject(value);
    }
    return result as T;
  }
  return obj;
}
```

### 테스트 (`security/redaction.test.ts`)

```typescript
// packages/server/src/services/security/redaction.test.ts
import { describe, it, expect } from 'vitest';
import { redactSensitiveText, redactObject, REDACTION_PATTERNS } from './redaction.js';

describe('redactSensitiveText', () => {
  it('Anthropic API 키를 마스킹한다', () => {
    const input = 'key: sk-ant-abcdefghijklmnopqrstuvwx';
    expect(redactSensitiveText(input)).toContain('[REDACTED_ANTHROPIC_KEY]');
    expect(redactSensitiveText(input)).not.toContain('abcdefghij');
  });

  it('OpenAI API 키를 마스킹한다', () => {
    const input = 'key: sk-abcdefghijklmnopqrstuvwx';
    expect(redactSensitiveText(input)).toContain('[REDACTED_OPENAI_KEY]');
  });

  it('Alpha Vantage 키를 마스킹한다', () => {
    const input = 'ALPHA_VANTAGE_API_KEY=ABCDEF1234567890';
    expect(redactSensitiveText(input)).toContain('[REDACTED]');
    expect(redactSensitiveText(input)).not.toContain('ABCDEF1234567890');
  });

  it('CoinGecko 키를 마스킹한다', () => {
    const input = 'key: CG-abcdefghijklmnopqrstuvwxyz';
    expect(redactSensitiveText(input)).toContain('[REDACTED_COINGECKO_KEY]');
  });

  it('거래소 API secret을 마스킹한다', () => {
    const input = 'binance_secret=abcdefghijklmnopqrstuvwx';
    expect(redactSensitiveText(input)).toContain('[REDACTED_EXCHANGE_SECRET]');
  });

  it('Bearer 토큰을 마스킹한다', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test.sig';
    const result = redactSensitiveText(input);
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('JWT를 마스킹한다', () => {
    const input = 'token=eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYWRtaW4ifQ.signaturehere';
    expect(redactSensitiveText(input)).toContain('[REDACTED_JWT]');
  });

  it('PEM 개인 키를 마스킹한다', () => {
    const input = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...\n-----END PRIVATE KEY-----';
    expect(redactSensitiveText(input)).toBe('[REDACTED_PRIVATE_KEY]');
  });

  it('Discord 봇 토큰을 마스킹한다', () => {
    // Build fake token from parts to avoid GitHub push protection false positive
    const input = ['MTIzNDU2Nzg5MDEyMzQ1Njc4OQ', 'AbCdEf', 'abcdefghijklmnopqrstuvwxyz1234'].join(
      '.',
    );
    expect(redactSensitiveText(input)).toContain('[REDACTED_DISCORD_TOKEN]');
  });

  it('URL 파라미터의 API 키를 마스킹한다', () => {
    const input = 'https://api.example.com/data?api_key=secretvalue123&format=json';
    expect(redactSensitiveText(input)).toContain('[REDACTED]');
    expect(redactSensitiveText(input)).not.toContain('secretvalue123');
  });

  it('일반 텍스트를 변경하지 않는다 (false positive 방지)', () => {
    const input = 'Hello, this is a normal log message with no secrets.';
    expect(redactSensitiveText(input)).toBe(input);
  });

  it('$1 백레퍼런스가 키 이름을 보존한다', () => {
    const input = 'api_key=sk-verylongapikeythatshouldbereplaced';
    const result = redactSensitiveText(input);
    expect(result).toContain('api_key');
  });

  it('연속 호출에서 regex lastIndex 문제가 없다', () => {
    const input = 'key: sk-ant-abcdefghijklmnopqrstuvwx';
    redactSensitiveText(input);
    const result = redactSensitiveText(input);
    expect(result).toContain('[REDACTED_ANTHROPIC_KEY]');
  });
});

describe('redactObject', () => {
  it('중첩 객체의 문자열 값을 마스킹한다', () => {
    const obj = {
      config: {
        apiKey: 'sk-ant-abcdefghijklmnopqrstuvwx',
        name: 'test',
      },
    };
    const result = redactObject(obj);
    expect(result.config.apiKey).toContain('[REDACTED_ANTHROPIC_KEY]');
    expect(result.config.name).toBe('test');
  });

  it('배열 내 문자열도 마스킹한다', () => {
    const arr = ['normal', 'key: sk-ant-abcdefghijklmnopqrstuvwx'];
    const result = redactObject(arr);
    expect(result[0]).toBe('normal');
    expect(result[1]).toContain('[REDACTED_ANTHROPIC_KEY]');
  });

  it('비문자열 값은 변경하지 않는다', () => {
    expect(redactObject(42)).toBe(42);
    expect(redactObject(null)).toBe(null);
    expect(redactObject(true)).toBe(true);
  });
});

describe('REDACTION_PATTERNS', () => {
  it('13개 이상의 패턴이 등록되어 있다', () => {
    expect(REDACTION_PATTERNS.length).toBeGreaterThanOrEqual(13);
  });

  it('모든 패턴에 name, pattern, replacement가 있다', () => {
    for (const p of REDACTION_PATTERNS) {
      expect(p.name).toBeTruthy();
      expect(p.pattern).toBeInstanceOf(RegExp);
      expect(typeof p.replacement).toBe('string');
    }
  });
});
```

---

## Todo 6: 보안 감사 (`security/audit.ts`)

**파일**: `packages/server/src/services/security/audit.ts`
**의존**: 없음 (`node:fs/promises`만 사용)
**검증**: `audit.test.ts` 통과

### 구현 코드

```typescript
// packages/server/src/services/security/audit.ts
import { stat } from 'node:fs/promises';

/** 보안 감사 결과 항목 */
export interface SecurityAuditFinding {
  readonly checkId: string;
  readonly severity: 'info' | 'warn' | 'critical';
  readonly title: string;
  readonly detail: string;
  readonly remediation?: string;
}

/** 보안 감사 리포트 */
export interface SecurityAuditReport {
  readonly findings: SecurityAuditFinding[];
  readonly summary: {
    readonly critical: number;
    readonly warn: number;
    readonly info: number;
  };
  readonly timestamp: number;
}

/** 보안 감사 옵션 */
export interface SecurityAuditOptions {
  readonly checkApiKeys?: boolean;
  readonly checkFilePermissions?: boolean;
  readonly checkEnvironment?: boolean;
}

/**
 * 보안 감사를 실행한다.
 * 금융 데이터를 다루는 FinClaw에 특화된 보안 검사 수행.
 */
export async function runSecurityAudit(
  options: SecurityAuditOptions = {},
): Promise<SecurityAuditReport> {
  const findings: SecurityAuditFinding[] = [];

  if (options.checkApiKeys !== false) {
    findings.push(...collectApiKeyFindings());
  }

  if (options.checkFilePermissions !== false) {
    findings.push(...(await collectFilePermissionFindings()));
  }

  if (options.checkEnvironment !== false) {
    findings.push(...collectEnvironmentFindings());
  }

  const summary = {
    critical: findings.filter((f) => f.severity === 'critical').length,
    warn: findings.filter((f) => f.severity === 'warn').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };

  return { findings, summary, timestamp: Date.now() };
}

function collectApiKeyFindings(): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];

  // 필수 키 존재 여부
  const requiredKeys: Array<{ env: string; name: string }> = [
    { env: 'ANTHROPIC_API_KEY', name: 'Anthropic API 키' },
    { env: 'DISCORD_TOKEN', name: 'Discord 봇 토큰' },
  ];
  for (const { env, name } of requiredKeys) {
    if (!process.env[env]) {
      findings.push({
        checkId: `api_key.missing.${env.toLowerCase()}`,
        severity: 'critical',
        title: `필수 API 키 미설정: ${name}`,
        detail: `환경변수 ${env}가 설정되지 않았습니다.`,
        remediation: `.env 파일에 ${env}를 설정하거나 환경변수로 전달하세요.`,
      });
    }
  }

  // 선택 키 안내
  const optionalKeys: Array<{ env: string; name: string }> = [
    { env: 'ALPHA_VANTAGE_API_KEY', name: 'Alpha Vantage' },
    { env: 'COINGECKO_API_KEY', name: 'CoinGecko' },
  ];
  for (const { env, name } of optionalKeys) {
    if (!process.env[env]) {
      findings.push({
        checkId: `api_key.optional.${env.toLowerCase()}`,
        severity: 'info',
        title: `선택 API 키 미설정: ${name}`,
        detail: `${name} 키(${env})가 없으면 해당 데이터 소스를 사용할 수 없습니다.`,
      });
    }
  }

  // 위험 환경변수 감지
  const dangerousEnvVars = [
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'NODE_OPTIONS',
    'NODE_DEBUG',
    'UV_THREADPOOL_SIZE',
  ];
  for (const envVar of dangerousEnvVars) {
    if (process.env[envVar]) {
      findings.push({
        checkId: `env.dangerous.${envVar.toLowerCase()}`,
        severity: 'warn',
        title: `위험한 환경변수 감지: ${envVar}`,
        detail: `${envVar}가 설정되어 있습니다. 보안 위험을 초래할 수 있습니다.`,
        remediation: `${envVar} 환경변수를 제거하거나, 꼭 필요한 경우 값을 검증하세요.`,
      });
    }
  }

  return findings;
}

async function collectFilePermissionFindings(): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];

  // WSL/Windows 환경에서는 POSIX 퍼미션 검사 무의미
  if (process.platform === 'win32' || process.env.WSL_DISTRO_NAME) {
    findings.push({
      checkId: 'file_perm.skipped',
      severity: 'info',
      title: '파일 퍼미션 검사 생략',
      detail: 'WSL/Windows 환경에서는 POSIX 파일 퍼미션이 적용되지 않습니다.',
    });
    return findings;
  }

  const sensitiveFiles = ['.env', 'finclaw.db', 'finclaw.db-wal', 'finclaw.db-shm'];
  for (const file of sensitiveFiles) {
    try {
      const st = await stat(file);
      const mode = st.mode & 0o777;

      if (mode & 0o004) {
        findings.push({
          checkId: `file_perm.world_readable.${file}`,
          severity: 'critical',
          title: `민감 파일 world-readable: ${file}`,
          detail: `${file}이 제3자에게 읽기 가능합니다 (mode: ${mode.toString(8)}).`,
          remediation: `chmod 600 ${file}`,
        });
      } else if (mode & 0o040) {
        findings.push({
          checkId: `file_perm.group_readable.${file}`,
          severity: 'warn',
          title: `민감 파일 group-readable: ${file}`,
          detail: `${file}이 그룹에게 읽기 가능합니다 (mode: ${mode.toString(8)}).`,
          remediation: `chmod 600 ${file}`,
        });
      }
    } catch {
      // 파일 없음 — 무시
    }
  }

  return findings;
}

function collectEnvironmentFindings(): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];

  if (!process.env.NODE_ENV) {
    findings.push({
      checkId: 'env.node_env_unset',
      severity: 'warn',
      title: 'NODE_ENV 미설정',
      detail: 'NODE_ENV가 설정되지 않았습니다. production 환경에서는 명시적으로 설정하세요.',
      remediation: 'NODE_ENV=production 으로 설정하세요.',
    });
  }

  const dbPath = process.env.DB_PATH ?? '';
  if (dbPath.startsWith('/tmp') || dbPath.startsWith('/var/tmp')) {
    findings.push({
      checkId: 'env.db_path_tmp',
      severity: 'warn',
      title: 'DB 경로가 임시 디렉토리',
      detail: `DB_PATH(${dbPath})가 임시 디렉토리를 가리킵니다. 재부팅 시 데이터 손실 위험.`,
      remediation: '영구 저장소 경로로 DB_PATH를 변경하세요.',
    });
  }

  const alertInterval = Number(process.env.ALERT_CHECK_INTERVAL_MS);
  if (alertInterval > 0 && alertInterval < 10_000) {
    findings.push({
      checkId: 'env.alert_interval_too_short',
      severity: 'warn',
      title: '알림 체크 간격이 너무 짧음',
      detail: `ALERT_CHECK_INTERVAL_MS(${alertInterval}ms)가 10초 미만입니다. API rate limit에 걸릴 수 있습니다.`,
      remediation: '최소 60000ms (1분) 이상으로 설정하세요.',
    });
  }

  return findings;
}
```

### 테스트 (`security/audit.test.ts`)

```typescript
// packages/server/src/services/security/audit.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runSecurityAudit } from './audit.js';

describe('runSecurityAudit', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('필수 API 키 미설정 시 critical finding을 생성한다', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.DISCORD_TOKEN;

    const report = await runSecurityAudit({ checkFilePermissions: false });

    const criticals = report.findings.filter((f) => f.severity === 'critical');
    expect(criticals.length).toBeGreaterThanOrEqual(2);
    expect(report.summary.critical).toBeGreaterThanOrEqual(2);
  });

  it('선택 API 키 미설정 시 info finding을 생성한다', async () => {
    delete process.env.ALPHA_VANTAGE_API_KEY;
    delete process.env.COINGECKO_API_KEY;

    const report = await runSecurityAudit({ checkFilePermissions: false });

    const infos = report.findings.filter((f) => f.severity === 'info');
    expect(infos.some((f) => f.checkId.includes('alpha_vantage'))).toBe(true);
  });

  it('위험한 환경변수 감지 시 warn finding을 생성한다', async () => {
    process.env.LD_PRELOAD = '/some/lib.so';

    const report = await runSecurityAudit({ checkFilePermissions: false });

    const warns = report.findings.filter((f) => f.checkId.includes('ld_preload'));
    expect(warns).toHaveLength(1);
    expect(warns[0].severity).toBe('warn');
  });

  it('NODE_ENV 미설정 시 warn finding을 생성한다', async () => {
    delete process.env.NODE_ENV;

    const report = await runSecurityAudit({ checkFilePermissions: false, checkApiKeys: false });

    expect(report.findings.some((f) => f.checkId === 'env.node_env_unset')).toBe(true);
  });

  it('DB_PATH가 /tmp일 때 warn finding을 생성한다', async () => {
    process.env.DB_PATH = '/tmp/finclaw.db';

    const report = await runSecurityAudit({ checkFilePermissions: false, checkApiKeys: false });

    expect(report.findings.some((f) => f.checkId === 'env.db_path_tmp')).toBe(true);
  });

  it('ALERT_CHECK_INTERVAL_MS가 10초 미만일 때 warn finding을 생성한다', async () => {
    process.env.ALERT_CHECK_INTERVAL_MS = '5000';

    const report = await runSecurityAudit({ checkFilePermissions: false, checkApiKeys: false });

    expect(report.findings.some((f) => f.checkId === 'env.alert_interval_too_short')).toBe(true);
  });

  it('WSL 환경에서 파일 퍼미션 검사를 건너뛴다', async () => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu';

    const report = await runSecurityAudit({ checkApiKeys: false, checkEnvironment: false });

    expect(report.findings.some((f) => f.checkId === 'file_perm.skipped')).toBe(true);
  });

  it('summary가 severity별 카운트를 정확히 집계한다', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.NODE_ENV;

    const report = await runSecurityAudit({ checkFilePermissions: false });

    expect(report.summary.critical + report.summary.warn + report.summary.info).toBe(
      report.findings.length,
    );
  });

  it('timestamp가 리포트에 포함된다', async () => {
    const before = Date.now();
    const report = await runSecurityAudit({
      checkApiKeys: false,
      checkFilePermissions: false,
      checkEnvironment: false,
    });
    const after = Date.now();

    expect(report.timestamp).toBeGreaterThanOrEqual(before);
    expect(report.timestamp).toBeLessThanOrEqual(after);
  });
});
```

---

## Todo 7: 크론 스케줄러 (`cron/scheduler.ts`)

**파일**: `packages/server/src/services/cron/scheduler.ts`
**의존**: `croner` (npm), `@finclaw/infra` (FinClawLogger, ConcurrencyLaneManager)
**검증**: `scheduler.test.ts` 통과
**사전 작업**: `pnpm add croner@^9 --filter @finclaw/server`

### 구현 코드

```typescript
// packages/server/src/services/cron/scheduler.ts
import { Cron } from 'croner';
import type { FinClawLogger, ConcurrencyLaneManager } from '@finclaw/infra';

// ─── Types ───

export interface CronJob {
  readonly id: string;
  readonly name: string;
  readonly schedule: CronSchedule;
  readonly handler: (signal?: AbortSignal) => Promise<void>;
  readonly enabled: boolean;
  readonly lastRunAt: number | null;
  readonly lastStatus: 'ok' | 'error' | null;
  readonly nextRunAt: number | null;
}

export type CronSchedule =
  | { readonly kind: 'cron'; readonly expr: string; readonly tz?: string }
  | { readonly kind: 'every'; readonly intervalMs: number }
  | { readonly kind: 'at'; readonly atMs: number };

export interface CronSchedulerDeps {
  readonly logger: FinClawLogger;
  readonly lanes: ConcurrencyLaneManager;
}

export interface CronScheduler {
  add(job: Omit<CronJob, 'id' | 'lastRunAt' | 'lastStatus' | 'nextRunAt'>): CronJob;
  remove(jobId: string): boolean;
  setEnabled(jobId: string, enabled: boolean): void;
  list(): CronJob[];
  start(): void;
  stop(): void;
  readonly running: boolean;
}

// ─── Internal types ───

type InternalJob = CronJob & { _cron?: Cron; _timer?: ReturnType<typeof setTimeout> };
type MutableJobState = {
  lastRunAt: number | null;
  lastStatus: 'ok' | 'error' | null;
  nextRunAt: number | null;
};

// ─── Implementation ───

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export function createCronScheduler(deps: CronSchedulerDeps): CronScheduler {
  const { logger, lanes } = deps;
  const jobs = new Map<string, InternalJob>();
  let isRunning = false;
  let abortController: AbortController | null = null;

  function computeNextRunAt(schedule: CronSchedule): number | null {
    const now = Date.now();
    switch (schedule.kind) {
      case 'cron': {
        const cron = new Cron(schedule.expr, { timezone: schedule.tz });
        const next = cron.nextRun();
        return next ? next.getTime() : null;
      }
      case 'every':
        return now + schedule.intervalMs;
      case 'at':
        return schedule.atMs > now ? schedule.atMs : null;
    }
  }

  function armJob(job: InternalJob): void {
    // 이전 크론 인스턴스 정리
    job._cron?.stop();
    if (job._timer) clearTimeout(job._timer);

    if (!job.enabled || !isRunning) return;

    const { schedule } = job;

    if (schedule.kind === 'cron') {
      job._cron = new Cron(schedule.expr, { timezone: schedule.tz }, async () => {
        await executeJob(job);
      });
    } else if (schedule.kind === 'every') {
      const delay = Math.min(schedule.intervalMs, MAX_TIMEOUT_MS);
      const run = async () => {
        if (!job.enabled || !isRunning) return;
        await executeJob(job);
        if (job.enabled && isRunning) {
          job._timer = setTimeout(run, delay);
          job._timer.unref();
        }
      };
      job._timer = setTimeout(run, delay);
      job._timer.unref();
    } else if (schedule.kind === 'at') {
      const delay = Math.min(schedule.atMs - Date.now(), MAX_TIMEOUT_MS);
      if (delay > 0) {
        job._timer = setTimeout(async () => {
          await executeJob(job);
        }, delay);
        job._timer.unref();
      }
    }
  }

  async function executeJob(job: InternalJob): Promise<void> {
    const state = job as unknown as MutableJobState;
    state.lastRunAt = Date.now();

    // ConcurrencyLane을 통한 동시성 제어 (laneId='cron', key=job.name)
    const handle = await lanes.acquire('cron', job.name);
    try {
      await job.handler(abortController?.signal);
      state.lastStatus = 'ok';
    } catch (error) {
      state.lastStatus = 'error';
      logger.error(`[Cron Error] ${job.name}: ${error}`);
    } finally {
      handle.release();
    }

    state.nextRunAt = computeNextRunAt(job.schedule);
  }

  return {
    add(input) {
      const id = crypto.randomUUID();
      const job: InternalJob = {
        ...input,
        id,
        lastRunAt: null,
        lastStatus: null,
        nextRunAt: computeNextRunAt(input.schedule),
      };
      jobs.set(id, job);
      if (isRunning) armJob(job);
      return job;
    },

    remove(jobId) {
      const job = jobs.get(jobId);
      if (!job) return false;
      job._cron?.stop();
      if (job._timer) clearTimeout(job._timer);
      return jobs.delete(jobId);
    },

    setEnabled(jobId, enabled) {
      const job = jobs.get(jobId);
      if (!job) return;
      (job as { enabled: boolean }).enabled = enabled;
      if (enabled && isRunning) {
        armJob(job);
      } else {
        job._cron?.stop();
        if (job._timer) clearTimeout(job._timer);
      }
    },

    list() {
      return Array.from(jobs.values());
    },

    start() {
      isRunning = true;
      abortController = new AbortController();
      for (const job of jobs.values()) {
        armJob(job);
      }
      logger.info(`[Cron] Scheduler started with ${jobs.size} jobs`);
    },

    stop() {
      isRunning = false;
      abortController?.abort();
      abortController = null;
      for (const job of jobs.values()) {
        job._cron?.stop();
        if (job._timer) clearTimeout(job._timer);
      }
      logger.info('[Cron] Scheduler stopped');
    },

    get running() {
      return isRunning;
    },
  };
}
```

### 테스트 (`cron/scheduler.test.ts`)

```typescript
// packages/server/src/services/cron/scheduler.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCronScheduler, type CronScheduler } from './scheduler.js';
import { ConcurrencyLaneManager } from '@finclaw/infra';

function createTestLogger() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    flush: vi.fn().mockResolvedValue(undefined),
  };
}

describe('CronScheduler', () => {
  let scheduler: CronScheduler;
  let logger: ReturnType<typeof createTestLogger>;
  let lanes: ConcurrencyLaneManager;

  beforeEach(() => {
    logger = createTestLogger();
    lanes = new ConcurrencyLaneManager();
    scheduler = createCronScheduler({ logger, lanes });
  });

  afterEach(() => {
    scheduler.stop();
    lanes.dispose();
  });

  it('작업을 등록하고 list로 조회할 수 있다', () => {
    const job = scheduler.add({
      name: 'test-job',
      schedule: { kind: 'every', intervalMs: 60_000 },
      handler: async () => {},
      enabled: true,
    });

    expect(job.id).toBeTruthy();
    expect(scheduler.list()).toHaveLength(1);
    expect(scheduler.list()[0].name).toBe('test-job');
  });

  it('작업을 제거할 수 있다', () => {
    const job = scheduler.add({
      name: 'test-job',
      schedule: { kind: 'every', intervalMs: 60_000 },
      handler: async () => {},
      enabled: true,
    });

    expect(scheduler.remove(job.id)).toBe(true);
    expect(scheduler.list()).toHaveLength(0);
  });

  it('존재하지 않는 작업 제거 시 false를 반환한다', () => {
    expect(scheduler.remove('nonexistent')).toBe(false);
  });

  it('start/stop으로 스케줄러를 제어할 수 있다', () => {
    expect(scheduler.running).toBe(false);
    scheduler.start();
    expect(scheduler.running).toBe(true);
    scheduler.stop();
    expect(scheduler.running).toBe(false);
  });

  it('setEnabled로 작업을 비활성화할 수 있다', () => {
    const job = scheduler.add({
      name: 'test-job',
      schedule: { kind: 'every', intervalMs: 60_000 },
      handler: async () => {},
      enabled: true,
    });

    scheduler.setEnabled(job.id, false);
    expect(scheduler.list()[0].enabled).toBe(false);
  });

  it('every 스케줄이 지정 간격 후 실행된다', async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue(undefined);

    scheduler.add({
      name: 'interval-job',
      schedule: { kind: 'every', intervalMs: 100 },
      handler,
      enabled: true,
    });

    scheduler.start();

    await vi.advanceTimersByTimeAsync(150);

    expect(handler).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });

  it('handler 에러 시 lastStatus가 error로 설정된다', async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockRejectedValue(new Error('fail'));

    const job = scheduler.add({
      name: 'failing-job',
      schedule: { kind: 'every', intervalMs: 100 },
      handler,
      enabled: true,
    });

    scheduler.start();

    await vi.advanceTimersByTimeAsync(150);

    const updated = scheduler.list().find((j) => j.id === job.id);
    expect(updated?.lastStatus).toBe('error');
    expect(logger.error).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('stop 시 AbortSignal이 handler에 전파된다', async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;

    scheduler.add({
      name: 'signal-job',
      schedule: { kind: 'every', intervalMs: 100 },
      handler: async (signal) => {
        receivedSignal = signal;
        // 긴 작업 시뮬레이션
        await new Promise((resolve) => setTimeout(resolve, 1000));
      },
      enabled: true,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(150);

    scheduler.stop();

    expect(receivedSignal?.aborted).toBe(true);

    vi.useRealTimers();
  });

  it('nextRunAt이 등록 시 계산된다', () => {
    const now = Date.now();
    const job = scheduler.add({
      name: 'test-job',
      schedule: { kind: 'every', intervalMs: 60_000 },
      handler: async () => {},
      enabled: true,
    });

    expect(job.nextRunAt).toBeGreaterThanOrEqual(now);
  });

  it('at 스케줄: 과거 시간이면 nextRunAt이 null이다', () => {
    const job = scheduler.add({
      name: 'past-job',
      schedule: { kind: 'at', atMs: Date.now() - 1000 },
      handler: async () => {},
      enabled: true,
    });

    expect(job.nextRunAt).toBeNull();
  });
});
```

---

## Todo 8: 금융 크론 작업 (`cron/jobs/`)

**파일**:

- `packages/server/src/services/cron/jobs/market-refresh.ts`
- `packages/server/src/services/cron/jobs/alert-check.ts`
- `packages/server/src/services/cron/jobs/cleanup.ts`

**의존**: `@finclaw/storage` (Database, alerts CRUD, market-cache), `hooks/registry.ts`
**검증**: 기존 storage 테스트 + 스케줄러 통합 (scheduler.test.ts에서 간접 검증)

### 주의사항: Storage 기존 함수 재사용

- `getActiveAlerts()` → `packages/storage/src/tables/alerts.ts:86`
- `updateAlertTrigger()` → `packages/storage/src/tables/alerts.ts:91`
- `purgeExpiredCache()` → `packages/storage/src/tables/market-cache.ts:59`
- `getCachedData()` → `packages/storage/src/tables/market-cache.ts:26`

**`DatabaseSync`를 직접 사용하되, 가능한 곳은 storage 모듈의 기존 함수 활용.**

### market-refresh.ts

```typescript
// packages/server/src/services/cron/jobs/market-refresh.ts
import type { DatabaseSync } from 'node:sqlite';

/**
 * 시장 데이터 갱신 작업.
 * 활성 알림의 symbol 목록을 조회하고 시세 갱신을 트리거한다.
 * (실제 시세 조회는 Phase 16 market provider에서 구현)
 */
export function createMarketRefreshJob(db: DatabaseSync) {
  return {
    name: 'market-refresh',
    schedule: { kind: 'every' as const, intervalMs: 5 * 60 * 1000 }, // 5분마다
    enabled: true,
    handler: async (_signal?: AbortSignal) => {
      // 활성 알림의 고유 symbol 목록 조회
      const stmt = db.prepare('SELECT DISTINCT symbol FROM alerts WHERE enabled = 1');
      const symbols = (stmt.all() as Array<{ symbol: string }>).map((r) => r.symbol);

      if (symbols.length === 0) return;

      // TODO(phase-16): market provider를 통해 각 symbol 시세 조회 및 캐시 갱신
      // 현재는 symbol 목록만 수집 — provider 연동 시 여기서 setCachedData 호출
    },
  };
}
```

### alert-check.ts

```typescript
// packages/server/src/services/cron/jobs/alert-check.ts
import type { DatabaseSync } from 'node:sqlite';
import type { HookRegistry } from '../../hooks/registry.js';

/**
 * 가격 알림 체크 작업.
 * 활성 알림을 market_cache와 JOIN하여 현재가를 조회하고,
 * 조건 충족 시 훅 이벤트를 발행한다.
 */
export function createAlertCheckJob(db: DatabaseSync, hooks: HookRegistry) {
  return {
    name: 'alert-check',
    schedule: { kind: 'every' as const, intervalMs: 60 * 1000 }, // 1분마다
    enabled: true,
    handler: async (signal?: AbortSignal) => {
      const now = Date.now();

      const stmt = db.prepare(`
        SELECT a.id, a.symbol, a.condition_type, a.condition_value,
               a.cooldown_ms, a.last_triggered_at,
               json_extract(mc.data, '$.price') AS current_price
        FROM alerts a
        JOIN market_cache mc ON mc.key = a.symbol
        WHERE a.enabled = 1
          AND mc.expires_at > ?
      `);
      const alerts = stmt.all(now) as Array<{
        id: string;
        symbol: string;
        condition_type: string;
        condition_value: number;
        cooldown_ms: number;
        last_triggered_at: number | null;
        current_price: number | null;
      }>;

      for (const alert of alerts) {
        if (signal?.aborted) break;
        if (alert.current_price == null) continue;

        // 쿨다운 체크
        if (
          alert.cooldown_ms > 0 &&
          alert.last_triggered_at != null &&
          now - alert.last_triggered_at < alert.cooldown_ms
        ) {
          continue;
        }

        const shouldTrigger =
          (alert.condition_type === 'above' && alert.current_price >= alert.condition_value) ||
          (alert.condition_type === 'below' && alert.current_price <= alert.condition_value);

        if (shouldTrigger) {
          db.prepare(
            'UPDATE alerts SET last_triggered_at = ?, trigger_count = trigger_count + 1 WHERE id = ?',
          ).run(now, alert.id);

          hooks.trigger({
            type: 'market',
            action: 'alert-triggered',
            timestamp: now,
            context: {
              alertId: alert.id,
              symbol: alert.symbol,
              conditionType: alert.condition_type,
              conditionValue: alert.condition_value,
              currentPrice: alert.current_price,
            },
          });
        }
      }
    },
  };
}
```

### cleanup.ts

```typescript
// packages/server/src/services/cron/jobs/cleanup.ts
import type { DatabaseSync } from 'node:sqlite';

/**
 * 정리 작업.
 * - 만료된 시장 데이터 캐시 삭제
 * - 30일 이상 비활성 + 트리거된 알림 삭제
 */
export function createCleanupJob(db: DatabaseSync) {
  return {
    name: 'cleanup',
    schedule: { kind: 'cron' as const, expr: '0 3 * * *' }, // 매일 03:00
    enabled: true,
    handler: async (_signal?: AbortSignal) => {
      const now = Date.now();

      // 1. 만료된 캐시 삭제
      db.prepare('DELETE FROM market_cache WHERE expires_at <= ?').run(now);

      // 2. 30일 이상 비활성 + 트리거된 알림 삭제
      const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
      db.prepare(
        'DELETE FROM alerts WHERE enabled = 0 AND last_triggered_at IS NOT NULL AND last_triggered_at < ?',
      ).run(thirtyDaysAgo);
    },
  };
}
```

---

## Todo 9: 데몬 관리 (`daemon/systemd.ts`)

**파일**: `packages/server/src/services/daemon/systemd.ts`
**의존**: `node:fs/promises`, `node:child_process`
**검증**: `tsc --noEmit` 통과 + 수동 검증 (systemd 파일 내용 확인)

### 구현 코드

```typescript
// packages/server/src/services/daemon/systemd.ts
import { writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

/**
 * systemd 사용 가능 여부 감지.
 * WSL 환경에서는 systemd가 비활성화된 경우가 많으므로 힌트 제공.
 */
export function isSystemdAvailable(): { available: boolean; hint?: string } {
  if (process.platform !== 'linux') {
    return { available: false, hint: 'systemd는 Linux에서만 사용 가능합니다.' };
  }

  if (process.env.WSL_DISTRO_NAME) {
    try {
      execSync('systemctl --version', { stdio: 'ignore' });
      return {
        available: true,
        hint: 'WSL에서 systemd 활성화됨. /etc/wsl.conf에서 [boot] systemd=true 확인.',
      };
    } catch {
      return {
        available: false,
        hint: 'WSL에서 systemd가 비활성화되어 있습니다. /etc/wsl.conf에 [boot] systemd=true를 추가하세요.',
      };
    }
  }

  try {
    execSync('systemctl --version', { stdio: 'ignore' });
    return { available: true };
  } catch {
    return { available: false, hint: 'systemd를 찾을 수 없습니다. init 시스템을 확인하세요.' };
  }
}

export interface SystemdServiceOptions {
  readonly name?: string;
  readonly execPath: string;
  readonly workingDir: string;
  readonly envFile?: string;
  readonly outputPath: string;
}

/**
 * systemd 서비스 파일 생성.
 * Restart=on-failure (always 대신 — 설정 오류 시 무한 재시작 방지)
 */
export async function generateSystemdService(options: SystemdServiceOptions): Promise<void> {
  const { name = 'finclaw', execPath, workingDir, envFile, outputPath } = options;

  const unit = `[Unit]
Description=FinClaw Financial AI Assistant
After=network.target

[Service]
Type=simple
ExecStart=${execPath}
WorkingDirectory=${workingDir}
${envFile ? `EnvironmentFile=${envFile}` : '# EnvironmentFile= (not configured)'}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${name}

[Install]
WantedBy=multi-user.target
`;

  await writeFile(outputPath, unit, 'utf-8');
}
```

---

## Todo 10: Barrel Export (`services/index.ts`)

**파일**: `packages/server/src/services/index.ts`
**의존**: 모든 서비스 모듈
**검증**: `tsc --noEmit` 통과

### 구현 코드

```typescript
// packages/server/src/services/index.ts

// ── Hooks ──
export type {
  HookEventType,
  HookEvent,
  HookHandler,
  HookSource,
  HookEntry,
  HookRunMode,
  HookRunner,
  HookRunnerOptions,
  HookRegistration,
} from './hooks/types.js';
export { HookRegistry } from './hooks/registry.js';
export { createServiceHookRunner } from './hooks/runner.js';
export { bridgeEventBusToHooks } from './hooks/bridge.js';

// ── Cron ──
export type { CronJob, CronSchedule, CronScheduler, CronSchedulerDeps } from './cron/scheduler.js';
export { createCronScheduler } from './cron/scheduler.js';
export { createMarketRefreshJob } from './cron/jobs/market-refresh.js';
export { createAlertCheckJob } from './cron/jobs/alert-check.js';
export { createCleanupJob } from './cron/jobs/cleanup.js';

// ── Security ──
export type { RedactionPattern } from './security/redaction.js';
export { REDACTION_PATTERNS, redactSensitiveText, redactObject } from './security/redaction.js';
export type {
  SecurityAuditFinding,
  SecurityAuditReport,
  SecurityAuditOptions,
} from './security/audit.js';
export { runSecurityAudit } from './security/audit.js';

// ── Daemon ──
export type { SystemdServiceOptions } from './daemon/systemd.js';
export { isSystemdAvailable, generateSystemdService } from './daemon/systemd.js';
```

---

## 구현 순서 요약

| 순서 | Todo                         | 파일                                          | 의존     | 검증 방법                      |
| ---- | ---------------------------- | --------------------------------------------- | -------- | ------------------------------ |
| 0    | **사전 작업**                | `pnpm add croner@^9 --filter @finclaw/server` | —        | `pnpm ls croner`               |
| 1    | hooks/types.ts               | 타입 정의                                     | 없음     | `tsc --noEmit`                 |
| 2    | hooks/registry.ts + test     | Observer 패턴 레지스트리                      | Todo 1   | `vitest run registry.test.ts`  |
| 3    | hooks/runner.ts + test       | 3가지 실행 모드                               | Todo 1,2 | `vitest run runner.test.ts`    |
| 4    | hooks/bridge.ts              | EventBus ↔ HookRegistry                       | Todo 2   | `tsc --noEmit`                 |
| 5    | security/redaction.ts + test | 13+ regex 패턴 마스킹                         | 없음     | `vitest run redaction.test.ts` |
| 6    | security/audit.ts + test     | 3개 수집기 감사                               | 없음     | `vitest run audit.test.ts`     |
| 7    | cron/scheduler.ts + test     | croner 기반 스케줄러                          | croner   | `vitest run scheduler.test.ts` |
| 8    | cron/jobs/\*.ts              | 금융 크론 작업 3개                            | Todo 2,7 | `tsc --noEmit`                 |
| 9    | daemon/systemd.ts            | systemd 서비스 생성                           | 없음     | `tsc --noEmit`                 |
| 10   | services/index.ts            | barrel export                                 | 전체     | `tsc --noEmit`                 |

## 전체 검증

```bash
# 1. 타입 체크
pnpm exec tsc --noEmit

# 2. 단위 테스트
pnpm exec vitest run packages/server/src/services/

# 3. 린트
pnpm exec oxlint packages/server/src/services/
```

## 디렉토리 구조

```
packages/server/src/services/
├── index.ts                        (barrel)
├── hooks/
│   ├── types.ts                    (타입 정의)
│   ├── registry.ts                 (HookRegistry 클래스)
│   ├── registry.test.ts            (테스트)
│   ├── runner.ts                   (createServiceHookRunner)
│   ├── runner.test.ts              (테스트)
│   └── bridge.ts                   (EventBus 브리지)
├── cron/
│   ├── scheduler.ts                (createCronScheduler)
│   ├── scheduler.test.ts           (테스트)
│   └── jobs/
│       ├── market-refresh.ts       (시장 데이터 갱신)
│       ├── alert-check.ts          (가격 알림 체크)
│       └── cleanup.ts              (캐시/알림 정리)
├── security/
│   ├── redaction.ts                (13+ 리다이렉션 패턴)
│   ├── redaction.test.ts           (테스트)
│   ├── audit.ts                    (보안 감사)
│   └── audit.test.ts               (테스트)
└── daemon/
    └── systemd.ts                  (systemd 서비스 생성)
```
