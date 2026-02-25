# Phase 2 Part 2: 로깅/이벤트 + 네트워크 보안 + 재시도

> 현재 소스 분석 기준: 2026-02-26
> 대상 패키지: `packages/infra/`
> 소스 파일 8개, 테스트 파일 5개
> 예상 LOC: ~1,165 (소스 775 + 테스트 390)
> 비중: 35% (전체 3,200 LOC 중)
> Part 1 의존: errors, context, paths, env, backoff

---

## 선행 조건

Part 1 완료 필수. 다음 모듈이 존재하고 테스트를 통과해야 한다:

| 모듈         | Part 2에서의 사용처                      |
| ------------ | ---------------------------------------- |
| `errors.ts`  | logger, ssrf, fetch에서 에러 클래스 사용 |
| `context.ts` | logger에서 ALS 컨텍스트 자동 주입        |
| `paths.ts`   | logger에서 로그 파일 경로 결정           |
| `env.ts`     | logger에서 환경 변수 기반 설정           |
| `backoff.ts` | retry에서 지수 백오프 계산               |

---

## 작업 순서 및 의존성

```
T1 (logger-transports.ts)     ← Part 1 paths 의존
 └──→ T2 (logger.ts)          ← T1 + Part 1 context 의존
T3 (events.ts)                ← 독립 (TypedEmitter 패턴)
 └──→ T4 (system-events.ts)   ← T3에 의존 (이벤트 타입)
 └──→ T5 (agent-events.ts)    ← T3에 의존 (이벤트 타입)
T6 (ssrf.ts)                  ← Part 1 errors 의존
 └──→ T7 (fetch.ts)           ← T6에 의존
T8 (retry.ts)                 ← Part 1 backoff 의존
T9 (테스트: logger, system-events, ssrf, fetch, retry)
T10 (Part 2 전체 검증)

권장 실행 순서: T1 → T2 → T3 → T4~T5 (병렬) → T6 → T7 → T8 → T9 → T10
```

---

## T1. `logger-transports.ts` — 파일/콘솔 트랜스포트

### 왜

tslog 로거에 부착할 트랜스포트를 분리. 파일 트랜스포트는 JSON 형식으로 로그를 기록하고,
콘솔 트랜스포트는 개발 환경에서 pretty 출력을 제공한다.

### 무엇을 — `packages/infra/src/logger-transports.ts` (신규, ~80 LOC)

```typescript
// packages/infra/src/logger-transports.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogDir } from './paths.js';

export interface FileTransportConfig {
  enabled: boolean;
  path?: string;
  maxSizeMb?: number; // 기본: 10
  maxFiles?: number; // 기본: 5
}

/**
 * tslog에 파일 트랜스포트 부착
 *
 * JSON 라인 형식으로 파일에 로그 기록.
 * 간단한 크기 기반 로테이션 (maxSizeMb 초과 시 새 파일).
 */
export function attachFileTransport(
  logger: { attachTransport: (fn: (logObj: unknown) => void) => void },
  config: FileTransportConfig,
): void {
  if (!config.enabled) return;

  const logDir = config.path ?? getLogDir();
  fs.mkdirSync(logDir, { recursive: true });

  const logFile = path.join(logDir, 'finclaw.log');
  let stream = createWriteStream(logFile);
  let currentSize = getFileSize(logFile);
  const maxSize = (config.maxSizeMb ?? 10) * 1024 * 1024;
  const maxFiles = config.maxFiles ?? 5;

  logger.attachTransport((logObj: unknown) => {
    const line = JSON.stringify(logObj) + '\n';
    currentSize += Buffer.byteLength(line);

    if (currentSize > maxSize) {
      stream.end();
      rotateFiles(logFile, maxFiles);
      stream = createWriteStream(logFile);
      currentSize = 0;
    }

    stream.write(line);
  });
}

function createWriteStream(filePath: string): fs.WriteStream {
  return fs.createWriteStream(filePath, { flags: 'a', mode: 0o600 });
}

function getFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/** 로그 파일 로테이션: finclaw.log → finclaw.log.1 → ... → finclaw.log.N */
function rotateFiles(basePath: string, maxFiles: number): void {
  for (let i = maxFiles - 1; i >= 1; i--) {
    const from = i === 1 ? basePath : `${basePath}.${i - 1}`;
    const to = `${basePath}.${i}`;
    try {
      fs.renameSync(from, to);
    } catch {
      // 파일이 없으면 무시
    }
  }
}

/**
 * 모든 트랜스포트의 버퍼 플러시
 *
 * graceful shutdown 시 호출.
 * 반환된 Promise는 모든 스트림이 flush되면 resolve.
 */
export function createFlushFn(streams: fs.WriteStream[]): () => Promise<void> {
  return () =>
    Promise.all(
      streams.map(
        (s) => new Promise<void>((resolve) => (s.writableFinished ? resolve() : s.end(resolve))),
      ),
    ).then(() => {});
}
```

