# Phase 2: 인프라 기반 레이어

## 1. 목표

FinClaw의 최하위 인프라 계층을 `packages/infra/` 패키지로 구축한다. OpenClaw `src/infra/`(183파일, 31.8K LOC)에서 **금융 AI 에이전트 플랫폼에 필수적인 핵심 인프라만 추출**하여 ~47파일, ~3.2K LOC 규모로 구현한다.

구현 대상:

- **런타임 가드:** Node.js 22+ 버전 검증, ESM 엔트리포인트 판별
- **환경 정규화:** `FINCLAW_` 접두사 환경 변수 처리, `process.loadEnvFile()` 기반 .env 로딩
- **요청 컨텍스트:** AsyncLocalStorage 기반 요청별 컨텍스트 전파
- **구조화 로깅:** tslog 기반 JSON 파일 + 콘솔 pretty 로깅, `LoggerFactory` 인터페이스, ALS 컨텍스트 자동 주입
- **에러 시스템:** 하이브리드 에러 계층 (`isOperational`, `Error.cause`), 도메인 에러 co-location
- **재시도/백오프:** 지수 백오프 재시도, jitter, AbortSignal 지원, `sleepWithAbort()` (`node:timers/promises`)
- **서킷 브레이커:** 경량 Circuit Breaker (외부 서비스 장애 격리)
- **파일시스템 안전:** 원자적 파일 쓰기 (tmp → rename), 심링크 공격 방지 (`O_NOFOLLOW`)
- **네트워크 보안:** DNS 핀닝 SSRF 방지, `SsrfPolicy` 기반 정책 분리, 네이티브 fetch (`AbortSignal.timeout()`, `redirect: 'error'`)
- **프로세스 잠금:** 파일 기반 뮤텍스 (게이트웨이 단일 인스턴스 보장 + 포트 프로빙)
- **포트 관리:** TCP 포트 가용성 확인, 충돌 진단
- **이벤트 시스템:** `TypedEmitter<FinClawEventMap>` 패턴, 인메모리 이벤트 큐 (세션 스코프, MAX 20)
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

**실소스 괴리 보정표:**

| OpenClaw 참조          | 기존 plan.md 기술             | 실제 적용                                            |
| ---------------------- | ----------------------------- | ---------------------------------------------------- |
| `src/infra/` (flat)    | `src/infra/`                  | `packages/infra/src/` (모노레포 패키지)              |
| undici 기반 SSRF Agent | undici Agent                  | 네이티브 fetch + DNS 핀닝 + `SsrfPolicy`             |
| dotenv 패키지          | `pnpm add dotenv`             | `process.loadEnvFile()` (Node 22 내장)               |
| errors.ts 집중 에러    | 6개 에러 클래스 한 파일       | 인프라 에러만 co-locate, 도메인 에러 각 Phase로 분산 |
| sleep() 자체 구현      | `setTimeout` + `Promise` 래퍼 | `node:timers/promises` `setTimeout` + `AbortSignal`  |

---

## 3. 생성할 파일

### 인프라 파일 (2개)

| 파일 경로                      | 역할                               |
| ------------------------------ | ---------------------------------- |
| `packages/infra/package.json`  | 패키지 메타, `@finclaw/types` 의존 |
| `packages/infra/tsconfig.json` | `composite: true`, 프로젝트 참조   |

> 루트 `tsconfig.json`의 `references`에 `packages/infra` 추가 필요

### 소스 파일 (27개)

