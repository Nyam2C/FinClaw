# Phase 2 Part 1: 프로젝트 셋업 + 기반 모듈 + 환경/설정

> 현재 소스 분석 기준: 2026-02-26
> 대상 패키지: `packages/infra/`
> 소스 파일 10개, 테스트 파일 7개 + helpers.ts, 설정 파일 2개 + 루트 tsconfig 수정
> 예상 LOC: ~936 (소스 510 + 테스트 400 + 설정 26)
> 비중: 28% (전체 3,200 LOC 중)

---

## 작업 순서 및 의존성

```
T1 (package.json + tsconfig.json + 루트 tsconfig)
 └──→ T2 (errors.ts)             ← T1에 의존 (패키지 존재 필요)
       ├──→ T3 (backoff.ts)       ← 독립 (Ce=0)
       ├──→ T4 (format-duration)  ← 독립 (Ce=0)
       ├──→ T5 (warnings.ts)     ← 독립 (Ce=0)
       └──→ T6 (context.ts)      ← 독립 (Ce=0)
 └──→ T7 (test/helpers.ts)       ← T2에 의존 (에러 타입 사용)
 └──→ T8 (runtime-guard.ts)      ← T1에 의존
 └──→ T9 (dotenv.ts)             ← T1에 의존
 └──→ T10 (env.ts)               ← T1에 의존
 └──→ T11 (paths.ts)             ← T10에 의존 (getEnv 사용)
 └──→ T12 (is-main.ts)           ← T1에 의존
 └──→ T13 (테스트: errors, backoff, context, format-duration)  ← T2-T7에 의존
 └──→ T14 (테스트: runtime-guard, env, paths)                  ← T8-T11에 의존
 └──→ T15 (전체 검증)            ← T13, T14에 의존

권장 실행 순서: T1 → T2 → T3~T6 (병렬) → T7 → T8~T12 (병렬) → T13 → T14 → T15
```

---

## T1. 프로젝트 셋업

### 왜

`packages/infra/` 패키지가 존재하지 않는다. 모노레포에서 `@finclaw/infra`로 import하려면
`package.json`, `tsconfig.json`이 필요하고, 루트 `tsconfig.json`의 `references`에 추가해야 한다.

### 무엇을 — `packages/infra/package.json` (신규)

```json
{
  "name": "@finclaw/infra",
  "version": "0.1.0",
  "private": true,
  "files": ["dist"],
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "dependencies": {
    "@finclaw/types": "workspace:*",
    "tslog": "^4.9.3"
  }
}
```