### 검증

- 로그 디렉토리가 없을 때 자동 생성
- JSON 라인 형식으로 기록
- T9 logger.test.ts에서 간접 검증

---

## T2. `logger.ts` — 구조화 로깅 팩토리

### 왜

FinClaw 전역에서 사용하는 로거. tslog 기반으로 구조화 로깅을 제공하고,
ALS 컨텍스트(requestId, sessionKey)를 자동 주입. `LoggerFactory` 인터페이스로 DI/테스트 교체 가능.

### 무엇을 — `packages/infra/src/logger.ts` (신규, ~140 LOC)

```typescript
// packages/infra/src/logger.ts
import { Logger as TsLogger } from 'tslog';
import type { LogLevel } from '@finclaw/types';
import { getContext } from './context.js';
import { attachFileTransport, type FileTransportConfig } from './logger-transports.js';

export interface LoggerConfig {
  name: string;
  level?: LogLevel;
  file?: FileTransportConfig;
  console?: {
    enabled: boolean;
    pretty?: boolean; // 기본: !isCI
  };
  redactKeys?: string[];
  autoInjectContext?: boolean; // 기본: true
}

/** 로거 팩토리 인터페이스 — DI/테스트 교체 지점 */
export interface LoggerFactory {
  create(config: LoggerConfig): FinClawLogger;
}

export interface FinClawLogger {
  trace(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  fatal(msg: string, ...args: unknown[]): void;
  child(name: string): FinClawLogger;
  flush(): Promise<void>;
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

const LOG_LEVEL_MAP: Record<LogLevel, number> = {
  trace: 1,
  debug: 2,
  info: 3,
  warn: 4,
  error: 5,
  fatal: 6,
};

/** FinClaw 로거 팩토리 (기본 구현) */
export function createLogger(config: LoggerConfig): FinClawLogger {
  const isCI = process.env.CI === 'true';
  const tsLogger = new TsLogger({
    name: config.name,
    minLevel: LOG_LEVEL_MAP[config.level ?? 'info'],
    type: (config.console?.pretty ?? !isCI) ? 'pretty' : 'json',
    maskValuesOfKeys: config.redactKeys ?? DEFAULT_REDACT_KEYS,
    hideLogPositionForProduction: true,
  });

  // 파일 트랜스포트 부착
  if (config.file?.enabled) {
    attachFileTransport(tsLogger, config.file);
  }

  return wrapLogger(tsLogger, config.autoInjectContext ?? true);
}

/** tslog 인스턴스를 FinClawLogger로 래핑 */
function wrapLogger(tsLogger: TsLogger<unknown>, injectContext: boolean): FinClawLogger {
  const withCtx = (args: unknown[]): unknown[] => {
    if (!injectContext) return args;
    const ctx = getContext();
    if (!ctx) return args;
    return [{ _ctx: { requestId: ctx.requestId, sessionKey: ctx.sessionKey } }, ...args];
  };

  const flushCallbacks: (() => Promise<void>)[] = [];

  return {
    trace: (msg, ...args) => tsLogger.trace(msg, ...withCtx(args)),
    debug: (msg, ...args) => tsLogger.debug(msg, ...withCtx(args)),
    info: (msg, ...args) => tsLogger.info(msg, ...withCtx(args)),
    warn: (msg, ...args) => tsLogger.warn(msg, ...withCtx(args)),
    error: (msg, ...args) => tsLogger.error(msg, ...withCtx(args)),
    fatal: (msg, ...args) => tsLogger.fatal(msg, ...withCtx(args)),
    child: (name: string) => {
      const childTsLogger = tsLogger.getSubLogger({ name });
      return wrapLogger(childTsLogger, injectContext);
    },
    flush: async () => {
      await Promise.all(flushCallbacks.map((fn) => fn()));
    },
  };
}

/** 기본 LoggerFactory 구현 */
export const defaultLoggerFactory: LoggerFactory = {
  create: createLogger,
};
```

