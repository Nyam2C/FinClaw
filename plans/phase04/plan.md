# Phase 4: 프로세스 실행 & 메시지 라우팅

## 1. 목표

FinClaw의 프로세스 실행 관리 및 메시지 라우팅 계층을 구축한다. OpenClaw Phase 3(프로세스/라우팅/채널/플러그인)에서 **프로세스/라우팅 부분**을 분리하여 구현한다.

구현 대상:

- **프로세스 실행:** 자식 프로세스 spawn/exec, 타임아웃, 시그널 핸들링
- **동시성 레인:** 채널별/사용자별 rate limiting, 큐 모드 관리
- **세션 키 도출:** channel + account + chat → 고유 세션 키 생성
- **바인딩 매칭:** 인바운드 메시지를 올바른 에이전트/세션에 라우팅
- **메시지 큐:** 순서 보장된 메시지 처리, 우선순위 지원

이 Phase는 "메시지가 도착했을 때 어디로 보낼 것인가"라는 라우팅 결정 문제를 해결하며, Phase 8(자동 응답 파이프라인)의 직접적인 선행 조건이다.

---

## 2. OpenClaw 참조

| 참조 문서                                               | 적용할 패턴                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `openclaw_review/deep-dive/12-infrastructure.md`        | 프로세스 라이프사이클, withLock 뮤텍스 패턴, AbortSignal 전파          |
| `openclaw_review/deep-dive/07-auto-reply.md`            | 8단계 파이프라인 초기 단계(dispatch, routing), 큐 시스템(8파일, 632줄) |
| `openclaw_review/docs/07.자동-응답-파이프라인.md`       | MsgContext 생성, 세션 키 도출, QueueMode 전략 패턴                     |
| `openclaw_review/docs/13.데몬-크론-훅-프로세스-보안.md` | 프로세스 관리, 시그널 핸들링                                           |
| `openclaw_review/deep-dive/02-config-state.md`          | sessions/session-key.ts 세션 키 도출 알고리즘                          |

**FinClaw 적응 원칙:**

- OpenClaw의 auto-reply 큐 시스템(8파일, 632줄)을 FinClaw 단일 `message-queue.ts`로 축소
- OpenClaw의 dispatch-from-config.ts(433줄) 설정 기반 라우팅을 단순화
- OpenClaw의 인바운드 디바운싱(100줄)을 포함하되, 복잡한 채널별 분기 제거
- exec-approvals(셸 명령어 분석, 1267줄) 제외 → Phase 7에서 도구 승인으로 단순화

---

## 3. 생성할 파일

### 소스 파일 (10개)

| 파일 경로                         | 역할                                                  | 예상 LOC |
| --------------------------------- | ----------------------------------------------------- | -------- |
| `src/process/index.ts`            | Barrel export                                         | ~20      |
| `src/process/spawn.ts`            | 자식 프로세스 spawn/exec + 타임아웃 + 시그널          | ~150     |
| `src/process/signal-handler.ts`   | 프로세스 시그널 핸들링 (SIGINT, SIGTERM, 우아한 종료) | ~80      |
| `src/process/concurrency-lane.ts` | 채널/사용자별 동시 실행 제한 (rate limiter)           | ~120     |
| `src/process/session-key.ts`      | 세션 키 도출 알고리즘                                 | ~80      |
| `src/process/binding-matcher.ts`  | 인바운드 메시지 → 에이전트/세션 바인딩 매칭           | ~120     |
| `src/process/message-queue.ts`    | 세션별 메시지 큐 (직렬화, 우선순위, drain)            | ~180     |
| `src/process/message-router.ts`   | 메시지 라우팅 오케스트레이터                          | ~150     |
| `src/process/debounce.ts`         | 인바운드 메시지 디바운싱                              | ~80      |
| `src/process/lifecycle.ts`        | 프로세스 라이프사이클 관리 (startup, shutdown)        | ~100     |

### 테스트 파일 (5개)

| 파일 경로                               | 검증 대상                              | 예상 LOC |
| --------------------------------------- | -------------------------------------- | -------- |
| `test/process/spawn.test.ts`            | spawn 타임아웃, 시그널, 출력 캡처      | ~100     |
| `test/process/session-key.test.ts`      | 세션 키 도출 정규화, 결정성            | ~80      |
| `test/process/binding-matcher.test.ts`  | 바인딩 매칭 규칙, 와일드카드, fallback | ~100     |
| `test/process/message-queue.test.ts`    | 큐 직렬화, 우선순위, drain, MAX 제한   | ~120     |
| `test/process/concurrency-lane.test.ts` | rate limit, 대기열, 타임아웃           | ~80      |

