# Phase 4: 프로세스 실행 & 메시지 라우팅

## 1. 목표

FinClaw의 프로세스 실행 관리 및 메시지 라우팅 계층을 구축한다. OpenClaw Phase 3(프로세스/라우팅/채널/플러그인)에서 **프로세스/라우팅 부분**을 분리하여 구현한다.

구현 대상:

- **프로세스 실행:** 자식 프로세스 spawn/exec, 타임아웃, 시그널 핸들링
- **동시성 레인:** 채널별/사용자별 rate limiting, 큐 모드 관리
- **세션 키 도출:** channel + account + chat → 고유 세션 키 생성
- **바인딩 매칭:** 인바운드 메시지를 올바른 에이전트/세션에 라우팅
- **메시지 큐:** 순서 보장된 메시지 처리, 우선순위 지원

모노레포 구조(`packages/infra/` + `packages/server/src/process/`)에 맞춘 모듈 배치를 따르며, 기존 `@finclaw/infra` 모듈(FinClawError, Dedupe, EventBus, ALS 컨텍스트 등)을 최대 활용한다. AbortSignal 전파 체인으로 interrupt 모드 기반을 이 Phase에서 구축한다.

이 Phase는 "메시지가 도착했을 때 어디로 보낼 것인가"라는 라우팅 결정 문제를 해결하며, Phase 8(자동 응답 파이프라인)의 직접적인 선행 조건이다.

---

## 2. OpenClaw 참조

| 참조 문서                                                   | 적용할 패턴                                                            | 구체적 적용                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `openclaw_review/deep-dive/12-infrastructure.md`            | 프로세스 라이프사이클, withLock 뮤텍스 패턴, AbortSignal 전파          | spawn.ts: AbortSignal.any() 합성, signal-handler.ts                 |
| `openclaw_review/deep-dive/07-auto-reply.md`                | 8단계 파이프라인 초기 단계(dispatch, routing), 큐 시스템(8파일, 632줄) | message-queue.ts: QueueMode 전략, message-router.ts: 오케스트레이션 |
| `openclaw_review/docs/07.자동-응답-파이프라인.md`           | MsgContext 생성, 세션 키 도출, QueueMode 전략 패턴                     | session-key.ts: Agent-Scoped 키, message-queue.ts: 4종 구현         |
| `openclaw_review/docs/13.데몬-크론-훅-프로세스-보안.md`     | 프로세스 관리, 시그널 핸들링                                           | lifecycle.ts, signal-handler.ts: CleanupFn 기반 종료                |
| `openclaw_review/deep-dive/02-config-state.md`              | sessions/session-key.ts 세션 키 도출 알고리즘                          | session-key.ts: config의 deriveSessionKey와 별도 라우팅용 함수      |
| `openclaw_review/deep-dive/07-auto-reply.md` §command-queue | 3-Lane + Generation Counter 패턴                                       | concurrency-lane.ts: ConcurrencyLaneManager, resetGeneration()      |
| `openclaw_review/deep-dive/07-auto-reply.md` §routing       | Agent-Scoped 세션 키 (`agent:{agentId}:{rest}`)                        | session-key.ts: deriveRoutingSessionKey()                           |
| `openclaw_review/deep-dive/07-auto-reply.md` §binding       | 8계층→4계층 바인딩 축소                                                | binding-matcher.ts: peer > channel > account > default              |

**FinClaw 적응 원칙:**

- OpenClaw의 auto-reply 큐 시스템(8파일, 632줄)을 FinClaw 단일 `message-queue.ts`로 축소
- OpenClaw의 dispatch-from-config.ts(433줄) 설정 기반 라우팅을 단순화
- OpenClaw의 인바운드 디바운싱(100줄)을 포함하되, 복잡한 채널별 분기 제거
- exec-approvals(셸 명령어 분석, 1267줄) 제외 → Phase 7에서 도구 승인으로 단순화
- OpenClaw 4-Lane → 3-Lane (Nested 제외: main, cron, subagent만)
- OpenClaw 6 QueueMode → 4종 구현(`queue`, `followup`, `interrupt`, `collect`) / 6종 타입 선언
- OpenClaw 8+ 계층 바인딩 → 4계층(`peer > channel > account > default`)

---

## 3. 생성할 파일

### 소스 파일 (12개)