### 검증

- `createLogger({ name: 'test' })` → FinClawLogger 반환
- 각 레벨 메서드 호출 가능 (trace ~ fatal)
- `child('sub')` → 새 로거 반환
- `flush()` → 정상 resolve
- ALS 컨텍스트 주입: `runWithContext` 내에서 로그 시 `_ctx` 포함
- T9 테스트에서 검증

---

## T3. `events.ts` — TypedEmitter 패턴

### 왜

타입 안전한 이벤트 발행/구독 패턴. Node.js EventEmitter를 제네릭으로 래핑하여
이벤트명과 핸들러 시그니처를 컴파일 타임에 검증.

### 무엇을 — `packages/infra/src/events.ts` (신규, ~95 LOC)

````typescript
// packages/infra/src/events.ts
import { EventEmitter } from 'node:events';

/**
 * 이벤트 맵 타입 — 이벤트명 → 핸들러 시그니처 매핑
 *
 * 사용 예:
 * ```typescript
 * interface MyEvents {
 *   'user:login': (userId: string) => void;
 *   'error': (err: Error) => void;
 * }
 * const emitter = createTypedEmitter<MyEvents>();
 * ```
 */
export type EventMap = Record<string, (...args: never[]) => void>;

/** 타입 안전 EventEmitter 래퍼 */
export interface TypedEmitter<T extends EventMap> {
  on<K extends keyof T & string>(event: K, listener: T[K]): this;
  off<K extends keyof T & string>(event: K, listener: T[K]): this;
  once<K extends keyof T & string>(event: K, listener: T[K]): this;
  emit<K extends keyof T & string>(event: K, ...args: Parameters<T[K]>): boolean;
  removeAllListeners<K extends keyof T & string>(event?: K): this;
  listenerCount<K extends keyof T & string>(event: K): number;
}

/** TypedEmitter 팩토리 */
export function createTypedEmitter<T extends EventMap>(): TypedEmitter<T> {
  return new EventEmitter() as unknown as TypedEmitter<T>;
}

/** FinClaw 시스템 이벤트 맵 */
export interface FinClawEventMap {
  /** 시스템 초기화 완료 */
  'system:ready': () => void;
  /** 시스템 종료 시작 */
  'system:shutdown': (reason: string) => void;
  /** 에이전트 실행 시작 */
  'agent:run:start': (agentId: string, sessionKey: string) => void;
  /** 에이전트 실행 완료 */
  'agent:run:end': (agentId: string, sessionKey: string, durationMs: number) => void;
  /** 에이전트 실행 에러 */
  'agent:run:error': (agentId: string, sessionKey: string, error: Error) => void;
  /** 채널 메시지 수신 */
  'channel:message': (channelId: string, messageId: string) => void;
  /** 설정 변경 */
  'config:change': (changedPaths: string[]) => void;
  /** 스킬 실행 */
  'skill:execute': (skillName: string, agentId: string) => void;
  /** 스킬 실행 완료 */
  'skill:complete': (skillName: string, agentId: string, durationMs: number) => void;
}

/** 전역 이벤트 버스 (싱글턴) */
let globalBus: TypedEmitter<FinClawEventMap> | undefined;

export function getEventBus(): TypedEmitter<FinClawEventMap> {
  if (!globalBus) {
    globalBus = createTypedEmitter<FinClawEventMap>();
  }
  return globalBus;
}

/** 테스트용 이벤트 버스 초기화 */
export function resetEventBus(): void {
  globalBus?.removeAllListeners();
  globalBus = undefined;
}
````

### 검증

- `createTypedEmitter<MyEvents>()` → on/off/emit 동작
- 이벤트명 오타 → 컴파일 에러 (타입 수준 검증)
- `getEventBus()` → 싱글턴 반환
- `resetEventBus()` → 새 인스턴스 생성
- T9 테스트에서 검증 (system-events.test.ts에서 간접 검증)

---

## T4. `system-events.ts` — 세션 스코프 이벤트 큐

### 왜

