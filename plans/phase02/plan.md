# Phase 2: 인프라 기반 레이어

## 1. 목표

FinClaw의 최하위 인프라 계층을 구축한다. OpenClaw `src/infra/`(183파일, 31.8K LOC)에서 **금융 AI 에이전트 플랫폼에 필수적인 핵심 인프라만 추출**하여 ~40파일, ~6K LOC 규모로 구현한다.

구현 대상:

- **런타임 가드:** Node.js 22+ 버전 검증, ESM 엔트리포인트 판별
- **환경 정규화:** `FINCLAW_` 접두사 환경 변수 처리, dotenv 로딩
- **구조화 로깅:** tslog 기반 JSON 파일 + 콘솔 pretty 로깅
- **에러 시스템:** 커스텀 에러 클래스 계층, 구조화된 에러 추출
- **재시도/백오프:** 지수 백오프 재시도, jitter, AbortSignal 지원
- **파일시스템 안전:** 원자적 파일 쓰기 (tmp -> rename), 심링크 공격 방지
- **네트워크 보안:** DNS 핀닝 SSRF 방지 (undici 기반)
- **프로세스 잠금:** 파일 기반 뮤텍스 (게이트웨이 단일 인스턴스 보장)
- **포트 관리:** TCP 포트 가용성 확인, 충돌 진단
- **이벤트 시스템:** 인메모리 이벤트 큐 (세션 스코프, MAX 20)
- **경로 해석:** 데이터/설정 디렉토리 경로 결정

---

## 2. OpenClaw 참조

| 참조 문서                                               | 적용할 패턴                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| `openclaw_review/docs/12.인프라-런타임-기반-레이어.md`  | 12개 도메인 3계층 구조, 안정 의존성 원칙(SDP)                     |
| `openclaw_review/deep-dive/12-infrastructure.md`        | runtime-guard, env, gateway-lock, ports, ssrf, retry, errors 상세 |
| `openclaw_review/deep-dive/02-config-state.md`          | atomic write 패턴, 파일 잠금 메커니즘                             |
| `openclaw_review/docs/13.데몬-크론-훅-프로세스-보안.md` | 이벤트 큐, unhandled-rejections 분류                              |

**FinClaw 적응 원칙:**

- OpenClaw의 Bonjour/Tailscale 디스커버리 제외 (단일 서버 운용)
- OpenClaw의 exec-approvals(1,267줄 셸 파싱) 제외 (Phase 7 도구 시스템에서 단순화)
- OpenClaw의 자동 업데이트(update-runner 770줄) 제외 (Docker 배포 전략)
- OpenClaw의 아웃바운드 파이프라인(19파일) 제외 (Phase 8에서 구현)
- OpenClaw의 프로바이더 사용량 추적(15파일) 제외 (Phase 15에서 단순화)

---

## 3. 생성할 파일

### 소스 파일 (25개)