| 파일 경로                                        | 역할                                                                    | 예상 LOC |
| ------------------------------------------------ | ----------------------------------------------------------------------- | -------- |
| `packages/server/src/process/index.ts`           | Barrel export                                                           | ~20      |
| `packages/server/src/process/spawn.ts`           | 자식 프로세스 spawn/exec + AbortSignal.any() + 타임아웃                 | ~160     |
| `packages/server/src/process/signal-handler.ts`  | 프로세스 시그널 핸들링 (SIGINT, SIGTERM, 우아한 종료)                   | ~80      |
| `packages/infra/src/concurrency-lane.ts`         | 3-Lane 동시성 관리 (Generation counter, 범용 유틸)                      | ~150     |
| `packages/server/src/process/session-key.ts`     | 라우팅용 세션 키 도출 (`deriveRoutingSessionKey`)                       | ~90      |
| `packages/server/src/process/binding-matcher.ts` | 4계층 바인딩 매칭 (peer > channel > account > default)                  | ~130     |
| `packages/server/src/process/message-queue.ts`   | 세션별 메시지 큐 (QueueMode 4종 구현, DropPolicy, drain)                | ~200     |
| `packages/server/src/process/message-router.ts`  | 메시지 라우팅 오케스트레이터 (Dedupe, ALS, AbortSignal)                 | ~175     |
| `packages/server/src/process/debounce.ts`        | 인바운드 메시지 디바운싱                                                | ~80      |
| `packages/server/src/process/lifecycle.ts`       | 프로세스 라이프사이클 관리 (startup, shutdown)                          | ~100     |
| `packages/server/src/process/errors.ts`          | 프로세스/라우팅 에러 계층 (FinClawError 서브클래스)                     | ~70      |
| `packages/infra/src/index.ts`                    | barrel export 업데이트 (ConcurrencyLaneManager 추가) _(기존 파일 수정)_ | —        |

### 테스트 파일 (7개)

| 파일 경로                                              | 검증 대상                                                   | 예상 LOC |
| ------------------------------------------------------ | ----------------------------------------------------------- | -------- |
| `packages/server/test/process/spawn.test.ts`           | spawn 타임아웃, AbortSignal 합성, 출력 캡처                 | ~100     |
| `packages/server/test/process/session-key.test.ts`     | Agent-Scoped 키, 결정성, classifySessionKey                 | ~90      |
| `packages/server/test/process/binding-matcher.test.ts` | 4계층 매칭, 우선순위, fallback                              | ~100     |
| `packages/server/test/process/message-queue.test.ts`   | QueueMode 4종, DropPolicy, followup, purgeIdle              | ~130     |
| `packages/infra/test/concurrency-lane.test.ts`         | 3-Lane, Generation counter, dispose, clearWaiters           | ~100     |
| `packages/server/test/process/message-router.test.ts`  | Dedupe 통합, AbortController 전파, EventBus                 | ~100     |
| `packages/server/test/process/integration.test.ts`     | 전체 흐름 (route → dedupe → queue → lane → process → abort) | ~130     |

**총 파일 수:** 19개 (소스 12 + 테스트 7)

---

## 4. 핵심 인터페이스/타입

### 4.1 프로세스 Spawn (`spawn.ts`)

```typescript
// packages/server/src/process/spawn.ts
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { SpawnError, SpawnTimeoutError } from './errors.js';

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
 *   → setTimeout/clearTimeout 제거
 * - 타임아웃 시 SIGTERM -> 2초 유예 -> SIGKILL
 * - stdout/stderr 스트림 수집
 * - 최대 출력 버퍼 제한
 * - 에러를 SpawnError/SpawnTimeoutError로 래핑
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

    // 출력 수집
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

    // stdin 입력
    if (stdin) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }

    // AbortSignal 연동 (합성된 시그널 하나만 리스닝)
    combinedSignal.addEventListener('abort', () => gracefulKill(child), { once: true });

    // 완료 핸들링
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
      // SpawnError로 래핑 (errors.ts에서 import)
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

### 4.2 동시성 레인 (`concurrency-lane.ts`) — `packages/infra/src/`

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
 * OpenClaw의 Lane 큐잉 패턴:
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

  /** 모든 대기열 정리 (LaneClearedError로 reject) */
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
      const idx = queue.indexOf(waiter as any);
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

### 4.3 세션 키 도출 (`session-key.ts`)

```typescript
// packages/server/src/process/session-key.ts
import type { SessionKey, ChannelId, AgentId } from '@finclaw/types';
import { createSessionKey } from '@finclaw/types';