**총 파일 수:** 15개 (소스 10 + 테스트 5)

---

## 4. 핵심 인터페이스/타입

### 4.1 프로세스 Spawn (`spawn.ts`)

```typescript
// src/process/spawn.ts
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
  /** 중단 시그널 */
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
  durationMs: number;
}

/**
 * 안전한 자식 프로세스 실행
 *
 * - 타임아웃 시 SIGTERM -> 2초 유예 -> SIGKILL
 * - AbortSignal 연동
 * - stdout/stderr 스트림 수집
 * - 최대 출력 버퍼 제한
 */
export async function safeSpawn(opts: SpawnOptions): Promise<SpawnResult> {
  const {
    command,
    args = [],
    cwd,
    env,
    timeoutMs = 30_000,
    signal,
    stdin,
    maxBuffer = 10 * 1024 * 1024,
  } = opts;

  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const child = nodeSpawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;

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

    // 타임아웃
    const timer = setTimeout(() => {
      timedOut = true;
      gracefulKill(child);
    }, timeoutMs);

    // AbortSignal 연동
    signal?.addEventListener(
      'abort',
      () => {
        killed = true;
        gracefulKill(child);
      },
      { once: true },
    );

    // 완료 핸들링
    child.on('close', (exitCode, sig) => {
      clearTimeout(timer);
      resolve({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
        signal: sig ?? undefined,
        timedOut,
        durationMs: Date.now() - startTime,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
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

### 4.2 동시성 레인 (`concurrency-lane.ts`)

```typescript
// src/process/concurrency-lane.ts

export interface LaneConfig {
  /** 최대 동시 실행 수 */
  maxConcurrent: number;
  /** 대기열 최대 크기 (기본: 100) */
  maxQueueSize?: number;
  /** 대기 타임아웃 (ms, 기본: 60000) */
  waitTimeoutMs?: number;
}

export interface LaneHandle {
  /** 레인 해제 */
  release(): void;
}

/**
 * 동시성 레인 -- 채널/사용자별 실행 제한
 *
 * OpenClaw의 Lane 큐잉 패턴:
 * - 키별 독립 카운터
 * - maxConcurrent 초과 시 대기열에 삽입
 * - release 시 대기열에서 다음 항목 실행
 */
export class ConcurrencyLane {
  private active = new Map<string, number>();
  private waiters = new Map<
    string,
    Array<{
      resolve: (handle: LaneHandle) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }>
  >();

  constructor(private readonly config: LaneConfig) {}

  /**
   * 레인 획득 -- 동시 실행 한도 내면 즉시 반환,
   * 초과면 대기열에서 릴리즈까지 대기
   */
  async acquire(key: string): Promise<LaneHandle> {
    const current = this.active.get(key) ?? 0;

    if (current < this.config.maxConcurrent) {
      this.active.set(key, current + 1);
      return { release: () => this.release(key) };
    }

    // 대기열 크기 확인
    const queue = this.waiters.get(key) ?? [];
    if (queue.length >= (this.config.maxQueueSize ?? 100)) {
      throw new Error(`Concurrency lane queue full for key: ${key}`);
    }

    // 대기열에 삽입
    return new Promise<LaneHandle>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(key, waiter);
        reject(new Error(`Concurrency lane timeout for key: ${key}`));
      }, this.config.waitTimeoutMs ?? 60_000);

      const waiter = { resolve, reject, timer };
      if (!this.waiters.has(key)) this.waiters.set(key, []);
      this.waiters.get(key)!.push(waiter);
    });
  }

  private release(key: string): void {
    const current = this.active.get(key) ?? 0;
    const queue = this.waiters.get(key);

    if (queue && queue.length > 0) {
      // 대기열에서 다음 항목 실행
      const next = queue.shift()!;
      clearTimeout(next.timer);
      next.resolve({ release: () => this.release(key) });
    } else {
      // 카운터 감소
      if (current <= 1) {
        this.active.delete(key);
      } else {
        this.active.set(key, current - 1);
      }
    }
  }

  private removeWaiter(key: string, waiter: unknown): void {
    const queue = this.waiters.get(key);
    if (queue) {
      const idx = queue.indexOf(waiter as any);
      if (idx !== -1) queue.splice(idx, 1);
    }
  }

  /** 특정 키의 현재 활성 수 조회 */
  getActiveCount(key: string): number {
    return this.active.get(key) ?? 0;
  }

  /** 특정 키의 대기 수 조회 */
  getWaitingCount(key: string): number {
    return this.waiters.get(key)?.length ?? 0;
  }
}
```

### 4.3 세션 키 도출 (`session-key.ts`)

```typescript
// src/process/session-key.ts
import type { SessionKey, ChannelId } from '../types/index.js';
import { createSessionKey } from '../types/index.js';

