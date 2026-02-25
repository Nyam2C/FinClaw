# Phase 2 Part 3: 복원력 패턴 + 파일시스템 + 프로세스 + barrel export

> 현재 소스 분석 기준: 2026-02-26
> 대상 패키지: `packages/infra/`
> 소스 파일 9개, 테스트 파일 6개
> 예상 LOC: ~1,260 (소스 800 + 테스트 460)
> 비중: 37% (전체 3,200 LOC 중)
> Part 1 의존: errors, backoff
> Part 2 의존: events

---

## 선행 조건

Part 1 + Part 2 완료 필수. 다음 모듈이 존재하고 테스트를 통과해야 한다:

| 모듈         | Part 3에서의 사용처                         |
| ------------ | ------------------------------------------- |
| `errors.ts`  | gateway-lock, unhandled-rejections에서 사용 |
| `backoff.ts` | dedupe TTL 계산에서 참조 패턴               |
| `events.ts`  | unhandled-rejections에서 이벤트 발행        |
| `paths.ts`   | gateway-lock에서 lockDir 경로 결정          |
| `env.ts`     | ports에서 환경 변수 기반 포트 결정          |

---

## 작업 순서 및 의존성

```
T1 (dedupe.ts)                  ← 독립 (외부 의존 없음)
T2 (circuit-breaker.ts)         ← 독립 (외부 의존 없음)
T3 (fs-safe.ts)                 ← 독립 (node: 내장만)
 └──→ T4 (json-file.ts)         ← T3에 의존
T5 (gateway-lock.ts)            ← Part 1 errors 의존
T6 (ports.ts)                   ← Part 1 errors 의존
 └──→ T7 (ports-inspect.ts)     ← T6에 의존
T8 (unhandled-rejections.ts)    ← Part 1 errors 의존
T9 (테스트: dedupe, circuit-breaker, fs-safe, gateway-lock, ports, unhandled-rejections)
T10 (index.ts barrel export)    ← T1-T8 완료 후
T11 (Part 3 + 전체 통합 검증)

권장 실행 순서: T1~T3 (병렬) → T4 → T5~T8 (병렬) → T9 → T10 → T11
```

---

## T1. `dedupe.ts` — 동시 호출 중복 제거

### 왜

같은 키로 동시에 여러 호출이 발생할 때, 첫 호출만 실행하고 나머지는 결과를 공유.
API 호출 중복 방지, 캐시 스탬피드 완화에 사용.

### 무엇을 — `packages/infra/src/dedupe.ts` (신규, ~65 LOC)

```typescript
// packages/infra/src/dedupe.ts

export interface DedupeOptions {
  /** TTL (ms) — 결과 캐시 유지 시간 (기본: 0, 캐시 없음) */
  ttlMs?: number;
  /** 최대 캐시 엔트리 수 (기본: 1000) */
  maxSize?: number;
}

interface Entry<T> {
  promise: Promise<T>;
  expiresAt: number;
}

/**
 * 동시 호출 중복 제거기
 *
 * - 동일 key로 동시 호출 시 첫 호출의 Promise를 공유
 * - TTL > 0이면 결과를 캐시 (TTL 만료 시 삭제)
 * - maxSize 초과 시 가장 오래된 엔트리 삭제
 */
export class Dedupe<T> {
  private readonly inflight = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(opts: DedupeOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 0;
    this.maxSize = opts.maxSize ?? 1000;
  }

  /** 중복 제거된 실행 */
  async execute(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing && (this.ttlMs === 0 || Date.now() < existing.expiresAt)) {
      return existing.promise;
    }

    const promise = fn().finally(() => {
      if (this.ttlMs === 0) {
        this.inflight.delete(key);
      }
    });

    this.inflight.set(key, {
      promise,
      expiresAt: Date.now() + this.ttlMs,
    });

    // maxSize 초과 시 가장 오래된 것 삭제
    if (this.inflight.size > this.maxSize) {
      const firstKey = this.inflight.keys().next().value;
      if (firstKey !== undefined) this.inflight.delete(firstKey);
    }

    return promise;
  }

  /** 특정 키 확인 */
  check(key: string): boolean {
    return this.inflight.has(key);
  }

  /** 특정 키의 결과 조회 (없으면 undefined) */
  peek(key: string): Promise<T> | undefined {
    return this.inflight.get(key)?.promise;
  }

  /** 전체 캐시 클리어 */
  clear(): void {
    this.inflight.clear();
  }

  /** 현재 캐시 크기 */
  get size(): number {
    return this.inflight.size;
  }
}
```

### 검증

- 같은 key로 동시 3회 호출 → fn은 1회만 실행
- TTL=0 → 완료 즉시 삭제
- TTL>0 → TTL 기간 내 캐시 반환
- maxSize 초과 → 가장 오래된 것 삭제
- check/peek/clear/size 동작
- T9 테스트에서 검증

---

## T2. `circuit-breaker.ts` — 경량 서킷 브레이커

### 왜

외부 서비스 장애를 격리하여 시스템 전체 장애 확산을 방지.
closed → open → half-open → closed 상태 전이.

