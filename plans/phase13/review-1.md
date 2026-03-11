# Phase 13 TODO-1 구현 리뷰

> 리뷰 대상: `packages/server/src/cli/` (소스 11개) + `packages/server/bin/finclaw.js` + 테스트 6개
> 기준 문서: `plans/phase13/todo-1.md`

---

## 1. 파일 생성 현황

| #   | todo-1.md 파일                         | 생성 여부 | 비고                                    |
| --- | -------------------------------------- | --------- | --------------------------------------- |
| 1   | `cli/exit-codes.ts`                    | O         | 스펙 일치                               |
| 2   | `cli/terminal/theme.ts`                | O         | `as const` 누락 (사소)                  |
| 3   | `cli/terminal/table.ts`                | O         | 빈 배열 반환값 불일치                   |
| 4   | `cli/terminal/__tests__/table.test.ts` | O         | 정상                                    |
| 5   | `cli/gateway-client.ts`                | O         | `RpcResult.error` 타입 변경             |
| 6   | `cli/__tests__/gateway-client.test.ts` | O         | 정상                                    |
| 7   | `cli/deps.ts`                          | O         | 인터페이스 차이 다수                    |
| 8   | `cli/__tests__/test-helpers.ts`        | O         | 정상                                    |
| 9   | `cli/__tests__/deps.test.ts`           | O         | 정상                                    |
| 10  | `cli/route.ts`                         | O         | `RouteSpec`/`tryFastPath` 시그니처 변경 |
| 11  | `cli/__tests__/route.test.ts`          | O         | 정상                                    |
| 12  | `cli/preaction.ts`                     | O         | 설정 검증 범위 불일치                   |
| 13  | `cli/program.ts`                       | O         | lazy-loading 미구현                     |
| 14  | `cli/__tests__/program.test.ts`        | O         | 정상                                    |
| 15  | `cli/entry.ts`                         | O         | 시그니처 개선 (argv 파라미터화)         |
| 16  | `bin/finclaw.js`                       | O         | named import 방식 (개선)                |
| 17  | `cli/index.ts`                         | O         | export 목록 차이                        |

**package.json**: `bin`, `commander`, `picocolors` 모두 추가됨. 정상.

---

## 2. 스펙 불일치 (수정 필요)

### 2-1. `RpcResult.error` 타입 — `gateway-client.ts:6`

```
스펙: error?: { code: number; message: string }
구현: error?: string
```

- 에러에 `code` 정보가 유실됨. HTTP 상태코드, JSON-RPC 에러코드 등을 전달할 수 없음.
- `route.ts`, `program.ts`에서 `result.error`를 직접 문자열로 사용하는 곳 모두 수정 필요.
- **영향 범위**: `gateway-client.ts`, `deps.ts` (CliDeps 인터페이스), `route.ts`, `program.ts`, 테스트 전체.

### 2-2. `CliDeps.exit` 타입 — `deps.ts:21`

```
스펙: exit: (code: ExitCode) => never
구현: exit(code: number): void
```

- `ExitCode` 유니온 타입(`0|1|2|3|4`) 대신 `number`를 받아 잘못된 종료 코드 전달 가능.
- `never` 반환 타입이 아니므로 exit 이후 코드가 dead code로 처리되지 않음.

### 2-3. `formatTable` 빈 배열 반환값 — `table.ts:13`

```
스펙: 빈 배열 → "(no data)" 반환
구현: 빈 배열 → "" 반환
```

- 빈 결과를 사용자에게 보여줄 때 아무 출력도 없음. UX상 `"(no data)"` 명시가 나음.
- `table.test.ts:8`도 `toBe('')`로 되어 있어 함께 수정 필요.

### 2-4. 글로벌 옵션 누락 — `program.ts:24-25`

```
스펙: --no-color, --verbose, --json (3개)
구현: --verbose, --gateway-url (2개)
```

