# Phase 13 TODO-1: 기반 인프라 + 핵심 CLI 골격

> plan.md 단계 1~4 + 진입점(단계 7) | 소스 11개 + 테스트 5개 = 16개 파일
> 검증: `npx finclaw --version`, `npx finclaw health`, 유닛 테스트 통과

---

## 0. 사전 준비

- [ ] **0-1. 의존성 추가** — `packages/server/package.json`

  ```bash
  cd packages/server && pnpm add commander@^14 picocolors@^1.1.1
  ```

  - `dependencies`에 `commander`, `picocolors` 추가 확인
  - `pnpm install` → lockfile 갱신
  - `pnpm format:fix` 실행 (oxfmt가 package.json 키 순서 정리)

- [ ] **0-2. bin 필드 추가** — `packages/server/package.json`
  ```jsonc
  {
    "bin": {
      "finclaw": "./bin/finclaw.js",
    },
  }
  ```

---

## 1. 종료 코드 상수 (`exit-codes.ts`)

- [ ] **1-1.** `packages/server/src/cli/exit-codes.ts` 생성 (~15줄)

  ```typescript
  export type ExitCode = 0 | 1 | 2 | 3 | 4;

  export const EXIT = {
    OK: 0,
    ERROR: 1,
    USAGE: 2,
    GATEWAY_ERROR: 3,
    CONFIG_ERROR: 4,
  } as const satisfies Record<string, ExitCode>;
  ```

  - 검증: 타입체크 통과 (`pnpm typecheck`)

---

## 2. 터미널 유틸리티 (단계 1 일부)

- [ ] **2-1.** `packages/server/src/cli/terminal/theme.ts` 생성 (~30줄)
  - picocolors 래퍼: `success`, `error`, `warn`, `info`, `dim`, `bold` 함수 export
  - `NO_COLOR` 또는 `--no-color` 시 색상 비활성화 (picocolors는 NO_COLOR 자동 존중하므로 래핑만)

  ```typescript
  import pc from 'picocolors';

  export const theme = {
    success: pc.green,
    error: pc.red,
    warn: pc.yellow,
    info: pc.cyan,
    dim: pc.dim,
    bold: pc.bold,
  } as const;
  ```

- [ ] **2-2.** `packages/server/src/cli/terminal/table.ts` 생성 (~50줄)
  - `formatTable(rows: Record<string, unknown>[], columns?: string[]): string`
  - 각 컬럼 최대 너비 계산 → 패딩 → 헤더 + 구분선 + 데이터 행
  - 빈 배열 → `"(no data)"` 반환
  - `formatKeyValue(obj: Record<string, unknown>): string` — 단일 객체를 key: value 줄 나열

  ```typescript
  export function formatTable(rows: Record<string, unknown>[], columns?: string[]): string;
  export function formatKeyValue(obj: Record<string, unknown>): string;
  ```

- [ ] **2-3.** `packages/server/src/cli/terminal/__tests__/table.test.ts` 생성 (~60줄)
  - `formatTable` 테스트:
    - 빈 배열 → `"(no data)"`
    - 1행 → 헤더 + 구분선 + 데이터 1줄
    - 다수 행 → 컬럼 정렬 확인
    - columns 지정 시 해당 컬럼만 출력
  - `formatKeyValue` 테스트:
    - 단일 객체 → `"key: value"` 형식
  - 검증: `pnpm test -- packages/server/src/cli/terminal/__tests__/table.test.ts`

---

## 3. Gateway HTTP 클라이언트 (단계 2)

- [ ] **3-1.** `packages/server/src/cli/gateway-client.ts` 생성 (~80줄)
  - `RpcResult<T>` 인터페이스 정의 (`ok`, `data?`, `error?`)
  - `GatewayClientOptions` 인터페이스 (`baseUrl?`, `timeoutMs?`)
  - `DEFAULT_BASE_URL = 'http://127.0.0.1:3000'`
  - `getGatewayHealth(opts?)` — HTTP GET `/health`, AbortSignal.timeout 5s
  - `callGateway<T>(method, params?, opts?)` — HTTP POST `/rpc`, JSON-RPC 2.0 형식, AbortSignal.timeout 30s
  - 에러 시 `{ ok: false, error: { code, message } }` 반환 (throw 안 함)

  ```typescript
  export interface RpcResult<T> {
    readonly ok: boolean;
    readonly data?: T;
    readonly error?: { code: number; message: string };
  }

  export interface GatewayClientOptions {
    readonly baseUrl?: string;
    readonly timeoutMs?: number;
  }

  export async function getGatewayHealth(
    opts?: GatewayClientOptions,
  ): Promise<RpcResult<{ status: string; uptime: number }>>;
  export async function callGateway<T>(
    method: string,
    params?: unknown,
    opts?: GatewayClientOptions,
  ): Promise<RpcResult<T>>;
  ```