| 파일 경로                                    | 역할                                                                               | 예상 LOC |
| -------------------------------------------- | ---------------------------------------------------------------------------------- | -------- |
| **런타임 & 환경**                            |                                                                                    |          |
| `packages/infra/src/index.ts`                | Barrel export                                                                      | ~45      |
| `packages/infra/src/runtime-guard.ts`        | Node.js 22+ 버전 검증                                                              | ~50      |
| `packages/infra/src/env.ts`                  | `FINCLAW_` 접두사 환경 변수 정규화, `logAcceptedEnvOption()`, `isTruthyEnvValue()` | ~75      |
| `packages/infra/src/dotenv.ts`               | `process.loadEnvFile()` 기반 .env 로딩 (dotenv 패키지 불필요)                      | ~15      |
| `packages/infra/src/paths.ts`                | 데이터/설정/로그 디렉토리 경로 해석                                                | ~100     |
| `packages/infra/src/is-main.ts`              | ESM 엔트리포인트 판별                                                              | ~20      |
| **컨텍스트**                                 |                                                                                    |          |
| `packages/infra/src/context.ts`              | AsyncLocalStorage 기반 요청 컨텍스트                                               | ~50      |
| **로깅**                                     |                                                                                    |          |
| `packages/infra/src/logger.ts`               | tslog 기반 구조화 로깅 팩토리, `LoggerFactory`, `flush()`, ALS 자동 주입           | ~140     |
| `packages/infra/src/logger-transports.ts`    | 파일(JSON) + 콘솔(pretty) 트랜스포트                                               | ~80      |
| **에러**                                     |                                                                                    |          |
| `packages/infra/src/errors.ts`               | 하이브리드 에러 계층 (`isOperational`, `Error.cause`), 유틸리티                    | ~100     |
| `packages/infra/src/unhandled-rejections.ts` | 5단계 미처리 rejection 분류                                                        | ~100     |
| **재시도**                                   |                                                                                    |          |
| `packages/infra/src/retry.ts`                | 지수 백오프 재시도, `resolveRetryConfig()`                                         | ~110     |
| `packages/infra/src/backoff.ts`              | `computeBackoff()` 순수 함수, `sleepWithAbort()` (`node:timers/promises`)          | ~40      |
| `packages/infra/src/dedupe.ts`               | 동일 키 동시 호출 중복 제거, TTL + maxSize, check/peek/clear/size                  | ~65      |
| `packages/infra/src/circuit-breaker.ts`      | 경량 Circuit Breaker (closed → open → half-open)                                   | ~90      |
| **파일시스템**                               |                                                                                    |          |
| `packages/infra/src/fs-safe.ts`              | 원자적 파일 쓰기, 심링크 검사 강화 (`O_NOFOLLOW`)                                  | ~90      |
| `packages/infra/src/json-file.ts`            | JSON 파일 원자적 읽기/쓰기, 동기 API, `0o600` 퍼미션                               | ~65      |
| **네트워크**                                 |                                                                                    |          |
| `packages/infra/src/ssrf.ts`                 | DNS 핀닝 SSRF 방지, `SsrfPolicy` 기반 정책 분리                                    | ~135     |
| `packages/infra/src/fetch.ts`                | `SafeFetchOptions`, 네이티브 fetch, `AbortSignal.timeout()`, `redirect: 'error'`   | ~75      |
| **프로세스**                                 |                                                                                    |          |
| `packages/infra/src/gateway-lock.ts`         | 파일 기반 뮤텍스, 포트 프로빙, `signal`, `GatewayLockError` co-located             | ~165     |
| `packages/infra/src/ports.ts`                | TCP 포트 가용성 확인                                                               | ~80      |
| `packages/infra/src/ports-inspect.ts`        | 포트 점유 프로세스 진단                                                            | ~100     |
| **이벤트**                                   |                                                                                    |          |
| `packages/infra/src/events.ts`               | `TypedEmitter<FinClawEventMap>` 패턴                                               | ~95      |
| `packages/infra/src/system-events.ts`        | 세션 스코프 인메모리 이벤트 큐, `contextKey` 변경 감지, `resetForTest()`           | ~90      |
| `packages/infra/src/agent-events.ts`         | 에이전트 라이프사이클 이벤트                                                       | ~50      |
| **유틸**                                     |                                                                                    |          |
| `packages/infra/src/format-duration.ts`      | 밀리초 → "2h 30m 15s" 변환                                                         | ~30      |
| `packages/infra/src/warnings.ts`             | 중복 경고 억제 래퍼                                                                | ~30      |

### 테스트 파일 (18개)