- `--no-color`: picocolors는 `NO_COLOR` 환경변수를 자동 존중하지만, CLI 옵션으로도 제공해야 함.
- `--json`: 스펙에서 preaction 배너 분기(`--json` 아닐 때만 출력)와 명령어 출력 형식 분기에 사용. 누락 시 JSON 출력 모드 불가.
- `--gateway-url`: 스펙에 없는 추가 옵션. 유용하므로 유지 가능.

### 2-5. `preaction.ts` 설정 검증 범위 — `preaction.ts:22-27`

```
스펙: start, config 외 명령어만 설정 검증 (조건부)
구현: 모든 명령어에서 무조건 검증
```

- 설정 파일이 없는 상태에서 `finclaw config set`을 실행하면 에러로 종료됨.
- `finclaw start`도 설정 검증 실패 시 서버를 시작할 수 없음.
- `actionCommand.name()` 체크 분기 필요.

### 2-6. `CliDeps.loadConfig` 반환 타입 — `deps.ts:13`

```
스펙: loadConfig: () => Promise<FinClawConfig>  (async 래핑)
구현: loadConfig(): FinClawConfig               (동기)
```

- 실제 `loadConfig`가 동기 함수이므로 동기 시그니처도 동작은 함.
- 다만 스펙은 향후 비동기 설정 로더(원격 설정 등)를 고려해 `Promise`로 설계.
- `preaction.ts`에서 `await deps.loadConfig()`를 사용해야 하는데, 동기 함수라 `await` 없이 호출 중.
- **판단**: 현재는 동작하지만, 인터페이스를 `Promise<FinClawConfig>`로 통일하는 것을 권장.

---

## 3. 설계 차이 (의도적 변경으로 보이나 확인 필요)

### 3-1. `RouteSpec` 인터페이스 — `route.ts:8-9`

```
스펙: { match: (path: string[]) => boolean;  run: (argv, deps) => Promise<boolean> }
구현: { command: string;                      handle(deps): Promise<number> }
```

- 구현이 더 단순함. `match` 함수 대신 문자열 비교로 충분하므로 합리적인 단순화.
- `tryFastPath` 반환값도 `boolean` → `number | null`로 변경. 종료 코드를 직접 전달하므로 더 유용.

### 3-2. `tryFastPath` argv 처리 — `route.ts:45`

```
스펙: argv.slice(2).filter(a => !a.startsWith('-'))  (node, script 제거 후 필터)
구현: argv.find(arg => !arg.startsWith('-'))          (첫 positional arg만)
```

- `entry.ts:10`에서 `argv.slice(2)` 후 전달하므로 node/script은 이미 제거됨. 정상.
- 다만 `argv.find`는 첫 번째 매칭만 확인. 복합 경로(`market quote`)는 처리 불가.
- 현재 fast-path가 단일 키워드(`health`, `status`)뿐이므로 문제 없음.

### 3-3. Lazy-loading 미구현 — `program.ts:31-113`

```
스펙: registerLazyCommand → dynamic import('./commands/<name>.js') → 재파싱
구현: 모든 명령어를 inline placeholder action으로 등록
```

- 현재는 commands/ 디렉토리 자체가 없고 모든 명령어가 placeholder이므로 lazy-loading이 불필요.
- TODO-2에서 실제 명령어를 구현할 때 lazy-loading으로 전환해야 함.
- **주의**: 현재 구조에서 commands/ 모듈 추가 시 program.ts의 대규모 수정 필요.

### 3-4. `health`/`status` 이중 등록 — `program.ts:88-113`

- fast-path (`route.ts`)에서 처리하면서, Commander에도 등록.
- `entry.ts`에서 fast-path가 먼저 실행되므로 Commander의 health/status는 도달 불가 코드.
- fast-path 실패 시 fallback으로 동작할 수 있으나, fast-path는 null 반환 시에만 Commander로 넘어가므로 health/status 명령어는 항상 fast-path에서 처리됨.
- Commander의 health/status는 `--help` 출력에 포함되는 효과만 있음. 의도적이라면 유지.

---

## 4. 코드 품질 이슈 (사소)

### 4-1. `RpcResult` readonly 누락 — `gateway-client.ts:3-7`