### 무엇을 — `packages/infra/tsconfig.json` (신규)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "references": [{ "path": "../types" }]
}
```

> `@finclaw/types`를 import하므로 `references`에 `../types` 추가 필요.
> `packages/types/tsconfig.json`은 references가 없으므로 (순수 타입 패키지) 패턴이 다르다.

### 무엇을 — 루트 `tsconfig.json` 수정

**Before:**

```json
{
  "files": [],
  "references": [
    { "path": "packages/types" },
    { "path": "packages/config" },
```

**After:**

```json
{
  "files": [],
  "references": [
    { "path": "packages/types" },
    { "path": "packages/infra" },
    { "path": "packages/config" },
```

### 무엇을 — 의존성 설치

```bash
cd packages/infra && pnpm add tslog
```

> `pnpm.onlyBuiltDependencies`에 tslog은 네이티브 빌드가 없으므로 추가 불필요.

### 무엇을 — 빈 barrel export (임시)

`packages/infra/src/index.ts` (신규):

```typescript
// @finclaw/infra — barrel export (Part 3에서 완성)
export {};
```

> Part 1에서는 빈 export로 시작. `pnpm build`가 통과하려면 최소 하나의 소스 파일이 필요하다.

### 검증

```bash
pnpm install          # workspace 의존성 해석
pnpm typecheck        # 에러 0
pnpm build            # packages/infra/dist/ 생성
```

---

## T2. `errors.ts` — 에러 클래스 계층

### 왜

모든 인프라 모듈이 사용하는 에러 기반. `isOperational`로 운영 에러/프로그래밍 에러를 구분하고,
`Error.cause`로 에러 체이닝을 지원한다. Ce=0 (외부 의존 없음)이므로 가장 먼저 구현한다.

### 무엇을 — `packages/infra/src/errors.ts` (신규, ~100 LOC)

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

### 검증

- `pnpm typecheck` 통과
- T13 테스트에서 `instanceof`, `isOperational`, `Error.cause` 체이닝 검증

---

## T3. `backoff.ts` — 지수 백오프 + sleepWithAbort

### 왜

재시도 로직(Part 2 retry.ts)의 핵심 순수 함수. Ce=0으로 외부 의존 없이 독립 테스트 가능.
`node:timers/promises`의 `setTimeout`을 사용해 AbortSignal 지원.

### 무엇을 — `packages/infra/src/backoff.ts` (신규, ~40 LOC)

```typescript
// packages/infra/src/backoff.ts
import { setTimeout } from 'node:timers/promises';

export interface BackoffOptions {
  minDelay?: number; // 기본: 1000
  maxDelay?: number; // 기본: 30000
  jitter?: boolean; // 기본: true
}

/**
 * 지수 백오프 지연 시간 계산 (순수 함수)
 *
 * delay = min(maxDelay, 2^attempt * minDelay) + jitter
 */
export function computeBackoff(attempt: number, opts: BackoffOptions = {}): number {
  const { minDelay = 1000, maxDelay = 30000, jitter = true } = opts;
  const exponential = Math.min(maxDelay, Math.pow(2, attempt) * minDelay);
  if (!jitter) return exponential;
  return exponential + Math.floor(Math.random() * exponential * 0.1);
}

/**
 * AbortSignal 지원 sleep
 *
 * `node:timers/promises` setTimeout은 AbortSignal을 네이티브 지원.
 * signal이 이미 abort된 경우 즉시 reject.
 */
export async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  await setTimeout(ms, undefined, { signal });
}
```

### 검증

- `computeBackoff(0)` → `minDelay` 근처 값
- `computeBackoff(10)` → `maxDelay` 초과하지 않음
- `sleepWithAbort` + 이미 abort된 signal → 즉시 reject
- T13 테스트에서 검증

---

## T4. `format-duration.ts` — 밀리초 → 사람 읽기 형식

### 왜

로깅, 상태 표시에서 경과 시간을 "2h 30m 15s" 형식으로 표시. Ce=0 순수 함수.

### 무엇을 — `packages/infra/src/format-duration.ts` (신규, ~30 LOC)

```typescript
// packages/infra/src/format-duration.ts

/**
 * 밀리초를 "2h 30m 15s" 형식으로 변환
 *
 * - 0ms → "0ms"
 * - 999ms → "999ms"
 * - 1000ms → "1s"
 * - 3661000ms → "1h 1m 1s"
 */
export function formatDuration(ms: number): string {
  if (ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes % 60 > 0) parts.push(`${minutes % 60}m`);
  if (seconds % 60 > 0) parts.push(`${seconds % 60}s`);

  return parts.join(' ') || '0s';
}
```

### 검증

- `formatDuration(0)` → `"0ms"`
- `formatDuration(3661000)` → `"1h 1m 1s"`
- 경계값: 음수, 999, 1000, 60000
- T13 테스트에서 검증

---

## T5. `warnings.ts` — 중복 경고 억제

### 왜

동일 경고가 반복 출력되는 것을 방지. 첫 호출만 출력하고 이후는 무시. Ce=0 순수 모듈.

### 무엇을 — `packages/infra/src/warnings.ts` (신규, ~30 LOC)

```typescript
// packages/infra/src/warnings.ts

const emitted = new Set<string>();

/**
 * 중복 경고 억제 래퍼
 *
 * 동일 key로 호출 시 최초 1회만 fn 실행.
 */
export function warnOnce(key: string, fn: () => void): void {
  if (emitted.has(key)) return;
  emitted.add(key);
  fn();
}

/** 테스트용 상태 초기화 */
export function resetWarnings(): void {
  emitted.clear();
}
```

### 검증

- 같은 key로 2회 호출 → fn이 1회만 실행
- `resetWarnings()` 후 재호출 → fn이 다시 실행
- T13 테스트에서 검증 (warnings는 단순하므로 errors.test.ts에 포함하거나 별도 작성 판단)

---

## T6. `context.ts` — AsyncLocalStorage 요청 컨텍스트

### 왜

요청별 컨텍스트(requestId, sessionKey)를 ALS로 전파. 로거가 자동 주입하고,
에러 핸들러가 세션 식별에 사용. Ce=0.

### 무엇을 — `packages/infra/src/context.ts` (신규, ~50 LOC)

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

### 검증

- `runWithContext` 내부에서 `getContext()` → 주입한 컨텍스트 반환
- `runWithContext` 외부에서 `getContext()` → `undefined`
- 중첩 `runWithContext` → 내부 컨텍스트가 우선
- T13 테스트에서 검증

---

## T7. `test/helpers.ts` — 테스트 헬퍼

### 왜

임시 디렉토리 생성/정리, 테스트 로거 등 공통 유틸. Part 1-3 전체 테스트에서 사용.

### 무엇을 — `packages/infra/test/helpers.ts` (신규, ~30 LOC)

```typescript
// packages/infra/test/helpers.ts
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** 임시 디렉토리 생성 + 자동 정리 */
export async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finclaw-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 테스트용 무출력 로거 */
export function createTestLogger() {
  const noop = () => {};
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => createTestLogger(),
    flush: async () => {},
  };
}
```

### 검증

- `withTempDir` 콜백 내에서 디렉토리 존재
- 콜백 완료 후 디렉토리 삭제됨
- Part 2, Part 3에서도 사용

---

## T8. `runtime-guard.ts` — Node.js 22+ 버전 검증

### 왜

FinClaw는 Node.js 22+ 내장 기능(`process.loadEnvFile`, `node:sqlite` 등)에 의존.
프로세스 시작 시 최초 1회 검증하여 호환되지 않는 환경에서 명확한 에러 메시지를 제공.

### 무엇을 — `packages/infra/src/runtime-guard.ts` (신규, ~50 LOC)

```typescript
// packages/infra/src/runtime-guard.ts
const MINIMUM_NODE_VERSION = 22;

/**
 * Node.js 버전 검증
 *
 * 22 미만이면 에러 메시지 출력 후 process.exit(1).
 * 테스트에서는 process.exit를 spy하여 호출 여부만 확인.
 */
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

/** 현재 Node.js 메이저 버전 반환 (테스트 보조) */
export function getNodeMajorVersion(): number {
  return Number(process.versions.node.split('.')[0]);
}
```

### 검증

- 현재 환경(Node 22+)에서 `assertSupportedRuntime()` → 정상 통과 (exit 호출 없음)
- `process.versions.node`를 모킹하여 21 → `process.exit(1)` 호출 확인
- T14 테스트에서 검증

---

## T9. `dotenv.ts` — .env 파일 로딩

### 왜

Node.js 22의 `process.loadEnvFile()`을 사용하여 dotenv 패키지 없이 .env 로딩.
파일이 없으면 조용히 무시 (선택적 로딩).

### 무엇을 — `packages/infra/src/dotenv.ts` (신규, ~15 LOC)

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

### 검증

- 존재하지 않는 경로 → 에러 없이 무시
- 존재하는 .env 파일 → `process.env`에 반영
- T14에서는 직접 테스트하지 않음 (단순 래퍼이므로 env.test.ts에서 간접 검증)

---

## T10. `env.ts` — 환경 변수 정규화

### 왜

`FINCLAW_` 접두사 환경 변수를 정규화하고, 빈 문자열을 undefined로 변환.
`getEnv()`, `requireEnv()`, `isTruthyEnvValue()` 등 조회 유틸 제공.

### 무엇을 — `packages/infra/src/env.ts` (신규, ~75 LOC)

```typescript
// packages/infra/src/env.ts
const FINCLAW_PREFIX = 'FINCLAW_';

/** FINCLAW_ 접두사 환경 변수의 빈 문자열을 undefined로 정규화 */
export function normalizeEnv(): void {
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(FINCLAW_PREFIX)) continue;

    // 빈 문자열 → undefined 정규화
    if (value === '') {
      delete process.env[key];
    }
  }
}