세션별 인메모리 이벤트 큐. MAX 20개 제한으로 메모리 바운드.
에이전트에게 최근 시스템 이벤트를 전달하는 데 사용.

### 무엇을 — `packages/infra/src/system-events.ts` (신규, ~90 LOC)

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

### 검증

- 20개 초과 시 오래된 이벤트 삭제
- 연속 중복 이벤트 스킵
- drain → 소비적 (큐 비움), peek → 비소비적
- T9 테스트에서 검증

---

## T5. `agent-events.ts` — 에이전트 라이프사이클 이벤트

### 왜

에이전트 실행 시작/완료/에러를 이벤트 버스에 발행. 로깅, 모니터링에서 구독.

### 무엇을 — `packages/infra/src/agent-events.ts` (신규, ~50 LOC)

```typescript
// packages/infra/src/agent-events.ts
import { getEventBus } from './events.js';

/**
 * 에이전트 실행 시작 이벤트 발행
 */
export function emitAgentRunStart(agentId: string, sessionKey: string): void {
  getEventBus().emit('agent:run:start', agentId, sessionKey);
}

/**
 * 에이전트 실행 완료 이벤트 발행
 */
export function emitAgentRunEnd(agentId: string, sessionKey: string, durationMs: number): void {
  getEventBus().emit('agent:run:end', agentId, sessionKey, durationMs);
}

/**
 * 에이전트 실행 에러 이벤트 발행
 */
export function emitAgentRunError(agentId: string, sessionKey: string, error: Error): void {
  getEventBus().emit('agent:run:error', agentId, sessionKey, error);
}

/**
 * 에이전트 이벤트 구독 편의 함수
 */
export function onAgentRunStart(handler: (agentId: string, sessionKey: string) => void): void {
  getEventBus().on('agent:run:start', handler);
}

export function onAgentRunEnd(
  handler: (agentId: string, sessionKey: string, durationMs: number) => void,
): void {
  getEventBus().on('agent:run:end', handler);
}

export function onAgentRunError(
  handler: (agentId: string, sessionKey: string, error: Error) => void,
): void {
  getEventBus().on('agent:run:error', handler);
}
```

### 검증

- `emitAgentRunStart` → `onAgentRunStart` 구독 핸들러 호출
- events.ts의 이벤트 버스 싱글턴과 통합 동작
- T9 system-events.test.ts에서 간접 검증

---

## T6. `ssrf.ts` — DNS 핀닝 SSRF 방지

### 왜

외부 URL 접근 시 DNS 해석 결과를 검증하여 사설 IP 접근을 차단.
DNS 핀닝으로 TOCTOU 공격을 방지하고, `SsrfPolicy`로 정책을 분리.

### 무엇을 — `packages/infra/src/ssrf.ts` (신규, ~135 LOC)

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

### 검증

- 사설 IP (10.x, 172.16.x, 192.168.x, 127.x) → `SsrfBlockedError`
- 공인 IP → IP 문자열 반환 (핀닝용)
- IPv4-mapped-IPv6 (`::ffff:10.0.0.1`) → 사설 판별
- CGNAT (`100.64.0.0`) → 사설 판별
- `localhost` → hostname 수준 차단
- `SsrfPolicy.allowPrivateNetwork: true` → 사설 허용
- `SsrfPolicy.hostnameAllowlist` → 지정 호스트 우회
- T9 테스트에서 검증

---

## T7. `fetch.ts` — 안전한 HTTP 클라이언트

### 왜

네이티브 fetch를 래핑하여 SSRF 방지, 타임아웃, 리다이렉트 차단을 기본 적용.
`AbortSignal.timeout()`으로 타임아웃을 처리하고, `redirect: 'error'`로 오픈 리다이렉트를 차단.

### 무엇을 — `packages/infra/src/fetch.ts` (신규, ~75 LOC)