/**
 * 세션 키 도출
 *
 * OpenClaw sessions/session-key.ts 패턴:
 * channel + account + chatType + chatId → 고유 세션 키
 *
 * DM: "discord:user123:direct"
 * 그룹: "discord:user123:group:channel456"
 * 스레드: "discord:user123:group:channel456:thread789"
 */
export interface SessionKeyParams {
  channelId: ChannelId;
  accountId: string;
  chatType: 'direct' | 'group' | 'channel';
  chatId?: string;
  threadId?: string;
}

export function deriveSessionKey(params: SessionKeyParams): SessionKey {
  const parts: string[] = [
    normalizeChannelId(params.channelId as string),
    normalizeAccountId(params.accountId),
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
  return createSessionKey(`global:${agentId}:main`);
}

function normalizeChannelId(id: string): string {
  return id.toLowerCase().trim();
}

function normalizeAccountId(id: string): string {
  return id.toLowerCase().trim();
}

function normalizeChatId(id: string): string {
  // WhatsApp 그룹 ID의 @g.us 접미사 등 정규화
  return id.replace(/@[a-z.]+$/, '').trim();
}

/**
 * 세션 키에서 구성 요소 추출
 */
export function parseSessionKey(key: SessionKey): {
  channelId: string;
  accountId: string;
  chatType: string;
  chatId?: string;
  threadId?: string;
} {
  const parts = (key as string).split(':');
  return {
    channelId: parts[0],
    accountId: parts[1],
    chatType: parts[2],
    chatId: parts[3],
    threadId: parts[4],
  };
}
```

### 4.4 바인딩 매칭 (`binding-matcher.ts`)

```typescript
// src/process/binding-matcher.ts
import type { FinClawConfig } from '../types/index.js';
import type { InboundMessage } from '../types/message.js';
import type { AgentId, ChannelId } from '../types/common.js';

/**
 * 바인딩 규칙 -- 메시지를 에이전트에 매칭
 *
 * 우선순위:
 * 1. 명시적 바인딩 (channelId + chatId → agentId)
 * 2. 채널 기본 바인딩 (channelId → agentId)
 * 3. 글로벌 기본 에이전트
 */
export interface BindingRule {
  agentId: AgentId;
  channelId?: ChannelId;
  chatId?: string;
  chatType?: 'direct' | 'group' | 'channel';
  priority: number; // 높을수록 우선
}

export interface BindingMatch {
  agentId: AgentId;
  rule: BindingRule;
  matchType: 'explicit' | 'channel' | 'default';
}

/**
 * 인바운드 메시지에 대한 에이전트 바인딩 매칭
 *
 * OpenClaw의 dispatch-from-config.ts 설정 기반 라우팅을
 * 단순한 규칙 매칭으로 구현한다.
 */
export function matchBinding(
  msg: InboundMessage,
  rules: BindingRule[],
  defaultAgentId: AgentId,
): BindingMatch {
  // 우선순위 정렬 (높은 것 먼저)
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);

  for (const rule of sorted) {
    // 1. 명시적 바인딩 (채널 + 채팅 ID)
    if (rule.channelId && rule.chatId) {
      if (rule.channelId === msg.channelId && rule.chatId === extractChatId(msg)) {
        return { agentId: rule.agentId, rule, matchType: 'explicit' };
      }
      continue;
    }

    // 2. 채널 기본 바인딩
    if (rule.channelId && !rule.chatId) {
      if (rule.channelId === msg.channelId) {
        // chatType 필터 (있으면 적용)
        if (rule.chatType && rule.chatType !== msg.chatType) continue;
        return { agentId: rule.agentId, rule, matchType: 'channel' };
      }
      continue;
    }
  }

  // 3. 글로벌 기본
  return {
    agentId: defaultAgentId,
    rule: { agentId: defaultAgentId, priority: 0 },
    matchType: 'default',
  };
}