| 파일 경로                                          | 검증 대상                                        | 예상 LOC |
| -------------------------------------------------- | ------------------------------------------------ | -------- |
| `packages/infra/test/runtime-guard.test.ts`        | 버전 검증 통과/실패                              | ~40      |
| `packages/infra/test/env.test.ts`                  | 환경 변수 정규화, 빈값 처리, `isTruthyEnvValue`  | ~70      |
| `packages/infra/test/paths.test.ts`                | 경로 해석 (HOME, FINCLAW_STATE_DIR)              | ~50      |
| `packages/infra/test/context.test.ts`              | ALS 컨텍스트 전파, 중첩 실행                     | ~50      |
| `packages/infra/test/logger.test.ts`               | 로거 생성, 레벨 필터링, 자식 로거, flush         | ~80      |
| `packages/infra/test/errors.test.ts`               | 에러 계층, `isOperational`, `Error.cause` 체이닝 | ~80      |
| `packages/infra/test/unhandled-rejections.test.ts` | 5단계 분류 로직                                  | ~80      |
| `packages/infra/test/retry.test.ts`                | 재시도 횟수, 백오프 간격, AbortSignal            | ~100     |
| `packages/infra/test/backoff.test.ts`              | `computeBackoff`, `sleepWithAbort` 순수 함수     | ~50      |
| `packages/infra/test/dedupe.test.ts`               | 동시 호출 합산, TTL 만료, maxSize                | ~70      |
| `packages/infra/test/circuit-breaker.test.ts`      | 상태 전이 (closed→open→half-open→closed)         | ~70      |
| `packages/infra/test/fs-safe.test.ts`              | 원자적 쓰기, 심링크 차단, 크래시 시뮬레이션      | ~80      |
| `packages/infra/test/ssrf.test.ts`                 | 사설 IP 차단, DNS 핀닝, `SsrfPolicy`             | ~80      |
| `packages/infra/test/fetch.test.ts`                | `SafeHttpClient`, `redirect: 'error'`, 타임아웃  | ~60      |
| `packages/infra/test/gateway-lock.test.ts`         | 잠금 획득/해제, stale 감지, signal 취소          | ~100     |
| `packages/infra/test/ports.test.ts`                | 포트 가용성, EADDRINUSE                          | ~60      |
| `packages/infra/test/system-events.test.ts`        | 큐 삽입/drain/peek, MAX 제한, `resetForTest`     | ~70      |
| `packages/infra/test/format-duration.test.ts`      | 시간 포맷팅 경계값                               | ~30      |

**총 파일 수:** 47개 (소스 27 + 테스트 18 + 인프라 2)

---

## 4. 핵심 인터페이스/타입

### 4.1 로거 인터페이스 (`logger.ts`)

```typescript
// packages/infra/src/logger.ts
import { Logger as TsLogger } from 'tslog';
import type { LogLevel } from '@finclaw/types';

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
  autoInjectContext?: boolean; // ALS 요청 컨텍스트 자동 주입 (기본: true)
}

/** 로거 팩토리 인터페이스 — DI/테스트 교체 지점 */
export interface LoggerFactory {
  create(config: LoggerConfig): FinClawLogger;
}

/** FinClaw 로거 팩토리 (기본 구현) */
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

  return wrapLogger(tsLogger, config.autoInjectContext ?? true);
}

export interface FinClawLogger {
  trace(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  fatal(msg: string, ...args: unknown[]): void;
  child(name: string): FinClawLogger;
  flush(): Promise<void>; // 버퍼 강제 플러시 (graceful shutdown)
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
// packages/infra/src/errors.ts

/** FinClaw 기본 에러 — 모든 커스텀 에러의 상위 클래스 */
export class FinClawError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly isOperational: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    opts: {
      statusCode?: number;
      isOperational?: boolean;
      cause?: Error;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'FinClawError';
    this.code = code;
    this.statusCode = opts.statusCode ?? 500;
    this.isOperational = opts.isOperational ?? true;
    this.details = opts.details;
  }
}

/** SSRF 차단 에러 */
export class SsrfBlockedError extends FinClawError {
  constructor(hostname: string, ip: string) {
    super(`SSRF blocked: ${hostname} resolved to private IP ${ip}`, 'SSRF_BLOCKED', {
      statusCode: 403,
      details: { hostname, ip },
    });
    this.name = 'SsrfBlockedError';
  }
}

/** 포트 사용 중 에러 */
export class PortInUseError extends FinClawError {
  constructor(port: number, occupiedBy?: string) {
    super(`Port ${port} is already in use${occupiedBy ? ` by ${occupiedBy}` : ''}`, 'PORT_IN_USE', {
      statusCode: 503,
      details: { port, occupiedBy },
    });
    this.name = 'PortInUseError';
  }
}

// ──────────────────────────────────────────────
// 도메인 에러 co-location 원칙:
//   ConfigError    → packages/config/src/errors.ts    (Phase 3)
//   AuthError      → packages/channel-discord/src/    (Phase 5)
//   RateLimitError → packages/skills-finance/src/     (Phase 4)
//   GatewayLockError → packages/infra/src/gateway-lock.ts (co-located)
// ──────────────────────────────────────────────

/** 타입 가드 */
export function isFinClawError(err: unknown): err is FinClawError {
  return err instanceof FinClawError;
}

/** 에러 래핑 유틸 — cause 체이닝 */
export function wrapError(message: string, code: string, cause: unknown): FinClawError {
  return new FinClawError(message, code, {
    cause: cause instanceof Error ? cause : new Error(String(cause)),
  });
}

/** 에러 객체에서 구조화된 정보 추출 */
export function extractErrorInfo(err: unknown): {
  code: string;
  message: string;
  isOperational?: boolean;
  stack?: string;
  cause?: string;
} {
  if (err instanceof FinClawError) {
    return {
      code: err.code,
      message: err.message,
      isOperational: err.isOperational,
      stack: err.stack,
      cause: err.cause instanceof Error ? err.cause.message : undefined,
    };
  }
  if (err instanceof Error) {
    return { code: 'UNKNOWN', message: err.message, stack: err.stack };
  }
  return { code: 'UNKNOWN', message: String(err) };
}
```