```typescript
// packages/infra/src/fetch.ts
import { validateUrlSafety, type SsrfPolicy } from './ssrf.js';

export interface SafeFetchOptions {
  /** 타임아웃 (ms, 기본: 30000) */
  timeoutMs?: number;
  /** SSRF 정책 */
  ssrfPolicy?: SsrfPolicy;
  /** 리다이렉트 허용 (기본: false — 'error' 모드) */
  allowRedirect?: boolean;
  /** 추가 fetch 옵션 */
  init?: RequestInit;
}

/**
 * SSRF 방지가 적용된 안전한 fetch
 *
 * 1. URL 안전성 검증 (DNS 핀닝)
 * 2. AbortSignal.timeout() 적용
 * 3. redirect: 'error' 기본 적용
 */
export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const { timeoutMs = 30000, ssrfPolicy, allowRedirect = false, init = {} } = opts;

  // SSRF 검증
  await validateUrlSafety(url, ssrfPolicy);

  // AbortSignal 병합: 사용자 signal + timeout signal
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;

  const response = await fetch(url, {
    ...init,
    signal: combinedSignal,
    redirect: allowRedirect ? 'follow' : 'error',
  });

  return response;
}

/**
 * JSON 응답을 파싱하는 편의 함수
 */
export async function safeFetchJson<T = unknown>(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<T> {
  const response = await safeFetch(url, {
    ...opts,
    init: {
      ...opts.init,
      headers: {
        Accept: 'application/json',
        ...opts.init?.headers,
      },
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}
```

### 검증

- `safeFetch` → SSRF 검증 + 타임아웃 적용
- `redirect: 'error'` 기본 적용 → 리다이렉트 시 에러
- `allowRedirect: true` → 리다이렉트 허용
- `safeFetchJson` → JSON 파싱 + Content-Type 헤더 자동 설정
- T9 테스트에서 검증 (DNS 모킹 사용)

---

## T8. `retry.ts` — 지수 백오프 재시도

### 왜

외부 API 호출 시 일시적 장애를 자동 재시도. AbortSignal로 취소 가능하고,
`shouldRetry`로 재시도 조건을 커스터마이징.

### 무엇을 — `packages/infra/src/retry.ts` (신규, ~110 LOC)

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

### 검증

- `maxAttempts=3` → 최대 3회 시도
- 성공 시 즉시 반환, 재시도 없음
- `shouldRetry` → false 반환 시 즉시 throw
- `signal.aborted` → 즉시 'Retry aborted' throw
- `onRetry` 콜백 호출 확인
- `retryAfterMs` → delay 최소 보장
- `resolveRetryConfig` → 기본값 병합
- T9 테스트에서 검증

---

## T9. 테스트 (logger, system-events, ssrf, fetch, retry)

### 왜

Part 2 모듈들의 단위 테스트. DNS 해석은 `vi.mock()`으로 모킹.

### T9-1. `packages/infra/test/logger.test.ts` (신규, ~80 LOC)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLogger, type FinClawLogger } from '../src/logger.js';
import { runWithContext } from '../src/context.js';

describe('createLogger', () => {
  let logger: FinClawLogger;

  beforeEach(() => {
    logger = createLogger({
      name: 'test',
      level: 'trace',
      console: { enabled: true, pretty: false },
    });
  });

  it('모든 레벨 메서드를 가진다', () => {
    expect(typeof logger.trace).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.fatal).toBe('function');
  });

  it('에러 없이 로그를 기록한다', () => {
    expect(() => logger.info('test message')).not.toThrow();
    expect(() => logger.error('error message', { key: 'value' })).not.toThrow();
  });

  it('child 로거를 생성한다', () => {
    const child = logger.child('sub');
    expect(typeof child.info).toBe('function');
    expect(() => child.info('child message')).not.toThrow();
  });

  it('flush가 정상 resolve된다', async () => {
    await expect(logger.flush()).resolves.toBeUndefined();
  });
});