### 무엇을 — `packages/infra/src/circuit-breaker.ts` (신규, ~90 LOC)

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
  getFailures(): number {
    return this.failures;
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

### 검증

- closed 상태에서 성공 → closed 유지
- failureThreshold 도달 → open 전환
- open 상태에서 즉시 호출 → 에러 throw
- resetTimeoutMs 경과 후 → half-open 전환
- half-open에서 성공 → closed 전환
- half-open에서 실패 → open 전환
- `reset()` → closed, failures=0
- T9 테스트에서 검증

---

## T3. `fs-safe.ts` — 원자적 파일 쓰기 + 심링크 방지

### 왜

설정/세션 파일 쓰기 시 크래시 안전성 보장. 임시 파일 → rename으로 원자적 교체.
심링크 공격을 O_NOFOLLOW로 방지.

### 무엇을 — `packages/infra/src/fs-safe.ts` (신규, ~90 LOC)

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

/**
 * 디렉토리 존재 보장 (존재하지 않으면 생성)
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * 안전한 파일 삭제 (없으면 무시)
 */
export async function unlinkSafe(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function isWindowsRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return process.platform === 'win32' && (code === 'EPERM' || code === 'EEXIST');
}
```

### 검증

- 원자적 쓰기 후 파일 내용 일치
- 임시 파일이 남지 않음
- 심링크 대상에 readFileSafe → ELOOP/ENOENT (플랫폼 의존)
- `ensureDir` → 중첩 디렉토리 생성
- `unlinkSafe` → 없는 파일 삭제 시 에러 없음
- T9 테스트에서 검증

---

## T4. `json-file.ts` — JSON 파일 원자적 읽기/쓰기

### 왜

설정, 세션 데이터를 JSON 파일로 저장. `writeFileAtomic`을 사용하여 크래시 안전.
동기 API도 제공 (프로세스 시작 시 빠른 설정 로딩).

### 무엇을 — `packages/infra/src/json-file.ts` (신규, ~65 LOC)

```typescript
// packages/infra/src/json-file.ts
import * as fs from 'node:fs';
import { writeFileAtomic, readFileSafe, ensureDir } from './fs-safe.js';
import * as path from 'node:path';

/**
 * JSON 파일 비동기 읽기
 *
 * 파일이 없으면 undefined 반환.
 * JSON 파싱 실패 시 에러 throw.
 */
export async function readJsonFile<T = unknown>(filePath: string): Promise<T | undefined> {
  try {
    const content = await readFileSafe(filePath);
    return JSON.parse(content) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * JSON 파일 비동기 쓰기 (원자적)
 *
 * 디렉토리가 없으면 자동 생성.
 * 퍼미션: 0o600 (소유자만 읽기/쓰기).
 */
export async function writeJsonFile(filePath: string, data: unknown, indent = 2): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const content = JSON.stringify(data, null, indent) + '\n';
  await writeFileAtomic(filePath, content, 0o600);
}

/**
 * JSON 파일 동기 읽기 (프로세스 시작 시 사용)
 *
 * 파일이 없으면 undefined 반환.
 */
export function readJsonFileSync<T = unknown>(filePath: string): T | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
```

### 검증

- `writeJsonFile` + `readJsonFile` → 원래 데이터 복원
- 존재하지 않는 파일 → undefined
- 잘못된 JSON → 에러 throw
- 디렉토리 자동 생성
- `readJsonFileSync` → 동기 읽기 동작
- T9 fs-safe.test.ts에서 간접 검증

---

## T5. `gateway-lock.ts` — 파일 기반 뮤텍스

### 왜

게이트웨이 단일 인스턴스 보장. 파일 기반 잠금으로 동시 실행 방지.
PID + 타임스탬프로 stale 감지, AbortSignal로 취소 가능.

### 무엇을 — `packages/infra/src/gateway-lock.ts` (신규, ~165 LOC)

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
  port?: number;
  signal?: AbortSignal;
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

  await fs.mkdir(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, 'gateway.lock');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new GatewayLockError('Lock acquisition aborted');
    }

    try {
      const fd = await fs.open(lockPath, 'wx');
      const acquiredAt = Date.now();
      const payload = JSON.stringify({
        pid: process.pid,
        port,
        acquiredAt,
      });
      await fd.write(payload);
      await fd.close();

      return {
        lockPath,
        pid: process.pid,
        port,
        acquiredAt,
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

/**
 * 잠금 파일 정보 읽기 (디버깅/진단용)
 */
export async function readLockInfo(lockPath: string): Promise<
  | {
      pid: number;
      port?: number;
      acquiredAt: number;
    }
  | undefined
> {
  try {
    const content = await fs.readFile(lockPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

async function handleExistingLock(lockPath: string, staleThresholdMs: number): Promise<void> {
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs > staleThresholdMs) {
      // stale 잠금 → PID 유효성 추가 확인
      const info = await readLockInfo(lockPath);
      if (info && !isProcessAlive(info.pid)) {
        await fs.unlink(lockPath);
      } else if (Date.now() - stat.mtimeMs > staleThresholdMs * 2) {
        // 프로세스가 살아있어도 2x 임계치 초과 시 강제 삭제
        await fs.unlink(lockPath);
      }
    }
  } catch {
    // 파일이 이미 삭제됨 → 다음 루프에서 재시도
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

### 검증

- 잠금 획득 → lockPath 파일 생성
- 잠금 해제 → lockPath 파일 삭제
- 이미 잠긴 상태 → 타임아웃 후 GatewayLockError
- stale 잠금 (PID 죽음) → 자동 삭제 후 재획득
- signal abort → 즉시 GatewayLockError
- T9 테스트에서 검증

---

## T6. `ports.ts` — TCP 포트 가용성 확인

### 왜

서버 시작 전 포트 가용성을 확인. EADDRINUSE 감지로 명확한 에러 메시지 제공.

### 무엇을 — `packages/infra/src/ports.ts` (신규, ~80 LOC)

```typescript
// packages/infra/src/ports.ts
import * as net from 'node:net';
import { PortInUseError } from './errors.js';

/**
 * TCP 포트 가용성 확인
 *
 * 지정 포트에 바인딩 시도 후 즉시 해제.
 * 사용 중이면 PortInUseError throw.
 */
export async function assertPortAvailable(port: number, host = '0.0.0.0'): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new PortInUseError(port));
      } else {
        reject(err);
      }
    });

    server.listen(port, host, () => {
      server.close(() => resolve());
    });
  });
}