| 파일 경로                           | 역할                                                  | 예상 LOC |
| ----------------------------------- | ----------------------------------------------------- | -------- |
| **런타임 & 환경**                   |                                                       |          |
| `src/infra/index.ts`                | Barrel export                                         | ~40      |
| `src/infra/runtime-guard.ts`        | Node.js 22+ 버전 검증                                 | ~50      |
| `src/infra/env.ts`                  | FINCLAW\_ 접두사 환경 변수 정규화                     | ~60      |
| `src/infra/dotenv.ts`               | .env 파일 로딩                                        | ~40      |
| `src/infra/paths.ts`                | 데이터/설정/로그 디렉토리 경로 해석                   | ~100     |
| `src/infra/is-main.ts`              | ESM 엔트리포인트 판별                                 | ~20      |
| **로깅**                            |                                                       |          |
| `src/infra/logger.ts`               | tslog 기반 구조화 로깅 팩토리                         | ~120     |
| `src/infra/logger-transports.ts`    | 파일(JSON) + 콘솔(pretty) 트랜스포트                  | ~80      |
| **에러**                            |                                                       |          |
| `src/infra/errors.ts`               | 커스텀 에러 클래스 계층                               | ~120     |
| `src/infra/unhandled-rejections.ts` | 5단계 미처리 rejection 분류                           | ~100     |
| **재시도**                          |                                                       |          |
| `src/infra/retry.ts`                | 지수 백오프 재시도 (jitter, shouldRetry, AbortSignal) | ~100     |
| `src/infra/backoff.ts`              | computeBackoff() 순수 함수                            | ~30      |
| `src/infra/dedupe.ts`               | 동일 키 동시 호출 중복 제거                           | ~40      |
| **파일시스템**                      |                                                       |          |
| `src/infra/fs-safe.ts`              | 원자적 파일 쓰기, 안전한 읽기                         | ~80      |
| `src/infra/json-file.ts`            | JSON 파일 원자적 읽기/쓰기                            | ~60      |
| **네트워크**                        |                                                       |          |
| `src/infra/ssrf.ts`                 | DNS 핀닝 SSRF 방지                                    | ~120     |
| `src/infra/fetch.ts`                | SSRF-safe fetch 래퍼                                  | ~50      |
| **프로세스**                        |                                                       |          |
| `src/infra/gateway-lock.ts`         | 파일 기반 뮤텍스                                      | ~150     |
| `src/infra/ports.ts`                | TCP 포트 가용성 확인                                  | ~80      |
| `src/infra/ports-inspect.ts`        | 포트 점유 프로세스 진단                               | ~100     |
| **이벤트**                          |                                                       |          |
| `src/infra/events.ts`               | 타입 안전 EventEmitter 래퍼                           | ~80      |
| `src/infra/system-events.ts`        | 세션 스코프 인메모리 이벤트 큐                        | ~80      |
| `src/infra/agent-events.ts`         | 에이전트 라이프사이클 이벤트                          | ~50      |
| **유틸**                            |                                                       |          |
| `src/infra/format-duration.ts`      | 밀리초 -> "2h 30m 15s" 변환                           | ~30      |
| `src/infra/warnings.ts`             | 중복 경고 억제 래퍼                                   | ~30      |

### 테스트 파일 (15개)

| 파일 경로                                 | 검증 대상                             | 예상 LOC |
| ----------------------------------------- | ------------------------------------- | -------- |
| `test/infra/runtime-guard.test.ts`        | 버전 검증 통과/실패                   | ~40      |
| `test/infra/env.test.ts`                  | 환경 변수 정규화, 빈값 처리           | ~60      |
| `test/infra/paths.test.ts`                | 경로 해석 (HOME, FINCLAW_STATE_DIR)   | ~50      |
| `test/infra/logger.test.ts`               | 로거 생성, 레벨 필터링, 자식 로거     | ~80      |
| `test/infra/errors.test.ts`               | 에러 계층, 구조화 추출                | ~70      |
| `test/infra/unhandled-rejections.test.ts` | 5단계 분류 로직                       | ~80      |
| `test/infra/retry.test.ts`                | 재시도 횟수, 백오프 간격, AbortSignal | ~100     |
| `test/infra/backoff.test.ts`              | computeBackoff 순수 함수              | ~40      |
| `test/infra/dedupe.test.ts`               | 동시 호출 합산, 캐시 만료             | ~60      |
| `test/infra/fs-safe.test.ts`              | 원자적 쓰기, 크래시 시뮬레이션        | ~80      |
| `test/infra/ssrf.test.ts`                 | 사설 IP 차단, DNS 핀닝                | ~80      |
| `test/infra/gateway-lock.test.ts`         | 잠금 획득/해제, stale 감지            | ~100     |
| `test/infra/ports.test.ts`                | 포트 가용성, EADDRINUSE               | ~60      |
| `test/infra/system-events.test.ts`        | 큐 삽입/drain/peek, MAX 제한          | ~60      |
| `test/infra/format-duration.test.ts`      | 시간 포맷팅 경계값                    | ~30      |

**총 파일 수:** 40개 (소스 25 + 테스트 15)

---

## 4. 핵심 인터페이스/타입

### 4.1 로거 인터페이스 (`logger.ts`)