describe('ALS 컨텍스트 자동 주입', () => {
  it('runWithContext 내에서 로그 시 에러 없이 동작한다', () => {
    const logger = createLogger({
      name: 'ctx-test',
      level: 'trace',
      console: { enabled: true, pretty: false },
      autoInjectContext: true,
    });

    const ctx = { requestId: 'req-123', startedAt: Date.now() };
    runWithContext(ctx, () => {
      expect(() => logger.info('with context')).not.toThrow();
    });
  });

  it('autoInjectContext: false에서도 동작한다', () => {
    const logger = createLogger({
      name: 'no-ctx-test',
      level: 'trace',
      console: { enabled: true, pretty: false },
      autoInjectContext: false,
    });

    expect(() => logger.info('without context')).not.toThrow();
  });
});
```

### T9-2. `packages/infra/test/system-events.test.ts` (신규, ~70 LOC)

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createSessionKey, createTimestamp } from '@finclaw/types';
import {
  pushSystemEvent,
  drainSystemEvents,
  peekSystemEvents,
  clearSystemEvents,
  onContextKeyChange,
  resetForTest,
} from '../src/system-events.js';

const sk = createSessionKey('test-session');

function makeEvent(type: string, payload: unknown = null) {
  return { type, sessionKey: sk, payload, timestamp: createTimestamp(Date.now()) };
}

describe('system-events', () => {
  beforeEach(() => {
    resetForTest();
  });

  it('이벤트를 추가하고 peek으로 조회한다', () => {
    pushSystemEvent(makeEvent('test'));
    const events = peekSystemEvents(sk);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('test');
  });

  it('drain은 소비적이다 (큐를 비운다)', () => {
    pushSystemEvent(makeEvent('a'));
    pushSystemEvent(makeEvent('b'));
    const drained = drainSystemEvents(sk);
    expect(drained).toHaveLength(2);
    expect(peekSystemEvents(sk)).toHaveLength(0);
  });

  it('MAX 20개 제한을 초과하면 오래된 것이 삭제된다', () => {
    for (let i = 0; i < 25; i++) {
      pushSystemEvent(makeEvent(`event-${i}`, i));
    }
    const events = peekSystemEvents(sk);
    expect(events).toHaveLength(20);
    expect(events[0].type).toBe('event-5'); // 0-4 삭제됨
  });

  it('연속 중복 이벤트를 스킵한다', () => {
    pushSystemEvent(makeEvent('dup', 'same'));
    pushSystemEvent(makeEvent('dup', 'same'));
    pushSystemEvent(makeEvent('dup', 'same'));
    expect(peekSystemEvents(sk)).toHaveLength(1);
  });

  it('같은 type이라도 payload가 다르면 추가한다', () => {
    pushSystemEvent(makeEvent('dup', 'a'));
    pushSystemEvent(makeEvent('dup', 'b'));
    expect(peekSystemEvents(sk)).toHaveLength(2);
  });

  it('clearSystemEvents로 세션 큐를 삭제한다', () => {
    pushSystemEvent(makeEvent('test'));
    clearSystemEvents(sk);
    expect(peekSystemEvents(sk)).toHaveLength(0);
  });

  it('onContextKeyChange가 이전 세션을 정리한다', () => {
    pushSystemEvent(makeEvent('test'));
    const newSk = createSessionKey('new-session');
    onContextKeyChange(sk, newSk);
    expect(peekSystemEvents(sk)).toHaveLength(0);
  });

  it('빈 세션의 drain은 빈 배열을 반환한다', () => {
    const emptySk = createSessionKey('empty');
    expect(drainSystemEvents(emptySk)).toEqual([]);
  });
});
```

### T9-3. `packages/infra/test/ssrf.test.ts` (신규, ~80 LOC)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isPrivateIp, validateUrlSafety } from '../src/ssrf.js';
import { SsrfBlockedError } from '../src/errors.js';

// DNS 해석 모킹
vi.mock('node:dns/promises', () => ({
  resolve: vi.fn(),
}));

import { resolve as mockDnsResolve } from 'node:dns/promises';

describe('isPrivateIp', () => {
  it.each([
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.15.0.1', false],
    ['172.32.0.1', false],
    ['192.168.0.1', true],
    ['192.168.255.255', true],
    ['127.0.0.1', true],
    ['169.254.0.1', true],
    ['100.64.0.1', true], // CGNAT
    ['100.127.255.255', true], // CGNAT
    ['100.63.255.255', false], // CGNAT 경계 아래
    ['0.0.0.0', true],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
  ])('isPrivateIp(%s) → %s', (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });

  it('IPv4-mapped-IPv6를 처리한다', () => {
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
  });

  it('IPv6 사설 주소를 판별한다', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fd00::1')).toBe(true);
    expect(isPrivateIp('2001:db8::1')).toBe(false);
  });
});

