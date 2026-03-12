# Phase 15: 지원 서비스 (훅, 크론, 보안)

> 복잡도: **L** | 소스 파일: ~12 | 테스트 파일: ~5 | 총 ~17 파일

---

## 1. 목표

FinClaw의 **이벤트 확장, 스케줄링, 보안** 인프라를 구축한다. 4계층 훅 시스템으로 이벤트 기반 확장성을 제공하고, croner 기반 크론 스케줄러로 주기적 금융 작업(시장 데이터 갱신, 알림 체크, 캐시 정리)을 자동화하며, 보안 감사 모듈로 API 키와 자격 증명의 안전한 관리를 보장한다.

**핵심 목표:**

- 훅 시스템: 4계층 우선순위 (system > plugin > channel > user)로 이벤트 기반 확장
- 훅 러너: `createHookRunner()`로 3가지 실행 모드 (parallel, sequential, sync) 지원
- 크론 스케줄러: croner 라이브러리 기반 주기적 작업 실행, `@finclaw/infra`의 ConcurrencyLane·Logger 활용
- 금융 크론 작업: 시장 데이터 갱신, 가격 알림 체크, 캐시 정리
- 보안 감사: 자격 증명 리다이렉션 (13+ regex 패턴), 환경변수 위생 검사
- 데몬 관리: systemd 서비스 파일 생성 (Linux), 환경 감지
- EventBus 브리지: `@finclaw/infra`의 EventBus ↔ HookRegistry 연동

---

## 2. OpenClaw 참조

### 참조 문서

| 문서 경로                                           | 적용할 패턴                                                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `openclaw_review/deep-dive/13-daemon-cron-hooks.md` | hooks Observer 패턴, CronService Facade, security audit/fix, Promise Chain Lock, Atomic Write, Lane Queue |

### 적용할 핵심 패턴

**1) Observer 패턴 — 훅 레지스트리 (OpenClaw internal-hooks.ts 176줄)**

- OpenClaw: `Map<eventKey, handler[]>` 레지스트리, `registerInternalHook(eventKey, handler)`, `triggerInternalHook(event)`
- FinClaw: 동일 Observer 패턴. 이벤트 키 형식 `{type}` 또는 `{type}:{action}` (예: `agent:bootstrap`, `market:update`)

**2) 4계층 훅 소스 (OpenClaw workspace.ts 272줄)**

- OpenClaw: bundled > managed > workspace > plugin 디렉토리 탐색
- FinClaw: system > plugin > channel > user 4계층. 같은 이름의 훅이 여러 계층에 존재하면 user 레벨이 최우선

**3) CronService Facade (OpenClaw service.ts 49줄)**

- OpenClaw: start/stop/status/list/add/update/remove/run/wake 메서드
- FinClaw: 동일 패턴. 금융 특화 기본 작업(market-refresh, alert-check, cleanup) 내장

**4) Promise Chain Lock (OpenClaw locked.ts 23줄)**

- OpenClaw: `storeLocks` Map + `state.op` Promise 체인으로 파일 I/O 직렬화
- FinClaw: SQLite 접근이므로 파일 락 대신 DB 트랜잭션 사용. 크론 상태 관리에만 Promise 체인 적용

**5) 보안 감사 (OpenClaw audit.ts 933줄 + external-content.ts 178줄)**

- OpenClaw: 17+ 수집기, `fixSecurityFootguns()`, 11개 의심 패턴 탐지 + 경계 래핑
- FinClaw: API 키 보안(Anthropic, OpenAI, Alpha Vantage, CoinGecko), 환경변수 위생, 로그 리다이렉션에 집중

**6) Credential Redaction (OpenClaw logging/redact.ts 132줄)**

- OpenClaw: 16개 정규식 패턴으로 API 키/토큰/Authorization 헤더/PEM 키 자동 마스킹
- FinClaw: 13+ 금융 API 키 패턴 추가 (Alpha Vantage, CoinGecko, 거래소 API 등)

### 적용하지 않는 OpenClaw 패턴

| OpenClaw 패턴                            | 미적용 사유                                           |
| ---------------------------------------- | ----------------------------------------------------- |
| Chokidar 파일 감시                       | FinClaw에 이미 존재 (별도 구현)                       |
| 미디어 파일 처리                         | FinClaw 범위 밖 (금융 데이터 전용)                    |
| 크론 상태 영속성 (DB 저장)               | 인메모리로 충분 — 재시작 시 스케줄 재등록             |
| 3-platform 데몬 (macOS launchd, Windows) | Linux systemd 단일 플랫폼만 지원                      |
| 17+ 보안 수집기                          | 3개 핵심 수집기(API 키, 파일 퍼미션, 환경변수)로 충분 |

---

## 3. 생성할 파일

### 소스 파일 (12개)