```typescript
// src/infra/logger.ts
import { Logger as TsLogger } from 'tslog';
import type { LogLevel } from '../types/index.js';

export interface LoggerConfig {
  name: string;
  level?: LogLevel;
  file?: {
    enabled: boolean;
    path?: string; // 기본: FINCLAW_STATE_DIR/logs/
    maxSizeMb?: number; // 기본: 10
    maxFiles?: number; // 기본: 5
  };
  console?: {
    enabled: boolean;
    pretty?: boolean; // 기본: !isCI
  };
  redactKeys?: string[]; // 마스킹 대상 키 (token, password, apiKey 등)
}

/** FinClaw 로거 팩토리 */
export function createLogger(config: LoggerConfig): FinClawLogger {
  const tsLogger = new TsLogger({
    name: config.name,
    minLevel: mapLogLevel(config.level ?? 'info'),
    type: config.console?.pretty ? 'pretty' : 'json',
    maskValuesOfKeys: config.redactKeys ?? DEFAULT_REDACT_KEYS,
  });

  // 파일 트랜스포트 부착
  if (config.file?.enabled) {
    attachFileTransport(tsLogger, config.file);
  }

  return wrapLogger(tsLogger);
}

export interface FinClawLogger {
  trace(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  fatal(msg: string, ...args: unknown[]): void;
  child(name: string): FinClawLogger;
}

const DEFAULT_REDACT_KEYS = [
  'token',
  'password',
  'secret',
  'apiKey',
  'api_key',
  'authorization',
  'cookie',
  'botToken',
];
```

### 4.2 에러 클래스 계층 (`errors.ts`)

```typescript
// src/infra/errors.ts

/** FinClaw 기본 에러 -- 모든 커스텀 에러의 상위 클래스 */
export class FinClawError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code: string, statusCode = 500, details?: Record<string, unknown>) {
    super(message);
    this.name = 'FinClawError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

/** 설정 에러 */
export class ConfigError extends FinClawError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFIG_ERROR', 500, details);
    this.name = 'ConfigError';
  }
}

/** 인증 에러 */
export class AuthError extends FinClawError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'AUTH_ERROR', 401, details);
    this.name = 'AuthError';
  }
}

/** Rate limit 에러 */
export class RateLimitError extends FinClawError {
  readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message, 'RATE_LIMITED', 429);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** SSRF 차단 에러 */
export class SsrfBlockedError extends FinClawError {
  constructor(hostname: string, ip: string) {
    super(`SSRF blocked: ${hostname} resolved to private IP ${ip}`, 'SSRF_BLOCKED', 403, {
      hostname,
      ip,
    });
    this.name = 'SsrfBlockedError';
  }
}

/** 게이트웨이 잠금 에러 */
export class GatewayLockError extends FinClawError {
  constructor(message: string) {
    super(message, 'GATEWAY_LOCK_ERROR', 503);
    this.name = 'GatewayLockError';
  }
}

/** 포트 사용 중 에러 */
export class PortInUseError extends FinClawError {
  constructor(port: number, occupiedBy?: string) {
    super(
      `Port ${port} is already in use${occupiedBy ? ` by ${occupiedBy}` : ''}`,
      'PORT_IN_USE',
      503,
      { port, occupiedBy },
    );
    this.name = 'PortInUseError';
  }
}

/** 에러 객체에서 구조화된 정보 추출 */
export function extractErrorInfo(err: unknown): {
  code: string;
  message: string;
  stack?: string;
} {
  if (err instanceof FinClawError) {
    return { code: err.code, message: err.message, stack: err.stack };
  }
  if (err instanceof Error) {
    return { code: 'UNKNOWN', message: err.message, stack: err.stack };
  }
  return { code: 'UNKNOWN', message: String(err) };
}
```

### 4.3 재시도 인터페이스 (`retry.ts`)