- [ ] **3-2.** `packages/server/src/cli/__tests__/gateway-client.test.ts` 생성 (~80줄)
  - `vi.stubGlobal('fetch', ...)` 로 fetch mock
  - `getGatewayHealth`:
    - 성공 응답 → `{ ok: true, data: { status: 'ok', uptime: 123 } }`
    - HTTP 에러 (500) → `{ ok: false, error: { code: 500, message: ... } }`
    - 네트워크 에러 (fetch throw) → `{ ok: false, error: { code: -1, message: ... } }`
  - `callGateway`:
    - 성공 → JSON-RPC result 파싱, `{ ok: true, data: ... }`
    - RPC 에러 → `{ ok: false, error: json.error }`
    - 네트워크 에러 → `{ ok: false, error: { code: -1, ... } }`
    - 요청 body 확인: `{ jsonrpc: '2.0', id: 1, method, params }`
  - 검증: `pnpm test -- packages/server/src/cli/__tests__/gateway-client.test.ts`

---

## 4. CliDeps DI 컨테이너 (단계 3)

- [ ] **4-1.** `packages/server/src/cli/deps.ts` 생성 (~70줄)
  - `CliDeps` 인터페이스 (plan.md §4 그대로)
    - `loadConfig: () => Promise<FinClawConfig>`
    - `log: FinClawLogger`
    - `callGateway: <T>(method: string, params?: unknown) => Promise<RpcResult<T>>`
    - `getGatewayHealth: () => Promise<RpcResult<{ status: string; uptime: number }>>`
    - `exit: (code: ExitCode) => never`
    - `output: (text: string) => void`
    - `error: (text: string) => void`
  - `createDefaultDeps(overrides?: Partial<CliDeps>): CliDeps`
    - loadConfig: `@finclaw/config`의 `loadConfig()` 래핑 (동기 → async 래핑)
    - log: `@finclaw/infra`의 `createLogger({ name: 'cli', level: 'info' })`
    - callGateway / getGatewayHealth: `./gateway-client.js`에서 import
    - exit: `process.exit(code)`
    - output: `process.stdout.write(text + '\n')`
    - error: `process.stderr.write(text + '\n')`
    - overrides 스프레드로 부분 오버라이드 지원
  - **주의:** `loadConfig()`는 동기 함수이므로 `async () => loadConfig()` 로 래핑

- [ ] **4-2.** `packages/server/src/cli/__tests__/test-helpers.ts` 생성 (~40줄)
  - `createTestDeps(overrides?: Partial<CliDeps>): CliDeps`
    - 모든 필드를 vi.fn() mock으로 채움
    - loadConfig: `vi.fn().mockResolvedValue({})` (기본 빈 설정)
    - log: `{ info: vi.fn(), warn: vi.fn(), error: vi.fn(), ... }` (모든 레벨 mock)
    - callGateway: `vi.fn().mockResolvedValue({ ok: true, data: {} })`
    - getGatewayHealth: `vi.fn().mockResolvedValue({ ok: true, data: { status: 'ok', uptime: 0 } })`
    - exit: `vi.fn()` (`never` 타입은 `as unknown as ...` 캐스팅)
    - output: `vi.fn()`
    - error: `vi.fn()`
    - overrides 스프레드 적용

- [ ] **4-3.** `packages/server/src/cli/__tests__/deps.test.ts` 생성 (~50줄)
  - `createDefaultDeps()`:
    - 반환 객체가 모든 필수 키를 가짐
    - 각 필드가 함수인지 확인 (log는 객체)
  - `createDefaultDeps({ output: vi.fn() })`:
    - output만 mock이고 나머지는 실제 함수
  - 검증: `pnpm test -- packages/server/src/cli/__tests__/deps.test.ts`

---

## 5. Fast-path 라우팅 (단계 4)