| 파일 경로                                                  | 역할                                                                | 예상 줄 수 |
| ---------------------------------------------------------- | ------------------------------------------------------------------- | ---------- |
| `packages/server/src/services/index.ts`                    | 서비스 모듈 barrel export                                           | ~15        |
| `packages/server/src/services/hooks/types.ts`              | 훅 이벤트 타입, HookHandler, HookEntry, HookSource                  | ~75        |
| `packages/server/src/services/hooks/registry.ts`           | 이벤트 레지스트리 — Map 기반 핸들러 등록/발행                       | ~100       |
| `packages/server/src/services/hooks/runner.ts`             | `createHookRunner()` — 3가지 실행 모드 (parallel, sequential, sync) | ~130       |
| `packages/server/src/services/hooks/bridge.ts`             | `@finclaw/infra` EventBus ↔ HookRegistry 브리지                     | ~30        |
| `packages/server/src/services/cron/scheduler.ts`           | CronScheduler — croner 기반 스케줄 관리, 작업 등록/실행             | ~200       |
| `packages/server/src/services/cron/jobs/market-refresh.ts` | 시장 데이터 갱신 작업 (금융 특화)                                   | ~60        |
| `packages/server/src/services/cron/jobs/alert-check.ts`    | 가격 알림 체크 작업 (금융 특화)                                     | ~90        |
| `packages/server/src/services/cron/jobs/cleanup.ts`        | 만료 캐시 정리, 오래된 대화 아카이브                                | ~50        |
| `packages/server/src/services/security/audit.ts`           | 보안 감사 오케스트레이터 — API 키 검증, 파일 퍼미션 검사            | ~180       |
| `packages/server/src/services/security/redaction.ts`       | 자격 증명 리다이렉션 — 13+ regex 패턴                               | ~100       |
| `packages/server/src/services/daemon/systemd.ts`           | systemd 서비스 파일 생성 (Linux), 환경 감지                         | ~100       |

### 테스트 파일 (5개)

| 파일 경로                                                 | 테스트 대상                           | 테스트 종류 |
| --------------------------------------------------------- | ------------------------------------- | ----------- |
| `packages/server/src/services/hooks/registry.test.ts`     | 핸들러 등록/발행, 에러 격리, 우선순위 | unit        |
| `packages/server/src/services/hooks/runner.test.ts`       | 3가지 실행 모드, 타임아웃, 취소       | unit        |
| `packages/server/src/services/cron/scheduler.test.ts`     | 스케줄 등록, 실행, 일시정지/재개      | unit        |
| `packages/server/src/services/security/redaction.test.ts` | 13+ 패턴 마스킹, false positive 방지  | unit        |
| `packages/server/src/services/security/audit.test.ts`     | 3개 수집기, 감사 리포트 집계          | unit        |

---

## 4. 핵심 인터페이스/타입

```typescript
// packages/server/src/services/hooks/types.ts — 훅 시스템 타입

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
  readonly action: string; // 세부 액션 (예: "bootstrap", "update")
  readonly timestamp: number; // Unix timestamp ms
  readonly context: Record<string, unknown>; // 이벤트별 컨텍스트 데이터
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
  readonly events: string[]; // 구독할 이벤트 키 배열
  readonly handler: HookHandler;
  readonly priority: number; // 0=최고 우선순위, 기본 100
  readonly enabled: boolean;
}

/** 훅 실행 모드 */
export type HookRunMode =
  | 'parallel' // 모든 핸들러를 동시 실행 (void 결과)
  | 'sequential' // 순차 실행 (이전 결과가 다음 입력에 영향)
  | 'sync'; // 동기적 순차 실행

// packages/server/src/services/hooks/runner.ts — 훅 러너
export interface HookRunner {
  /** 이벤트를 발행하고 등록된 핸들러를 실행한다 */
  trigger(event: HookEvent): Promise<void>;

  /** 실행 모드를 설정한다 */
  readonly mode: HookRunMode;
}

export interface HookRunnerOptions {
  readonly mode: HookRunMode;
  readonly timeoutMs?: number; // 핸들러별 타임아웃 (기본 30초)
  readonly onError?: (error: Error, handler: HookEntry) => void;
}

// packages/server/src/services/cron/scheduler.ts — 크론 스케줄러
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
  | { readonly kind: 'cron'; readonly expr: string; readonly tz?: string } // cron 표현식
  | { readonly kind: 'every'; readonly intervalMs: number } // 고정 간격
  | { readonly kind: 'at'; readonly atMs: number }; // 일회성

export interface CronSchedulerDeps {
  readonly logger: FinClawLogger;
  readonly lanes: ConcurrencyLaneManager;
}

export interface CronScheduler {
  /** 작업 등록 */
  add(job: Omit<CronJob, 'id' | 'lastRunAt' | 'lastStatus' | 'nextRunAt'>): CronJob;

  /** 작업 삭제 */
  remove(jobId: string): boolean;

  /** 작업 활성화/비활성화 */
  setEnabled(jobId: string, enabled: boolean): void;

  /** 모든 작업 조회 */
  list(): CronJob[];

  /** 스케줄러 시작 */
  start(): void;

  /** 스케줄러 정지 — 진행 중인 작업에 AbortSignal 전파 */
  stop(): void;

  /** 현재 상태 */
  readonly running: boolean;
}

// packages/server/src/services/security/audit.ts — 보안 감사
export interface SecurityAuditFinding {
  readonly checkId: string;
  readonly severity: 'info' | 'warn' | 'critical';
  readonly title: string;
  readonly detail: string;
  readonly remediation?: string; // 교정 방법 안내
}

export interface SecurityAuditReport {
  readonly findings: SecurityAuditFinding[];
  readonly summary: {
    readonly critical: number;
    readonly warn: number;
    readonly info: number;
  };
  readonly timestamp: number;
}

export interface SecurityAuditOptions {
  readonly checkApiKeys?: boolean; // API 키 유효성 검사 (기본 true)
  readonly checkFilePermissions?: boolean; // 파일 퍼미션 검사 (기본 true)
  readonly checkEnvironment?: boolean; // 환경변수 위생 (기본 true)
}

// packages/server/src/services/security/redaction.ts — 자격 증명 마스킹
export interface RedactionPattern {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string; // 예: "[REDACTED_API_KEY]"
}
```