### 4.3 재시도 인터페이스 (`retry.ts`)

```typescript
// packages/infra/src/retry.ts
import { computeBackoff, sleepWithAbort } from './backoff.js';

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

/** Partial config → 완전한 config으로 병합 (기본값 적용) */
export function resolveRetryConfig(
  partial?: Partial<RetryOptions>,
): Required<Pick<RetryOptions, 'maxAttempts' | 'minDelay' | 'maxDelay' | 'jitter'>> {
  return {
    maxAttempts: partial?.maxAttempts ?? 3,
    minDelay: partial?.minDelay ?? 1000,
    maxDelay: partial?.maxDelay ?? 30000,
    jitter: partial?.jitter ?? true,
  };
}

/**
 * 지수 백오프 재시도
 *
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
      await sleepWithAbort(finalDelay, signal);
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
```

### 4.4 SSRF 방지 (`ssrf.ts`)

```typescript
// packages/infra/src/ssrf.ts
import { resolve as dnsResolve } from 'node:dns/promises';
import { SsrfBlockedError } from './errors.js';

/** SSRF 정책 설정 */
export interface SsrfPolicy {
  /** 사설 네트워크 허용 (테스트/개발용, 기본: false) */
  allowPrivateNetwork?: boolean;
  /** 추가 허용 호스트명 (정책 우회) */
  hostnameAllowlist?: string[];
}

/**
 * DNS 핀닝 기반 SSRF 방지
 *
 * 1. DNS 해석 → 모든 주소가 사설 IP인지 검사
 * 2. 검증된 IP를 핀닝하여 DNS 재해석 방지 (TOCTOU 공격 차단)
 */
export async function validateUrlSafety(url: string, policy?: SsrfPolicy): Promise<string> {
  const { hostname } = new URL(url);

  // 허용 목록 우선 통과
  if (policy?.hostnameAllowlist?.includes(hostname)) {
    const addresses = await dnsResolve(hostname);
    return addresses[0];
  }

  // 호스트명 수준 차단
  if (BLOCKED_HOSTNAMES.some((pattern) => hostname.endsWith(pattern))) {
    throw new SsrfBlockedError(hostname, hostname);
  }

  // DNS 해석 및 IP 검사
  const addresses = await dnsResolve(hostname);
  if (!policy?.allowPrivateNetwork) {
    for (const addr of addresses) {
      if (isPrivateIp(addr)) {
        throw new SsrfBlockedError(hostname, addr);
      }
    }
  }

  return addresses[0]; // 핀닝용 IP 반환
}

/** 사설 IP 판별 — IPv4, IPv6, IPv4-mapped-IPv6 모두 처리 */
export function isPrivateIp(ip: string): boolean {
  if (ip.startsWith('::ffff:')) return isPrivateIpv4(ip.slice(7));
  if (ip.includes(':')) return isPrivateIpv6(ip);
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
// packages/infra/src/gateway-lock.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FinClawError } from './errors.js';

/** Co-located 에러 클래스 */
export class GatewayLockError extends FinClawError {
  constructor(message: string, opts?: { cause?: Error }) {
    super(message, 'GATEWAY_LOCK_ERROR', { statusCode: 503, cause: opts?.cause });
    this.name = 'GatewayLockError';
  }
}

export interface GatewayLockHandle {
  lockPath: string;
  pid: number;
  port?: number;
  acquiredAt: number;
  release(): Promise<void>;
}

export interface GatewayLockOptions {
  lockDir: string;
  timeoutMs?: number; // 기본: 5000
  pollIntervalMs?: number; // 기본: 100
  staleThresholdMs?: number; // 기본: 30000
  port?: number; // lock 파일에 기록할 포트 (프로빙용)
  signal?: AbortSignal; // 취소 시그널
}

/**
 * 파일 기반 뮤텍스로 게이트웨이 단일 인스턴스 보장
 *
 * 1. fs.open('wx') exclusive 생성
 * 2. EEXIST → 기존 파일의 PID 유효성 검증
 * 3. stale 감지 → 파일 삭제 후 재시도
 * 4. 타임아웃/signal → GatewayLockError throw (Error.cause 포함)
 */
export async function acquireGatewayLock(opts: GatewayLockOptions): Promise<GatewayLockHandle> {
  const {
    lockDir,
    timeoutMs = 5000,
    pollIntervalMs = 100,
    staleThresholdMs = 30000,
    port,
    signal,
  } = opts;

  const lockPath = path.join(lockDir, 'gateway.lock');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new GatewayLockError('Lock acquisition aborted');
    }

    try {
      const fd = await fs.open(lockPath, 'wx');
      const payload = JSON.stringify({
        pid: process.pid,
        port,
        acquiredAt: Date.now(),
      });
      await fd.write(payload);
      await fd.close();

      return {
        lockPath,
        pid: process.pid,
        port,
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
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new GatewayLockError('Failed to create lock file', {
          cause: err instanceof Error ? err : undefined,
        });
      }

      // 기존 잠금 검사
      await handleExistingLock(lockPath, staleThresholdMs);
      await sleep(pollIntervalMs);
    }
  }

  throw new GatewayLockError(
    `Timeout acquiring gateway lock after ${timeoutMs}ms. Another instance may be running.`,
  );
}

async function handleExistingLock(lockPath: string, staleThresholdMs: number): Promise<void> {
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs > staleThresholdMs) {
      await fs.unlink(lockPath);
    }
  } catch {
    // 파일이 이미 삭제됨 → 다음 루프에서 재시도
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

### 4.6 시스템 이벤트 큐 (`system-events.ts`)

```typescript
// packages/infra/src/system-events.ts
import type { SessionKey, Timestamp } from '@finclaw/types';

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
  return queues.get(sessionKey as string) ?? [];
}