- [ ] **5-1.** `packages/server/src/cli/route.ts` 생성 (~50줄)
  - `RouteSpec` 인터페이스 (plan.md §4)
  - `routes` 배열: health, status 2개
    - health: `match: (path) => path[0] === 'health'`, `run`: `deps.getGatewayHealth()` 호출
    - status: `match: (path) => path[0] === 'status'`, `run`: `deps.callGateway('system.info')` 호출
  - `tryFastPath(argv: string[], deps: CliDeps): Promise<boolean>`
    - `getCommandPath(argv)` — `argv.slice(2).filter(a => !a.startsWith('-'))`
    - routes 순회하며 match → run 실행 → true 반환
    - 매칭 없으면 false
  - `getCommandPath` 내부 함수 (export 불필요)

- [ ] **5-2.** `packages/server/src/cli/__tests__/route.test.ts` 생성 (~60줄)
  - `createTestDeps()` 사용
  - `tryFastPath(['node', 'finclaw', 'health'], deps)`:
    - true 반환
    - `deps.getGatewayHealth` 1회 호출됨
    - 성공 시 `deps.output` 호출됨
    - 실패 시 `deps.error` 호출됨
  - `tryFastPath(['node', 'finclaw', 'status'], deps)`:
    - true 반환
    - `deps.callGateway` 1회 호출, 인자 `'system.info'`
  - `tryFastPath(['node', 'finclaw', 'market', 'quote'], deps)`:
    - false 반환 (fast-path 아님)
  - `tryFastPath(['node', 'finclaw', '--version'], deps)`:
    - false 반환 (옵션 필터링)
  - 검증: `pnpm test -- packages/server/src/cli/__tests__/route.test.ts`

---

## 6. Pre-Action 훅 (단계 4)

- [ ] **6-1.** `packages/server/src/cli/preaction.ts` 생성 (~50줄)
  - `registerPreActionHooks(program: Command, deps: CliDeps): void`
  - `program.hook('preAction', async (_thisCommand, actionCommand) => { ... })`
    - 배너: `--json` 아닐 때 `deps.error('FinClaw CLI v...')`
    - 설정 검증: `start`, `config` 외 명령어는 `deps.loadConfig()` 호출, 실패 시 에러 메시지
    - verbose: `program.opts().verbose` 시 `deps.log.info(...)` 호출

  ```typescript
  import type { Command } from 'commander';
  import type { CliDeps } from './deps.js';

  export function registerPreActionHooks(program: Command, deps: CliDeps): void;
  ```

---

## 7. 프로그램 빌더 (단계 7 일부)

- [ ] **7-1.** `packages/server/src/cli/program.ts` 생성 (~80줄)
  - `ProgramContext` 인터페이스: `version`, `description`
  - `createProgramContext(): ProgramContext`
    - version: `packages/server/package.json`의 `version` (import or readFileSync)
    - description: `'FinClaw — AI 금융 비서 CLI'`
  - `CommandEntry` 인터페이스: `name`, `description`, `register`
  - `commandEntries` 배열: 8개 명령어 (start, stop, config, agent, channel, market, news, alert)
    - 각 항목의 `register`는 dynamic `import('./commands/<name>.js')`
  - `registerLazyCommand(program, entry, deps)` — placeholder 등록 + action에서 실제 모듈 로딩
  - `buildProgram(deps: CliDeps): Command`
    1. `new Command()` → name, version, description
    2. 글로벌 옵션: `--no-color`, `--verbose`, `--json`
    3. `registerPreActionHooks(program, deps)` 호출
    4. `commandEntries`를 `registerLazyCommand`로 등록
    5. return program

- [ ] **7-2.** `packages/server/src/cli/__tests__/program.test.ts` 생성 (~70줄)
  - `createTestDeps()` 사용
  - `buildProgram(deps)`:
    - `program.name()` === `'finclaw'`
    - `program.version()` 이 문자열
    - `program.commands.length` >= 8 (lazy placeholders)
  - 글로벌 옵션 파싱:
    - `program.parse(['node', 'finclaw', '--verbose'], { from: 'user' })` → `program.opts().verbose === true`
    - `program.parse(['node', 'finclaw', '--json'], { from: 'user' })` → `program.opts().json === true`
  - 도움말 출력:
    - `program.helpInformation()` 에 'start', 'config', 'market' 등 포함
  - 검증: `pnpm test -- packages/server/src/cli/__tests__/program.test.ts`

---

## 8. CLI 진입점 & bin 래퍼 (단계 7)