/**
 * 환경 변수 조회
 *
 * FINCLAW_ 접두사를 우선 검색하고, 없으면 접두사 없는 키를 검색.
 */
export function getEnv(key: string, fallback?: string): string | undefined {
  return process.env[`${FINCLAW_PREFIX}${key}`] ?? process.env[key] ?? fallback;
}

/** 필수 환경 변수 조회 — 없으면 throw */
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

### 검증

- `normalizeEnv()` → 빈 `FINCLAW_*` 변수가 삭제됨
- `getEnv('PORT')` → `FINCLAW_PORT` 우선, 없으면 `PORT`, 없으면 fallback
- `requireEnv('PORT')` → 없으면 throw
- `isTruthyEnvValue('1')` → true, `isTruthyEnvValue('no')` → false
- T14 테스트에서 검증

---

## T11. `paths.ts` — 데이터/설정/로그 디렉토리 경로

### 왜

데이터, 설정, 로그 디렉토리 경로를 결정. `FINCLAW_STATE_DIR` 환경 변수로 재정의 가능.
XDG Base Directory 패턴을 따르되, 단순화하여 `~/.finclaw/` 기본 경로 사용.

### 무엇을 — `packages/infra/src/paths.ts` (신규, ~100 LOC)

```typescript
// packages/infra/src/paths.ts
import * as path from 'node:path';
import * as os from 'node:os';
import { getEnv } from './env.js';

/** 기본 상태 디렉토리 */
function defaultStateDir(): string {
  return path.join(os.homedir(), '.finclaw');
}

/** FinClaw 상태 디렉토리 (데이터/설정/로그의 루트) */
export function getStateDir(): string {
  return getEnv('STATE_DIR') ?? defaultStateDir();
}

/** 데이터 디렉토리 */
export function getDataDir(): string {
  return path.join(getStateDir(), 'data');
}

/** 설정 디렉토리 */
export function getConfigDir(): string {
  return path.join(getStateDir(), 'config');
}

/** 로그 디렉토리 */
export function getLogDir(): string {
  return path.join(getStateDir(), 'logs');
}

/** 세션 디렉토리 */
export function getSessionDir(): string {
  return path.join(getStateDir(), 'sessions');
}

/** 잠금 파일 디렉토리 */
export function getLockDir(): string {
  return path.join(getStateDir(), 'locks');
}

/** 설정 파일 경로 */
export function getConfigFilePath(): string {
  return path.join(getConfigDir(), 'finclaw.json');
}

/**
 * 모든 경로를 한번에 반환 (디버깅/로깅용)
 */
export function getAllPaths(): Record<string, string> {
  return {
    stateDir: getStateDir(),
    dataDir: getDataDir(),
    configDir: getConfigDir(),
    logDir: getLogDir(),
    sessionDir: getSessionDir(),
    lockDir: getLockDir(),
    configFile: getConfigFilePath(),
  };
}
```

