# Phase 4: 프로세스 실행 & 메시지 라우팅 — 상세 구현 TODO

> **참조:** `plans/phase04/plan.md`
> **브랜치:** `feature/process-routing`

## plan.md 대비 교정 사항

| #   | 위치                            | plan.md 원문                                                                   | 교정                                             | 이유                                          |
| --- | ------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------ | --------------------------------------------- |
| 1   | `message-router.ts` L917        | `{ requestId: entry.id, startTime: Date.now() }`                               | `{ requestId: entry.id, startedAt: Date.now() }` | `RequestContext.startedAt` (context.ts:8)     |
| 2   | `lifecycle.ts`                  | 파일명만 명시, 구현 코드 없음                                                  | Step 3에서 상세 코드 제공                        | plan.md §4에 누락                             |
| 3   | `server/package.json`           | `@finclaw/infra` 미포함                                                        | `"@finclaw/infra": "workspace:*"` 추가           | 빌드 실패 방지                                |
| 4   | `server/tsconfig.json`          | `{ "path": "../infra" }` 미포함                                                | references에 추가                                | 타입 체크 실패 방지                           |
| 5   | `message-queue.ts` collect 모드 | 타입만 선언, 구현 없음                                                         | `enqueue()`에 collect 윈도우 로직 추가           | plan.md §4.5에 구현 누락                      |
| 6   | `concurrency-lane.ts` L315      | `next.resolve({ release: () => this.releaseIfCurrent(key, next.generation) })` | 그대로 유지 (의도된 동작)                        | waiter의 generation으로 release 바인딩 — 정상 |

---

## Step 1: @finclaw/infra 확장 — ConcurrencyLane

**목표:** 3-Lane 동시성 관리자를 infra 패키지에 추가

### 1-1. `packages/infra/src/concurrency-lane.ts` (신규)

```typescript
// packages/infra/src/concurrency-lane.ts
import { FinClawError } from './errors.js';

/** 3-Lane ID: main(사용자 대화), cron(정기 작업), subagent(하위 에이전트) */
export type LaneId = 'main' | 'cron' | 'subagent';

export interface LaneConfig {
  /** 최대 동시 실행 수 */
  maxConcurrent: number;
  /** 대기열 최대 크기 (기본: 100) */
  maxQueueSize?: number;
  /** 대기 타임아웃 (ms, 기본: 60000) */
  waitTimeoutMs?: number;
}

/** 기본 레인 설정 */
export const DEFAULT_LANE_CONFIG: Record<LaneId, LaneConfig> = {
  main: { maxConcurrent: 1 },
  cron: { maxConcurrent: 2 },
  subagent: { maxConcurrent: 3 },
};

export interface LaneHandle {
  /** 레인 해제 */
  release(): void;
}

/**
 * 동시성 레인 -- 키별 동시 실행 제한
 *
 * - 키별 독립 카운터
 * - maxConcurrent 초과 시 대기열에 삽입
 * - release 시 대기열에서 다음 항목 실행
 * - Generation counter: resetGeneration() 시 stale completion 무시
 */
export class ConcurrencyLane {
  private active = new Map<string, number>();
  private generation = 0;
  private waiters = new Map<
    string,
    Array<{
      resolve: (handle: LaneHandle) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      generation: number;
    }>
  >();

  constructor(private readonly config: LaneConfig) {}

  async acquire(key: string): Promise<LaneHandle> {
    const current = this.active.get(key) ?? 0;
    const gen = this.generation;

    if (current < this.config.maxConcurrent) {
      this.active.set(key, current + 1);
      return { release: () => this.releaseIfCurrent(key, gen) };
    }

    const queue = this.waiters.get(key) ?? [];
    if (queue.length >= (this.config.maxQueueSize ?? 100)) {
      throw new FinClawError('Concurrency lane queue full', 'LANE_QUEUE_FULL', {
        details: { key },
      });
    }

    return new Promise<LaneHandle>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(key, waiter);
        reject(
          new FinClawError('Concurrency lane timeout', 'LANE_TIMEOUT', {
            details: { key },
          }),
        );
      }, this.config.waitTimeoutMs ?? 60_000);

      const waiter = { resolve, reject, timer, generation: gen };
      if (!this.waiters.has(key)) this.waiters.set(key, []);
      this.waiters.get(key)!.push(waiter);
    });
  }

  /** Generation이 일치할 때만 release (stale completion 무시) */
  private releaseIfCurrent(key: string, gen: number): void {
    if (gen !== this.generation) return; // stale — 무시
    this.release(key);
  }

  private release(key: string): void {
    const current = this.active.get(key) ?? 0;
    const queue = this.waiters.get(key);

    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      clearTimeout(next.timer);
      next.resolve({ release: () => this.releaseIfCurrent(key, next.generation) });
    } else {
      if (current <= 1) {
        this.active.delete(key);
      } else {
        this.active.set(key, current - 1);
      }
    }
  }

  /** Generation 리셋 — 진행 중인 모든 작업의 release를 무효화 */
  resetGeneration(): void {
    this.generation++;
    this.clearWaiters();
  }

  /** 모든 대기열 정리 (LANE_CLEARED 에러로 reject) */
  clearWaiters(): void {
    for (const [, queue] of this.waiters) {
      for (const waiter of queue) {
        clearTimeout(waiter.timer);
        waiter.reject(new FinClawError('Lane cleared', 'LANE_CLEARED'));
      }
    }
    this.waiters.clear();
  }

  /** 리소스 정리 */
  dispose(): void {
    this.clearWaiters();
    this.active.clear();
  }

  private removeWaiter(key: string, waiter: unknown): void {
    const queue = this.waiters.get(key);
    if (queue) {
      const idx = queue.indexOf(waiter as typeof queue extends Array<infer U> ? U : never);
      if (idx !== -1) queue.splice(idx, 1);
    }
  }

  getActiveCount(key: string): number {
    return this.active.get(key) ?? 0;
  }

  getWaitingCount(key: string): number {
    return this.waiters.get(key)?.length ?? 0;
  }
}

/**
 * 3-Lane 관리자 — main, cron, subagent 레인 통합 관리
 */
export class ConcurrencyLaneManager {
  private readonly lanes: Map<LaneId, ConcurrencyLane>;

  constructor(configs: Partial<Record<LaneId, LaneConfig>> = {}) {
    this.lanes = new Map();
    for (const id of ['main', 'cron', 'subagent'] as LaneId[]) {
      this.lanes.set(id, new ConcurrencyLane(configs[id] ?? DEFAULT_LANE_CONFIG[id]));
    }
  }

  acquire(laneId: LaneId, key: string): Promise<LaneHandle> {
    return this.getLane(laneId).acquire(key);
  }

  resetGeneration(laneId: LaneId): void {
    this.getLane(laneId).resetGeneration();
  }

  dispose(): void {
    for (const lane of this.lanes.values()) lane.dispose();
  }

  private getLane(id: LaneId): ConcurrencyLane {
    const lane = this.lanes.get(id);
    if (!lane) throw new FinClawError(`Unknown lane: ${id}`, 'UNKNOWN_LANE');
    return lane;
  }
}
```

### 1-2. `packages/infra/src/index.ts` 수정 — barrel export 추가

기존 파일 끝 `// 프로세스` 섹션 뒤에 추가:

```typescript
// 동시성
export {
  ConcurrencyLane,
  ConcurrencyLaneManager,
  DEFAULT_LANE_CONFIG,
  type LaneId,
  type LaneConfig,
  type LaneHandle,
} from './concurrency-lane.js';
```

### 1-3. `packages/infra/test/concurrency-lane.test.ts` (신규)

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ConcurrencyLane, ConcurrencyLaneManager } from '../src/concurrency-lane.js';