/** 특정 세션의 큐 삭제 */
export function clearSystemEvents(sessionKey: SessionKey): void {
  queues.delete(sessionKey as string);
}

/** contextKey 변경 감지 — 키가 바뀌면 이전 세션 큐 정리 */
export function onContextKeyChange(oldKey: SessionKey, newKey: SessionKey): void {
  if (oldKey !== newKey) {
    clearSystemEvents(oldKey);
  }
}

/** 테스트용 전체 상태 초기화 */
export function resetForTest(): void {
  queues.clear();
}
```

### 4.7 요청 컨텍스트 (`context.ts`)

```typescript
// packages/infra/src/context.ts
import { AsyncLocalStorage } from 'node:async_hooks';

/** 요청별 컨텍스트 */
export interface RequestContext {
  requestId: string;
  sessionKey?: string;
  startedAt: number;
}

const als = new AsyncLocalStorage<RequestContext>();

/** 컨텍스트를 주입하고 콜백 실행 */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/** 현재 컨텍스트 조회 (없으면 undefined) */
export function getContext(): RequestContext | undefined {
  return als.getStore();
}

/** 현재 요청 ID (로깅 등에서 편의 사용) */
export function getRequestId(): string | undefined {
  return als.getStore()?.requestId;
}
```

### 4.8 서킷 브레이커 (`circuit-breaker.ts`)

```typescript
// packages/infra/src/circuit-breaker.ts

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** open 전환 실패 임계 (기본: 5) */
  failureThreshold?: number;
  /** open → half-open 전환 대기 시간 (기본: 30_000ms) */
  resetTimeoutMs?: number;
  /** half-open에서 시도할 최대 요청 수 (기본: 1) */
  halfOpenMaxAttempts?: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastFailureAt = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxAttempts: number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 30_000;
    this.halfOpenMaxAttempts = opts.halfOpenMaxAttempts ?? 1;
  }

  /** 보호된 함수 실행 */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureAt >= this.resetTimeoutMs) {
        this.state = 'half-open';
      } else {
        throw new Error(`Circuit is open (failures: ${this.failures})`);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  getState(): CircuitState {
    return this.state;
  }
  reset(): void {
    this.state = 'closed';
    this.failures = 0;
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureAt = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
    }
  }
}

export function createCircuitBreaker(opts?: CircuitBreakerOptions): CircuitBreaker {
  return new CircuitBreaker(opts);
}
```

---

## 5. 구현 상세

### 5.1 모듈 계층 구조

안정 의존성 원칙(SDP)을 따라 3계층으로 구성한다.

```
최하위 (Ce=0, 안정 기반):
  errors.ts, backoff.ts, format-duration.ts, warnings.ts, context.ts
  → 외부 의존 없는 순수 함수/클래스