### 검증

- `FINCLAW_STATE_DIR` 미설정 → `~/.finclaw/` 기본 경로
- `FINCLAW_STATE_DIR=/tmp/test` → `/tmp/test/` 기준 경로
- `getAllPaths()` → 모든 경로가 stateDir 하위
- T14 테스트에서 검증

---

## T12. `is-main.ts` — ESM 엔트리포인트 판별

### 왜

`node packages/infra/src/foo.ts`로 직접 실행 시를 판별. 스크립트 모드 분기에 사용.

### 무엇을 — `packages/infra/src/is-main.ts` (신규, ~20 LOC)

```typescript
// packages/infra/src/is-main.ts

/**
 * ESM 엔트리포인트 판별
 *
 * `import.meta.url`과 `process.argv[1]`을 비교하여
 * 현재 모듈이 직접 실행되었는지 판별.
 */
export function isMain(importMetaUrl: string): boolean {
  try {
    const moduleUrl = new URL(importMetaUrl);
    const argUrl = new URL(`file://${process.argv[1]}`);
    return moduleUrl.pathname === argUrl.pathname;
  } catch {
    return false;
  }
}
```

### 검증

- `isMain(import.meta.url)` → 직접 실행 시 true, import 시 false
- 잘못된 URL → false (에러 없음)
- 단순 유틸이므로 별도 테스트 파일 없이 T14에서 간접 검증 가능

---

## T13. 기반 모듈 테스트 (errors, backoff, context, format-duration)

### 왜

Ce=0 순수 모듈들의 단위 테스트. 외부 의존 없으므로 모킹 불필요.

### T13-1. `packages/infra/test/errors.test.ts` (신규, ~80 LOC)

```typescript
import { describe, it, expect } from 'vitest';
import {
  FinClawError,
  SsrfBlockedError,
  PortInUseError,
  isFinClawError,
  wrapError,
  extractErrorInfo,
} from '../src/errors.js';