```typescript
// src/infra/retry.ts
import { computeBackoff } from './backoff.js';

export interface RetryOptions {
  /** 최대 재시도 횟수 (기본: 3) */
  maxAttempts?: number;
  /** 최소 지연 (ms, 기본: 1000) */
  minDelay?: number;
  /** 최대 지연 (ms, 기본: 30000) */
  maxDelay?: number;
  /** jitter 활성화 (기본: true) */
  jitter?: boolean;
  /** 재시도 조건 함수 */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** 중단 시그널 */
  signal?: AbortSignal;
  /** 서버 제공 retryAfter (ms) */
  retryAfterMs?: number;
  /** 재시도 시 콜백 */
  onRetry?: (error: unknown, attempt: number, delay: number) => void;
}

/**
 * 지수 백오프 재시도
 *
 * OpenClaw의 retry.ts(128줄) 패턴을 따른다.
 * delay = min(maxDelay, 2^attempt * minDelay) + jitter
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    minDelay = 1000,
    maxDelay = 30000,
    jitter = true,
    shouldRetry = defaultShouldRetry,
    signal,
    onRetry,
  } = opts;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new Error('Retry aborted');
    }

    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      if (attempt >= maxAttempts - 1 || !shouldRetry(error, attempt)) {
        throw error;
      }

      const delay = computeBackoff(attempt, { minDelay, maxDelay, jitter });
      const finalDelay = opts.retryAfterMs ? Math.max(delay, opts.retryAfterMs) : delay;

      onRetry?.(error, attempt, finalDelay);
      await sleep(finalDelay, signal);
    }
  }

  throw lastError;
}

function defaultShouldRetry(error: unknown): boolean {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return TRANSIENT_ERROR_CODES.has(code ?? '');
  }
  return false;
}

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Sleep aborted'));
      },
      { once: true },
    );
  });
}
```

### 4.4 SSRF 방지 (`ssrf.ts`)

```typescript
// src/infra/ssrf.ts
import { resolve as dnsResolve } from 'node:dns/promises';
import { SsrfBlockedError } from './errors.js';

/**
 * DNS 핀닝 기반 SSRF 방지 에이전트 생성
 *
 * OpenClaw net/ssrf.ts(242줄) 패턴:
 * 1. DNS 해석 -> 모든 주소가 사설 IP인지 검사
 * 2. 검증된 IP를 핀닝하여 DNS 재해석 방지 (TOCTOU 공격 차단)
 */
export async function validateUrlSafety(url: string): Promise<string> {
  const { hostname } = new URL(url);

  // 호스트명 수준 차단
  if (BLOCKED_HOSTNAMES.some((pattern) => hostname.endsWith(pattern))) {
    throw new SsrfBlockedError(hostname, hostname);
  }

  // DNS 해석 및 IP 검사
  const addresses = await dnsResolve(hostname);
  for (const addr of addresses) {
    if (isPrivateIp(addr)) {
      throw new SsrfBlockedError(hostname, addr);
    }
  }

  return addresses[0]; // 핀닝용 IP 반환
}

/** 사설 IP 판별 -- IPv4, IPv6, IPv4-mapped-IPv6 모두 처리 */
export function isPrivateIp(ip: string): boolean {
  // IPv4-mapped-IPv6 (::ffff:x.x.x.x)
  if (ip.startsWith('::ffff:')) {
    return isPrivateIpv4(ip.slice(7));
  }

  // IPv6
  if (ip.includes(':')) {
    return isPrivateIpv6(ip);
  }

  // IPv4
  return isPrivateIpv4(ip);
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;

  const [a, b] = parts;
  return (
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) || // 169.254.0.0/16 (link-local)
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 (CGNAT)
    a === 0 // 0.0.0.0/8
  );
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return (
    normalized === '::1' || // loopback
    normalized.startsWith('fe80:') || // link-local
    normalized.startsWith('fc') || // unique local
    normalized.startsWith('fd') // unique local
  );
}

const BLOCKED_HOSTNAMES = ['localhost', '.local', '.internal', '.localhost'];
```

### 4.5 게이트웨이 잠금 (`gateway-lock.ts`)