중간 (설정/경로에만 의존):
  env.ts, paths.ts, logger.ts, retry.ts, fs-safe.ts, ssrf.ts,
  dedupe.ts, circuit-breaker.ts, events.ts
  → 최하위 모듈 + node: 내장만 의존

최상위 (여러 도메인 조합):
  gateway-lock.ts, ports.ts, unhandled-rejections.ts,
  fetch.ts, system-events.ts
  → 중간 모듈을 조합하는 오케스트레이터
```

### 5.2 런타임 가드

```typescript
// packages/infra/src/runtime-guard.ts
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
// packages/infra/src/env.ts
const FINCLAW_PREFIX = 'FINCLAW_';

export function normalizeEnv(): void {
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(FINCLAW_PREFIX)) continue;

    // 빈 문자열 → undefined 정규화
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

/** truthy 환경 변수 판별 ('1', 'true', 'yes') */
export function isTruthyEnvValue(value: string | undefined): boolean {
  return value != null && ['1', 'true', 'yes'].includes(value.toLowerCase());
}

/** 허용된 환경 변수 값을 로그에 기록 (민감 정보 제외) */
export function logAcceptedEnvOption(
  key: string,
  value: string,
  logger: { info: (msg: string) => void },
): void {
  logger.info(`env: ${key} = ${value}`);
}
```

### 5.4 dotenv 재설계

```typescript
// packages/infra/src/dotenv.ts

/**
 * .env 파일 로딩 — Node.js 22+ process.loadEnvFile() 사용
 * dotenv 패키지 불필요
 */
export function loadDotenv(envPath?: string): void {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // .env 파일이 없으면 무시 (선택적 로딩)
  }
}
```

### 5.5 원자적 파일 쓰기

```typescript
// packages/infra/src/fs-safe.ts
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * 원자적 파일 쓰기
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
    if (isWindowsRenameError(err)) {
      await fs.copyFile(tmpPath, filePath);
      await fs.chmod(filePath, mode);
      await fs.unlink(tmpPath).catch(() => {});
    } else {
      await fs.unlink(tmpPath).catch(() => {});
      throw err;
    }
  }
}

/**
 * 안전한 파일 읽기 — 심링크 검사
 * O_NOFOLLOW로 심링크 공격 방지
 */
export async function readFileSafe(filePath: string): Promise<string> {
  const fd = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const content = await fd.readFile({ encoding: 'utf-8' });
    return content;
  } finally {
    await fd.close();
  }
}

function isWindowsRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return process.platform === 'win32' && (code === 'EPERM' || code === 'EEXIST');
}
```

### 5.6 unhandled-rejections 5단계 분류

```typescript
// packages/infra/src/unhandled-rejections.ts