describe('FinClawError', () => {
  it('기본값으로 생성된다', () => {
    const err = new FinClawError('test', 'TEST_CODE');
    expect(err.message).toBe('test');
    expect(err.code).toBe('TEST_CODE');
    expect(err.statusCode).toBe(500);
    expect(err.isOperational).toBe(true);
    expect(err.name).toBe('FinClawError');
  });

  it('옵션으로 커스터마이징된다', () => {
    const cause = new Error('root');
    const err = new FinClawError('test', 'CODE', {
      statusCode: 400,
      isOperational: false,
      cause,
      details: { key: 'value' },
    });
    expect(err.statusCode).toBe(400);
    expect(err.isOperational).toBe(false);
    expect(err.cause).toBe(cause);
    expect(err.details).toEqual({ key: 'value' });
  });

  it('Error를 상속한다', () => {
    const err = new FinClawError('test', 'CODE');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FinClawError);
    expect(err.stack).toBeDefined();
  });
});

describe('SsrfBlockedError', () => {
  it('hostname과 ip를 포함한다', () => {
    const err = new SsrfBlockedError('evil.com', '10.0.0.1');
    expect(err.code).toBe('SSRF_BLOCKED');
    expect(err.statusCode).toBe(403);
    expect(err.details).toEqual({ hostname: 'evil.com', ip: '10.0.0.1' });
    expect(err.name).toBe('SsrfBlockedError');
  });
});

describe('PortInUseError', () => {
  it('포트 정보를 포함한다', () => {
    const err = new PortInUseError(8080, 'node');
    expect(err.code).toBe('PORT_IN_USE');
    expect(err.message).toContain('8080');
    expect(err.message).toContain('node');
  });

  it('occupiedBy 없이 생성 가능하다', () => {
    const err = new PortInUseError(3000);
    expect(err.message).toContain('3000');
    expect(err.message).not.toContain('by');
  });
});

describe('isFinClawError', () => {
  it('FinClawError 인스턴스에 true', () => {
    expect(isFinClawError(new FinClawError('test', 'CODE'))).toBe(true);
  });

  it('하위 클래스에도 true', () => {
    expect(isFinClawError(new SsrfBlockedError('h', '1'))).toBe(true);
  });

  it('일반 Error에 false', () => {
    expect(isFinClawError(new Error('test'))).toBe(false);
  });

  it('non-Error에 false', () => {
    expect(isFinClawError('string')).toBe(false);
    expect(isFinClawError(null)).toBe(false);
  });
});

describe('wrapError', () => {
  it('Error를 cause로 체이닝한다', () => {
    const original = new Error('original');
    const wrapped = wrapError('wrapped', 'WRAP', original);
    expect(wrapped.cause).toBe(original);
    expect(wrapped.code).toBe('WRAP');
  });

  it('non-Error를 Error로 변환하여 cause에 넣는다', () => {
    const wrapped = wrapError('wrapped', 'WRAP', 'string cause');
    expect(wrapped.cause).toBeInstanceOf(Error);
    expect((wrapped.cause as Error).message).toBe('string cause');
  });
});

describe('extractErrorInfo', () => {
  it('FinClawError에서 구조화된 정보를 추출한다', () => {
    const cause = new Error('root');
    const err = new FinClawError('test', 'CODE', { cause });
    const info = extractErrorInfo(err);
    expect(info.code).toBe('CODE');
    expect(info.message).toBe('test');
    expect(info.isOperational).toBe(true);
    expect(info.cause).toBe('root');
  });

  it('일반 Error에서 기본 정보를 추출한다', () => {
    const info = extractErrorInfo(new Error('plain'));
    expect(info.code).toBe('UNKNOWN');
    expect(info.message).toBe('plain');
  });

  it('non-Error를 문자열로 변환한다', () => {
    const info = extractErrorInfo(42);
    expect(info.code).toBe('UNKNOWN');
    expect(info.message).toBe('42');
  });
});
```

### T13-2. `packages/infra/test/backoff.test.ts` (신규, ~50 LOC)

```typescript
import { describe, it, expect } from 'vitest';
import { computeBackoff, sleepWithAbort } from '../src/backoff.js';