---

## 5. 구현 상세

### 5.1 훅 레지스트리 (Observer 패턴)

```typescript
// packages/server/src/services/hooks/registry.ts
import type { HookEntry, HookEvent, HookHandler, HookSource } from './types.js';

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
   * 동일 eventKey에 여러 핸들러가 등록되면 우선순위(priority)순으로 실행된다.
   */
  register(entry: Omit<HookEntry, 'priority'> & { priority?: number }): void {
    const priority = entry.priority ?? SOURCE_PRIORITY[entry.source];
    const fullEntry: HookEntry = { ...entry, priority };

    for (const eventKey of entry.events) {
      const existing = this.handlers.get(eventKey) ?? [];
      existing.push(fullEntry);
      // 우선순위 오름차순 정렬 (0 = 최고 우선순위)
      existing.sort((a, b) => a.priority - b.priority);
      this.handlers.set(eventKey, existing);
    }
  }

  /** 특정 이벤트 키에 등록된 핸들러를 조회한다 */
  getHandlers(eventKey: string): ReadonlyArray<HookEntry> {
    return this.handlers.get(eventKey) ?? [];
  }

  /**
   * 이벤트를 발행한다.
   * type 키와 type:action 키 양쪽의 핸들러를 모두 수집한 후,
   * 우선순위순으로 실행한다.
   */
  async trigger(event: HookEvent): Promise<void> {
    const typeHandlers = this.getHandlers(event.type);
    const actionHandlers = this.getHandlers(`${event.type}:${event.action}`);

    // 병합 후 우선순위 재정렬
    const allHandlers = [...typeHandlers, ...actionHandlers]
      .filter((h) => h.enabled)
      .sort((a, b) => a.priority - b.priority);

    // 각 핸들러를 에러 격리로 실행
    for (const entry of allHandlers) {
      try {
        await entry.handler(event);
      } catch (error) {
        // 한 핸들러의 에러가 다른 핸들러를 중단시키지 않는다
        console.error(`[Hook Error] ${entry.name}: ${error}`);
      }
    }
  }

  /** 등록된 모든 훅 엔트리를 반환한다 */
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

  /** 특정 훅을 제거한다 */
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
}
```

### 5.2 훅 러너 (3가지 실행 모드)

```typescript
// packages/server/src/services/hooks/runner.ts
import type { HookEntry, HookEvent, HookRunMode, HookRunner, HookRunnerOptions } from './types.js';
import { HookRegistry } from './registry.js';

/**
 * 훅 러너를 생성한다.
 *
 * 실행 모드:
 * - parallel: 모든 핸들러를 Promise.allSettled로 동시 실행. 빠르지만 순서 보장 없음.
 * - sequential: 순차 실행. 이전 핸들러의 부수효과가 다음에 영향.
 * - sync: 동기적 순차 실행. 비동기 핸들러는 await하지 않음.
 */
export function createHookRunner(
  registry: HookRegistry,
  options: HookRunnerOptions = { mode: 'parallel' },
): HookRunner {
  const { mode, timeoutMs = 30_000, onError } = options;

  return {
    mode,
    async trigger(event: HookEvent): Promise<void> {
      const handlers = [
        ...registry.getHandlers(event.type),
        ...registry.getHandlers(`${event.type}:${event.action}`),
      ].filter((h) => h.enabled);

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
      handler.handler(event); // 비동기 결과 무시
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

### 5.3 EventBus 브리지

```typescript
// packages/server/src/services/hooks/bridge.ts
import { getEventBus, type FinClawEventMap } from '@finclaw/infra';
import type { HookRegistry } from './registry.js';
import type { HookEventType } from './types.js';