/**
 * L1: AbortError → warn
 * L2: Fatal (OOM, 시스템) → exit
 * L3: Config (설정/인증) → exit
 * L4: Transient (네트워크) → warn
 * L5: 기타 → exit
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

### 5.7 데이터 흐름

```
[프로세스 시작]
      │
      ├── runtime-guard.ts     → Node 22+ 검증
      ├── dotenv.ts            → .env 로딩 (process.loadEnvFile)
      ├── env.ts               → FINCLAW_ 변수 정규화
      ├── paths.ts             → 디렉토리 경로 해석
      ├── context.ts           → ALS 요청 컨텍스트 초기화
      ├── logger.ts            → 로거 초기화 (ALS 자동 주입)
      ├── unhandled-rejections → 에러 핸들러 등록
      │
      ├── gateway-lock.ts      → 단일 인스턴스 보장 + 포트 프로빙
      ├── ports.ts             → 포트 가용성 확인
      │
      └── [이후 Phase에서 사용]
          ├── retry.ts         → API 호출 재시도
          ├── circuit-breaker  → 외부 서비스 장애 격리
          ├── ssrf.ts          → 외부 요청 보안
          ├── fetch.ts         → SafeHttpClient (네이티브 fetch)
          ├── fs-safe.ts       → 설정/세션 파일 쓰기
          └── system-events.ts → 이벤트 수집/소비
```

---

## 6. 선행 조건

| 조건                    | 산출물                                              | Phase          |
| ----------------------- | --------------------------------------------------- | -------------- |
| 핵심 타입 정의          | `packages/types/` (LogLevel, Timestamp, SessionKey) | Phase 1        |
| Brand 타입 팩토리       | `createTimestamp()`, `createSessionKey()`           | Phase 1        |
| 빌드/테스트 인프라      | tsc, tsgo, vitest, oxlint                           | Phase 0 (완료) |
| 패키지 구조             | `packages/infra/package.json`, `tsconfig.json`      | 이 Phase       |
| 루트 tsconfig 참조 추가 | `tsconfig.json` references에 `packages/infra` 추가  | 이 Phase       |

**신규 외부 의존성:** `tslog` 1개만 (dotenv 제거)

```bash
cd packages/infra && pnpm add tslog
```

---

## 7. 산출물 및 검증

### 산출물 목록

| #   | 산출물                                    | 검증 방법                                           |
| --- | ----------------------------------------- | --------------------------------------------------- |
| 1   | `packages/infra/` 패키지 (27개 소스 파일) | `pnpm typecheck` 통과                               |
| 2   | 런타임 가드                               | Node 22 미만에서 프로세스 종료 확인                 |
| 3   | 구조화 로거                               | JSON 파일 출력 + 콘솔 pretty 출력 확인              |
| 4   | 에러 클래스 계층                          | `instanceof`, `isOperational`, `Error.cause` 테스트 |
| 5   | 재시도 유틸                               | 재시도 횟수, 백오프 간격, AbortSignal 중단 테스트   |
| 6   | 원자적 파일 쓰기                          | 동시 쓰기 시 데이터 무결성 + 심링크 차단 테스트     |
| 7   | SSRF 방지                                 | 사설 IP 차단, DNS 핀닝, `SsrfPolicy` 테스트         |
| 8   | 게이트웨이 잠금                           | 잠금 획득/해제, stale 감지, signal 취소 테스트      |
| 9   | 포트 관리                                 | EADDRINUSE 감지 테스트                              |
| 10  | 이벤트 큐                                 | MAX 20 제한, drain/peek, `resetForTest` 테스트      |
| 11  | 테스트 파일 (18개)                        | `pnpm test` 전체 통과                               |

### 검증 기준

```bash
# 1. 타입 체크 통과
pnpm typecheck       # 에러 0

# 2. 빌드 통과
pnpm build           # dist/ 생성 확인

# 3. 단위 테스트 통과 (18개 파일)
pnpm test            # 전체 통과, 커버리지 70%+

# 4. 린트 통과
pnpm lint            # 에러 0

# 5. 순환 의존 없음
# errors.ts, backoff.ts, context.ts는 Fan-In 0 유지

# 6. 통합 검증
# runtime-guard → env → paths → context → logger → gateway-lock → ports
# 순서대로 호출하여 프로세스 초기화 시나리오 통과

# 7. 컨텍스트 전파
# ALS 기반 requestId가 runWithContext() 내부에서 getRequestId()로 조회 가능
# 중첩 호출, setTimeout 콜백에서도 전파 확인

# 8. CB 상태 전이
# closed → (failureThreshold 초과) → open → (resetTimeout 경과) → half-open → closed

# 9. SafeHttpClient 보안
# redirect: 'error' 기본 적용, AbortSignal.timeout 동작, SSRF 차단 통합

# 10. Error.cause 체이닝
# wrapError()로 체이닝 시 cause 체인 추적 가능, extractErrorInfo()에서 cause 추출

# 11. 모노레포 통합
# packages/infra가 다른 패키지에서 @finclaw/infra로 import 가능
# tsconfig references 정상 동작
```

---

## 8. 복잡도 및 예상 파일 수

| 항목              | 값                                                   |
| ----------------- | ---------------------------------------------------- |
| **복잡도**        | **L (Large)**                                        |
| 소스 파일         | 27개                                                 |
| 테스트 파일       | 18개                                                 |
| 인프라 파일       | 2개 (package.json, tsconfig.json)                    |
| **총 파일 수**    | **47개**                                             |
| 예상 LOC (소스)   | ~2,100줄                                             |
| 예상 LOC (테스트) | ~1,100줄                                             |
| **예상 LOC 합계** | **~3,200줄**                                         |
| 신규 의존성       | 1개 (tslog) — dotenv 제거                            |
| 난이도            | 중간 (파일 I/O, 네트워크 보안, 동시성 잠금, ALS, CB) |

**위험 요소:**

- **R1:** gateway-lock의 Windows 호환성 (EPERM rename fallback)
- **R2:** SSRF 방지에서 IPv6/CGNAT 엣지 케이스
- **R3:** tslog 트랜스포트 설정이 로그 로테이션에 미치는 영향
- **R4:** 파일 잠금의 NFS/네트워크 파일시스템 비호환 (FinClaw는 로컬 전용이므로 수용 가능)
- **R5:** ALS 컨텍스트 유실 — Worker threads, `setTimeout` 등에서 AsyncLocalStorage 컨텍스트 전파 실패 가능. 테스트로 검증 필요.
- **R6:** CB 오탐 — 일시적 네트워크 지연을 장애로 오판하여 circuit open. `failureThreshold`/`resetTimeout` 튜닝 필요.
- **R7:** `process.loadEnvFile()` 동작 차이 — dotenv와 미묘하게 다를 수 있음 (주석 처리, 멀티라인 등). Edge case 테스트 필요.
- **R8:** 네이티브 fetch undici 버전 고정 불가 — Node.js 내장 fetch는 undici 버전이 Node.js에 종속됨. SSRF 방지 시 undici 내부 동작 의존 주의.

---

## 9. 구현 순서

의존 관계 기반 6단계. 각 Step 완료 후 `pnpm typecheck && pnpm test` 검증.

```
Step 1: 프로젝트 셋업
  → packages/infra/{package.json, tsconfig.json}
  → 루트 tsconfig.json references 추가
  → pnpm add tslog
  → 검증: pnpm typecheck 통과

Step 2: 기반 모듈 (Ce=0, 외부 의존 없음)
  → errors.ts, backoff.ts, format-duration.ts, warnings.ts, context.ts
  → 테스트: errors.test.ts, backoff.test.ts, context.test.ts, format-duration.test.ts
  → 검증: 순수 함수 단위 테스트 통과

Step 3: 환경/설정
  → runtime-guard.ts, dotenv.ts, env.ts, paths.ts, is-main.ts
  → 테스트: runtime-guard.test.ts, env.test.ts, paths.test.ts
  → 검증: 환경 변수 정규화, 경로 해석 테스트 통과

Step 4: 로깅/이벤트
  → logger.ts, logger-transports.ts, events.ts, system-events.ts, agent-events.ts
  → 테스트: logger.test.ts, system-events.test.ts
  → 검증: 로거 생성, ALS 컨텍스트 주입, 이벤트 큐 테스트 통과

Step 5: 네트워크/재시도
  → ssrf.ts, fetch.ts, retry.ts, dedupe.ts, circuit-breaker.ts
  → 테스트: ssrf.test.ts, fetch.test.ts, retry.test.ts, dedupe.test.ts, circuit-breaker.test.ts
  → 검증: SSRF 차단, CB 상태 전이, 재시도 로직 테스트 통과

Step 6: 파일시스템/프로세스
  → fs-safe.ts, json-file.ts, gateway-lock.ts, ports.ts, ports-inspect.ts,
    unhandled-rejections.ts, index.ts (barrel)
  → 테스트: fs-safe.test.ts, gateway-lock.test.ts, ports.test.ts,
    unhandled-rejections.test.ts
  → 검증: 원자적 쓰기, 잠금 획득/해제, 전체 통합 테스트 통과
```

---

## 10. 테스트 전략

### 모킹 전략

- `node:` 내장 모듈은 `vi.mock()` 최소화. 실제 임시 디렉토리(`node:os` `tmpdir`) 사용 (fs), 실제 서버(`node:net`) 사용 (ports).
- DNS 해석(`node:dns/promises`)만 `vi.mock()`으로 모킹 (SSRF 테스트에서 사설 IP 반환 시뮬레이션).
- `process.env`는 `vi.stubEnv()`로 격리.
- `process.exit`는 `vi.spyOn()`으로 호출 여부만 확인 (실제 종료 방지).

### 경계값 시나리오

| 모듈              | 경계값                                                          |
| ----------------- | --------------------------------------------------------------- |
| `backoff.ts`      | attempt=0, maxDelay 도달, jitter 범위 확인                      |
| `dedupe.ts`       | TTL=0 (즉시 만료), maxSize 초과, 동시 100개 호출                |
| `circuit-breaker` | failureThreshold=1 (즉시 open), resetTimeout=0 (즉시 half-open) |
| `env.ts`          | 빈 문자열, undefined, 특수문자 키                               |
| `system-events`   | MAX_EVENTS_PER_SESSION 정확히 도달, +1 초과                     |
| `gateway-lock`    | timeoutMs=0 (즉시 실패), stale 잠금, 동시 2개 인스턴스          |
| `ssrf.ts`         | IPv4-mapped-IPv6, CGNAT(100.64.x.x), `SsrfPolicy` 허용 목록     |

### 테스트 헬퍼

```typescript
// packages/infra/test/helpers.ts

/** 임시 디렉토리 생성 + 자동 정리 */
export async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void>;

/** 테스트용 로거 (출력 억제) */
export function createTestLogger(): FinClawLogger;

/** 타임아웃 유틸 (vi.useFakeTimers 대안) */
export function advanceTime(ms: number): Promise<void>;
```