describe('computeBackoff', () => {
  it('attempt=0에서 minDelay 근처 값을 반환한다', () => {
    const delay = computeBackoff(0, { minDelay: 1000, maxDelay: 30000, jitter: false });
    expect(delay).toBe(1000);
  });

  it('attempt 증가에 따라 지수적으로 증가한다', () => {
    const d0 = computeBackoff(0, { jitter: false });
    const d1 = computeBackoff(1, { jitter: false });
    const d2 = computeBackoff(2, { jitter: false });
    expect(d1).toBe(d0 * 2);
    expect(d2).toBe(d0 * 4);
  });

  it('maxDelay를 초과하지 않는다', () => {
    const delay = computeBackoff(20, { minDelay: 1000, maxDelay: 5000, jitter: false });
    expect(delay).toBe(5000);
  });

  it('jitter 활성화 시 기본값보다 크거나 같다', () => {
    const delay = computeBackoff(2, { minDelay: 1000, maxDelay: 30000, jitter: true });
    const base = computeBackoff(2, { minDelay: 1000, maxDelay: 30000, jitter: false });
    expect(delay).toBeGreaterThanOrEqual(base);
  });

  it('기본 옵션으로 동작한다', () => {
    const delay = computeBackoff(0);
    expect(delay).toBeGreaterThanOrEqual(1000);
  });
});

describe('sleepWithAbort', () => {
  it('짧은 시간 sleep이 정상 완료된다', async () => {
    await expect(sleepWithAbort(10)).resolves.toBeUndefined();
  });

  it('이미 abort된 signal로 즉시 reject된다', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleepWithAbort(10000, controller.signal)).rejects.toThrow();
  });

  it('sleep 중 abort 시 reject된다', async () => {
    const controller = new AbortController();
    const promise = sleepWithAbort(10000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow();
  });
});
```

### T13-3. `packages/infra/test/context.test.ts` (신규, ~50 LOC)

```typescript
import { describe, it, expect } from 'vitest';
import { runWithContext, getContext, getRequestId } from '../src/context.js';

describe('RequestContext (ALS)', () => {
  it('runWithContext 내부에서 getContext로 조회된다', () => {
    const ctx = { requestId: 'req-1', startedAt: Date.now() };
    runWithContext(ctx, () => {
      expect(getContext()).toBe(ctx);
      expect(getRequestId()).toBe('req-1');
    });
  });

  it('runWithContext 외부에서는 undefined이다', () => {
    expect(getContext()).toBeUndefined();
    expect(getRequestId()).toBeUndefined();
  });

  it('중첩 runWithContext에서 내부 컨텍스트가 우선한다', () => {
    const outer = { requestId: 'outer', startedAt: 1 };
    const inner = { requestId: 'inner', startedAt: 2 };

    runWithContext(outer, () => {
      expect(getRequestId()).toBe('outer');
      runWithContext(inner, () => {
        expect(getRequestId()).toBe('inner');
      });
      expect(getRequestId()).toBe('outer');
    });
  });

  it('비동기 콜백에서 컨텍스트가 전파된다', async () => {
    const ctx = { requestId: 'async-req', startedAt: Date.now() };
    await runWithContext(ctx, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(getRequestId()).toBe('async-req');
    });
  });
});
```

### T13-4. `packages/infra/test/format-duration.test.ts` (신규, ~30 LOC)

```typescript
import { describe, it, expect } from 'vitest';
import { formatDuration } from '../src/format-duration.js';