/**
 * 라우팅용 세션 키 도출 (Agent-Scoped)
 *
 * 함수명: deriveRoutingSessionKey (config 패키지의 deriveSessionKey와 충돌 회피)
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

function normalizeChannelId(id: string): string {
  return id.toLowerCase().trim();
}

function normalizeChatId(id: string): string {
  return id.replace(/@[a-z.]+$/, '').trim();
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
```

### 4.4 바인딩 매칭 (`binding-matcher.ts`)

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
      // accountId는 메시지에 직접 없으므로 senderId 기반 매칭
      // (추후 확장 시 account resolver 주입 가능)
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

### 4.5 메시지 큐 (`message-queue.ts`)

```typescript
// packages/server/src/process/message-queue.ts
import type { SessionKey, Timestamp } from '@finclaw/types';
import type { InboundMessage } from '@finclaw/types';

/**
 * 큐 모드 — OpenClaw QueueMode 대응
 *
 * 6종 타입 선언 (Phase 8 명칭 통일):
 * - queue:          순차 처리 (기본, 구 serial)
 * - followup:       처리 완료 후 후속 메시지 자동 연결
 * - interrupt:      진행 중인 처리를 취소하고 새 메시지 처리
 * - collect:        시간 윈도우 내 메시지를 모아서 한 번에 처리
 * - steer:          (Phase 8) 진행 중인 처리에 방향 전환 주입
 * - steer-backlog:  (Phase 8) steer + 미처리분 백로그
 *
 * Phase 4 구현: queue, followup, interrupt, collect (4종)
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
 * OpenClaw reply/queue/ (8파일, 632줄) 패턴을 단일 클래스로 축소:
 * - 세션별 독립 큐
 * - QueueMode에 따른 처리 전략 (4종 구현)
 * - drain 시 순차적 소비
 * - 처리 중 상태 추적
 */
export class MessageQueue {
  private queues = new Map<string, QueueEntry[]>();
  private processing = new Set<string>();
  private lastActivity = new Map<string, number>();
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

    // interrupt 모드: 처리 중이면 취소 시그널 반환
    if (this.config.mode === 'interrupt' && this.processing.has(key)) {
      return 'interrupt';
    }

    // 현재 처리 중이 아니면 즉시 처리 가능
    return !this.processing.has(key);
  }

  /**
   * 다음 처리할 메시지를 꺼냄
   */
  dequeue(sessionKey: SessionKey): QueueEntry | undefined {
    const key = sessionKey as string;
    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) return undefined;
    return queue.shift();
  }

  /**
   * followup 모드: 현재 처리 완료 후 후속 메시지가 있으면 꺼냄
   * (처리 완료 직후 호출 — markDone 전에 사용)
   */
  dequeueFollowup(sessionKey: SessionKey): QueueEntry | undefined {
    if (this.config.mode !== 'followup') return undefined;
    return this.dequeue(sessionKey);
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
    this.queues.delete(sessionKey as string);
    this.processing.delete(sessionKey as string);
    this.lastActivity.delete(sessionKey as string);
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

### 4.6 메시지 라우터 (`message-router.ts`)

```typescript
// packages/server/src/process/message-router.ts
import type { InboundMessage, MsgContext, SessionKey, AgentId } from '@finclaw/types';
import type { FinClawConfig } from '@finclaw/types';
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
  /** AbortSignal 파라미터 추가 — interrupt 모드 지원 */
  onProcess: (ctx: MsgContext, match: BindingMatch, signal: AbortSignal) => Promise<void>;
}

/**
 * 메시지 라우팅 오케스트레이터
 *
 * 인바운드 메시지의 전체 라우팅 흐름:
 * 1.   세션 키 도출
 * 1.5  Dedupe 중복 체크 (5초 TTL)
 * 2.   바인딩 매칭 (메시지 → 에이전트)
 * 3.   메시지 큐 삽입/즉시 처리 결정
 * 4.   동시성 레인 확인 (ConcurrencyLaneManager)
 * 5.   MsgContext 생성
 * 5.5  AbortController 생성 + activeControllers Map
 * 6.   EventBus 이벤트 발행 ('channel:message')
 * 6.5  runWithContext() ALS 래핑
 * 7.   처리 콜백 호출
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
    this.queue = new MessageQueue({
      mode: 'queue',
      maxSize: 50,
    });
    this.laneManager = new ConcurrencyLaneManager();
    this.dedupe = new Dedupe({ ttlMs: 5000 });
  }

  async route(msg: InboundMessage): Promise<void> {
    const { logger, config } = this.deps;

    // 1. 세션 키 도출 (Agent-Scoped)
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
      enqueuedAt: Date.now() as any,
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

    // 4. 동시성 레인 획득 (ConcurrencyLaneManager 사용)
    const laneId: LaneId = 'main'; // 기본 레인 (추후 cron/subagent 분기)
    const handle = await this.laneManager.acquire(laneId, key);

    // 5.5 AbortController 생성
    const controller = new AbortController();
    this.activeControllers.set(key, controller);

    try {
      // 5. MsgContext 생성
      const ctx = buildMsgContext(entry.message, sessionKey, match);

      // 6.5 runWithContext() ALS 래핑
      await runWithContext({ requestId: entry.id, startTime: Date.now() }, async () => {
        // 7. 처리 콜백 호출 (AbortSignal 전달)
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
  match: BindingMatch,
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

### 4.7 프로세스 에러 계층 (`errors.ts`) — 신규

```typescript
// packages/server/src/process/errors.ts
import { FinClawError } from '@finclaw/infra';

/** spawn 실행 실패 */
export class SpawnError extends FinClawError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'SPAWN_ERROR', { details });
  }
}