describe('ConcurrencyLane', () => {
  it('maxConcurrent 이내에서 즉시 acquire 가능', async () => {
    const lane = new ConcurrencyLane({ maxConcurrent: 2 });
    const h1 = await lane.acquire('k');
    const h2 = await lane.acquire('k');
    expect(lane.getActiveCount('k')).toBe(2);
    h1.release();
    h2.release();
  });

  it('maxConcurrent 초과 시 대기하다 release 후 진행', async () => {
    const lane = new ConcurrencyLane({ maxConcurrent: 1 });
    const h1 = await lane.acquire('k');
    expect(lane.getActiveCount('k')).toBe(1);

    let resolved = false;
    const p2 = lane.acquire('k').then((h) => {
      resolved = true;
      return h;
    });
    // 아직 대기 중
    (await vi.advanceTimersByTimeAsync?.(0)) ?? Promise.resolve();
    expect(lane.getWaitingCount('k')).toBe(1);

    h1.release();
    const h2 = await p2;
    expect(resolved).toBe(true);
    h2.release();
  });

  it('maxQueueSize 초과 시 LANE_QUEUE_FULL 에러', async () => {
    const lane = new ConcurrencyLane({ maxConcurrent: 1, maxQueueSize: 1 });
    await lane.acquire('k');
    // 큐에 1개 대기
    void lane.acquire('k');
    // 큐에 2번째 → 에러
    await expect(lane.acquire('k')).rejects.toThrow('LANE_QUEUE_FULL');
  });

  it('resetGeneration 후 stale release는 무시됨', async () => {
    const lane = new ConcurrencyLane({ maxConcurrent: 1 });
    const h1 = await lane.acquire('k');
    expect(lane.getActiveCount('k')).toBe(1);

    lane.resetGeneration();
    h1.release(); // stale — 무시
    // active count는 여전히 1 (stale release 무시 → clearWaiters에서 active 변경 없음)
    // 실제로는 resetGeneration이 clearWaiters만 호출하고 active를 변경하지 않음
    // stale release가 무시되므로 active가 줄어들지 않음
    expect(lane.getActiveCount('k')).toBe(1);
  });

  it('clearWaiters가 대기 중인 모든 waiter를 reject', async () => {
    const lane = new ConcurrencyLane({ maxConcurrent: 1 });
    await lane.acquire('k');
    const p = lane.acquire('k');

    lane.clearWaiters();
    await expect(p).rejects.toThrow('Lane cleared');
  });

  it('dispose 후 active와 waiters 모두 정리', async () => {
    const lane = new ConcurrencyLane({ maxConcurrent: 1 });
    await lane.acquire('k');
    void lane.acquire('k'); // 대기 추가

    lane.dispose();
    expect(lane.getActiveCount('k')).toBe(0);
    expect(lane.getWaitingCount('k')).toBe(0);
  });

  it('다른 키는 독립적으로 관리', async () => {
    const lane = new ConcurrencyLane({ maxConcurrent: 1 });
    const h1 = await lane.acquire('a');
    const h2 = await lane.acquire('b');
    expect(lane.getActiveCount('a')).toBe(1);
    expect(lane.getActiveCount('b')).toBe(1);
    h1.release();
    h2.release();
  });
});

describe('ConcurrencyLaneManager', () => {
  it('3-Lane 기본 설정으로 생성', () => {
    const mgr = new ConcurrencyLaneManager();
    // main(1), cron(2), subagent(3) 기본 설정
    expect(mgr).toBeDefined();
  });

  it('존재하지 않는 레인 접근 시 UNKNOWN_LANE 에러', () => {
    const mgr = new ConcurrencyLaneManager();
    // @ts-expect-error -- 잘못된 레인 ID 테스트
    expect(() => mgr.acquire('invalid', 'k')).rejects.toThrow('UNKNOWN_LANE');
  });

  it('dispose가 모든 레인을 정리', async () => {
    const mgr = new ConcurrencyLaneManager();
    await mgr.acquire('main', 'k');
    mgr.dispose();
    // dispose 후에는 정리 완료 (에러 없이 통과하면 성공)
  });
});
```

### 검증

```bash
# 1-1. 빌드 및 타입 체크
pnpm build && pnpm typecheck

# 1-2. 단위 테스트
pnpm test -- packages/infra/test/concurrency-lane.test.ts
```

- [ ] `concurrency-lane.ts` 생성 완료
- [ ] `index.ts` barrel export 추가 완료
- [ ] `concurrency-lane.test.ts` 통과
- [ ] `pnpm typecheck` 통과

---

## Step 2: @finclaw/server 패키지 설정 + process 기반 파일

**목표:** server 패키지에 infra 의존성 추가, process/ 디렉토리 구조 + 에러 계층 + barrel export 생성

### 2-1. `packages/server/package.json` 수정

`"dependencies"`에 추가:

```jsonc
"@finclaw/infra": "workspace:*"
```

수정 후 `pnpm install`로 심링크 갱신. 이후 `pnpm format:fix`로 oxfmt 포맷 적용.

### 2-2. `packages/server/tsconfig.json` 수정

`"references"` 배열에 추가:

```jsonc
{ "path": "../infra" }
```

최종 references:

```json
[
  { "path": "../types" },
  { "path": "../infra" },
  { "path": "../config" },
  { "path": "../storage" },
  { "path": "../agent" },
  { "path": "../channel-discord" },
  { "path": "../skills-finance" }
]
```

### 2-3. `packages/server/src/process/errors.ts` (신규)

```typescript
// packages/server/src/process/errors.ts
import { FinClawError } from '@finclaw/infra';

/** spawn 실행 실패 */
export class SpawnError extends FinClawError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'SPAWN_ERROR', { details });
    this.name = 'SpawnError';
  }
}

/** spawn 타임아웃 */
export class SpawnTimeoutError extends FinClawError {
  constructor(command: string, timeoutMs: number) {
    super(`Spawn timeout: ${command} (${timeoutMs}ms)`, 'SPAWN_TIMEOUT', {
      details: { command, timeoutMs },
    });
    this.name = 'SpawnTimeoutError';
  }
}

/** 레인 대기열 정리됨 (Generation 리셋) */
export class LaneClearedError extends FinClawError {
  constructor(laneKey?: string) {
    super('Lane cleared', 'LANE_CLEARED', { details: { laneKey } });
    this.name = 'LaneClearedError';
  }
}

/** 큐 가득 참 */
export class QueueFullError extends FinClawError {
  constructor(sessionKey: string, maxSize: number) {
    super(`Queue full for session: ${sessionKey}`, 'QUEUE_FULL', {
      details: { sessionKey, maxSize },
    });
    this.name = 'QueueFullError';
  }
}
```

### 2-4. `packages/server/src/process/index.ts` (신규)

```typescript
// packages/server/src/process — barrel export

// 에러
export { SpawnError, SpawnTimeoutError, LaneClearedError, QueueFullError } from './errors.js';

// 프로세스 실행
export { safeSpawn, type SpawnOptions, type SpawnResult } from './spawn.js';

// 시그널 핸들링
export { setupGracefulShutdown } from './signal-handler.js';

// 라이프사이클
export { ProcessLifecycle } from './lifecycle.js';

// 세션 키
export {
  deriveRoutingSessionKey,
  deriveGlobalSessionKey,
  classifySessionKey,
  parseRoutingSessionKey,
  type RoutingSessionKeyParams,
  type SessionKeyKind,
} from './session-key.js';

// 바인딩 매칭
export {
  matchBinding,
  extractBindingRules,
  type MatchTier,
  type BindingRule,
  type BindingMatch,
} from './binding-matcher.js';

// 메시지 큐
export {
  MessageQueue,
  type QueueMode,
  type QueueDropPolicy,
  type QueueEntry,
  type MessageQueueConfig,
} from './message-queue.js';

// 디바운스
export { createDebouncer, type DebounceConfig } from './debounce.js';

// 메시지 라우터
export { MessageRouter, type MessageRouterDeps } from './message-router.js';
```

> **주의:** barrel은 모든 파일이 완성된 후 최종 검증. Step 2에서 생성만 하고, 타입 체크는 Step 6 이후에 수행.

### 검증

```bash
# 2-1. 의존성 설치
pnpm install

# 2-2. 포맷 적용 (oxfmt이 package.json 키 순서 재정렬)
pnpm format:fix

# 2-3. errors.ts 단독 타입 체크 (barrel의 다른 모듈은 아직 없으므로 errors.ts만)
pnpm typecheck  # → barrel import 에러 예상됨 — OK, Step 6 후 재검증
```

- [ ] `server/package.json`에 `@finclaw/infra` 추가 + `pnpm install` 완료
- [ ] `server/tsconfig.json`에 `{ "path": "../infra" }` 추가
- [ ] `process/errors.ts` 생성 완료
- [ ] `process/index.ts` 생성 완료 (모든 모듈 완성 전까지 barrel import 에러 허용)

---

## Step 3: 프로세스 실행 기반 — spawn, signal-handler, lifecycle

**목표:** 자식 프로세스 실행, 우아한 종료, 라이프사이클 관리

### 3-1. `packages/server/src/process/spawn.ts` (신규)

```typescript
// packages/server/src/process/spawn.ts
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

export interface SpawnOptions {
  /** 실행할 명령어 */
  command: string;
  /** 명령어 인자 */
  args?: string[];
  /** 작업 디렉토리 */
  cwd?: string;
  /** 환경 변수 */
  env?: NodeJS.ProcessEnv;
  /** 타임아웃 (ms, 기본: 30000) */
  timeoutMs?: number;
  /** 외부 중단 시그널 (AbortSignal.any()로 타임아웃과 합성) */
  signal?: AbortSignal;
  /** stdin 입력 */
  stdin?: string;
  /** 최대 출력 버퍼 (bytes, 기본: 10MB) */
  maxBuffer?: number;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal?: string;
  timedOut: boolean;
  /** 외부 AbortSignal에 의한 취소 여부 */
  aborted: boolean;
  durationMs: number;
}