describe('formatDuration', () => {
  it('0ms를 반환한다', () => {
    expect(formatDuration(0)).toBe('0ms');
  });

  it('밀리초 단위를 반환한다', () => {
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('초 단위를 반환한다', () => {
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(5000)).toBe('5s');
  });

  it('분 + 초를 반환한다', () => {
    expect(formatDuration(90000)).toBe('1m 30s');
  });

  it('시 + 분 + 초를 반환한다', () => {
    expect(formatDuration(3661000)).toBe('1h 1m 1s');
  });

  it('정확히 1시간을 반환한다', () => {
    expect(formatDuration(3600000)).toBe('1h');
  });

  it('음수에 0ms를 반환한다', () => {
    expect(formatDuration(-100)).toBe('0ms');
  });
});
```

### 검증 (T13 전체)

- `pnpm test -- packages/infra/test/errors.test.ts packages/infra/test/backoff.test.ts packages/infra/test/context.test.ts packages/infra/test/format-duration.test.ts` — 전체 통과

---

## T14. 환경/설정 테스트 (runtime-guard, env, paths)

### 왜

환경 의존적 모듈의 동작 검증. `process.env`, `process.versions` 모킹 필요.

### T14-1. `packages/infra/test/runtime-guard.test.ts` (신규, ~40 LOC)

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { assertSupportedRuntime, getNodeMajorVersion } from '../src/runtime-guard.js';

describe('assertSupportedRuntime', () => {
  it('Node 22+에서 정상 통과한다', () => {
    // 현재 환경이 22+이므로 exit 호출 없음
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    assertSupportedRuntime();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

describe('getNodeMajorVersion', () => {
  it('현재 Node 메이저 버전을 반환한다', () => {
    const major = getNodeMajorVersion();
    expect(major).toBeGreaterThanOrEqual(22);
    expect(typeof major).toBe('number');
  });
});
```

> `process.versions.node`를 직접 모킹하면 불안정하므로, 현재 환경(Node 22+)에서 통과 확인만 한다.
> 22 미만 환경에서의 exit 동작은 통합 테스트에서 별도 프로세스로 검증.

### T14-2. `packages/infra/test/env.test.ts` (신규, ~70 LOC)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeEnv, getEnv, requireEnv, isTruthyEnvValue } from '../src/env.js';

describe('normalizeEnv', () => {
  beforeEach(() => {
    vi.stubEnv('FINCLAW_EMPTY', '');
    vi.stubEnv('FINCLAW_VALUE', 'hello');
    vi.stubEnv('OTHER_EMPTY', '');
  });

  it('빈 FINCLAW_ 변수를 삭제한다', () => {
    normalizeEnv();
    expect(process.env.FINCLAW_EMPTY).toBeUndefined();
  });

  it('값이 있는 FINCLAW_ 변수를 유지한다', () => {
    normalizeEnv();
    expect(process.env.FINCLAW_VALUE).toBe('hello');
  });

  it('FINCLAW_ 접두사가 아닌 빈 변수는 무시한다', () => {
    normalizeEnv();
    expect(process.env.OTHER_EMPTY).toBe('');
  });
});

describe('getEnv', () => {
  beforeEach(() => {
    vi.stubEnv('FINCLAW_PORT', '8080');
    vi.stubEnv('HOST', 'localhost');
  });

  it('FINCLAW_ 접두사 변수를 우선 반환한다', () => {
    vi.stubEnv('PORT', '3000');
    expect(getEnv('PORT')).toBe('8080');
  });

  it('FINCLAW_ 없으면 접두사 없는 키를 반환한다', () => {
    expect(getEnv('HOST')).toBe('localhost');
  });

  it('둘 다 없으면 fallback을 반환한다', () => {
    expect(getEnv('MISSING', 'default')).toBe('default');
  });

  it('fallback도 없으면 undefined를 반환한다', () => {
    expect(getEnv('MISSING')).toBeUndefined();
  });
});

describe('requireEnv', () => {
  it('값이 있으면 반환한다', () => {
    vi.stubEnv('FINCLAW_TOKEN', 'abc');
    expect(requireEnv('TOKEN')).toBe('abc');
  });

  it('값이 없으면 throw한다', () => {
    expect(() => requireEnv('NONEXISTENT')).toThrow('Required environment variable');
  });
});

describe('isTruthyEnvValue', () => {
  it.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['yes', true],
    ['YES', true],
    ['0', false],
    ['false', false],
    ['no', false],
    ['', false],
    [undefined, false],
  ])('isTruthyEnvValue(%j) → %s', (input, expected) => {
    expect(isTruthyEnvValue(input)).toBe(expected);
  });
});
```

### T14-3. `packages/infra/test/paths.test.ts` (신규, ~50 LOC)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { getStateDir, getDataDir, getLogDir, getConfigDir, getAllPaths } from '../src/paths.js';

describe('paths', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('기본 stateDir은 ~/.finclaw/ 이다', () => {
    expect(getStateDir()).toBe(path.join(os.homedir(), '.finclaw'));
  });

  it('FINCLAW_STATE_DIR 환경 변수로 재정의된다', () => {
    vi.stubEnv('FINCLAW_STATE_DIR', '/tmp/custom');
    expect(getStateDir()).toBe('/tmp/custom');
  });

  it('dataDir은 stateDir/data 이다', () => {
    vi.stubEnv('FINCLAW_STATE_DIR', '/tmp/test');
    expect(getDataDir()).toBe('/tmp/test/data');
  });

  it('logDir은 stateDir/logs 이다', () => {
    vi.stubEnv('FINCLAW_STATE_DIR', '/tmp/test');
    expect(getLogDir()).toBe('/tmp/test/logs');
  });

  it('configDir은 stateDir/config 이다', () => {
    vi.stubEnv('FINCLAW_STATE_DIR', '/tmp/test');
    expect(getConfigDir()).toBe('/tmp/test/config');
  });

  it('getAllPaths는 모든 경로를 반환한다', () => {
    vi.stubEnv('FINCLAW_STATE_DIR', '/tmp/test');
    const paths = getAllPaths();
    expect(paths.stateDir).toBe('/tmp/test');
    expect(paths.dataDir).toBe('/tmp/test/data');
    expect(paths.logDir).toBe('/tmp/test/logs');
    expect(paths.configDir).toBe('/tmp/test/config');
    expect(Object.keys(paths)).toHaveLength(7);
  });
});
```