function extractChatId(msg: InboundMessage): string {
  return msg.threadId ?? msg.id;
}

/**
 * 설정에서 바인딩 규칙 추출
 */
export function extractBindingRules(config: FinClawConfig): BindingRule[] {
  const rules: BindingRule[] = [];

  // 에이전트별 설정에서 바인딩 추출
  const entries = config.agents?.entries ?? {};
  for (const [agentId, entry] of Object.entries(entries)) {
    // 에이전트에 할당된 채널이 있으면 규칙 생성
    // (추후 config에 bindings 필드 추가 시 확장)
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
// src/process/message-queue.ts
import type { SessionKey, Timestamp } from '../types/index.js';
import type { InboundMessage } from '../types/message.js';
import { createTimestamp } from '../types/index.js';

/**
 * 큐 모드 -- OpenClaw QueueMode 대응
 *
 * - serial: 순차 처리 (기본)
 * - interrupt: 진행 중인 처리를 취소하고 새 메시지 처리
 * - collect: 시간 윈도우 내 메시지를 모아서 한 번에 처리
 */
export type QueueMode = 'serial' | 'interrupt' | 'collect';

export interface QueueEntry {
  id: string;
  message: InboundMessage;
  sessionKey: SessionKey;
  enqueuedAt: Timestamp;
  priority: number; // 높을수록 우선
}

export interface MessageQueueConfig {
  mode?: QueueMode;
  maxSize?: number; // 기본: 50
  collectWindowMs?: number; // collect 모드 시간 윈도우 (ms, 기본: 2000)
}

const DEFAULT_MAX_SIZE = 50;

/**
 * 세션별 메시지 큐
 *
 * OpenClaw reply/queue/ (8파일, 632줄) 패턴을 단일 클래스로 축소:
 * - 세션별 독립 큐
 * - QueueMode에 따른 처리 전략
 * - drain 시 순차적 소비
 * - 처리 중 상태 추적
 */
export class MessageQueue {
  private queues = new Map<string, QueueEntry[]>();
  private processing = new Set<string>();
  private config: Required<MessageQueueConfig>;

  constructor(config: MessageQueueConfig = {}) {
    this.config = {
      mode: config.mode ?? 'serial',
      maxSize: config.maxSize ?? DEFAULT_MAX_SIZE,
      collectWindowMs: config.collectWindowMs ?? 2000,
    };
  }

  /**
   * 메시지를 큐에 삽입
   * @returns true: 즉시 처리 가능, false: 큐에 대기
   */
  enqueue(entry: QueueEntry): boolean {
    const key = entry.sessionKey as string;
    let queue = this.queues.get(key);

    if (!queue) {
      queue = [];
      this.queues.set(key, queue);
    }

    // MAX 크기 제한
    if (queue.length >= this.config.maxSize) {
      // 가장 오래된 것 제거 (LRU)
      queue.shift();
    }

    queue.push(entry);

    // 우선순위 정렬 (높은 것 먼저)
    queue.sort((a, b) => b.priority - a.priority);

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
   * 세션의 처리 시작을 표시
   */
  markProcessing(sessionKey: SessionKey): void {
    this.processing.add(sessionKey as string);
  }

  /**
   * 세션의 처리 완료를 표시
   * @returns 큐에 남은 메시지가 있으면 true
   */
  markDone(sessionKey: SessionKey): boolean {
    const key = sessionKey as string;
    this.processing.delete(key);
    const queue = this.queues.get(key);
    return (queue?.length ?? 0) > 0;
  }

  /**
   * 세션이 현재 처리 중인지 확인
   */
  isProcessing(sessionKey: SessionKey): boolean {
    return this.processing.has(sessionKey as string);
  }

  /**
   * 세션의 대기 메시지 수
   */
  pendingCount(sessionKey: SessionKey): number {
    return this.queues.get(sessionKey as string)?.length ?? 0;
  }

  /**
   * 세션 큐 비우기
   */
  clear(sessionKey: SessionKey): void {
    this.queues.delete(sessionKey as string);
    this.processing.delete(sessionKey as string);
  }

  /**
   * 전체 통계
   */
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
// src/process/message-router.ts
import type { InboundMessage, MsgContext } from '../types/message.js';
import type { FinClawConfig } from '../types/config.js';
import type { SessionKey, AgentId, ChannelId } from '../types/common.js';
import type { FinClawLogger } from '../infra/logger.js';
import { deriveSessionKey } from './session-key.js';
import { matchBinding, extractBindingRules, type BindingMatch } from './binding-matcher.js';
import { MessageQueue, type QueueEntry } from './message-queue.js';
import { ConcurrencyLane } from './concurrency-lane.js';

export interface MessageRouterDeps {
  config: FinClawConfig;
  logger: FinClawLogger;
  onProcess: (ctx: MsgContext, match: BindingMatch) => Promise<void>;
}

/**
 * 메시지 라우팅 오케스트레이터
 *
 * 인바운드 메시지의 전체 라우팅 흐름:
 * 1. 세션 키 도출
 * 2. 바인딩 매칭 (메시지 → 에이전트)
 * 3. 동시성 레인 확인
 * 4. 메시지 큐 삽입/즉시 처리 결정
 * 5. MsgContext 생성
 * 6. 처리 콜백 호출
 */
export class MessageRouter {
  private readonly queue: MessageQueue;
  private readonly lane: ConcurrencyLane;
  private readonly deps: MessageRouterDeps;
  private entryCounter = 0;

  constructor(deps: MessageRouterDeps) {
    this.deps = deps;
    this.queue = new MessageQueue({
      mode: 'serial',
      maxSize: 50,
    });
    this.lane = new ConcurrencyLane({
      maxConcurrent: deps.config.agents?.defaults?.maxConcurrent ?? 3,
    });
  }

  /**
   * 인바운드 메시지 라우팅 진입점
   */
  async route(msg: InboundMessage): Promise<void> {
    const { logger, config } = this.deps;

    // 1. 세션 키 도출
    const sessionKey = deriveSessionKey({
      channelId: msg.channelId,
      accountId: msg.senderId,
      chatType: msg.chatType,
      chatId: msg.threadId,
    });

    // 2. 바인딩 매칭
    const rules = extractBindingRules(config);
    const defaultAgentId = getDefaultAgentId(config);
    const match = matchBinding(msg, rules, defaultAgentId);

    logger.debug(
      `Routing message to agent ${match.agentId as string} ` +
        `(match: ${match.matchType}, session: ${sessionKey as string})`,
    );

    // 3. 큐에 삽입
    const entry: QueueEntry = {
      id: `msg-${++this.entryCounter}`,
      message: msg,
      sessionKey,
      enqueuedAt: Date.now() as any,
      priority: 0,
    };

    const canProcessNow = this.queue.enqueue(entry);

    if (canProcessNow) {
      await this.processNext(sessionKey, match);
    }
  }

  private async processNext(sessionKey: SessionKey, match: BindingMatch): Promise<void> {
    const entry = this.queue.dequeue(sessionKey);
    if (!entry) return;

    this.queue.markProcessing(sessionKey);

    // 4. 동시성 레인 획득
    const laneKey = `${match.agentId as string}:${sessionKey as string}`;
    const handle = await this.lane.acquire(laneKey);

    try {
      // 5. MsgContext 생성
      const ctx = buildMsgContext(entry.message, sessionKey, match);

      // 6. 처리 콜백 호출
      await this.deps.onProcess(ctx, match);
    } catch (err) {
      this.deps.logger.error(`Message processing failed: ${String(err)}`);
    } finally {
      handle.release();
      const hasMore = this.queue.markDone(sessionKey);
      if (hasMore) {
        // 다음 메시지 비동기 처리
        void this.processNext(sessionKey, match);
      }
    }
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

---

## 5. 구현 상세

### 5.1 데이터 흐름

```
[채널 플러그인] ── InboundMessage ──> [MessageRouter.route()]
                                            │
                                    1. deriveSessionKey()
                                    2. matchBinding()
                                    3. MessageQueue.enqueue()
                                            │
                                     ┌──────┴──────┐
                                     │             │
                              [즉시 처리]    [큐 대기]
                                     │             │
                              ConcurrencyLane.acquire()
                                     │
                              buildMsgContext()
                                     │
                              onProcess(ctx, match)
                                     │
                              [Phase 8: auto-reply 파이프라인]
```

### 5.2 시그널 핸들링

```typescript
// src/process/signal-handler.ts
import type { FinClawLogger } from '../infra/logger.js';
import type { AsyncDisposable } from '../types/index.js';

/**
 * 우아한 종료 핸들러
 *
 * SIGINT/SIGTERM 수신 시:
 * 1. 새 메시지 수신 중단
 * 2. 진행 중인 메시지 처리 완료 대기 (30초 타임아웃)
 * 3. 리소스 정리 (게이트웨이 잠금 해제, DB 연결 닫기)
 * 4. 프로세스 종료
 */
export function setupGracefulShutdown(logger: FinClawLogger, cleanupFns: AsyncDisposable[]): void {
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

| 조건              | 산출물                                                     | Phase   |
| ----------------- | ---------------------------------------------------------- | ------- |
| 핵심 타입         | MsgContext, InboundMessage, SessionKey, AgentId, ChannelId | Phase 1 |
| Brand 타입 팩토리 | createSessionKey(), createAgentId() 등                     | Phase 1 |
| 로깅              | FinClawLogger                                              | Phase 2 |
| 에러 클래스       | FinClawError 계층                                          | Phase 2 |
| 설정 시스템       | FinClawConfig, loadConfig()                                | Phase 3 |
| 이벤트 큐         | system-events (선택적, 라우팅 이벤트 발행용)               | Phase 2 |

**외부 의존성:** 없음 (Node.js 내장 `node:child_process` 사용)

---

## 7. 산출물 및 검증

### 산출물 목록

| #   | 산출물                    | 검증 방법                                               |
| --- | ------------------------- | ------------------------------------------------------- |
| 1   | 프로세스 spawn + 타임아웃 | spawn.test.ts: 정상 종료, 타임아웃, SIGKILL             |
| 2   | 우아한 종료 핸들러        | SIGINT/SIGTERM 시뮬레이션                               |
| 3   | 동시성 레인               | concurrency-lane.test.ts: 한도 초과 대기, 릴리즈 체인   |
| 4   | 세션 키 도출              | session-key.test.ts: 결정성, 정규화, 파싱               |
| 5   | 바인딩 매칭               | binding-matcher.test.ts: 우선순위, 와일드카드, fallback |
| 6   | 메시지 큐                 | message-queue.test.ts: 직렬화, 우선순위, MAX, drain     |
| 7   | 메시지 라우터             | 통합 테스트: 전체 흐름 (route → queue → process)        |
| 8   | 디바운서                  | debounce 윈도우, maxWait, flush                         |

### 검증 기준

```bash
# 1. 단위 테스트
pnpm test -- test/process/

# 2. 세션 키 결정성 검증
# 동일 입력 → 항상 동일 키
# deriveSessionKey({discord, user1, direct}) === deriveSessionKey({discord, user1, direct})

# 3. 동시성 레인 검증
# maxConcurrent=2일 때 3번째 요청은 대기열에 삽입
# 1번째가 release되면 3번째가 즉시 실행

# 4. 메시지 큐 직렬화 검증
# 동일 세션에 메시지 3개 연속 → 순차 처리 보장

# 5. 전체
pnpm typecheck && pnpm lint && pnpm test
```

---

## 8. 복잡도 및 예상 파일 수

| 항목              | 값                              |
| ----------------- | ------------------------------- |
| **복잡도**        | **M (Medium)**                  |
| 소스 파일         | 10개                            |
| 테스트 파일       | 5개                             |
| **총 파일 수**    | **15개**                        |
| 예상 LOC (소스)   | ~1,080줄                        |
| 예상 LOC (테스트) | ~480줄                          |
| 예상 작업 시간    | 3-4시간                         |
| 신규 의존성       | 0개                             |
| 난이도            | 중간 (동시성 관리, 라우팅 로직) |

**위험 요소:**

- 동시성 레인의 타이머 누수 (cleanup 필요)
- 메시지 큐의 메모리 누적 (비활성 세션 정리 필요)
- 바인딩 매칭 규칙이 설정 변경 시 즉시 반영되어야 함 → Phase 3 설정 핫 리로드와 연동
- 큐 모드 'interrupt'에서 진행 중인 LLM 호출을 취소하려면 AbortSignal 전파 필요 → Phase 9에서 구현