- [ ] **8-1.** `packages/server/src/cli/entry.ts` 생성 (~40줄)

  ```typescript
  import { buildProgram } from './program.js';
  import { createDefaultDeps } from './deps.js';
  import { tryFastPath } from './route.js';
  import { EXIT } from './exit-codes.js';

  async function main(): Promise<void> {
    const deps = createDefaultDeps();

    // 1. Fast-path (health, status)
    if (await tryFastPath(process.argv, deps)) {
      return;
    }

    // 2. Commander 전체 경로
    const program = buildProgram(deps);
    await program.parseAsync(process.argv);
  }

  main().catch((err) => {
    console.error(err);
    process.exit(EXIT.ERROR);
  });
  ```

- [ ] **8-2.** `packages/server/bin/finclaw.js` 생성 (~3줄)

  ```javascript
  #!/usr/bin/env node
  import '../dist/cli/entry.js';
  ```

  - 파일 실행 권한 부여: `chmod +x packages/server/bin/finclaw.js`

---

## 9. Barrel export (단계 7)

- [ ] **9-1.** `packages/server/src/cli/index.ts` 생성 (~15줄)
  ```typescript
  export { EXIT } from './exit-codes.js';
  export type { ExitCode } from './exit-codes.js';
  export type { RpcResult, GatewayClientOptions } from './gateway-client.js';
  export type { CliDeps } from './deps.js';
  export { createDefaultDeps } from './deps.js';
  export type { RouteSpec } from './route.js';
  export { tryFastPath } from './route.js';
  export { buildProgram } from './program.js';
  export { theme } from './terminal/theme.js';
  export { formatTable, formatKeyValue } from './terminal/table.js';
  ```

---

## 10. 최종 검증

- [ ] **10-1.** 타입체크: `pnpm typecheck` 통과
- [ ] **10-2.** 린트: `pnpm lint` 통과
- [ ] **10-3.** 포맷: `pnpm format:fix` 실행
- [ ] **10-4.** 유닛 테스트 전체 통과:

  ```bash
  pnpm test -- packages/server/src/cli/
  ```

  - `table.test.ts` ✓
  - `gateway-client.test.ts` ✓
  - `deps.test.ts` ✓
  - `route.test.ts` ✓
  - `program.test.ts` ✓

- [ ] **10-5.** 빌드 후 바이너리 실행:

  ```bash
  pnpm build && npx finclaw --version
  ```

  - 버전 번호 출력 확인

- [ ] **10-6.** Fast-path 수동 테스트:

  ```bash
  npx finclaw health
  ```

  - Gateway 미실행 시: `{ "status": "unreachable", "error": "fetch failed" }` 출력

---

## 파일 생성 순서 요약

| 순서 | 파일                                   | 의존 대상                                                         |
| ---- | -------------------------------------- | ----------------------------------------------------------------- |
| 1    | `cli/exit-codes.ts`                    | 없음                                                              |
| 2    | `cli/terminal/theme.ts`                | picocolors                                                        |
| 3    | `cli/terminal/table.ts`                | 없음                                                              |
| 4    | `cli/terminal/__tests__/table.test.ts` | table.ts                                                          |
| 5    | `cli/gateway-client.ts`                | exit-codes.ts (RpcResult 타입만)                                  |
| 6    | `cli/__tests__/gateway-client.test.ts` | gateway-client.ts                                                 |
| 7    | `cli/deps.ts`                          | exit-codes.ts, gateway-client.ts, @finclaw/config, @finclaw/infra |
| 8    | `cli/__tests__/test-helpers.ts`        | deps.ts                                                           |
| 9    | `cli/__tests__/deps.test.ts`           | deps.ts, test-helpers.ts                                          |
| 10   | `cli/route.ts`                         | deps.ts                                                           |
| 11   | `cli/__tests__/route.test.ts`          | route.ts, test-helpers.ts                                         |
| 12   | `cli/preaction.ts`                     | deps.ts, commander                                                |
| 13   | `cli/program.ts`                       | deps.ts, preaction.ts, commander                                  |
| 14   | `cli/__tests__/program.test.ts`        | program.ts, test-helpers.ts                                       |
| 15   | `cli/entry.ts`                         | program.ts, deps.ts, route.ts, exit-codes.ts                      |
| 16   | `bin/finclaw.js`                       | entry.ts (dist)                                                   |
| 17   | `cli/index.ts`                         | 모든 모듈                                                         |

> 모든 경로의 접두사: `packages/server/src/` (bin 제외)