/**
 * @finclaw/infra EventBus → HookRegistry 브리지.
 * EventBus에서 발생하는 이벤트를 HookRegistry의 훅 이벤트로 변환·전파한다.
 *
 * 반환값: 브리지 해제 함수 (shutdown 시 호출)
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
  ];

  const unsubscribers: Array<() => void> = [];

  for (const { busEvent, hookType, hookAction } of mappings) {
    const unsub = bus.on(busEvent, (payload: unknown) => {
      registry.trigger({
        type: hookType,
        action: hookAction,
        timestamp: Date.now(),
        context: { payload },
      });
    });
    unsubscribers.push(unsub);
  }

  return () => unsubscribers.forEach((fn) => fn());
}
```

### 5.4 크론 스케줄러

```typescript
// packages/server/src/services/cron/scheduler.ts
import { Cron } from 'croner';
import type { CronJob, CronSchedule, CronScheduler, CronSchedulerDeps } from './scheduler.js';
import type { FinClawLogger, ConcurrencyLaneManager } from '@finclaw/infra';

/** Node.js setTimeout 최대값 (2^31 - 1 ms) */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export function createCronScheduler(deps: CronSchedulerDeps): CronScheduler {
  const { logger, lanes } = deps;
  const jobs = new Map<
    string,
    CronJob & { _cron?: Cron; _timer?: ReturnType<typeof setTimeout> }
  >();
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

  function armJob(job: CronJob & { _cron?: Cron; _timer?: ReturnType<typeof setTimeout> }): void {
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
      // setInterval 대신 setTimeout 체인으로 drift 방지
      const delay = Math.min(schedule.intervalMs, MAX_TIMEOUT_MS);
      const run = async () => {
        if (!job.enabled || !isRunning) return;
        await executeJob(job);
        job._timer = setTimeout(run, delay);
        job._timer.unref(); // 프로세스 종료 차단 방지
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

  async function executeJob(
    job: CronJob & { _cron?: Cron; _timer?: ReturnType<typeof setTimeout> },
  ): Promise<void> {
    const mutableJob = job as {
      lastRunAt: number | null;
      lastStatus: 'ok' | 'error' | null;
      nextRunAt: number | null;
    };
    mutableJob.lastRunAt = Date.now();

    // ConcurrencyLane을 통한 동시성 제어
    const handle = await lanes.acquire('cron');
    try {
      await job.handler(abortController?.signal);
      mutableJob.lastStatus = 'ok';
    } catch (error) {
      mutableJob.lastStatus = 'error';
      logger.error(`[Cron Error] ${job.name}: ${error}`);
    } finally {
      handle.release();
    }

    mutableJob.nextRunAt = computeNextRunAt(job.schedule);
  }

  return {
    add(input) {
      const id = crypto.randomUUID();
      const job: CronJob & { _cron?: Cron; _timer?: ReturnType<typeof setTimeout> } = {
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
      if (enabled && isRunning) armJob(job);
      else {
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
    },

    stop() {
      isRunning = false;
      // 진행 중인 작업에 취소 시그널 전파
      abortController?.abort();
      abortController = null;
      for (const job of jobs.values()) {
        job._cron?.stop();
        if (job._timer) clearTimeout(job._timer);
      }
    },

    get running() {
      return isRunning;
    },
  };
}
```

### 5.5 금융 크론 작업

> **스키마 참조**: `packages/storage/src/database.ts` alerts 테이블
>
> | 컬럼                | 타입                       | 비고                                                  |
> | ------------------- | -------------------------- | ----------------------------------------------------- |
> | `symbol`            | TEXT NOT NULL              | 종목 심볼 (plan.md 초안의 `ticker`와 다름)            |
> | `condition_type`    | TEXT NOT NULL              | 조건 유형 (above, below 등)                           |
> | `condition_value`   | REAL NOT NULL              | 조건 값 (목표가)                                      |
> | `condition_field`   | TEXT                       | 비교 대상 필드 (price, volume 등)                     |
> | `enabled`           | INTEGER NOT NULL DEFAULT 1 | 활성=1, 비활성=0 (초안의 `triggered`와 **의미 반전**) |
> | `last_triggered_at` | INTEGER                    | 마지막 트리거 시각 (초안의 `triggered_at`과 다름)     |
> | `trigger_count`     | INTEGER NOT NULL DEFAULT 0 | 트리거 횟수                                           |
> | `cooldown_ms`       | INTEGER NOT NULL DEFAULT 0 | 트리거 간 쿨다운                                      |

```typescript
// packages/server/src/services/cron/jobs/market-refresh.ts
import type { Database } from '@finclaw/storage';

/**
 * 시장 데이터 갱신 작업.
 * 활성 알림의 symbol 목록을 조회하고, 각 symbol의 최신 시세를 갱신한다.
 */
export function createMarketRefreshJob(db: Database) {
  return {
    name: 'market-refresh',
    schedule: { kind: 'every' as const, intervalMs: 5 * 60 * 1000 }, // 5분마다
    enabled: true,
    handler: async (signal?: AbortSignal) => {
      // 1. 활성 알림의 고유 symbol 목록 조회
      const stmt = db.db.prepare('SELECT DISTINCT symbol FROM alerts WHERE enabled = 1');
      const symbols = (stmt.all() as Array<{ symbol: string }>).map((r) => r.symbol);

      if (symbols.length === 0) return;

      // 2. 각 symbol의 최신 시세 조회 (market skill 호출)
      // Phase 16에서 구현될 market provider를 통해 시세 조회
      // 여기서는 시장 데이터 캐시 갱신 트리거만 발행
    },
  };
}

// packages/server/src/services/cron/jobs/alert-check.ts
import type { Database } from '@finclaw/storage';
import type { HookRegistry } from '../../hooks/registry.js';

/**
 * 가격 알림 체크 작업.
 * 활성 알림을 market_cache와 JOIN하여 현재가를 조회하고,
 * 조건 충족 시 알림을 트리거한다.
 */
export function createAlertCheckJob(db: Database, hooks: HookRegistry) {
  return {
    name: 'alert-check',
    schedule: { kind: 'every' as const, intervalMs: 60 * 1000 }, // 1분마다
    enabled: true,
    handler: async (signal?: AbortSignal) => {
      const now = Date.now();

      // 활성 알림을 market_cache와 JOIN하여 현재가 조회
      const stmt = db.db.prepare(`
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
          const update = db.db.prepare(
            'UPDATE alerts SET last_triggered_at = ?, trigger_count = trigger_count + 1 WHERE id = ?',
          );
          update.run(now, alert.id);

          // 훅 이벤트 발행으로 채널 알림 전송 트리거
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

// packages/server/src/services/cron/jobs/cleanup.ts
import type { Database } from '@finclaw/storage';

/**
 * 정리 작업.
 * - 만료된 시장 데이터 캐시 삭제
 * - 30일 이상 비활성 + 트리거된 알림 삭제
 */
export function createCleanupJob(db: Database) {
  return {
    name: 'cleanup',
    schedule: { kind: 'cron' as const, expr: '0 3 * * *' }, // 매일 03:00
    enabled: true,
    handler: async (signal?: AbortSignal) => {
      const now = Date.now();

      // 1. 만료된 캐시 삭제
      const purgeCache = db.db.prepare('DELETE FROM market_cache WHERE expires_at <= ?');
      const cacheResult = purgeCache.run(now);

      // 2. 30일 이상 비활성 + 트리거된 알림 삭제
      const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
      const purgeAlerts = db.db.prepare(
        'DELETE FROM alerts WHERE enabled = 0 AND last_triggered_at IS NOT NULL AND last_triggered_at < ?',
      );
      const alertResult = purgeAlerts.run(thirtyDaysAgo);
    },
  };
}
```

### 5.6 보안 감사 & 자격 증명 리다이렉션

```typescript
// packages/server/src/services/security/redaction.ts

/** 금융 API 키를 포함한 13+ 리다이렉션 패턴 */
export const REDACTION_PATTERNS: RedactionPattern[] = [
  // 범용 API 키/토큰
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

  // Anthropic
  {
    name: 'anthropic_api_key',
    pattern: /sk-ant-[A-Za-z0-9\-]{20,}/g,
    replacement: '[REDACTED_ANTHROPIC_KEY]',
  },

  // OpenAI
  { name: 'openai_api_key', pattern: /sk-[A-Za-z0-9]{20,}/g, replacement: '[REDACTED_OPENAI_KEY]' },

  // Alpha Vantage (금융)
  {
    name: 'alpha_vantage_key',
    pattern:
      /(?:ALPHA_VANTAGE|alphavantage)[_-]?(?:API[_-]?)?KEY\s*[:=]\s*["']?[A-Z0-9]{10,}["']?/gi,
    replacement: 'ALPHA_VANTAGE_KEY=[REDACTED]',
  },

  // CoinGecko (금융)
  {
    name: 'coingecko_key',
    pattern: /CG-[A-Za-z0-9]{20,}/g,
    replacement: '[REDACTED_COINGECKO_KEY]',
  },

  // 거래소 API (금융)
  {
    name: 'exchange_api_secret',
    pattern:
      /(binance|upbit|bithumb|coinbase)[_-]?(?:secret|api[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9+/]{20,}["']?/gi,
    replacement: '$1=[REDACTED_EXCHANGE_SECRET]',
  },

  // PEM 개인 키
  {
    name: 'pem_private_key',
    pattern:
      /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },

  // Discord 봇 토큰
  {
    name: 'discord_token',
    pattern: /[MN][A-Za-z\d]{23,28}\.[A-Za-z\d-_]{6}\.[A-Za-z\d-_]{27,}/g,
    replacement: '[REDACTED_DISCORD_TOKEN]',
  },

  // JSON Web Token
  {
    name: 'jwt_token',
    pattern: /eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g,
    replacement: '[REDACTED_JWT]',
  },

  // 환경변수 값 내 비밀
  {
    name: 'env_secret',
    pattern: /(SECRET|PASSWORD|CREDENTIAL|PRIVATE)(?:_KEY)?\s*=\s*["']?[^\s"']+["']?/gi,
    replacement: '$1=[REDACTED]',
  },
];

/**
 * 텍스트에서 민감한 자격 증명을 마스킹한다.
 * 로그 출력, 에러 메시지, 진단 리포트에서 사용된다.
 */
export function redactSensitiveText(text: string): string {
  let result = text;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
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

// packages/server/src/services/security/audit.ts
import type { SecurityAuditFinding, SecurityAuditReport, SecurityAuditOptions } from './audit.js';
import { stat } from 'node:fs/promises';

/**
 * 보안 감사를 실행한다.
 * 금융 데이터를 다루는 FinClaw에 특화된 보안 검사를 수행한다.
 */
export async function runSecurityAudit(
  options: SecurityAuditOptions = {},
): Promise<SecurityAuditReport> {
  const findings: SecurityAuditFinding[] = [];

  // 1. API 키 검사
  if (options.checkApiKeys !== false) {
    findings.push(...collectApiKeyFindings());
  }

  // 2. 파일 퍼미션 검사
  if (options.checkFilePermissions !== false) {
    findings.push(...(await collectFilePermissionFindings()));
  }

  // 3. 환경변수 위생 검사
  if (options.checkEnvironment !== false) {
    findings.push(...collectEnvironmentFindings());
  }

  // 심각도 집계
  const summary = {
    critical: findings.filter((f) => f.severity === 'critical').length,
    warn: findings.filter((f) => f.severity === 'warn').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };

  return { findings, summary, timestamp: Date.now() };
}

function collectApiKeyFindings(): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];

  // 필수 키 존재 여부 확인
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
        detail: `${envVar}가 설정되어 있습니다. 이는 보안 위험을 초래할 수 있습니다.`,
        remediation: `${envVar} 환경변수를 제거하거나, 꼭 필요한 경우 값을 검증하세요.`,
      });
    }
  }

  return findings;
}

async function collectFilePermissionFindings(): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];

  // WSL/Windows 환경에서는 퍼미션 검사가 무의미하므로 스킵
  if (process.platform === 'win32' || process.env.WSL_DISTRO_NAME) {
    findings.push({
      checkId: 'file_perm.skipped',
      severity: 'info',
      title: '파일 퍼미션 검사 생략',
      detail: 'WSL/Windows 환경에서는 POSIX 파일 퍼미션이 적용되지 않습니다.',
    });
    return findings;
  }

  // .env 파일과 DB 파일 퍼미션 검사
  const sensitiveFiles = ['.env', 'finclaw.db', 'finclaw.db-wal', 'finclaw.db-shm'];
  for (const file of sensitiveFiles) {
    try {
      const st = await stat(file);
      const mode = st.mode & 0o777;

      // 제3자(other) 읽기 가능 → critical
      if (mode & 0o004) {
        findings.push({
          checkId: `file_perm.world_readable.${file}`,
          severity: 'critical',
          title: `민감 파일 world-readable: ${file}`,
          detail: `${file}이 제3자에게 읽기 가능합니다 (mode: ${mode.toString(8)}).`,
          remediation: `chmod 600 ${file}`,
        });
      }
      // 그룹 읽기 가능 → warn
      else if (mode & 0o040) {
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

  // NODE_ENV 확인
  if (!process.env.NODE_ENV) {
    findings.push({
      checkId: 'env.node_env_unset',
      severity: 'warn',
      title: 'NODE_ENV 미설정',
      detail: 'NODE_ENV가 설정되지 않았습니다. production 환경에서는 명시적으로 설정하세요.',
      remediation: 'NODE_ENV=production 으로 설정하세요.',
    });
  }

  // DB_PATH가 임시 디렉토리인지 확인
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

  // ALERT_CHECK_INTERVAL_MS가 너무 짧은지 확인
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

### 5.7 데몬 관리 (systemd)

```typescript
// packages/server/src/services/daemon/systemd.ts
import { writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

/**
 * systemd 사용 가능 여부를 감지한다.
 * WSL 환경에서는 systemd가 비활성화된 경우가 많으므로 힌트를 제공한다.
 */
export function isSystemdAvailable(): { available: boolean; hint?: string } {
  if (process.platform !== 'linux') {
    return { available: false, hint: 'systemd는 Linux에서만 사용 가능합니다.' };
  }

  // WSL 환경 감지
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

  // 일반 Linux
  try {
    execSync('systemctl --version', { stdio: 'ignore' });
    return { available: true };
  } catch {
    return { available: false, hint: 'systemd를 찾을 수 없습니다. init 시스템을 확인하세요.' };
  }
}

/**
 * systemd 서비스 파일을 생성한다.
 * Restart=on-failure (always 대신 — 설정 오류 시 무한 재시작 방지)
 */
export async function generateSystemdService(options: {
  readonly name?: string;
  readonly execPath: string;
  readonly workingDir: string;
  readonly envFile?: string;
  readonly outputPath: string;
}): Promise<void> {
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

### 5.8 데이터 흐름 다이어그램

```
훅 이벤트 흐름:
  트리거 소스 (Gateway, Agent, Cron)
    │
    └─→ registry.trigger({ type: 'market', action: 'update', context: { symbol: 'AAPL' } })
         │
         ├─→ handlers['market'] (system 우선순위 0)
         │      └─→ 시장 데이터 캐시 갱신
         │
         ├─→ handlers['market:update'] (plugin 우선순위 100)
         │      └─→ 커스텀 알림 로직
         │
         └─→ handlers['market:update'] (user 우선순위 300)
                └─→ 사용자 정의 웹훅 호출

EventBus 브리지 흐름:
  @finclaw/infra EventBus
    │
    └─→ bridge.ts (이벤트 변환)
         │
         └─→ HookRegistry.trigger() (훅 핸들러 실행)

크론 작업 흐름:
  CronScheduler.start()  (AbortController 생성)
    │
    ├─→ market-refresh (5분마다)
    │      └─→ 활성 알림 symbol 조회 → 시세 갱신 → 캐시 업데이트
    │
    ├─→ alert-check (1분마다)
    │      └─→ alerts JOIN market_cache → 조건 체크 → hooks.trigger('market:alert-triggered')
    │
    └─→ cleanup (매일 03:00)
           └─→ 만료 캐시 삭제 + 30일 초과 비활성 알림 삭제

보안 감사 흐름:
  runSecurityAudit(options)
    │
    ├─→ collectApiKeyFindings()
    │      └─→ 필수 키(Anthropic, Discord) + 선택 키(Alpha Vantage, CoinGecko) + 위험 env
    │
    ├─→ collectFilePermissionFindings()
    │      └─→ .env, DB 파일 퍼미션 검사 (WSL/Windows 스킵)
    │
    └─→ collectEnvironmentFindings()
           └─→ NODE_ENV, DB_PATH, ALERT_CHECK_INTERVAL_MS 검사
```

---

## 6. 서비스 부트스트랩 & Graceful Shutdown

서비스 초기화 순서와 종료 처리를 명시한다.

### 부트스트랩 순서

```typescript
// packages/server/src/bootstrap.ts (Phase 15 관련 부분)

// 1. HookRegistry 생성
const hookRegistry = new HookRegistry();

// 2. EventBus 브리지 연결
const unbridgeEventBus = bridgeEventBusToHooks(hookRegistry);

// 3. 기본 훅 등록 (system 계층)
hookRegistry.register({
  id: 'system:market-alert-log',
  name: 'market-alert-logger',
  source: 'system',
  events: ['market:alert-triggered'],
  handler: (event) => {
    logger.info('[Alert Triggered]', event.context);
  },
  enabled: true,
});

// 4. 크론 스케줄러 생성 (infra DI 주입)
const scheduler = createCronScheduler({ logger, lanes });

// 5. 크론 작업 등록
scheduler.add(createMarketRefreshJob(db));
scheduler.add(createAlertCheckJob(db, hookRegistry));
scheduler.add(createCleanupJob(db));

// 6. 스케줄러 시작
scheduler.start();
```

### Graceful Shutdown

```typescript
function setupGracefulShutdown(scheduler: CronScheduler, unbridgeEventBus: () => void): void {
  const shutdown = () => {
    scheduler.stop(); // AbortController.abort() → 진행 중 작업 취소
    unbridgeEventBus(); // EventBus 리스너 해제
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
```

---

## 7. 선행 조건

| 선행 Phase         | 필요한 산출물                                                                             | 사용처                         |
| ------------------ | ----------------------------------------------------------------------------------------- | ------------------------------ |
| Phase 1 (types)    | `HookEvent`, `CronJob` 타입 기초                                                          | 서비스 인터페이스 정의         |
| Phase 2 (infra)    | `createLogger`/`FinClawLogger`, `ConcurrencyLaneManager`, `getEventBus`/`FinClawEventMap` | 크론 DI, 브리지, 로깅          |
| Phase 5 (plugin)   | 플러그인 시스템                                                                           | 플러그인 훅 등록 계층          |
| Phase 10 (gateway) | Gateway 서버, 이벤트 시스템                                                               | 훅 트리거 소스, 크론 작업 실행 |
| Phase 14 (storage) | SQLite 데이터베이스, alerts/market_cache 테이블                                           | 크론 작업의 데이터 소스        |

### 새로운 의존성

| 패키지   | 버전     | 용도                           |
| -------- | -------- | ------------------------------ |
| `croner` | `^9.0.0` | 크론 표현식 파싱 & 스케줄 실행 |

---

## 8. 구현 순서

의존성 기반 10-step 순서. 각 단계는 이전 단계의 산출물에 의존한다.

| 순서 | 파일                                                          | 의존 대상                                         |
| ---- | ------------------------------------------------------------- | ------------------------------------------------- |
| 1    | `hooks/types.ts`                                              | 없음                                              |
| 2    | `hooks/registry.ts`                                           | types.ts                                          |
| 3    | `hooks/runner.ts`                                             | types.ts, registry.ts                             |
| 4    | `hooks/bridge.ts`                                             | registry.ts, @finclaw/infra                       |
| 5    | `security/redaction.ts`                                       | 없음                                              |
| 6    | `security/audit.ts`                                           | 없음                                              |
| 7    | `cron/scheduler.ts`                                           | @finclaw/infra                                    |
| 8    | `cron/jobs/market-refresh.ts`, `alert-check.ts`, `cleanup.ts` | scheduler.ts, hooks/registry.ts, @finclaw/storage |
| 9    | `daemon/systemd.ts`                                           | 없음                                              |
| 10   | `index.ts` (barrel)                                           | 모든 모듈                                         |

---

## 9. 산출물 및 검증

### 기능 검증 항목

| #   | 검증 항목               | 검증 방법                                         | 기대 결과                                       |
| --- | ----------------------- | ------------------------------------------------- | ----------------------------------------------- |
| 1   | 훅 등록                 | `registry.register(entry)`                        | 핸들러가 이벤트 키에 등록됨                     |
| 2   | 훅 우선순위             | system(0) → plugin(100) → user(300) 순서 검증     | 우선순위 오름차순 실행                          |
| 3   | 훅 에러 격리            | 첫 핸들러 throw → 두 번째 핸들러 실행 여부        | 에러 격리, 나머지 계속 실행                     |
| 4   | 이벤트 발행             | `trigger({ type: 'agent', action: 'bootstrap' })` | type + type:action 양쪽 핸들러 호출             |
| 5   | 러너 parallel           | 5개 핸들러 동시 실행                              | Promise.allSettled로 전체 완료 대기             |
| 6   | 러너 sequential         | 순차 실행 중 하나 실패                            | 실패 후 다음 핸들러 계속                        |
| 7   | 러너 타임아웃           | 30초 초과 핸들러                                  | 타임아웃 에러 + 다음 핸들러 실행                |
| 8   | 크론 cron 표현식        | `{ kind: 'cron', expr: '0 */5 * * *' }`           | 5분마다 실행                                    |
| 9   | 크론 every 간격         | `{ kind: 'every', intervalMs: 60000 }`            | 1분 간격 실행                                   |
| 10  | 크론 at 일회성          | `{ kind: 'at', atMs: futureTime }`                | 지정 시간에 1회 실행                            |
| 11  | 리다이렉션 Anthropic    | `sk-ant-xxxxx` 포함 텍스트                        | `[REDACTED_ANTHROPIC_KEY]` 치환                 |
| 12  | 리다이렉션 OpenAI       | `sk-xxxxxxx` 포함 텍스트                          | `[REDACTED_OPENAI_KEY]` 치환                    |
| 13  | 리다이렉션 금융 키      | Alpha Vantage/CoinGecko 키 포함                   | 정상 마스킹                                     |
| 14  | 보안 감사               | `runSecurityAudit()`                              | findings 배열 + severity 집계                   |
| 15  | 환경변수 검사           | LD_PRELOAD 설정 시                                | warn 수준 finding 생성                          |
| 16  | AbortController 취소    | `scheduler.stop()` 후 진행 중 작업                | handler에 signal.aborted = true 전파            |
| 17  | timer.unref()           | `every` 스케줄 타이머                             | 프로세스가 크론 타이머만으로 종료 차단되지 않음 |
| 18  | redaction $1 백레퍼런스 | `api_key=sk-xxx` 입력                             | `api_key=[REDACTED]` (키 이름 보존)             |
| 19  | alerts 스키마 정합      | market-refresh SQL 실행                           | `symbol`, `enabled` 컬럼 정상 조회              |
| 20  | ConcurrencyLane 통합    | 크론 작업 실행 시                                 | `cron` 레인 acquire/release 호출                |
| 21  | 환경변수 감사           | NODE_ENV 미설정 시                                | warn finding 생성                               |
| 22  | 파일 퍼미션 검사        | .env 파일 mode 0o644                              | group-readable warn 생성 (Linux)                |
| 23  | systemd 환경 감지       | WSL 환경에서 호출                                 | available=false + WSL 힌트 반환                 |
| 24  | EventBus 브리지         | agent:run:start 이벤트 발생                       | HookRegistry에 agent:turn-start 훅 트리거       |
| 25  | withTimeout 타이머 정리 | 핸들러 정상 완료 시                               | clearTimeout 호출 (타이머 누수 없음)            |

### 테스트 커버리지 목표

| 모듈                    | 목표 커버리지 |
| ----------------------- | ------------- |
| `hooks/registry.ts`     | 90%+          |
| `hooks/runner.ts`       | 85%+          |
| `cron/scheduler.ts`     | 80%+          |
| `security/redaction.ts` | 95%+          |
| `security/audit.ts`     | 75%+          |

---

## 10. 복잡도 및 예상 파일 수

| 항목               | 값                                  |
| ------------------ | ----------------------------------- |
| 복잡도             | **L** (Large)                       |
| 소스 파일          | 12개                                |
| 테스트 파일        | 5개                                 |
| 총 파일 수         | **~17개**                           |
| 예상 총 코드 줄 수 | ~2,100줄 (소스 ~1,400, 테스트 ~700) |
| 새 의존성          | `croner`                            |
| 예상 구현 시간     | 6-8시간                             |

### 복잡도 근거

OpenClaw의 지원 서비스가 117파일/20.9K LOC인 반면, FinClaw는 핵심 3개 영역(훅, 크론, 보안)만 구현한다. 데몬 관리는 systemd 단일 플랫폼만 지원하고(OpenClaw의 3플랫폼 대비), 크론은 격리 에이전트 실행 없이 단순 작업 실행만 구현한다. 보안은 금융 API 키에 특화된 리다이렉션에 집중하며, OpenClaw의 17+ 수집기 대비 3개 핵심 수집기만 포함한다. 그러나 훅 시스템의 4계층 우선순위, 3가지 실행 모드, 에러 격리 메커니즘은 아키텍처적 복잡도가 높아 L 등급에 해당한다. EventBus 브리지, AbortController 기반 취소, ConcurrencyLane 통합이 추가되어 초안 대비 복잡도 소폭 증가.