/**
 * 사용 가능한 포트 찾기
 *
 * 지정 포트부터 시작하여 사용 가능한 첫 포트를 반환.
 * maxTries 횟수만큼 시도.
 */
export async function findAvailablePort(
  startPort: number,
  maxTries = 10,
  host = '0.0.0.0',
): Promise<number> {
  for (let i = 0; i < maxTries; i++) {
    const port = startPort + i;
    try {
      await assertPortAvailable(port, host);
      return port;
    } catch (err) {
      if (!(err instanceof PortInUseError)) throw err;
      // 다음 포트 시도
    }
  }
  throw new PortInUseError(startPort, `ports ${startPort}-${startPort + maxTries - 1} all in use`);
}

/**
 * 포트 번호 유효성 검사
 */
export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
```

### 검증

- 사용되지 않는 포트 → 정상 통과
- 사용 중인 포트 → PortInUseError
- `findAvailablePort` → 점유 포트 건너뛰고 가용 포트 반환
- `isValidPort` → 1-65535 범위 검증
- T9 테스트에서 검증

---

## T7. `ports-inspect.ts` — 포트 점유 프로세스 진단

### 왜

포트 충돌 시 어떤 프로세스가 점유하고 있는지 진단 정보 제공.
`lsof` (Linux/macOS) 또는 `netstat` (Windows) 기반.

### 무엇을 — `packages/infra/src/ports-inspect.ts` (신규, ~100 LOC)

```typescript
// packages/infra/src/ports-inspect.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PortOccupant {
  pid: number;
  command: string;
  user?: string;
}

/**
 * 포트를 점유하고 있는 프로세스 정보 조회
 *
 * Linux/macOS: lsof -i :<port> -sTCP:LISTEN
 * 실패 시 undefined 반환 (권한 부족 등)
 */
export async function inspectPortOccupant(port: number): Promise<PortOccupant | undefined> {
  try {
    if (process.platform === 'win32') {
      return await inspectWindows(port);
    }
    return await inspectUnix(port);
  } catch {
    return undefined;
  }
}

async function inspectUnix(port: number): Promise<PortOccupant | undefined> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-n', '-P'], {
      timeout: 5000,
    });

    const lines = stdout.trim().split('\n');
    if (lines.length < 2) return undefined;

    // lsof 출력: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
    const parts = lines[1].split(/\s+/);
    return {
      command: parts[0],
      pid: Number(parts[1]),
      user: parts[2],
    };
  } catch {
    return undefined;
  }
}

async function inspectWindows(port: number): Promise<PortOccupant | undefined> {
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano'], { timeout: 5000 });
    const lines = stdout.split('\n');
    const portLine = lines.find((l) => l.includes(`:${port}`) && l.includes('LISTENING'));
    if (!portLine) return undefined;

    const parts = portLine.trim().split(/\s+/);
    const pid = Number(parts[parts.length - 1]);
    return { pid, command: 'unknown' };
  } catch {
    return undefined;
  }
}

/**
 * 포트 점유 정보를 사람이 읽을 수 있는 문자열로 포맷
 */