```typescript
// src/infra/gateway-lock.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { GatewayLockError } from './errors.js';

export interface GatewayLockHandle {
  lockPath: string;
  pid: number;
  acquiredAt: number;
  release(): Promise<void>;
}

export interface GatewayLockOptions {
  lockDir: string;
  timeoutMs?: number; // 기본: 5000
  pollIntervalMs?: number; // 기본: 100
  staleThresholdMs?: number; // 기본: 30000
}

/**
 * 파일 기반 뮤텍스로 게이트웨이 단일 인스턴스 보장
 *
 * OpenClaw gateway-lock.ts(243줄) 패턴:
 * 1. fs.open('wx') exclusive 생성
 * 2. EEXIST -> 기존 파일의 PID 유효성 검증
 * 3. stale 감지 -> 파일 삭제 후 재시도
 * 4. 타임아웃 초과 -> GatewayLockError throw
 */
export async function acquireGatewayLock(opts: GatewayLockOptions): Promise<GatewayLockHandle> {
  const { lockDir, timeoutMs = 5000, pollIntervalMs = 100, staleThresholdMs = 30000 } = opts;

  const lockPath = path.join(lockDir, 'gateway.lock');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const fd = await fs.open(lockPath, 'wx');
      const payload = JSON.stringify({
        pid: process.pid,
        acquiredAt: Date.now(),
      });
      await fd.write(payload);
      await fd.close();

      return {
        lockPath,
        pid: process.pid,
        acquiredAt: Date.now(),
        release: async () => {
          try {
            await fs.unlink(lockPath);
          } catch {
            /* ignore */
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      // 기존 잠금 검사
      await handleExistingLock(lockPath, staleThresholdMs);
      await sleep(pollIntervalMs);
    }
  }

  throw new GatewayLockError(
    `Timeout acquiring gateway lock after ${timeoutMs}ms. ` + 'Another instance may be running.',
  );
}

async function handleExistingLock(lockPath: string, staleThresholdMs: number): Promise<void> {
  try {
    const stat = await fs.stat(lockPath);
    const age = Date.now() - stat.mtimeMs;

    if (age > staleThresholdMs) {
      // stale 잠금 -> 강제 삭제
      await fs.unlink(lockPath);
    }
  } catch {
    // 파일이 이미 삭제됨 -> 다음 루프에서 재시도
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

### 4.6 시스템 이벤트 큐 (`system-events.ts`)

```typescript
// src/infra/system-events.ts
import type { SessionKey, Timestamp } from '../types/index.js';

const MAX_EVENTS_PER_SESSION = 20;

export interface SystemEvent {
  type: string;
  sessionKey: SessionKey;
  payload: unknown;
  timestamp: Timestamp;
}

/** 세션별 이벤트 큐 저장소 */
const queues = new Map<string, SystemEvent[]>();

/**
 * 이벤트 추가
 *
 * OpenClaw system-events.ts 패턴:
 * - MAX 20 제한, 초과 시 가장 오래된 것 삭제 (shift)
 * - 연속 중복 자동 스킵
 */
export function pushSystemEvent(event: SystemEvent): void {
  const key = event.sessionKey as string;
  let queue = queues.get(key);
  if (!queue) {
    queue = [];
    queues.set(key, queue);
  }

  // 연속 중복 스킵
  const last = queue[queue.length - 1];
  if (last && last.type === event.type && last.payload === event.payload) {
    return;
  }

  queue.push(event);

  // MAX 제한
  while (queue.length > MAX_EVENTS_PER_SESSION) {
    queue.shift();
  }
}

/** 큐를 비우며 모든 이벤트 반환 (소비적) */
export function drainSystemEvents(sessionKey: SessionKey): SystemEvent[] {
  const key = sessionKey as string;
  const queue = queues.get(key);
  if (!queue || queue.length === 0) return [];
  const events = [...queue];
  queue.length = 0;
  return events;
}

/** 큐를 비우지 않고 조회 */
export function peekSystemEvents(sessionKey: SessionKey): readonly SystemEvent[] {
  const key = sessionKey as string;
  return queues.get(key) ?? [];
}

/** 특정 세션의 큐 삭제 */
export function clearSystemEvents(sessionKey: SessionKey): void {
  queues.delete(sessionKey as string);
}
```

---

## 5. 구현 상세

### 5.1 모듈 계층 구조

OpenClaw의 안정 의존성 원칙(SDP)을 따라 3계층으로 구성한다.

```
최하위 (Ce=0, 안정 기반):
  errors.ts, backoff.ts, format-duration.ts, warnings.ts
  → 외부 의존 없는 순수 함수/클래스

중간 (설정/경로에만 의존):
  env.ts, paths.ts, logger.ts, retry.ts, fs-safe.ts, ssrf.ts
  → 최하위 모듈 + node: 내장만 의존