describe('validateUrlSafety', () => {
  beforeEach(() => {
    vi.mocked(mockDnsResolve).mockReset();
  });

  it('공인 IP로 해석되면 IP를 반환한다', async () => {
    vi.mocked(mockDnsResolve).mockResolvedValue(['93.184.216.34'] as never);
    const ip = await validateUrlSafety('https://example.com/path');
    expect(ip).toBe('93.184.216.34');
  });

  it('사설 IP로 해석되면 SsrfBlockedError를 던진다', async () => {
    vi.mocked(mockDnsResolve).mockResolvedValue(['10.0.0.1'] as never);
    await expect(validateUrlSafety('https://evil.com')).rejects.toThrow(SsrfBlockedError);
  });

  it('localhost를 hostname 수준에서 차단한다', async () => {
    await expect(validateUrlSafety('https://localhost:8080')).rejects.toThrow(SsrfBlockedError);
  });

  it('.local 도메인을 차단한다', async () => {
    await expect(validateUrlSafety('https://server.local')).rejects.toThrow(SsrfBlockedError);
  });

  it('allowPrivateNetwork: true에서 사설 IP를 허용한다', async () => {
    vi.mocked(mockDnsResolve).mockResolvedValue(['10.0.0.1'] as never);
    const ip = await validateUrlSafety('https://internal.dev', {
      allowPrivateNetwork: true,
    });
    expect(ip).toBe('10.0.0.1');
  });

  it('hostnameAllowlist에 포함된 호스트를 통과시킨다', async () => {
    vi.mocked(mockDnsResolve).mockResolvedValue(['10.0.0.1'] as never);
    const ip = await validateUrlSafety('https://trusted.internal', {
      hostnameAllowlist: ['trusted.internal'],
    });
    expect(ip).toBe('10.0.0.1');
  });
});
```

### T9-4. `packages/infra/test/fetch.test.ts` (신규, ~60 LOC)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { safeFetch } from '../src/fetch.js';

// ssrf 모듈 모킹 (DNS 호출 방지)
vi.mock('../src/ssrf.js', () => ({
  validateUrlSafety: vi.fn().mockResolvedValue('93.184.216.34'),
}));

// 글로벌 fetch 모킹
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { validateUrlSafety } from '../src/ssrf.js';

describe('safeFetch', () => {
  beforeEach(() => {
    vi.mocked(validateUrlSafety).mockResolvedValue('93.184.216.34');
    mockFetch.mockReset();
  });

  it('SSRF 검증을 호출한다', async () => {
    mockFetch.mockResolvedValue(new Response('ok'));
    await safeFetch('https://example.com');
    expect(validateUrlSafety).toHaveBeenCalledWith('https://example.com', undefined);
  });

  it('redirect: error가 기본 적용된다', async () => {
    mockFetch.mockResolvedValue(new Response('ok'));
    await safeFetch('https://example.com');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('allowRedirect: true에서 redirect: follow가 적용된다', async () => {
    mockFetch.mockResolvedValue(new Response('ok'));
    await safeFetch('https://example.com', { allowRedirect: true });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ redirect: 'follow' }),
    );
  });

  it('AbortSignal.timeout이 적용된다', async () => {
    mockFetch.mockResolvedValue(new Response('ok'));
    await safeFetch('https://example.com', { timeoutMs: 5000 });
    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs.signal).toBeDefined();
  });

  it('SSRF 검증 실패 시 에러를 전파한다', async () => {
    vi.mocked(validateUrlSafety).mockRejectedValue(new Error('SSRF blocked'));
    await expect(safeFetch('https://evil.com')).rejects.toThrow('SSRF blocked');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
```

### T9-5. `packages/infra/test/retry.test.ts` (신규, ~100 LOC)