export function formatPortOccupant(port: number, occupant: PortOccupant | undefined): string {
  if (!occupant) {
    return `Port ${port} is in use (unable to determine occupant)`;
  }
  const user = occupant.user ? ` by user ${occupant.user}` : '';
  return `Port ${port} is in use by ${occupant.command} (PID ${occupant.pid})${user}`;
}
```

### 검증

- `inspectPortOccupant` → 사용 중인 포트에서 프로세스 정보 반환 (또는 undefined)
- `formatPortOccupant` → 사람이 읽을 수 있는 문자열
- 실패 시 에러 없이 undefined 반환
- 별도 테스트 파일 불필요 (ports.test.ts에서 간접 검증, 플랫폼 의존적이므로)

---

## T8. `unhandled-rejections.ts` — 5단계 미처리 rejection 분류

### 왜

미처리 Promise rejection을 5단계로 분류하여 적절한 액션(warn/exit) 수행.
AbortError, 일시적 네트워크 에러는 경고만, 나머지는 프로세스 종료.

### 무엇을 — `packages/infra/src/unhandled-rejections.ts` (신규, ~100 LOC)

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
        logger.warn(`Unhandled rejection (${level}): ${formatReason(reason)}`);
        break;
      default:
        logger.error(`Fatal unhandled rejection (${level}): ${formatReason(reason)}`);
        process.exit(1);
    }
  });
}

export type ErrorLevel = 'abort' | 'fatal' | 'config' | 'transient' | 'unknown';

/** 에러 분류 (테스트에서도 사용) */
export function classifyError(err: unknown): ErrorLevel {
  if (isAbortError(err)) return 'abort';
  if (isFatalError(err)) return 'fatal';
  if (isConfigError(err)) return 'config';
  if (isTransientError(err)) return 'transient';
  return 'unknown';
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return false;
}

function isFatalError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('out of memory') ||
    msg.includes('heap') ||
    msg.includes('stack overflow') ||
    (err as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY'
  );
}

function isConfigError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('invalid config') ||
    msg.includes('authentication') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('invalid token')
  );
}

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return TRANSIENT_CODES.has(code ?? '');
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

function formatReason(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  return String(reason);
}
```

### 검증

- AbortError → 'abort' 분류 (warn, exit 없음)
- OOM 에러 → 'fatal' 분류 (exit)
- ECONNRESET → 'transient' 분류 (warn, exit 없음)
- 설정 에러 → 'config' 분류 (exit)
- 알 수 없는 에러 → 'unknown' 분류 (exit)
- T9 테스트에서 검증

---

## T9. 테스트 (dedupe, circuit-breaker, fs-safe, gateway-lock, ports, unhandled-rejections)

### 왜

Part 3 모듈들의 단위 테스트. 실제 임시 디렉토리와 TCP 서버를 사용하여 모킹 최소화.

### T9-1. `packages/infra/test/dedupe.test.ts` (신규, ~70 LOC)

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Dedupe } from '../src/dedupe.js';