/**
 * 안전한 자식 프로세스 실행
 *
 * - AbortSignal.timeout() + AbortSignal.any()로 타임아웃/외부 취소 합성
 * - 타임아웃 시 SIGTERM -> 2초 유예 -> SIGKILL
 * - stdout/stderr 스트림 수집 (maxBuffer 제한)
 */
export async function safeSpawn(opts: SpawnOptions): Promise<SpawnResult> {
  const {
    command,
    args = [],
    cwd,
    env,
    timeoutMs = 30_000,
    signal: externalSignal,
    stdin,
    maxBuffer = 10 * 1024 * 1024,
  } = opts;

  // AbortSignal 합성: 타임아웃 + 외부 시그널
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = externalSignal
    ? AbortSignal.any([timeoutSignal, externalSignal])
    : timeoutSignal;

  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const child = nodeSpawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length <= maxBuffer) {
        stdout += chunk.toString();
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length + chunk.length <= maxBuffer) {
        stderr += chunk.toString();
      }
    });

    if (stdin) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }

    combinedSignal.addEventListener('abort', () => gracefulKill(child), { once: true });

    child.on('close', (exitCode, sig) => {
      const timedOut = timeoutSignal.aborted;
      const aborted = externalSignal?.aborted ?? false;
      resolve({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
        signal: sig ?? undefined,
        timedOut,
        aborted,
        durationMs: Date.now() - startTime,
      });
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

/** SIGTERM -> 2초 유예 -> SIGKILL */
function gracefulKill(child: ChildProcess): void {
  child.kill('SIGTERM');
  setTimeout(() => {
    if (!child.killed) {
      child.kill('SIGKILL');
    }
  }, 2000);
}
```

### 3-2. `packages/server/src/process/signal-handler.ts` (신규)

```typescript
// packages/server/src/process/signal-handler.ts
import type { CleanupFn } from '@finclaw/types';
import type { FinClawLogger } from '@finclaw/infra';

/**
 * 우아한 종료 핸들러
 *
 * SIGINT/SIGTERM 수신 시:
 * 1. 새 메시지 수신 중단
 * 2. 진행 중인 메시지 처리 완료 대기 (30초 타임아웃)
 * 3. 리소스 정리 (CleanupFn[] 순차 실행)
 * 4. 프로세스 종료
 */
export function setupGracefulShutdown(logger: FinClawLogger, cleanupFns: CleanupFn[]): void {
  let shuttingDown = false;

  const handler = async (signal: string) => {
    if (shuttingDown) {
      logger.warn(`Forced exit on second ${signal}`);
      process.exit(1);
    }

    shuttingDown = true;
    logger.info(`Received ${signal}, starting graceful shutdown...`);

    const timeout = setTimeout(() => {
      logger.error('Shutdown timeout (30s), forcing exit');
      process.exit(1);
    }, 30_000);

    try {
      for (const cleanup of cleanupFns) {
        try {
          await cleanup();
        } catch (err) {
          logger.error(`Cleanup error: ${String(err)}`);
        }
      }
      logger.info('Graceful shutdown complete');
      clearTimeout(timeout);
      process.exit(0);
    } catch (err) {
      logger.error(`Shutdown error: ${String(err)}`);
      clearTimeout(timeout);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void handler('SIGINT'));
  process.on('SIGTERM', () => void handler('SIGTERM'));
}
```

### 3-3. `packages/server/src/process/lifecycle.ts` (신규)

> plan.md에 코드가 누락되어 있었으므로 여기서 상세 제공.

```typescript
// packages/server/src/process/lifecycle.ts
import type { CleanupFn } from '@finclaw/types';
import type { FinClawLogger } from '@finclaw/infra';
import { setupGracefulShutdown } from './signal-handler.js';

export interface ProcessLifecycleDeps {
  logger: FinClawLogger;
}

/**
 * 프로세스 라이프사이클 관리자
 *
 * - CleanupFn 등록/해제
 * - 시그널 핸들러 연동
 * - 정리 함수를 등록 역순으로 실행 (LIFO)
 */
export class ProcessLifecycle {
  private readonly cleanupFns: CleanupFn[] = [];
  private readonly logger: FinClawLogger;
  private initialized = false;

  constructor(deps: ProcessLifecycleDeps) {
    this.logger = deps.logger;
  }

  /** 정리 함수 등록 (LIFO 순서로 실행됨) */
  register(fn: CleanupFn): void {
    this.cleanupFns.push(fn);
  }

  /** 시그널 핸들러 초기화 (한 번만 호출) */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    // 등록 역순으로 실행하기 위해 reversed copy 전달
    setupGracefulShutdown(this.logger, [...this.cleanupFns].reverse());
    this.logger.info('Process lifecycle initialized');
  }

  /** 수동 종료 (테스트 등에서 사용) */
  async shutdown(): Promise<void> {
    this.logger.info('Manual shutdown initiated');
    const reversed = [...this.cleanupFns].reverse();
    for (const cleanup of reversed) {
      try {
        await cleanup();
      } catch (err) {
        this.logger.error(`Cleanup error: ${String(err)}`);
      }
    }
  }
}
```

### 3-4. `packages/server/test/process/spawn.test.ts` (신규)

```typescript
import { describe, it, expect } from 'vitest';
import { safeSpawn } from '../../src/process/spawn.js';

describe('safeSpawn', () => {
  it('정상 명령 실행 후 stdout 수집', async () => {
    const result = await safeSpawn({ command: 'echo', args: ['hello'] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
  });

  it('존재하지 않는 명령 실행 시 에러', async () => {
    await expect(safeSpawn({ command: '__nonexistent_cmd_12345__' })).rejects.toThrow();
  });

  it('타임아웃 시 timedOut=true', async () => {
    const result = await safeSpawn({
      command: 'sleep',
      args: ['10'],
      timeoutMs: 100,
    });
    expect(result.timedOut).toBe(true);
  });

  it('외부 AbortSignal로 취소 시 aborted=true', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const result = await safeSpawn({
      command: 'sleep',
      args: ['10'],
      signal: controller.signal,
      timeoutMs: 30_000,
    });
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it('stdin 입력 전달', async () => {
    const result = await safeSpawn({
      command: 'cat',
      stdin: 'hello from stdin',
    });
    expect(result.stdout.trim()).toBe('hello from stdin');
  });

  it('exitCode가 0이 아닌 경우', async () => {
    const result = await safeSpawn({ command: 'false' });
    expect(result.exitCode).not.toBe(0);
  });

  it('durationMs가 양수', async () => {
    const result = await safeSpawn({ command: 'echo', args: ['hi'] });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
```

### 검증

```bash
pnpm test -- packages/server/test/process/spawn.test.ts
```

- [ ] `spawn.ts` 생성 완료
- [ ] `signal-handler.ts` 생성 완료
- [ ] `lifecycle.ts` 생성 완료
- [ ] `spawn.test.ts` 통과
- [ ] AbortSignal 합성 (타임아웃 vs 외부 취소) 구분 검증

---

## Step 4: 세션 키 + 바인딩 매칭

**목표:** Agent-Scoped 세션 키 도출, 4계층 바인딩 매칭

> Step 2 이후 실행. Step 3와 병렬 가능.

### 4-1. `packages/server/src/process/session-key.ts` (신규)

```typescript
// packages/server/src/process/session-key.ts
import type { SessionKey, ChannelId, AgentId } from '@finclaw/types';
import { createSessionKey } from '@finclaw/types';

/**
 * 라우팅용 세션 키 도출 (Agent-Scoped)
 *
 * 키 형식: agent:{agentId}:{channelId}:{chatType}[:chatId[:threadId]]
 *
 * 예시:
 * - DM:     "agent:main:discord:direct"
 * - 그룹:   "agent:main:discord:group:channel456"
 * - 스레드: "agent:main:discord:group:channel456:thread789"
 */
export interface RoutingSessionKeyParams {
  channelId: ChannelId;
  accountId: string;
  chatType: 'direct' | 'group' | 'channel';
  chatId?: string;
  threadId?: string;
  /** 에이전트 ID (기본: 'main') */
  agentId?: AgentId | string;
}

export function deriveRoutingSessionKey(params: RoutingSessionKeyParams): SessionKey {
  const agentId = (params.agentId as string) ?? 'main';
  const parts: string[] = [
    'agent',
    agentId,
    normalizeChannelId(params.channelId as string),
    params.chatType,
  ];

  if (params.chatType !== 'direct' && params.chatId) {
    parts.push(normalizeChatId(params.chatId));
  }

  if (params.threadId) {
    parts.push(params.threadId);
  }

  return createSessionKey(parts.join(':'));
}

/** 글로벌 세션 키 (채널 무관, 에이전트 전체) */
export function deriveGlobalSessionKey(agentId: string): SessionKey {
  return createSessionKey(`agent:${agentId}:global`);
}

/** 세션 키 분류 */
export type SessionKeyKind = 'agent' | 'legacy' | 'malformed';

export function classifySessionKey(key: SessionKey): SessionKeyKind {
  const str = key as string;
  if (str.startsWith('agent:')) {
    const parts = str.split(':');
    return parts.length >= 4 ? 'agent' : 'malformed';
  }
  // config의 deriveSessionKey가 생성한 키 (scope:id 형식)
  if (str.includes(':')) return 'legacy';
  return 'malformed';
}

/**
 * 세션 키에서 구성 요소 추출 (agent-scoped 키 전용)
 */
export function parseRoutingSessionKey(key: SessionKey):
  | {
      agentId: string;
      channelId: string;
      chatType: string;
      chatId?: string;
      threadId?: string;
    }
  | undefined {
  if (classifySessionKey(key) !== 'agent') return undefined;
  const parts = (key as string).split(':');
  // agent:{agentId}:{channelId}:{chatType}[:chatId[:threadId]]
  return {
    agentId: parts[1],
    channelId: parts[2],
    chatType: parts[3],
    chatId: parts[4],
    threadId: parts[5],
  };
}

function normalizeChannelId(id: string): string {
  return id.toLowerCase().trim();
}

function normalizeChatId(id: string): string {
  return id.replace(/@[a-z.]+$/, '').trim();
}
```

### 4-2. `packages/server/src/process/binding-matcher.ts` (신규)

```typescript
// packages/server/src/process/binding-matcher.ts
import type { FinClawConfig } from '@finclaw/types';
import type { InboundMessage, AgentId, ChannelId } from '@finclaw/types';

/**
 * 4계층 매칭 우선순위 (OpenClaw 8계층에서 축소)
 *
 * 1. peer    — senderId 지정 (특정 사용자 → 특정 에이전트)
 * 2. channel — channelId 지정 (특정 채널 → 특정 에이전트)
 * 3. account — accountId 지정 (계정 단위)
 * 4. default — 글로벌 기본 에이전트
 */
export type MatchTier = 'peer' | 'channel' | 'account' | 'default';

export interface BindingRule {
  agentId: AgentId;
  channelId?: ChannelId;
  /** 특정 발신자 바인딩 */
  senderId?: string;
  /** 계정 단위 바인딩 */
  accountId?: string;
  chatType?: 'direct' | 'group' | 'channel';
  priority: number; // 높을수록 우선
}

export interface BindingMatch {
  agentId: AgentId;
  rule: BindingRule;
  matchTier: MatchTier;
}

/**
 * 인바운드 메시지에 대한 에이전트 바인딩 매칭 (4계층)
 *
 * 우선순위: peer > channel > account > default
 */
export function matchBinding(
  msg: InboundMessage,
  rules: BindingRule[],
  defaultAgentId: AgentId,
): BindingMatch {
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);

  for (const rule of sorted) {
    // chatType 필터 (있으면 적용)
    if (rule.chatType && rule.chatType !== msg.chatType) continue;

    // 1. peer 바인딩 (senderId 일치)
    if (rule.senderId) {
      if (rule.senderId === msg.senderId) {
        return { agentId: rule.agentId, rule, matchTier: 'peer' };
      }
      continue;
    }

    // 2. channel 바인딩 (channelId 일치)
    if (rule.channelId) {
      if (rule.channelId === msg.channelId) {
        return { agentId: rule.agentId, rule, matchTier: 'channel' };
      }
      continue;
    }

    // 3. account 바인딩
    if (rule.accountId) {
      return { agentId: rule.agentId, rule, matchTier: 'account' };
    }
  }

  // 4. default
  return {
    agentId: defaultAgentId,
    rule: { agentId: defaultAgentId, priority: 0 },
    matchTier: 'default',
  };
}

/**
 * 설정에서 바인딩 규칙 추출
 */
export function extractBindingRules(config: FinClawConfig): BindingRule[] {
  const rules: BindingRule[] = [];

  const entries = config.agents?.entries ?? {};
  for (const [agentId, entry] of Object.entries(entries)) {
    if (entry.agentDir) {
      rules.push({
        agentId: agentId as AgentId,
        priority: 10,
      });
    }
  }

  return rules;
}
```

### 4-3. `packages/server/test/process/session-key.test.ts` (신규)

```typescript
import { describe, it, expect } from 'vitest';
import type { ChannelId, AgentId } from '@finclaw/types';
import {
  deriveRoutingSessionKey,
  deriveGlobalSessionKey,
  classifySessionKey,
  parseRoutingSessionKey,
} from '../../src/process/session-key.js';
import { createSessionKey, createChannelId } from '@finclaw/types';

describe('deriveRoutingSessionKey', () => {
  it('DM 세션 키 형식: agent:{agentId}:{channelId}:direct', () => {
    const key = deriveRoutingSessionKey({
      channelId: createChannelId('discord'),
      accountId: 'user1',
      chatType: 'direct',
    });
    expect(key as string).toBe('agent:main:discord:direct');
  });

  it('그룹 세션 키에 chatId 포함', () => {
    const key = deriveRoutingSessionKey({
      channelId: createChannelId('discord'),
      accountId: 'user1',
      chatType: 'group',
      chatId: 'channel456',
    });
    expect(key as string).toBe('agent:main:discord:group:channel456');
  });

  it('스레드 세션 키에 threadId 포함', () => {
    const key = deriveRoutingSessionKey({
      channelId: createChannelId('discord'),
      accountId: 'user1',
      chatType: 'group',
      chatId: 'channel456',
      threadId: 'thread789',
    });
    expect(key as string).toBe('agent:main:discord:group:channel456:thread789');
  });

  it('커스텀 agentId 사용', () => {
    const key = deriveRoutingSessionKey({
      channelId: createChannelId('discord'),
      accountId: 'user1',
      chatType: 'direct',
      agentId: 'finance' as AgentId,
    });
    expect(key as string).toBe('agent:finance:discord:direct');
  });

  it('동일 입력 → 동일 출력 (결정성)', () => {
    const params = {
      channelId: createChannelId('discord'),
      accountId: 'user1',
      chatType: 'direct' as const,
    };
    const key1 = deriveRoutingSessionKey(params);
    const key2 = deriveRoutingSessionKey(params);
    expect(key1).toBe(key2);
  });

  it('channelId 대소문자 무시 (normalizeChannelId)', () => {
    const key1 = deriveRoutingSessionKey({
      channelId: createChannelId('Discord'),
      accountId: 'user1',
      chatType: 'direct',
    });
    const key2 = deriveRoutingSessionKey({
      channelId: createChannelId('discord'),
      accountId: 'user1',
      chatType: 'direct',
    });
    expect(key1).toBe(key2);
  });
});

describe('deriveGlobalSessionKey', () => {
  it('글로벌 키 형식: agent:{agentId}:global', () => {
    const key = deriveGlobalSessionKey('main');
    expect(key as string).toBe('agent:main:global');
  });
});

describe('classifySessionKey', () => {
  it('agent-scoped 키 분류', () => {
    expect(classifySessionKey(createSessionKey('agent:main:discord:direct'))).toBe('agent');
  });

  it('agent: 접두사이나 parts < 4이면 malformed', () => {
    expect(classifySessionKey(createSessionKey('agent:main'))).toBe('malformed');
  });

  it('config 스타일 키는 legacy', () => {
    expect(classifySessionKey(createSessionKey('channel:discord_123'))).toBe('legacy');
  });

  it('콜론 없는 키는 malformed', () => {
    expect(classifySessionKey(createSessionKey('nocolon'))).toBe('malformed');
  });
});

describe('parseRoutingSessionKey', () => {
  it('agent-scoped 키 파싱', () => {
    const parsed = parseRoutingSessionKey(createSessionKey('agent:main:discord:group:ch1:t1'));
    expect(parsed).toEqual({
      agentId: 'main',
      channelId: 'discord',
      chatType: 'group',
      chatId: 'ch1',
      threadId: 't1',
    });
  });

  it('non-agent 키는 undefined 반환', () => {
    expect(parseRoutingSessionKey(createSessionKey('channel:foo'))).toBeUndefined();
  });
});
```

### 4-4. `packages/server/test/process/binding-matcher.test.ts` (신규)

```typescript
import { describe, it, expect } from 'vitest';
import type { AgentId, ChannelId } from '@finclaw/types';
import type { InboundMessage } from '@finclaw/types';
import { createChannelId, createTimestamp } from '@finclaw/types';
import {
  matchBinding,
  extractBindingRules,
  type BindingRule,
} from '../../src/process/binding-matcher.js';

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'msg-1',
    channelId: createChannelId('discord'),
    chatType: 'direct',
    senderId: 'user1',
    body: 'hello',
    timestamp: createTimestamp(Date.now()),
    ...overrides,
  };
}

const defaultAgent = 'default' as AgentId;

describe('matchBinding', () => {
  it('peer 바인딩이 최우선', () => {
    const rules: BindingRule[] = [
      { agentId: 'agent-channel' as AgentId, channelId: createChannelId('discord'), priority: 10 },
      { agentId: 'agent-peer' as AgentId, senderId: 'user1', priority: 20 },
    ];
    const match = matchBinding(makeMsg(), rules, defaultAgent);
    expect(match.matchTier).toBe('peer');
    expect(match.agentId).toBe('agent-peer');
  });

  it('channel 바인딩 매칭', () => {
    const rules: BindingRule[] = [
      { agentId: 'agent-ch' as AgentId, channelId: createChannelId('discord'), priority: 10 },
    ];
    const match = matchBinding(makeMsg(), rules, defaultAgent);
    expect(match.matchTier).toBe('channel');
  });

  it('account 바인딩 매칭', () => {
    const rules: BindingRule[] = [
      { agentId: 'agent-acc' as AgentId, accountId: 'acc1', priority: 10 },
    ];
    const match = matchBinding(makeMsg(), rules, defaultAgent);
    expect(match.matchTier).toBe('account');
  });

  it('매칭 규칙 없으면 default', () => {
    const match = matchBinding(makeMsg(), [], defaultAgent);
    expect(match.matchTier).toBe('default');
    expect(match.agentId).toBe(defaultAgent);
  });

  it('chatType 필터가 적용됨', () => {
    const rules: BindingRule[] = [
      {
        agentId: 'agent-group' as AgentId,
        channelId: createChannelId('discord'),
        chatType: 'group',
        priority: 10,
      },
    ];
    // direct 메시지 → chatType=group 규칙은 건너뜀 → default
    const match = matchBinding(makeMsg({ chatType: 'direct' }), rules, defaultAgent);
    expect(match.matchTier).toBe('default');
  });

  it('priority가 높은 규칙이 우선', () => {
    const rules: BindingRule[] = [
      { agentId: 'low' as AgentId, channelId: createChannelId('discord'), priority: 1 },
      { agentId: 'high' as AgentId, channelId: createChannelId('discord'), priority: 100 },
    ];
    const match = matchBinding(makeMsg(), rules, defaultAgent);
    expect(match.agentId).toBe('high');
  });
});

describe('extractBindingRules', () => {
  it('agentDir가 있는 에이전트만 규칙 생성', () => {
    const rules = extractBindingRules({
      agents: {
        entries: {
          main: { agentDir: './agents/main' },
          empty: {},
        },
      },
    });
    expect(rules).toHaveLength(1);
    expect(rules[0].agentId).toBe('main');
  });

  it('agents가 없으면 빈 배열', () => {
    expect(extractBindingRules({})).toEqual([]);
  });
});
```

### 검증

```bash
pnpm test -- packages/server/test/process/session-key.test.ts
pnpm test -- packages/server/test/process/binding-matcher.test.ts
```

- [ ] `session-key.ts` 생성 완료
- [ ] `binding-matcher.ts` 생성 완료
- [ ] `session-key.test.ts` 통과
- [ ] `binding-matcher.test.ts` 통과

---

## Step 5: 메시지 큐 + 디바운스

**목표:** 세션별 메시지 큐 (QueueMode 4종), 인바운드 디바운서

> Step 2 이후 실행. Step 3/4와 병렬 가능.

### 5-1. `packages/server/src/process/message-queue.ts` (신규)

```typescript
// packages/server/src/process/message-queue.ts
import type { SessionKey, Timestamp } from '@finclaw/types';
import type { InboundMessage } from '@finclaw/types';

/**
 * 큐 모드 — OpenClaw QueueMode 대응
 *
 * Phase 4 구현: queue, followup, interrupt, collect (4종)
 * Phase 8 추가: steer, steer-backlog (2종)
 */
export type QueueMode = 'queue' | 'followup' | 'interrupt' | 'collect' | 'steer' | 'steer-backlog';

/** 큐 가득 찰 때의 드롭 정책 */
export type QueueDropPolicy = 'old' | 'new';

export interface QueueEntry {
  id: string;
  message: InboundMessage;
  sessionKey: SessionKey;
  enqueuedAt: Timestamp;
  priority: number;
}

export interface MessageQueueConfig {
  mode?: QueueMode;
  maxSize?: number; // 기본: 50
  collectWindowMs?: number; // collect 모드 시간 윈도우 (ms, 기본: 2000)
  dropPolicy?: QueueDropPolicy; // 기본: 'old'
}

const DEFAULT_MAX_SIZE = 50;

/**
 * 세션별 메시지 큐
 *
 * - 세션별 독립 큐
 * - QueueMode에 따른 처리 전략 (4종)
 * - drain 시 순차적 소비
 * - 처리 중 상태 추적
 */
export class MessageQueue {
  private queues = new Map<string, QueueEntry[]>();
  private processing = new Set<string>();
  private lastActivity = new Map<string, number>();
  private collectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private config: Required<MessageQueueConfig>;

  constructor(config: MessageQueueConfig = {}) {
    this.config = {
      mode: config.mode ?? 'queue',
      maxSize: config.maxSize ?? DEFAULT_MAX_SIZE,
      collectWindowMs: config.collectWindowMs ?? 2000,
      dropPolicy: config.dropPolicy ?? 'old',
    };
  }

  /**
   * 메시지를 큐에 삽입
   * @returns true: 즉시 처리 가능, false: 큐에 대기, 'interrupt': 진행 중 취소 필요
   */
  enqueue(entry: QueueEntry): boolean | 'interrupt' {
    const key = entry.sessionKey as string;
    let queue = this.queues.get(key);

    if (!queue) {
      queue = [];
      this.queues.set(key, queue);
    }

    this.lastActivity.set(key, Date.now());

    // MAX 크기 제한
    if (queue.length >= this.config.maxSize) {
      if (this.config.dropPolicy === 'old') {
        queue.shift(); // 가장 오래된 것 제거
      } else {
        return false; // 새 메시지 드롭
      }
    }

    queue.push(entry);

    // 우선순위 정렬 (높은 것 먼저)
    queue.sort((a, b) => b.priority - a.priority);

    // collect 모드: 시간 윈도우 내 메시지를 모아서 처리
    if (this.config.mode === 'collect') {
      // 기존 타이머를 리셋하여 윈도우 연장
      clearTimeout(this.collectTimers.get(key));
      this.collectTimers.set(
        key,
        setTimeout(() => {
          this.collectTimers.delete(key);
          // 윈도우 종료 시 onCollectReady 콜백이 있으면 호출
          // (MessageRouter에서 폴링 또는 이벤트로 처리)
        }, this.config.collectWindowMs),
      );
      return false; // collect 모드에서는 즉시 처리하지 않음
    }

    // interrupt 모드: 처리 중이면 취소 시그널 반환
    if (this.config.mode === 'interrupt' && this.processing.has(key)) {
      return 'interrupt';
    }

    // 현재 처리 중이 아니면 즉시 처리 가능
    return !this.processing.has(key);
  }

  /** 다음 처리할 메시지를 꺼냄 */
  dequeue(sessionKey: SessionKey): QueueEntry | undefined {
    const key = sessionKey as string;
    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) return undefined;
    return queue.shift();
  }

  /**
   * collect 모드: 큐의 모든 메시지를 한 번에 꺼냄
   * (시간 윈도우 종료 후 호출)
   */
  dequeueAll(sessionKey: SessionKey): QueueEntry[] {
    const key = sessionKey as string;
    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) return [];
    const all = [...queue];
    queue.length = 0;
    return all;
  }

  /**
   * followup 모드: 현재 처리 완료 후 후속 메시지가 있으면 꺼냄
   */
  dequeueFollowup(sessionKey: SessionKey): QueueEntry | undefined {
    if (this.config.mode !== 'followup') return undefined;
    return this.dequeue(sessionKey);
  }

  /** collect 모드의 윈도우 타이머가 만료되었는지 확인 */
  isCollectReady(sessionKey: SessionKey): boolean {
    const key = sessionKey as string;
    return (
      this.config.mode === 'collect' &&
      !this.collectTimers.has(key) &&
      this.pendingCount(sessionKey) > 0
    );
  }

  markProcessing(sessionKey: SessionKey): void {
    this.processing.add(sessionKey as string);
  }

  markDone(sessionKey: SessionKey): boolean {
    const key = sessionKey as string;
    this.processing.delete(key);
    this.lastActivity.set(key, Date.now());
    const queue = this.queues.get(key);
    return (queue?.length ?? 0) > 0;
  }

  isProcessing(sessionKey: SessionKey): boolean {
    return this.processing.has(sessionKey as string);
  }

  pendingCount(sessionKey: SessionKey): number {
    return this.queues.get(sessionKey as string)?.length ?? 0;
  }

  clear(sessionKey: SessionKey): void {
    const key = sessionKey as string;
    this.queues.delete(key);
    this.processing.delete(key);
    this.lastActivity.delete(key);
    clearTimeout(this.collectTimers.get(key));
    this.collectTimers.delete(key);
  }

  /**
   * 비활성 세션 정리 — thresholdMs 이상 활동 없는 세션 큐 제거
   * @returns 정리된 세션 수
   */
  purgeIdle(thresholdMs: number): number {
    const now = Date.now();
    let purged = 0;

    for (const [key, lastTime] of this.lastActivity) {
      if (now - lastTime > thresholdMs && !this.processing.has(key)) {
        this.queues.delete(key);
        this.lastActivity.delete(key);
        clearTimeout(this.collectTimers.get(key));
        this.collectTimers.delete(key);
        purged++;
      }
    }

    return purged;
  }

  stats(): { totalQueued: number; totalProcessing: number; sessionCount: number } {
    let totalQueued = 0;
    for (const queue of this.queues.values()) {
      totalQueued += queue.length;
    }
    return {
      totalQueued,
      totalProcessing: this.processing.size,
      sessionCount: this.queues.size,
    };
  }
}
```

### 5-2. `packages/server/src/process/debounce.ts` (신규)

```typescript
// packages/server/src/process/debounce.ts

export interface DebounceConfig {
  /** 디바운스 윈도우 (ms, 기본: 1000) */
  windowMs?: number;
  /** 최대 대기 시간 (ms, 기본: 5000) */
  maxWaitMs?: number;
}

/**
 * 인바운드 메시지 디바운서
 *
 * - 키별 독립 타이머
 * - 윈도우 내 마지막 메시지만 처리
 * - maxWait로 무한 지연 방지
 */
export function createDebouncer<T>(
  handler: (key: string, value: T) => Promise<void>,
  config: DebounceConfig = {},
): {
  push(key: string, value: T): void;
  flush(key: string): void;
  destroy(): void;
} {
  const windowMs = config.windowMs ?? 1000;
  const maxWaitMs = config.maxWaitMs ?? 5000;

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const maxTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<string, T>();

  function fire(key: string): void {
    const value = pending.get(key);
    if (value === undefined) return;

    pending.delete(key);
    clearTimeout(timers.get(key));
    clearTimeout(maxTimers.get(key));
    timers.delete(key);
    maxTimers.delete(key);

    void handler(key, value);
  }

  return {
    push(key, value) {
      pending.set(key, value);

      // 윈도우 타이머 리셋
      clearTimeout(timers.get(key));
      timers.set(
        key,
        setTimeout(() => fire(key), windowMs),
      );

      // maxWait 타이머 (최초 1회만)
      if (!maxTimers.has(key)) {
        maxTimers.set(
          key,
          setTimeout(() => fire(key), maxWaitMs),
        );
      }
    },
    flush(key) {
      fire(key);
    },
    destroy() {
      for (const timer of timers.values()) clearTimeout(timer);
      for (const timer of maxTimers.values()) clearTimeout(timer);
      timers.clear();
      maxTimers.clear();
      pending.clear();
    },
  };
}
```

### 5-3. `packages/server/test/process/message-queue.test.ts` (신규)

```typescript
import { describe, it, expect } from 'vitest';
import { createSessionKey, createChannelId, createTimestamp } from '@finclaw/types';
import type { InboundMessage, SessionKey } from '@finclaw/types';
import { MessageQueue, type QueueEntry } from '../../src/process/message-queue.js';

const sk = createSessionKey('agent:main:discord:direct');

function makeEntry(id: string, priority = 0): QueueEntry {
  return {
    id,
    message: {
      id,
      channelId: createChannelId('discord'),
      chatType: 'direct',
      senderId: 'user1',
      body: `msg-${id}`,
      timestamp: createTimestamp(Date.now()),
    },
    sessionKey: sk,
    enqueuedAt: createTimestamp(Date.now()),
    priority,
  };
}

describe('MessageQueue — queue 모드 (기본)', () => {
  it('빈 큐에 enqueue → 즉시 처리 가능 (true)', () => {
    const mq = new MessageQueue();
    expect(mq.enqueue(makeEntry('1'))).toBe(true);
  });

  it('처리 중이면 enqueue → 대기 (false)', () => {
    const mq = new MessageQueue();
    mq.enqueue(makeEntry('1'));
    mq.dequeue(sk);
    mq.markProcessing(sk);
    expect(mq.enqueue(makeEntry('2'))).toBe(false);
  });

  it('dequeue 순서: 우선순위 높은 것 먼저', () => {
    const mq = new MessageQueue();
    mq.enqueue(makeEntry('low', 0));
    mq.enqueue(makeEntry('high', 10));
    const entry = mq.dequeue(sk);
    expect(entry?.id).toBe('high');
  });

  it('markDone 후 대기 메시지 있으면 true', () => {
    const mq = new MessageQueue();
    mq.enqueue(makeEntry('1'));
    mq.enqueue(makeEntry('2'));
    mq.dequeue(sk);
    mq.markProcessing(sk);
    expect(mq.markDone(sk)).toBe(true);
  });

  it('purgeIdle이 비활성 세션 정리', () => {
    const mq = new MessageQueue();
    mq.enqueue(makeEntry('1'));
    mq.dequeue(sk);
    mq.markProcessing(sk);
    mq.markDone(sk);
    // lastActivity를 과거로 설정할 수 없으므로 thresholdMs=0으로 즉시 정리
    const purged = mq.purgeIdle(0);
    expect(purged).toBe(1);
  });
});

describe('MessageQueue — interrupt 모드', () => {
  it('처리 중일 때 enqueue → "interrupt" 반환', () => {
    const mq = new MessageQueue({ mode: 'interrupt' });
    mq.enqueue(makeEntry('1'));
    mq.dequeue(sk);
    mq.markProcessing(sk);
    expect(mq.enqueue(makeEntry('2'))).toBe('interrupt');
  });
});

describe('MessageQueue — followup 모드', () => {
  it('dequeueFollowup이 followup 모드에서만 동작', () => {
    const mq = new MessageQueue({ mode: 'followup' });
    mq.enqueue(makeEntry('1'));
    mq.enqueue(makeEntry('2'));
    mq.dequeue(sk);
    mq.markProcessing(sk);
    // 처리 완료 후 followup
    const followup = mq.dequeueFollowup(sk);
    expect(followup?.id).toBe('2');
  });

  it('queue 모드에서 dequeueFollowup은 undefined', () => {
    const mq = new MessageQueue({ mode: 'queue' });
    mq.enqueue(makeEntry('1'));
    mq.enqueue(makeEntry('2'));
    mq.dequeue(sk);
    expect(mq.dequeueFollowup(sk)).toBeUndefined();
  });
});

describe('MessageQueue — collect 모드', () => {
  it('collect 모드에서 enqueue는 항상 false (윈도우 대기)', () => {
    const mq = new MessageQueue({ mode: 'collect', collectWindowMs: 100 });
    expect(mq.enqueue(makeEntry('1'))).toBe(false);
    expect(mq.enqueue(makeEntry('2'))).toBe(false);
    expect(mq.pendingCount(sk)).toBe(2);
  });

  it('dequeueAll이 모든 메시지를 한 번에 반환', () => {
    const mq = new MessageQueue({ mode: 'collect' });
    mq.enqueue(makeEntry('1'));
    mq.enqueue(makeEntry('2'));
    mq.enqueue(makeEntry('3'));
    const all = mq.dequeueAll(sk);
    expect(all).toHaveLength(3);
    expect(mq.pendingCount(sk)).toBe(0);
  });
});

describe('MessageQueue — DropPolicy', () => {
  it('dropPolicy=old: maxSize 초과 시 가장 오래된 것 제거', () => {
    const mq = new MessageQueue({ maxSize: 2, dropPolicy: 'old' });
    mq.enqueue(makeEntry('1'));
    mq.enqueue(makeEntry('2'));
    mq.enqueue(makeEntry('3')); // '1' 제거
    expect(mq.pendingCount(sk)).toBe(2);
    const first = mq.dequeue(sk);
    expect(first?.id).toBe('2');
  });

  it('dropPolicy=new: maxSize 초과 시 새 메시지 드롭 (false)', () => {
    const mq = new MessageQueue({ maxSize: 2, dropPolicy: 'new' });
    mq.enqueue(makeEntry('1'));
    mq.enqueue(makeEntry('2'));
    expect(mq.enqueue(makeEntry('3'))).toBe(false);
    expect(mq.pendingCount(sk)).toBe(2);
  });
});

describe('MessageQueue — stats & clear', () => {
  it('stats가 올바른 집계 반환', () => {
    const mq = new MessageQueue();
    mq.enqueue(makeEntry('1'));
    mq.enqueue(makeEntry('2'));
    mq.dequeue(sk);
    mq.markProcessing(sk);
    const s = mq.stats();
    expect(s.totalQueued).toBe(1);
    expect(s.totalProcessing).toBe(1);
  });

  it('clear가 세션 큐 완전 정리', () => {
    const mq = new MessageQueue();
    mq.enqueue(makeEntry('1'));
    mq.markProcessing(sk);
    mq.clear(sk);
    expect(mq.pendingCount(sk)).toBe(0);
    expect(mq.isProcessing(sk)).toBe(false);
  });
});
```

### 검증

```bash
pnpm test -- packages/server/test/process/message-queue.test.ts
```

- [ ] `message-queue.ts` 생성 완료 (collect 윈도우 로직 포함)
- [ ] `debounce.ts` 생성 완료
- [ ] `message-queue.test.ts` 통과

---

## Step 6: 메시지 라우터

**목표:** 인바운드 메시지의 전체 라우팅 오케스트레이션

> Step 3, 4, 5 모두 완료 필요.

### 6-1. `packages/server/src/process/message-router.ts` (신규)

```typescript
// packages/server/src/process/message-router.ts
import type { InboundMessage, MsgContext, SessionKey, AgentId } from '@finclaw/types';
import type { FinClawConfig } from '@finclaw/types';
import { createTimestamp } from '@finclaw/types';
import {
  Dedupe,
  getEventBus,
  runWithContext,
  type FinClawLogger,
  ConcurrencyLaneManager,
  type LaneId,
} from '@finclaw/infra';
import { deriveRoutingSessionKey } from './session-key.js';
import { matchBinding, extractBindingRules, type BindingMatch } from './binding-matcher.js';
import { MessageQueue, type QueueEntry } from './message-queue.js';

export interface MessageRouterDeps {
  config: FinClawConfig;
  logger: FinClawLogger;
  /** 메시지 처리 콜백 — AbortSignal로 interrupt 모드 지원 */
  onProcess: (ctx: MsgContext, match: BindingMatch, signal: AbortSignal) => Promise<void>;
}

/**
 * 메시지 라우팅 오케스트레이터
 *
 * 흐름:
 * 1.   세션 키 도출 (deriveRoutingSessionKey)
 * 1.5  Dedupe 중복 체크 (5초 TTL)
 * 2.   바인딩 매칭 (matchBinding — 4계층)
 * 3.   메시지 큐 삽입/즉시 처리 결정
 * 4.   동시성 레인 acquire (ConcurrencyLaneManager)
 * 5.   MsgContext 생성 (buildMsgContext)
 * 5.5  AbortController 생성 → activeControllers Map
 * 6.   EventBus 이벤트 발행 ('channel:message')
 * 6.5  runWithContext() ALS 래핑
 * 7.   처리 콜백 호출 (onProcess)
 */
export class MessageRouter {
  private readonly queue: MessageQueue;
  private readonly laneManager: ConcurrencyLaneManager;
  private readonly dedupe: Dedupe<boolean>;
  /** interrupt 모드: 세션별 활성 AbortController */
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly deps: MessageRouterDeps;
  private entryCounter = 0;

  constructor(deps: MessageRouterDeps) {
    this.deps = deps;
    this.queue = new MessageQueue({ mode: 'queue', maxSize: 50 });
    this.laneManager = new ConcurrencyLaneManager();
    this.dedupe = new Dedupe({ ttlMs: 5000 });
  }

  async route(msg: InboundMessage): Promise<void> {
    const { logger, config } = this.deps;

    // 1. 세션 키 도출
    const sessionKey = deriveRoutingSessionKey({
      channelId: msg.channelId,
      accountId: msg.senderId,
      chatType: msg.chatType,
      chatId: msg.threadId,
    });

    // 1.5 Dedupe 중복 체크
    if (this.dedupe.check(msg.id)) {
      logger.debug(`Duplicate message filtered: ${msg.id}`);
      return;
    }

    // 2. 바인딩 매칭
    const rules = extractBindingRules(config);
    const defaultAgentId = getDefaultAgentId(config);
    const match = matchBinding(msg, rules, defaultAgentId);

    logger.debug(
      `Routing message to agent ${match.agentId as string} ` +
        `(match: ${match.matchTier}, session: ${sessionKey as string})`,
    );

    // 6. EventBus 이벤트 발행
    getEventBus().emit('channel:message', msg.channelId as string, msg.id);

    // 3. 큐에 삽입
    const entry: QueueEntry = {
      id: `msg-${++this.entryCounter}`,
      message: msg,
      sessionKey,
      enqueuedAt: createTimestamp(Date.now()),
      priority: 0,
    };

    const enqueueResult = this.queue.enqueue(entry);

    // interrupt 모드: 기존 처리 취소
    if (enqueueResult === 'interrupt') {
      const key = sessionKey as string;
      const existing = this.activeControllers.get(key);
      if (existing) {
        existing.abort();
        this.activeControllers.delete(key);
      }
    }

    if (enqueueResult === true || enqueueResult === 'interrupt') {
      await this.processNext(sessionKey, match);
    }
  }

  private async processNext(sessionKey: SessionKey, match: BindingMatch): Promise<void> {
    const entry = this.queue.dequeue(sessionKey);
    if (!entry) return;

    this.queue.markProcessing(sessionKey);
    const key = sessionKey as string;

    // 4. 동시성 레인 획득
    const laneId: LaneId = 'main';
    const handle = await this.laneManager.acquire(laneId, key);

    // 5.5 AbortController 생성
    const controller = new AbortController();
    this.activeControllers.set(key, controller);

    try {
      // 5. MsgContext 생성
      const ctx = buildMsgContext(entry.message, sessionKey, match);

      // 6.5 runWithContext() ALS 래핑 ── 교정: startedAt (plan.md의 startTime → startedAt)
      await runWithContext({ requestId: entry.id, startedAt: Date.now() }, async () => {
        // 7. 처리 콜백 호출
        await this.deps.onProcess(ctx, match, controller.signal);
      });
    } catch (err) {
      this.deps.logger.error(`Message processing failed: ${String(err)}`);
    } finally {
      this.activeControllers.delete(key);
      handle.release();
      const hasMore = this.queue.markDone(sessionKey);
      if (hasMore) {
        void this.processNext(sessionKey, match);
      }
    }
  }

  /** 리소스 정리 */
  dispose(): void {
    for (const controller of this.activeControllers.values()) {
      controller.abort();
    }
    this.activeControllers.clear();
    this.laneManager.dispose();
    this.dedupe.clear();
  }
}

function buildMsgContext(
  msg: InboundMessage,
  sessionKey: SessionKey,
  _match: BindingMatch,
): MsgContext {
  return {
    body: msg.body,
    bodyForAgent: msg.body,
    rawBody: msg.rawBody ?? msg.body,
    from: msg.senderId,
    senderId: msg.senderId,
    senderName: msg.senderName ?? msg.senderId,
    provider: msg.channelId as string,
    channelId: msg.channelId,
    chatType: msg.chatType,
    sessionKey,
    accountId: msg.senderId,
    media: msg.media,
    timestamp: msg.timestamp,
  };
}

function getDefaultAgentId(config: FinClawConfig): AgentId {
  const entries = config.agents?.entries ?? {};
  const firstAgent = Object.keys(entries)[0];
  return (firstAgent ?? 'default') as AgentId;
}
```

### 6-2. `packages/server/test/process/message-router.test.ts` (신규)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InboundMessage, MsgContext } from '@finclaw/types';
import type { FinClawConfig } from '@finclaw/types';
import { createChannelId, createTimestamp } from '@finclaw/types';
import { resetEventBus, getEventBus, type FinClawLogger } from '@finclaw/infra';
import { MessageRouter, type MessageRouterDeps } from '../../src/process/message-router.js';
import type { BindingMatch } from '../../src/process/binding-matcher.js';

function makeLogger(): FinClawLogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    flush: vi.fn().mockResolvedValue(undefined),
  } as unknown as FinClawLogger;
}

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: `msg-${Date.now()}-${Math.random()}`,
    channelId: createChannelId('discord'),
    chatType: 'direct',
    senderId: 'user1',
    body: 'hello',
    timestamp: createTimestamp(Date.now()),
    ...overrides,
  };
}

const config: FinClawConfig = {
  agents: { entries: { main: { agentDir: './agents/main' } } },
};

describe('MessageRouter', () => {
  beforeEach(() => {
    resetEventBus();
  });

  it('메시지를 라우팅하고 onProcess 호출', async () => {
    const onProcess = vi.fn().mockResolvedValue(undefined);
    const router = new MessageRouter({
      config,
      logger: makeLogger(),
      onProcess,
    });

    await router.route(makeMsg());
    expect(onProcess).toHaveBeenCalledTimes(1);

    const [ctx, match, signal] = onProcess.mock.calls[0];
    expect(ctx.body).toBe('hello');
    expect(match.matchTier).toBe('channel'); // main agent has agentDir → priority 10
    expect(signal).toBeInstanceOf(AbortSignal);

    router.dispose();
  });

  it('동일 id 중복 메시지 필터링 (Dedupe)', async () => {
    const onProcess = vi.fn().mockResolvedValue(undefined);
    const router = new MessageRouter({
      config,
      logger: makeLogger(),
      onProcess,
    });

    const msg = makeMsg({ id: 'dup-1' });
    await router.route(msg);
    await router.route(msg); // 중복

    expect(onProcess).toHaveBeenCalledTimes(1);
    router.dispose();
  });

  it('EventBus에 channel:message 이벤트 발행', async () => {
    const onProcess = vi.fn().mockResolvedValue(undefined);
    const router = new MessageRouter({
      config,
      logger: makeLogger(),
      onProcess,
    });

    const handler = vi.fn();
    getEventBus().on('channel:message', handler);

    await router.route(makeMsg());
    expect(handler).toHaveBeenCalledTimes(1);

    router.dispose();
  });

  it('dispose 시 활성 AbortController abort', async () => {
    let capturedSignal: AbortSignal | undefined;
    const onProcess = vi
      .fn()
      .mockImplementation(async (_ctx: MsgContext, _match: BindingMatch, signal: AbortSignal) => {
        capturedSignal = signal;
        // 처리 중 지연
        await new Promise((r) => setTimeout(r, 100));
      });
    const router = new MessageRouter({
      config,
      logger: makeLogger(),
      onProcess,
    });

    const routePromise = router.route(makeMsg());
    // 즉시 dispose → abort
    await new Promise((r) => setTimeout(r, 10));
    router.dispose();

    await routePromise;
    expect(capturedSignal?.aborted).toBe(true);
  });
});
```

### 검증

```bash
pnpm test -- packages/server/test/process/message-router.test.ts
```

- [ ] `message-router.ts` 생성 완료 (`startedAt` 교정 반영)
- [ ] `message-router.test.ts` 통과
- [ ] Dedupe 중복 필터링 검증
- [ ] AbortController 전파 검증
- [ ] EventBus channel:message 발행 검증

---

## Step 7: 통합 테스트 + 최종 검증

**목표:** 전체 흐름 통합 테스트, barrel export 검증, 타입 체크 + 린트

### 7-1. `packages/server/test/process/integration.test.ts` (신규)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InboundMessage, MsgContext } from '@finclaw/types';
import type { FinClawConfig } from '@finclaw/types';
import { createChannelId, createTimestamp } from '@finclaw/types';
import { resetEventBus, type FinClawLogger } from '@finclaw/infra';
import { MessageRouter } from '../../src/process/message-router.js';
import type { BindingMatch } from '../../src/process/binding-matcher.js';
import { deriveRoutingSessionKey } from '../../src/process/session-key.js';

function makeLogger(): FinClawLogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    flush: vi.fn().mockResolvedValue(undefined),
  } as unknown as FinClawLogger;
}

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: `msg-${Date.now()}-${Math.random()}`,
    channelId: createChannelId('discord'),
    chatType: 'direct',
    senderId: 'user1',
    body: 'test',
    timestamp: createTimestamp(Date.now()),
    ...overrides,
  };
}