```
스펙: readonly ok, readonly data, readonly error
구현: 모든 필드 mutable
```

### 4-2. `GatewayClientOptions` readonly 누락 — `gateway-client.ts:9-12`

```
스펙: readonly baseUrl, readonly timeoutMs
구현: mutable
```

### 4-3. `theme.ts` — `as const` 누락

```
스펙: } as const;
구현: };
```

- 기능 차이 없으나, 타입 추론 시 리터럴 타입 대신 일반 함수 타입으로 추론됨.

### 4-4. `deps.ts:1-2` import 순서

```typescript
import type { FinClawLogger } from '@finclaw/infra'; // line 1
// packages/server/src/cli/deps.ts                     // line 2 (주석)
import type { FinClawConfig } from '@finclaw/types'; // line 3
```

- 파일 상단 주석이 import 사이에 끼어 있음. 주석을 최상단으로 이동하거나 제거.

### 4-5. `callGateway` params 타입 — `gateway-client.ts:38`

```
스펙: params?: unknown
구현: params?: Record<string, unknown>
```

- `unknown`이 더 유연하나, `Record<string, unknown>`도 실용적. 배열 params가 필요한 RPC 메서드가 있다면 문제.

---

## 5. 테스트 커버리지

| 테스트 파일              | 상태 | 비고                                                  |
| ------------------------ | ---- | ----------------------------------------------------- |
| `table.test.ts`          | O    | 빈 배열 기대값 수정 필요 (""→"(no data)")             |
| `gateway-client.test.ts` | O    | `error` 필드 타입에 따른 assertion 수정 필요          |
| `deps.test.ts`           | O    | 각 필드의 함수 여부 검증 누락 (hasProperty만 체크)    |
| `route.test.ts`          | O    | 양호                                                  |
| `program.test.ts`        | O    | 글로벌 옵션 테스트에 `--json`, `--no-color` 추가 필요 |

---

## 6. 리팩토링 사항

### R-1. `RpcResult.error` 구조화 (우선순위: 높음)

`error?: string`을 `error?: { code: number; message: string }`로 변경. 에러 코드 정보는 CLI의 종료 코드 결정, 에러 분류, 재시도 로직에 필수. gateway-client에서 HTTP 상태코드와 JSON-RPC 에러코드를 이미 알고 있으므로 전달해야 함.

### R-2. lazy-loading 전환 준비 (우선순위: 중간)

현재 inline placeholder 방식을 `CommandEntry[]` + `registerLazyCommand()` 패턴으로 전환. TODO-2에서 실제 명령어 모듈을 추가할 때 program.ts 전체를 수정하지 않으려면, 지금 구조를 잡아두는 것이 좋음.

### R-3. health/status 이중 등록 제거 (우선순위: 낮음)

fast-path에서 항상 처리되므로 Commander 측 등록은 제거하고, `--help`에 표시만 하려면 `.command('health').description('...').helpOption(false)` 등으로 대체 가능. 또는 fast-path가 아닌 Commander로 통합하고 fast-path 자체를 제거하는 것도 방안 (명령어 2개뿐이라 성능 차이 미미).

### R-4. `preaction.ts` 설정 검증 조건 분기 (우선순위: 높음)

설정 없이 실행 가능해야 하는 명령어(`start`, `config`, `health`, `status`)를 화이트리스트로 관리. 현재 구조는 초기 설정 단계에서 모든 명령어가 막힘.

### R-5. `CliDeps` 인터페이스 정비 (우선순위: 중간)

- `exit` 파라미터를 `ExitCode`로 변경, 반환 타입을 `never`로 변경
- `loadConfig` 반환을 `Promise<FinClawConfig>`로 변경 (async 래핑)
- `RpcResult`, `GatewayClientOptions`의 `readonly` 추가

### R-6. `--json`, `--no-color` 글로벌 옵션 추가 (우선순위: 높음)

`--json`은 출력 형식의 핵심 분기점. `--no-color`는 CI/pipe 환경에서 필수. 두 옵션 없이는 스크립팅에서 CLI를 사용하기 어려움.