describe('Dedupe', () => {
  it('동일 키 동시 호출 시 fn을 1회만 실행한다', async () => {
    const dedupe = new Dedupe();
    const fn = vi.fn().mockResolvedValue('result');

    const [r1, r2, r3] = await Promise.all([
      dedupe.execute('key', fn),
      dedupe.execute('key', fn),
      dedupe.execute('key', fn),
    ]);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(r1).toBe('result');
    expect(r2).toBe('result');
    expect(r3).toBe('result');
  });

  it('다른 키는 각각 실행한다', async () => {
    const dedupe = new Dedupe();
    const fn = vi.fn().mockResolvedValue('ok');

    await Promise.all([dedupe.execute('a', fn), dedupe.execute('b', fn)]);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('TTL=0이면 완료 후 즉시 삭제한다', async () => {
    const dedupe = new Dedupe({ ttlMs: 0 });
    await dedupe.execute('key', async () => 'ok');
    expect(dedupe.size).toBe(0);
  });

  it('TTL>0이면 결과를 캐시한다', async () => {
    const dedupe = new Dedupe({ ttlMs: 10000 });
    const fn = vi.fn().mockResolvedValue('cached');

    await dedupe.execute('key', fn);
    await dedupe.execute('key', fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(dedupe.size).toBe(1);
  });

  it('maxSize 초과 시 가장 오래된 것을 삭제한다', async () => {
    const dedupe = new Dedupe({ ttlMs: 10000, maxSize: 2 });

    await dedupe.execute('a', async () => 1);
    await dedupe.execute('b', async () => 2);
    await dedupe.execute('c', async () => 3);

    expect(dedupe.size).toBe(2);
    expect(dedupe.check('a')).toBe(false);
    expect(dedupe.check('b')).toBe(true);
    expect(dedupe.check('c')).toBe(true);
  });

  it('check/peek/clear가 동작한다', async () => {
    const dedupe = new Dedupe({ ttlMs: 10000 });
    await dedupe.execute('key', async () => 'val');

    expect(dedupe.check('key')).toBe(true);
    expect(dedupe.check('none')).toBe(false);
    await expect(dedupe.peek('key')).resolves.toBe('val');
    expect(dedupe.peek('none')).toBeUndefined();

    dedupe.clear();
    expect(dedupe.size).toBe(0);
  });

  it('fn 에러 시 동일 키 재실행이 가능하다', async () => {
    const dedupe = new Dedupe();
    const fn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValue('ok');

    await expect(dedupe.execute('key', fn)).rejects.toThrow('fail');
    const result = await dedupe.execute('key', fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
```

### T9-2. `packages/infra/test/circuit-breaker.test.ts` (신규, ~70 LOC)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CircuitBreaker, createCircuitBreaker } from '../src/circuit-breaker.js';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = createCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 100 });
  });

  it('closed 상태에서 성공 → closed 유지', async () => {
    await cb.execute(async () => 'ok');
    expect(cb.getState()).toBe('closed');
  });

  it('failureThreshold 도달 → open 전환', async () => {
    for (let i = 0; i < 3; i++) {
      await cb
        .execute(async () => {
          throw new Error('fail');
        })
        .catch(() => {});
    }
    expect(cb.getState()).toBe('open');
    expect(cb.getFailures()).toBe(3);
  });

  it('open 상태에서 즉시 호출 → 에러 throw', async () => {
    for (let i = 0; i < 3; i++) {
      await cb
        .execute(async () => {
          throw new Error('fail');
        })
        .catch(() => {});
    }
    await expect(cb.execute(async () => 'ok')).rejects.toThrow('Circuit is open');
  });

  it('resetTimeoutMs 경과 후 → half-open 전환, 성공 시 closed', async () => {
    for (let i = 0; i < 3; i++) {
      await cb
        .execute(async () => {
          throw new Error('fail');
        })
        .catch(() => {});
    }
    expect(cb.getState()).toBe('open');

    // resetTimeout 경과 대기
    await new Promise((r) => setTimeout(r, 150));

    // half-open에서 성공 → closed
    const result = await cb.execute(async () => 'recovered');
    expect(result).toBe('recovered');
    expect(cb.getState()).toBe('closed');
    expect(cb.getFailures()).toBe(0);
  });

  it('half-open에서 실패 → open으로 재전환', async () => {
    const fastCb = createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });
    await fastCb
      .execute(async () => {
        throw new Error('fail');
      })
      .catch(() => {});
    expect(fastCb.getState()).toBe('open');

    await new Promise((r) => setTimeout(r, 60));

    await fastCb
      .execute(async () => {
        throw new Error('fail again');
      })
      .catch(() => {});
    expect(fastCb.getState()).toBe('open');
  });

  it('reset()으로 초기 상태 복귀', async () => {
    for (let i = 0; i < 3; i++) {
      await cb
        .execute(async () => {
          throw new Error('fail');
        })
        .catch(() => {});
    }
    cb.reset();
    expect(cb.getState()).toBe('closed');
    expect(cb.getFailures()).toBe(0);
  });

  it('성공하면 실패 카운터가 리셋된다', async () => {
    await cb
      .execute(async () => {
        throw new Error('fail');
      })
      .catch(() => {});
    await cb
      .execute(async () => {
        throw new Error('fail');
      })
      .catch(() => {});
    expect(cb.getFailures()).toBe(2);

    await cb.execute(async () => 'ok');
    expect(cb.getFailures()).toBe(0);
  });
});
```

### T9-3. `packages/infra/test/fs-safe.test.ts` (신규, ~80 LOC)

```typescript
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeFileAtomic, readFileSafe, ensureDir, unlinkSafe } from '../src/fs-safe.js';
import { readJsonFile, writeJsonFile, readJsonFileSync } from '../src/json-file.js';
import { withTempDir } from './helpers.js';

describe('writeFileAtomic', () => {
  it('파일을 원자적으로 쓴다', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'test.txt');
      await writeFileAtomic(filePath, 'hello world');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('hello world');
    });
  });

  it('임시 파일이 남지 않는다', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'test.txt');
      await writeFileAtomic(filePath, 'data');
      const files = await fs.readdir(dir);
      expect(files).toEqual(['test.txt']);
    });
  });

  it('기존 파일을 덮어쓴다', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'test.txt');
      await writeFileAtomic(filePath, 'first');
      await writeFileAtomic(filePath, 'second');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('second');
    });
  });
});

describe('readFileSafe', () => {
  it('파일을 읽는다', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'test.txt');
      await fs.writeFile(filePath, 'hello');
      const content = await readFileSafe(filePath);
      expect(content).toBe('hello');
    });
  });

  it('존재하지 않는 파일에 에러를 던진다', async () => {
    await expect(readFileSafe('/nonexistent/file')).rejects.toThrow();
  });
});

describe('ensureDir', () => {
  it('중첩 디렉토리를 생성한다', async () => {
    await withTempDir(async (dir) => {
      const nested = path.join(dir, 'a', 'b', 'c');
      await ensureDir(nested);
      const stat = await fs.stat(nested);
      expect(stat.isDirectory()).toBe(true);
    });
  });
});

describe('unlinkSafe', () => {
  it('파일을 삭제한다', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'test.txt');
      await fs.writeFile(filePath, 'data');
      await unlinkSafe(filePath);
      await expect(fs.access(filePath)).rejects.toThrow();
    });
  });

  it('없는 파일 삭제 시 에러 없이 통과한다', async () => {
    await expect(unlinkSafe('/nonexistent/file')).resolves.toBeUndefined();
  });
});

describe('JSON file operations', () => {
  it('writeJsonFile + readJsonFile로 데이터를 왕복한다', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'data.json');
      const data = { key: 'value', num: 42, nested: { arr: [1, 2] } };
      await writeJsonFile(filePath, data);
      const result = await readJsonFile(filePath);
      expect(result).toEqual(data);
    });
  });

  it('존재하지 않는 JSON 파일 → undefined', async () => {
    const result = await readJsonFile('/nonexistent/data.json');
    expect(result).toBeUndefined();
  });

  it('디렉토리를 자동 생성한다', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'sub', 'dir', 'data.json');
      await writeJsonFile(filePath, { ok: true });
      const result = await readJsonFile(filePath);
      expect(result).toEqual({ ok: true });
    });
  });

  it('readJsonFileSync로 동기 읽기한다', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'sync.json');
      await writeJsonFile(filePath, { sync: true });
      const result = readJsonFileSync(filePath);
      expect(result).toEqual({ sync: true });
    });
  });
});
```

### T9-4. `packages/infra/test/gateway-lock.test.ts` (신규, ~100 LOC)

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { acquireGatewayLock, readLockInfo, GatewayLockError } from '../src/gateway-lock.js';
import { withTempDir } from './helpers.js';

describe('acquireGatewayLock', () => {
  it('잠금을 획득하고 해제한다', async () => {
    await withTempDir(async (dir) => {
      const handle = await acquireGatewayLock({ lockDir: dir });
      expect(handle.pid).toBe(process.pid);
      expect(handle.lockPath).toBe(path.join(dir, 'gateway.lock'));

      // 잠금 파일 존재 확인
      const stat = await fs.stat(handle.lockPath);
      expect(stat.isFile()).toBe(true);

      // 해제
      await handle.release();
      await expect(fs.access(handle.lockPath)).rejects.toThrow();
    });
  });

  it('포트 정보를 잠금 파일에 기록한다', async () => {
    await withTempDir(async (dir) => {
      const handle = await acquireGatewayLock({ lockDir: dir, port: 8080 });
      const info = await readLockInfo(handle.lockPath);
      expect(info?.port).toBe(8080);
      expect(info?.pid).toBe(process.pid);
      await handle.release();
    });
  });

  it('이미 잠긴 상태에서 타임아웃된다', async () => {
    await withTempDir(async (dir) => {
      const handle = await acquireGatewayLock({ lockDir: dir });

      await expect(
        acquireGatewayLock({ lockDir: dir, timeoutMs: 200, pollIntervalMs: 50 }),
      ).rejects.toThrow(GatewayLockError);

      await handle.release();
    });
  });

  it('signal abort 시 즉시 에러를 던진다', async () => {
    await withTempDir(async (dir) => {
      const handle = await acquireGatewayLock({ lockDir: dir });
      const controller = new AbortController();
      controller.abort();

      await expect(
        acquireGatewayLock({
          lockDir: dir,
          timeoutMs: 5000,
          signal: controller.signal,
        }),
      ).rejects.toThrow('Lock acquisition aborted');

      await handle.release();
    });
  });

  it('stale 잠금을 자동 삭제하고 재획득한다', async () => {
    await withTempDir(async (dir) => {
      const lockPath = path.join(dir, 'gateway.lock');

      // 가짜 stale 잠금 파일 생성 (존재하지 않는 PID)
      const staleLock = JSON.stringify({
        pid: 999999999,
        acquiredAt: Date.now() - 100000,
      });
      await fs.writeFile(lockPath, staleLock);

      // mtime을 과거로 설정하여 stale로 판단되게 함
      const pastTime = new Date(Date.now() - 100000);
      await fs.utimes(lockPath, pastTime, pastTime);

      // stale이므로 획득 가능
      const handle = await acquireGatewayLock({
        lockDir: dir,
        staleThresholdMs: 1000,
        timeoutMs: 2000,
      });
      expect(handle.pid).toBe(process.pid);
      await handle.release();
    });
  });

  it('lockDir이 없으면 자동 생성한다', async () => {
    await withTempDir(async (dir) => {
      const lockDir = path.join(dir, 'nested', 'locks');
      const handle = await acquireGatewayLock({ lockDir });
      expect(handle.lockPath).toBe(path.join(lockDir, 'gateway.lock'));
      await handle.release();
    });
  });
});
```

### T9-5. `packages/infra/test/ports.test.ts` (신규, ~60 LOC)

```typescript
import { describe, it, expect } from 'vitest';
import * as net from 'node:net';
import { assertPortAvailable, findAvailablePort, isValidPort } from '../src/ports.js';
import { PortInUseError } from '../src/errors.js';

describe('assertPortAvailable', () => {
  it('사용되지 않는 포트에서 통과한다', async () => {
    // 높은 포트 번호 사용 (충돌 가능성 낮음)
    await expect(assertPortAvailable(49999)).resolves.toBeUndefined();
  });

  it('사용 중인 포트에서 PortInUseError를 던진다', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      await expect(assertPortAvailable(port)).rejects.toThrow(PortInUseError);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('findAvailablePort', () => {
  it('사용 가능한 포트를 반환한다', async () => {
    const port = await findAvailablePort(49990, 10);
    expect(port).toBeGreaterThanOrEqual(49990);
    expect(port).toBeLessThanOrEqual(49999);
  });

  it('점유된 포트를 건너뛴다', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const occupiedPort = (server.address() as net.AddressInfo).port;

    try {
      const port = await findAvailablePort(occupiedPort, 5);
      expect(port).toBeGreaterThan(occupiedPort);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('isValidPort', () => {
  it.each([
    [1, true],
    [80, true],
    [8080, true],
    [65535, true],
    [0, false],
    [-1, false],
    [65536, false],
    [1.5, false],
    [NaN, false],
  ])('isValidPort(%s) → %s', (port, expected) => {
    expect(isValidPort(port)).toBe(expected);
  });
});
```

### T9-6. `packages/infra/test/unhandled-rejections.test.ts` (신규, ~80 LOC)

```typescript
import { describe, it, expect } from 'vitest';
import { classifyError, type ErrorLevel } from '../src/unhandled-rejections.js';

describe('classifyError', () => {
  it('AbortError → abort', () => {
    const err = new DOMException('aborted', 'AbortError');
    expect(classifyError(err)).toBe('abort');
  });

  it('Error with name AbortError → abort', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(classifyError(err)).toBe('abort');
  });

  it('OOM → fatal', () => {
    expect(classifyError(new Error('JavaScript heap out of memory'))).toBe('fatal');
  });

  it('stack overflow → fatal', () => {
    expect(classifyError(new Error('Maximum call stack overflow'))).toBe('fatal');
  });

  it('ECONNRESET → transient', () => {
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    expect(classifyError(err)).toBe('transient');
  });

  it('ETIMEDOUT → transient', () => {
    const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    expect(classifyError(err)).toBe('transient');
  });

  it('ECONNREFUSED → transient', () => {
    const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    expect(classifyError(err)).toBe('transient');
  });

  it('invalid config → config', () => {
    expect(classifyError(new Error('Invalid config: missing key'))).toBe('config');
  });

  it('authentication failure → config', () => {
    expect(classifyError(new Error('Authentication failed'))).toBe('config');
  });

  it('unauthorized → config', () => {
    expect(classifyError(new Error('Unauthorized access'))).toBe('config');
  });

  it('invalid token → config', () => {
    expect(classifyError(new Error('Invalid token provided'))).toBe('config');
  });

  it('알 수 없는 에러 → unknown', () => {
    expect(classifyError(new Error('something went wrong'))).toBe('unknown');
  });

  it('non-Error → unknown', () => {
    expect(classifyError('string error')).toBe('unknown');
    expect(classifyError(42)).toBe('unknown');
    expect(classifyError(null)).toBe('unknown');
  });
});
```

### 검증 (T9 전체)

- `pnpm test -- packages/infra/test/dedupe.test.ts packages/infra/test/circuit-breaker.test.ts packages/infra/test/fs-safe.test.ts packages/infra/test/gateway-lock.test.ts packages/infra/test/ports.test.ts packages/infra/test/unhandled-rejections.test.ts` — 전체 통과

---

## T10. `index.ts` — barrel export 완성

### 왜

Part 1에서 빈 export로 시작한 barrel을 모든 모듈의 public API를 export하도록 완성.
`@finclaw/infra`에서 모든 모듈을 import할 수 있게 한다.

### 무엇을 — `packages/infra/src/index.ts` 전체 교체

**Before (Part 1 임시):**

```typescript
// @finclaw/infra — barrel export (Part 3에서 완성)
export {};
```

**After:**

```typescript
// @finclaw/infra — barrel export

// 에러
export {
  FinClawError,
  SsrfBlockedError,
  PortInUseError,
  isFinClawError,
  wrapError,
  extractErrorInfo,
} from './errors.js';

// 백오프/재시도
export { computeBackoff, sleepWithAbort, type BackoffOptions } from './backoff.js';
export { retry, resolveRetryConfig, type RetryOptions } from './retry.js';
export { Dedupe, type DedupeOptions } from './dedupe.js';
export {
  CircuitBreaker,
  createCircuitBreaker,
  type CircuitState,
  type CircuitBreakerOptions,
} from './circuit-breaker.js';

// 유틸
export { formatDuration } from './format-duration.js';
export { warnOnce, resetWarnings } from './warnings.js';

// 컨텍스트
export { runWithContext, getContext, getRequestId, type RequestContext } from './context.js';

// 환경/설정
export { assertSupportedRuntime, getNodeMajorVersion } from './runtime-guard.js';
export { loadDotenv } from './dotenv.js';
export { normalizeEnv, getEnv, requireEnv, isTruthyEnvValue, logAcceptedEnvOption } from './env.js';
export {
  getStateDir,
  getDataDir,
  getConfigDir,
  getLogDir,
  getSessionDir,
  getLockDir,
  getConfigFilePath,
  getAllPaths,
} from './paths.js';
export { isMain } from './is-main.js';

// 로깅
export {
  createLogger,
  defaultLoggerFactory,
  type LoggerConfig,
  type LoggerFactory,
  type FinClawLogger,
} from './logger.js';
export { attachFileTransport, type FileTransportConfig } from './logger-transports.js';

// 이벤트
export {
  createTypedEmitter,
  getEventBus,
  resetEventBus,
  type EventMap,
  type TypedEmitter,
  type FinClawEventMap,
} from './events.js';
export {
  pushSystemEvent,
  drainSystemEvents,
  peekSystemEvents,
  clearSystemEvents,
  onContextKeyChange,
  resetForTest,
  type SystemEvent,
} from './system-events.js';
export {
  emitAgentRunStart,
  emitAgentRunEnd,
  emitAgentRunError,
  onAgentRunStart,
  onAgentRunEnd,
  onAgentRunError,
} from './agent-events.js';

// 네트워크
export { validateUrlSafety, isPrivateIp, type SsrfPolicy } from './ssrf.js';
export { safeFetch, safeFetchJson, type SafeFetchOptions } from './fetch.js';

// 파일시스템
export { writeFileAtomic, readFileSafe, ensureDir, unlinkSafe } from './fs-safe.js';
export { readJsonFile, writeJsonFile, readJsonFileSync } from './json-file.js';

// 프로세스
export {
  acquireGatewayLock,
  readLockInfo,
  GatewayLockError,
  type GatewayLockHandle,
  type GatewayLockOptions,
} from './gateway-lock.js';
export { assertPortAvailable, findAvailablePort, isValidPort } from './ports.js';
export { inspectPortOccupant, formatPortOccupant, type PortOccupant } from './ports-inspect.js';
export {
  setupUnhandledRejectionHandler,
  classifyError,
  type ErrorLevel,
} from './unhandled-rejections.js';
```

### 검증

- `pnpm typecheck` 통과
- `pnpm build` → `dist/index.d.ts`에 모든 export 포함
- 다른 패키지에서 `import { FinClawError } from '@finclaw/infra'` 가능

---

## T11. Part 3 + 전체 통합 검증

### 왜

모든 변경(Part 1 + Part 2 + Part 3)을 적용한 후 전체 정합성을 확인한다.

### 검증 명령어

```bash
pnpm typecheck        # 에러 0
pnpm build            # packages/infra/dist/ 생성
pnpm test             # 18개 테스트 파일 전체 통과
pnpm lint             # 에러 0
```

### 성공 기준

| 명령어           | 기대 결과                                             |
| ---------------- | ----------------------------------------------------- |
| `pnpm typecheck` | 에러 0                                                |
| `pnpm build`     | `packages/infra/dist/` 생성                           |
| `pnpm test`      | Part 1 (7) + Part 2 (5) + Part 3 (6) = 18개 파일 통과 |
| `pnpm lint`      | 에러 0                                                |

### 통합 확인 사항

```bash
# 1. barrel export 검증 — 모든 모듈이 import 가능
#    다른 패키지에서:
#    import { FinClawError, createLogger, retry } from '@finclaw/infra'

# 2. 순환 의존 없음
#    errors.ts, backoff.ts, context.ts는 Ce=0 유지 (외부 import 없음)

# 3. 의존 그래프 확인
#    errors.ts        → (없음)
#    backoff.ts       → (없음, node:timers/promises만)
#    context.ts       → (없음, node:async_hooks만)
#    env.ts           → (없음)
#    paths.ts         → env.ts
#    logger.ts        → context.ts, logger-transports.ts, @finclaw/types
#    retry.ts         → backoff.ts
#    ssrf.ts          → errors.ts
#    fetch.ts         → ssrf.ts
#    gateway-lock.ts  → errors.ts
#    ports.ts         → errors.ts
#    system-events.ts → @finclaw/types
#    events.ts        → (없음, node:events만)

# 4. 파일 수 확인
#    소스: 27개 (src/*.ts)
#    테스트: 18개 (test/*.test.ts + test/helpers.ts)
#    설정: 2개 (package.json, tsconfig.json)
```

---

## 변경 요약

| 파일                                | 변경 유형 | 예상 LOC   |
| ----------------------------------- | --------- | ---------- |
| `src/dedupe.ts`                     | 신규      | ~65        |
| `src/circuit-breaker.ts`            | 신규      | ~90        |
| `src/fs-safe.ts`                    | 신규      | ~90        |
| `src/json-file.ts`                  | 신규      | ~65        |
| `src/gateway-lock.ts`               | 신규      | ~165       |
| `src/ports.ts`                      | 신규      | ~80        |
| `src/ports-inspect.ts`              | 신규      | ~100       |
| `src/unhandled-rejections.ts`       | 신규      | ~100       |
| `src/index.ts`                      | 전체 교체 | ~45        |
| `test/dedupe.test.ts`               | 신규      | ~70        |
| `test/circuit-breaker.test.ts`      | 신규      | ~70        |
| `test/fs-safe.test.ts`              | 신규      | ~80        |
| `test/gateway-lock.test.ts`         | 신규      | ~100       |
| `test/ports.test.ts`                | 신규      | ~60        |
| `test/unhandled-rejections.test.ts` | 신규      | ~80        |
| **합계**                            |           | **~1,260** |