const config: FinClawConfig = {
  agents: { entries: { main: { agentDir: './agents/main' } } },
};

describe('Integration: route → dedupe → queue → lane → process → abort', () => {
  beforeEach(() => {
    resetEventBus();
  });

  it('전체 라우팅 흐름 (정상)', async () => {
    const processLog: string[] = [];
    const onProcess = vi.fn().mockImplementation(async (ctx: MsgContext) => {
      processLog.push(ctx.body);
    });

    const router = new MessageRouter({ config, logger: makeLogger(), onProcess });

    await router.route(makeMsg({ body: 'first' }));
    await router.route(makeMsg({ body: 'second' }));

    expect(processLog).toEqual(['first', 'second']);
    router.dispose();
  });

  it('중복 메시지는 dedupe로 필터링', async () => {
    const onProcess = vi.fn().mockResolvedValue(undefined);
    const router = new MessageRouter({ config, logger: makeLogger(), onProcess });

    const msg = makeMsg({ id: 'same-id' });
    await router.route(msg);
    await router.route(msg);

    expect(onProcess).toHaveBeenCalledTimes(1);
    router.dispose();
  });

  it('AbortSignal이 onProcess에 전달됨', async () => {
    let signal: AbortSignal | undefined;
    const onProcess = vi
      .fn()
      .mockImplementation(async (_ctx: MsgContext, _match: BindingMatch, s: AbortSignal) => {
        signal = s;
      });

    const router = new MessageRouter({ config, logger: makeLogger(), onProcess });
    await router.route(makeMsg());

    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    router.dispose();
  });

  it('세션 키 결정성 — 동일 입력은 동일 세션에 라우팅', () => {
    const params = {
      channelId: createChannelId('discord'),
      accountId: 'user1',
      chatType: 'direct' as const,
    };
    const k1 = deriveRoutingSessionKey(params);
    const k2 = deriveRoutingSessionKey(params);
    expect(k1).toBe(k2);
  });

  it('onProcess 에러 시 라우터가 크래시하지 않음', async () => {
    const onProcess = vi.fn().mockRejectedValue(new Error('boom'));
    const logger = makeLogger();
    const router = new MessageRouter({ config, logger, onProcess });

    // 에러 발생하지만 route()가 reject되지 않아야 함
    await expect(router.route(makeMsg())).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
    router.dispose();
  });

  it('dispose 후에는 새 route 호출 시 정상 동작 (새 인스턴스 필요)', async () => {
    const onProcess = vi.fn().mockResolvedValue(undefined);
    const router = new MessageRouter({ config, logger: makeLogger(), onProcess });

    await router.route(makeMsg());
    router.dispose();

    // dispose 후에도 route는 에러 없이 동작해야 함 (dedupe cleared)
    // 단, laneManager가 dispose되어 acquire 실패 가능 → 새 인스턴스 권장
  });
});
```

### 7-2. barrel export 최종 검증

`packages/server/src/process/index.ts`의 모든 import가 유효한지 확인:

```bash
pnpm typecheck
```

### 검증

```bash
# 전체 테스트
pnpm test -- packages/server/test/process/
pnpm test -- packages/infra/test/concurrency-lane.test.ts