### 검증 (T14 전체)

- `pnpm test -- packages/infra/test/runtime-guard.test.ts packages/infra/test/env.test.ts packages/infra/test/paths.test.ts` — 전체 통과

---

## T15. Part 1 전체 검증

### 왜

모든 변경(T1-T14)을 적용한 후 Part 1의 정합성을 확인한다.

### 검증 명령어

```bash
pnpm typecheck        # 에러 0
pnpm build            # packages/infra/dist/ 생성
pnpm test             # Part 1 테스트 7개 파일 전체 통과
pnpm lint             # 에러 0
```

### 성공 기준

| 명령어           | 기대 결과                   |
| ---------------- | --------------------------- |
| `pnpm typecheck` | 에러 0                      |
| `pnpm build`     | `packages/infra/dist/` 생성 |
| `pnpm test`      | 7개 테스트 파일 통과        |
| `pnpm lint`      | 에러 0                      |

추가 확인:

- `errors.ts`, `backoff.ts`, `context.ts`는 Ce=0 유지 (외부 import 없음)
- `paths.ts` → `env.ts` 의존만 존재 (순환 없음)
- Part 2에서 사용할 모듈이 모두 import 가능

---

## 변경 요약

| 파일                           | 변경 유형 | 예상 LOC |
| ------------------------------ | --------- | -------- |
| `packages/infra/package.json`  | 신규      | ~16      |
| `packages/infra/tsconfig.json` | 신규      | ~5       |
| `tsconfig.json` (루트)         | 수정      | +1       |
| `src/index.ts`                 | 신규      | ~3       |
| `src/errors.ts`                | 신규      | ~100     |
| `src/backoff.ts`               | 신규      | ~40      |
| `src/format-duration.ts`       | 신규      | ~30      |
| `src/warnings.ts`              | 신규      | ~30      |
| `src/context.ts`               | 신규      | ~50      |
| `src/runtime-guard.ts`         | 신규      | ~50      |
| `src/dotenv.ts`                | 신규      | ~15      |
| `src/env.ts`                   | 신규      | ~75      |
| `src/paths.ts`                 | 신규      | ~100     |
| `src/is-main.ts`               | 신규      | ~20      |
| `test/helpers.ts`              | 신규      | ~30      |
| `test/errors.test.ts`          | 신규      | ~80      |
| `test/backoff.test.ts`         | 신규      | ~50      |
| `test/context.test.ts`         | 신규      | ~50      |
| `test/format-duration.test.ts` | 신규      | ~30      |
| `test/runtime-guard.test.ts`   | 신규      | ~40      |
| `test/env.test.ts`             | 신규      | ~70      |
| `test/paths.test.ts`           | 신규      | ~50      |
| **합계**                       |           | **~935** |