/** spawn 타임아웃 */
export class SpawnTimeoutError extends FinClawError {
  constructor(command: string, timeoutMs: number) {
    super(`Spawn timeout: ${command} (${timeoutMs}ms)`, 'SPAWN_TIMEOUT', {
      details: { command, timeoutMs },
    });
  }
}

/** 레인 대기열 정리됨 (Generation 리셋) */
export class LaneClearedError extends FinClawError {
  constructor(laneKey?: string) {
    super('Lane cleared', 'LANE_CLEARED', { details: { laneKey } });
  }
}

/** 큐 가득 참 */
export class QueueFullError extends FinClawError {
  constructor(sessionKey: string, maxSize: number) {
    super(`Queue full for session: ${sessionKey}`, 'QUEUE_FULL', {
      details: { sessionKey, maxSize },
    });
  }
}
```

### 4.8 시그널 핸들러 (`signal-handler.ts`) — 타입 정정

```typescript
// packages/server/src/process/signal-handler.ts
import type { CleanupFn } from '@finclaw/types';
import type { FinClawLogger } from '@finclaw/infra';

/**
 * 우아한 종료 핸들러
 *
 * 타입 정정: AsyncDisposable[] → CleanupFn[]
 * (types/common.ts에 CleanupFn = () => Promise<void> 이미 정의)
 *
 * SIGINT/SIGTERM 수신 시:
 * 1. 새 메시지 수신 중단
 * 2. 진행 중인 메시지 처리 완료 대기 (30초 타임아웃)
 * 3. 리소스 정리 (게이트웨이 잠금 해제, DB 연결 닫기)
 * 4. 프로세스 종료
 */
export function setupGracefulShutdown(logger: FinClawLogger, cleanupFns: CleanupFn[]): void {
  // (시그니처만 변경, 구현 동일 — §5.2 참조)
}
```

---

## 5. 구현 상세

### 5.1 데이터 흐름

```
[채널 플러그인] ── InboundMessage ──> [MessageRouter.route()]
                                            │
                                    1.   deriveRoutingSessionKey()
                                    1.5  Dedupe.check(msg.id) ── 중복 → return
                                    2.   matchBinding() (4계층)
                                         EventBus.emit('channel:message')
                                    3.   MessageQueue.enqueue()
                                            │
                                     ┌──────┼──────────┐
                                     │      │          │
                              [즉시 처리] [큐 대기] ['interrupt']
                                     │                 │
                                     │      activeControllers.get() → abort()
                                     │                 │
                                     └────────┬────────┘
                                              │
                                    4.   ConcurrencyLaneManager.acquire('main', key)
                                    5.   buildMsgContext()
                                    5.5  new AbortController() → activeControllers.set()
                                    6.5  runWithContext({ requestId, startTime }, async () => {
                                    7.     onProcess(ctx, match, signal)
                                         })
                                              │
                                    [Phase 8: auto-reply 파이프라인]