최상위 (여러 도메인 조합):
  gateway-lock.ts, ports.ts, unhandled-rejections.ts
  → 중간 모듈을 조합하는 오케스트레이터
```

### 5.2 런타임 가드

```typescript
// src/infra/runtime-guard.ts
const MINIMUM_NODE_VERSION = 22;

export function assertSupportedRuntime(): void {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < MINIMUM_NODE_VERSION) {
    console.error(
      `FinClaw requires Node.js ${MINIMUM_NODE_VERSION} or later.\n` +
        `Current version: ${process.versions.node}\n` +
        `Install: https://nodejs.org/`,
    );
    process.exit(1);
  }
}
```

### 5.3 환경 변수 정규화

```typescript
// src/infra/env.ts
const FINCLAW_PREFIX = 'FINCLAW_';

export function normalizeEnv(): void {
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(FINCLAW_PREFIX)) continue;

    // 빈 문자열 -> undefined 정규화 (OpenClaw 패턴)
    if (value === '') {
      delete process.env[key];
    }
  }
}

export function getEnv(key: string, fallback?: string): string | undefined {
  return process.env[`${FINCLAW_PREFIX}${key}`] ?? process.env[key] ?? fallback;
}

export function requireEnv(key: string): string {
  const value = getEnv(key);
  if (!value) {
    throw new Error(`Required environment variable not set: ${FINCLAW_PREFIX}${key} or ${key}`);
  }
  return value;
}
```

### 5.4 원자적 파일 쓰기

```typescript
// src/infra/fs-safe.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * 원자적 파일 쓰기 -- OpenClaw fs-safe.ts(103줄) 패턴
 *
 * 1. 임시 파일에 쓰기 (PID+UUID로 충돌 방지)
 * 2. rename()으로 원자적 교체
 * 3. Windows fallback: copyFile + chmod + unlink
 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
  mode = 0o600,
): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpName = `.tmp.${process.pid}.${crypto.randomUUID()}`;
  const tmpPath = path.join(dir, tmpName);

  try {
    await fs.writeFile(tmpPath, data, { mode });
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    // Windows fallback (EPERM/EEXIST on rename)
    if (isWindowsRenameError(err)) {
      await fs.copyFile(tmpPath, filePath);
      await fs.chmod(filePath, mode);
      await fs.unlink(tmpPath).catch(() => {});
    } else {
      // 임시 파일 정리
      await fs.unlink(tmpPath).catch(() => {});
      throw err;
    }
  }
}

function isWindowsRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return process.platform === 'win32' && (code === 'EPERM' || code === 'EEXIST');
}
```

### 5.5 unhandled-rejections 5단계 분류

```typescript
// src/infra/unhandled-rejections.ts

/**
 * OpenClaw unhandled-rejections.ts(160줄) 패턴:
 * L1: AbortError -> warn
 * L2: Fatal (OOM, 시스템) -> exit
 * L3: Config (설정/인증) -> exit
 * L4: Transient (네트워크) -> warn
 * L5: 기타 -> exit
 */
export function setupUnhandledRejectionHandler(logger: {
  warn: (msg: string) => void;
  error: (msg: string) => void;
}): void {
  process.on('unhandledRejection', (reason: unknown) => {
    const level = classifyError(reason);

    switch (level) {
      case 'abort':
      case 'transient':
        logger.warn(`Unhandled rejection (${level}): ${String(reason)}`);
        break;
      default:
        logger.error(`Fatal unhandled rejection (${level}): ${String(reason)}`);
        process.exit(1);
    }
  });
}

type ErrorLevel = 'abort' | 'fatal' | 'config' | 'transient' | 'unknown';

function classifyError(err: unknown): ErrorLevel {
  if (isAbortError(err)) return 'abort';
  if (isFatalError(err)) return 'fatal';
  if (isConfigError(err)) return 'config';
  if (isTransientError(err)) return 'transient';
  return 'unknown';
}
```

### 5.6 데이터 흐름

```
[프로세스 시작]
      │
      ├── runtime-guard.ts     → Node 22+ 검증
      ├── dotenv.ts            → .env 로딩
      ├── env.ts               → FINCLAW_ 변수 정규화
      ├── paths.ts             → 디렉토리 경로 해석
      ├── logger.ts            → 로거 초기화
      ├── unhandled-rejections → 에러 핸들러 등록
      │
      ├── gateway-lock.ts      → 단일 인스턴스 보장
      ├── ports.ts             → 포트 가용성 확인
      │
      └── [이후 Phase에서 사용]
          ├── retry.ts         → API 호출 재시도
          ├── ssrf.ts          → 외부 요청 보안
          ├── fs-safe.ts       → 설정/세션 파일 쓰기
          └── system-events.ts → 이벤트 수집/소비