# 타입 체크 + 린트
pnpm typecheck && pnpm lint

# 전체
pnpm typecheck && pnpm lint && pnpm test
```

- [ ] `integration.test.ts` 통과
- [ ] `pnpm typecheck` 통과 (all packages)
- [ ] `pnpm lint` 통과
- [ ] `pnpm test` 전체 통과

---

## 파일 생성 요약

### 소스 파일 (12개)

| #   | 파일                                             | Step | 작업                             |
| --- | ------------------------------------------------ | ---- | -------------------------------- |
| 1   | `packages/infra/src/concurrency-lane.ts`         | 1    | 신규                             |
| 2   | `packages/infra/src/index.ts`                    | 1    | 수정 (barrel export 추가)        |
| 3   | `packages/server/package.json`                   | 2    | 수정 (`@finclaw/infra` 추가)     |
| 4   | `packages/server/tsconfig.json`                  | 2    | 수정 (`../infra` reference 추가) |
| 5   | `packages/server/src/process/errors.ts`          | 2    | 신규                             |
| 6   | `packages/server/src/process/index.ts`           | 2    | 신규                             |
| 7   | `packages/server/src/process/spawn.ts`           | 3    | 신규                             |
| 8   | `packages/server/src/process/signal-handler.ts`  | 3    | 신규                             |
| 9   | `packages/server/src/process/lifecycle.ts`       | 3    | 신규                             |
| 10  | `packages/server/src/process/session-key.ts`     | 4    | 신규                             |
| 11  | `packages/server/src/process/binding-matcher.ts` | 4    | 신규                             |
| 12  | `packages/server/src/process/message-queue.ts`   | 5    | 신규                             |
| 13  | `packages/server/src/process/debounce.ts`        | 5    | 신규                             |
| 14  | `packages/server/src/process/message-router.ts`  | 6    | 신규                             |

### 테스트 파일 (7개)

| #   | 파일                                                   | Step |
| --- | ------------------------------------------------------ | ---- |
| 1   | `packages/infra/test/concurrency-lane.test.ts`         | 1    |
| 2   | `packages/server/test/process/spawn.test.ts`           | 3    |
| 3   | `packages/server/test/process/session-key.test.ts`     | 4    |
| 4   | `packages/server/test/process/binding-matcher.test.ts` | 4    |
| 5   | `packages/server/test/process/message-queue.test.ts`   | 5    |
| 6   | `packages/server/test/process/message-router.test.ts`  | 6    |
| 7   | `packages/server/test/process/integration.test.ts`     | 7    |

### Step 의존성 그래프

```
Step 1 (infra ConcurrencyLane)
   │
Step 2 (server 패키지 설정 + errors + barrel)
   │
   ├── Step 3 (spawn, signal-handler, lifecycle) ──┐
   ├── Step 4 (session-key, binding-matcher) ──────┤
   └── Step 5 (message-queue, debounce) ───────────┤
                                                    │
                                              Step 6 (message-router)
                                                    │
                                              Step 7 (통합 테스트 + 최종 검증)
```

Step 3, 4, 5는 **병렬 실행 가능**.