```typescript
import { describe, it, expect, vi } from 'vitest';
import { retry, resolveRetryConfig } from '../src/retry.js';

describe('resolveRetryConfig', () => {
  it('기본값을 적용한다', () => {
    const config = resolveRetryConfig();
    expect(config.maxAttempts).toBe(3);
    expect(config.minDelay).toBe(1000);
    expect(config.maxDelay).toBe(30000);
    expect(config.jitter).toBe(true);
  });

  it('부분 설정을 병합한다', () => {
    const config = resolveRetryConfig({ maxAttempts: 5, jitter: false });
    expect(config.maxAttempts).toBe(5);
    expect(config.minDelay).toBe(1000);
    expect(config.jitter).toBe(false);
  });
});

describe('retry', () => {
  it('첫 시도 성공 시 즉시 반환한다', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retry(fn, { maxAttempts: 3, minDelay: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('일시적 에러 후 재시도하여 성공한다', async () => {
    const err = Object.assign(new Error('fail'), { code: 'ECONNRESET' });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    const result = await retry(fn, { maxAttempts: 3, minDelay: 10, jitter: false });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('maxAttempts 초과 시 마지막 에러를 던진다', async () => {
    const err = Object.assign(new Error('fail'), { code: 'ECONNRESET' });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retry(fn, { maxAttempts: 2, minDelay: 10, jitter: false })).rejects.toThrow(
      'fail',
    );
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('shouldRetry가 false이면 즉시 throw한다', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fatal'));
    await expect(
      retry(fn, { maxAttempts: 3, minDelay: 10, shouldRetry: () => false }),
    ).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('signal이 abort되면 즉시 throw한다', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(retry(fn, { maxAttempts: 3, signal: controller.signal })).rejects.toThrow(
      'Retry aborted',
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('onRetry 콜백을 호출한다', async () => {
    const err = Object.assign(new Error('fail'), { code: 'ECONNRESET' });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    const onRetry = vi.fn();
    await retry(fn, { maxAttempts: 3, minDelay: 10, jitter: false, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(err, 0, expect.any(Number));
  });

  it('retryAfterMs가 delay의 최소 보장을 한다', async () => {
    const err = Object.assign(new Error('fail'), { code: 'ECONNRESET' });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    const onRetry = vi.fn();
    await retry(fn, {
      maxAttempts: 3,
      minDelay: 10,
      jitter: false,
      retryAfterMs: 100,
      onRetry,
    });
    // delay는 최소 retryAfterMs(100)
    expect(onRetry.mock.calls[0][2]).toBeGreaterThanOrEqual(100);
  });

  it('비일시적 에러는 재시도하지 않는다 (기본 shouldRetry)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('not transient'));
    await expect(retry(fn, { maxAttempts: 3, minDelay: 10 })).rejects.toThrow('not transient');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

### 검증 (T9 전체)

- `pnpm test -- packages/infra/test/logger.test.ts packages/infra/test/system-events.test.ts packages/infra/test/ssrf.test.ts packages/infra/test/fetch.test.ts packages/infra/test/retry.test.ts` — 전체 통과

---

## T10. Part 2 전체 검증

### 왜

모든 변경(T1-T9)을 적용한 후 Part 2의 정합성을 확인한다.

### 검증 명령어

```bash
pnpm typecheck        # 에러 0
pnpm build            # packages/infra/dist/ 생성
pnpm test             # Part 1 + Part 2 테스트 전체 통과 (12개 파일)
pnpm lint             # 에러 0
```

### 성공 기준

| 명령어           | 기대 결과                                    |
| ---------------- | -------------------------------------------- |
| `pnpm typecheck` | 에러 0                                       |
| `pnpm build`     | `packages/infra/dist/` 생성                  |
| `pnpm test`      | Part 1 (7개) + Part 2 (5개) = 12개 파일 통과 |
| `pnpm lint`      | 에러 0                                       |

추가 확인:

- `logger.ts` → `context.ts`, `logger-transports.ts`, `paths.ts` 의존 (순환 없음)
- `retry.ts` → `backoff.ts` 의존 (순환 없음)
- `fetch.ts` → `ssrf.ts` → `errors.ts` 의존 (순환 없음)
- `system-events.ts` → `@finclaw/types` 의존만 (인프라 내부 의존 없음)

---

## 변경 요약

| 파일                         | 변경 유형 | 예상 LOC   |
| ---------------------------- | --------- | ---------- |
| `src/logger-transports.ts`   | 신규      | ~80        |
| `src/logger.ts`              | 신규      | ~140       |
| `src/events.ts`              | 신규      | ~95        |
| `src/system-events.ts`       | 신규      | ~90        |
| `src/agent-events.ts`        | 신규      | ~50        |
| `src/ssrf.ts`                | 신규      | ~135       |
| `src/fetch.ts`               | 신규      | ~75        |
| `src/retry.ts`               | 신규      | ~110       |
| `test/logger.test.ts`        | 신규      | ~80        |
| `test/system-events.test.ts` | 신규      | ~70        |
| `test/ssrf.test.ts`          | 신규      | ~80        |
| `test/fetch.test.ts`         | 신규      | ~60        |
| `test/retry.test.ts`         | 신규      | ~100       |
| **합계**                     |           | **~1,165** |