```

---

## 6. 선행 조건

| 조건               | 산출물                                            | Phase          |
| ------------------ | ------------------------------------------------- | -------------- |
| 핵심 타입 정의     | `src/types/` (LogLevel, Timestamp, SessionKey 등) | Phase 1        |
| Brand 타입 팩토리  | `createTimestamp()`, `createSessionKey()`         | Phase 1        |
| 빌드/테스트 인프라 | tsc, tsgo, vitest, oxlint                         | Phase 0 (완료) |

**신규 외부 의존성:** `tslog` (구조화 로깅)

```bash
pnpm add tslog
```

---

## 7. 산출물 및 검증

### 산출물 목록

| #   | 산출물                            | 검증 방법                                         |
| --- | --------------------------------- | ------------------------------------------------- |
| 1   | `src/infra/` 디렉토리 (25개 파일) | `pnpm typecheck` 통과                             |
| 2   | 런타임 가드                       | Node 22 미만에서 프로세스 종료 확인               |
| 3   | 구조화 로거                       | JSON 파일 출력 + 콘솔 pretty 출력 확인            |
| 4   | 에러 클래스 계층                  | `instanceof` 체인 + `extractErrorInfo()` 테스트   |
| 5   | 재시도 유틸                       | 재시도 횟수, 백오프 간격, AbortSignal 중단 테스트 |
| 6   | 원자적 파일 쓰기                  | 동시 쓰기 시 데이터 무결성 테스트                 |
| 7   | SSRF 방지                         | 사설 IP(10.x, 172.16.x, ::1 등) 차단 테스트       |
| 8   | 게이트웨이 잠금                   | 잠금 획득/해제, stale 감지, 타임아웃 테스트       |
| 9   | 포트 관리                         | EADDRINUSE 감지 테스트                            |
| 10  | 이벤트 큐                         | MAX 20 제한, drain/peek 소비 패턴 테스트          |
| 11  | 테스트 파일 (15개)                | `pnpm test` 전체 통과                             |

### 검증 기준

```bash
# 1. 타입 체크 통과
pnpm typecheck       # 에러 0

# 2. 빌드 통과
pnpm build           # dist/ 생성 확인

# 3. 단위 테스트 통과 (15개 파일)
pnpm test            # 전체 통과, 커버리지 70%+

# 4. 린트 통과
pnpm lint            # 에러 0

# 5. 순환 의존 없음
# errors.ts, backoff.ts는 Fan-In 0 유지

# 6. 통합 검증
# runtime-guard -> env -> paths -> logger -> gateway-lock -> ports
# 순서대로 호출하여 프로세스 초기화 시나리오 통과
```

---

## 8. 복잡도 및 예상 파일 수

| 항목              | 값                                          |
| ----------------- | ------------------------------------------- |
| **복잡도**        | **L (Large)**                               |
| 소스 파일         | 25개                                        |
| 테스트 파일       | 15개                                        |
| **총 파일 수**    | **40개**                                    |
| 예상 LOC (소스)   | ~1,780줄                                    |
| 예상 LOC (테스트) | ~990줄                                      |
| 예상 작업 시간    | 5-7시간                                     |
| 신규 의존성       | 1개 (tslog)                                 |
| 난이도            | 중간 (파일 I/O, 네트워크 보안, 동시성 잠금) |

**위험 요소:**

- gateway-lock의 Windows 호환성 (EPERM rename fallback)
- SSRF 방지에서 IPv6/CGNAT 엣지 케이스
- tslog 트랜스포트 설정이 로그 로테이션에 미치는 영향
- 파일 잠금의 NFS/네트워크 파일시스템 비호환 (FinClaw는 로컬 전용이므로 수용 가능)