```

### 5.2 시그널 핸들링

```typescript
// packages/server/src/process/signal-handler.ts
import type { CleanupFn } from '@finclaw/types';
import type { FinClawLogger } from '@finclaw/infra';

/**
 * 우아한 종료 핸들러
 *
 * 타입 정정: AsyncDisposable[] → CleanupFn[]
 * (types/common.ts에 CleanupFn = () => Promise<void> 이미 정의)
 *
 * SIGINT/SIGTERM 수신 시:
 * 1. 새 메시지 수신 중단
 * 2. 진행 중인 메시지 처리 완료 대기 (30초 타임아웃)
 * 3. 리소스 정리 (게이트웨이 잠금 해제, DB 연결 닫기)
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

### 5.3 디바운싱

```typescript
// src/process/debounce.ts

export interface DebounceConfig {
  /** 디바운스 윈도우 (ms, 기본: 1000) */
  windowMs?: number;
  /** 최대 대기 시간 (ms, 기본: 5000) */
  maxWaitMs?: number;
}

/**
 * 인바운드 메시지 디바운서
 *
 * OpenClaw inbound-debounce.ts(100줄) 패턴:
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

---

## 6. 선행 조건

| 조건              | 산출물                                                                | Phase   |
| ----------------- | --------------------------------------------------------------------- | ------- |
| 핵심 타입         | MsgContext, InboundMessage, SessionKey, AgentId, ChannelId, CleanupFn | Phase 1 |
| Brand 타입 팩토리 | createSessionKey(), createAgentId() 등                                | Phase 1 |
| 로깅              | FinClawLogger                                                         | Phase 2 |
| 에러 클래스       | FinClawError 계층                                                     | Phase 2 |
| 설정 시스템       | FinClawConfig, loadConfig()                                           | Phase 3 |
| 이벤트 발행       | `FinClawEventMap` 기존 이벤트 활용 (`channel:message`, `agent:run:*`) | Phase 2 |

**패키지 의존성 추가 필요:**

- `packages/server/package.json`에 `"@finclaw/infra": "workspace:*"` 추가
- `packages/server/tsconfig.json` references에 `{ "path": "../infra" }` 추가

**기존 infra 모듈 의존 테이블:**

| 모듈                     | 위치                                 | 사용처                                   |
| ------------------------ | ------------------------------------ | ---------------------------------------- |
| `FinClawError`           | `@finclaw/infra` errors.ts           | errors.ts (서브클래스 기반)              |
| `Dedupe`                 | `@finclaw/infra` dedupe.ts           | message-router.ts (중복 메시지 필터링)   |
| `getEventBus`            | `@finclaw/infra` events.ts           | message-router.ts (channel:message 발행) |
| `runWithContext`         | `@finclaw/infra` context.ts          | message-router.ts (요청별 ALS 전파)      |
| `ConcurrencyLaneManager` | `@finclaw/infra` concurrency-lane.ts | message-router.ts (3-Lane 관리)          |
| `FinClawLogger`          | `@finclaw/infra` logger.ts           | message-router.ts, signal-handler.ts     |

**외부 의존성:** 없음 (Node.js 내장 `node:child_process` 사용)

---

## 7. 산출물 및 검증

### 산출물 목록

| #   | 산출물                              | 검증 방법                                                            |
| --- | ----------------------------------- | -------------------------------------------------------------------- |
| 1   | 프로세스 spawn + AbortSignal 합성   | spawn.test.ts: 정상 종료, 타임아웃/외부취소 구분, SIGKILL            |
| 2   | 우아한 종료 핸들러 (CleanupFn 기반) | SIGINT/SIGTERM 시뮬레이션                                            |
| 3   | 3-Lane 동시성 관리 + Generation     | concurrency-lane.test.ts: 한도 초과 대기, Generation 리셋, dispose   |
| 4   | Agent-Scoped 세션 키                | session-key.test.ts: 결정성, classifySessionKey, 파싱                |
| 5   | 4계층 바인딩 매칭                   | binding-matcher.test.ts: peer>channel>account>default 우선순위       |
| 6   | 메시지 큐 (QueueMode 4종)           | message-queue.test.ts: queue/followup/interrupt/collect, purgeIdle   |
| 7   | 메시지 라우터 (Dedupe + ALS)        | message-router.test.ts: Dedupe 필터, AbortController 전파, EventBus  |
| 8   | 디바운서                            | debounce 윈도우, maxWait, flush                                      |
| 9   | 프로세스/라우팅 에러 계층           | errors.ts: FinClawError 서브클래스 4종                               |
| 10  | 통합 테스트                         | integration.test.ts: route → dedupe → queue → lane → process → abort |

### 검증 기준

```bash
# 1. 단위 테스트
pnpm test -- packages/server/test/process/
pnpm test -- packages/infra/test/concurrency-lane.test.ts

# 2. 세션 키 결정성 검증
# 동일 입력 → 항상 동일 키 (Agent-Scoped 형식)
# deriveRoutingSessionKey({discord, user1, direct}) → "agent:main:discord:direct"

# 3. 동시성 레인 + Generation 검증
# maxConcurrent=1일 때 2번째 요청은 대기열에 삽입
# resetGeneration() 후 stale release는 무시됨

# 4. 메시지 큐 QueueMode 검증
# queue 모드: 순차 처리, interrupt 모드: 'interrupt' 반환, followup: dequeueFollowup()

# 5. AbortSignal 합성 검증
# AbortSignal.timeout() + 외부 AbortSignal → AbortSignal.any()
# 타임아웃 vs 외부 취소 구분 (timedOut, aborted 플래그)

# 6. 전체
pnpm typecheck && pnpm lint && pnpm test
```

---

## 8. 복잡도 및 예상 파일 수

| 항목              | 값                              |
| ----------------- | ------------------------------- |
| **복잡도**        | **M (Medium)**                  |
| 소스 파일         | 12개                            |
| 테스트 파일       | 7개                             |
| **총 파일 수**    | **19개**                        |
| 예상 LOC (소스)   | ~1,315줄                        |
| 예상 LOC (테스트) | ~760줄                          |
| 예상 작업 시간    | 3-4시간                         |
| 신규 의존성       | 0개                             |
| 난이도            | 중간 (동시성 관리, 라우팅 로직) |

**위험 요소:**

- 동시성 레인의 타이머 누수 (dispose() + clearWaiters()로 해결)
- 메시지 큐의 메모리 누적 (purgeIdle(thresholdMs)로 해결)
- 바인딩 매칭 규칙이 설정 변경 시 즉시 반영되어야 함 → Phase 3 설정 핫 리로드와 연동
- AbortSignal.any() 장기 리스너 — spawn 단발 실행이므로 무해
- `packages/server` → `@finclaw/infra` 의존성 미등록 시 빌드 실패 (반드시 package.json + tsconfig.json 추가)
- signal-handler.ts의 AsyncDisposable → CleanupFn 정정 필요 (types/common.ts에 이미 정의)

---

## 9. 구현 순서

```
Step 1. @finclaw/infra 확장
        └── concurrency-lane.ts (3-Lane + Generation) + barrel + test
        검증: pnpm build && pnpm typecheck

Step 2. @finclaw/server 패키지 설정
        └── package.json + tsconfig.json에 infra 추가
        └── process/index.ts (barrel) + process/errors.ts
        검증: pnpm typecheck

Step 3. 프로세스 실행 기반 (Step 2 후)
        └── spawn.ts + signal-handler.ts + lifecycle.ts + test
        검증: AbortSignal 합성, 타임아웃/외부취소 구분

Step 4. 세션 키 + 바인딩 (Step 2 후, Step 3과 병렬 가능)
        └── session-key.ts + binding-matcher.ts + tests
        검증: Agent-Scoped 키, 4계층 우선순위

Step 5. 메시지 큐 + 디바운스 (Step 2 후, Step 3/4와 병렬 가능)
        └── message-queue.ts + debounce.ts + test
        검증: QueueMode 4종, DropPolicy, followup, purgeIdle

Step 6. 메시지 라우터 (Step 3,4,5 모두 필요)
        └── message-router.ts + test
        검증: Dedupe + AbortController 전파 + EventBus

Step 7. 통합 테스트 (Step 6 후)
        └── integration.test.ts
        검증: pnpm typecheck && pnpm lint && pnpm test
```
