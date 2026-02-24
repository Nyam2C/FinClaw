# Phase 13: CLI 진입점 & 명령어 체계

> 복잡도: **L** | 소스 파일: ~12 | 테스트 파일: ~6 | 총 ~18 파일

---

## 1. 목표

FinClaw CLI의 **진입점과 명령어 체계**를 구축한다. Commander.js 기반의 프로그램 셋업, lazy-loading 서브커맨드 등록, fast-path 라우팅, 그리고 DI 컨테이너(CliDeps)를 구현하여 사용자가 터미널에서 FinClaw의 모든 기능에 접근할 수 있는 CLI 인터페이스를 제공한다.

**핵심 목표:**

- Commander.js 기반 프로그램 인스턴스 생성 (버전, 도움말, 글로벌 옵션)
- 10개 명령어 그룹의 lazy-loading 등록으로 O(1) 시작 시간 유지
- Fast-path 라우팅: `health`, `status` 명령어가 Commander 파싱 없이 직접 실행
- CliDeps 의존성 컨테이너로 테스트 가능한 명령어 구조
- 금융 특화 명령어 (`market`, `news`, `alert`) 포함

---

## 2. OpenClaw 참조

### 참조 문서

| 문서 경로                                            | 적용할 패턴                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `openclaw_review/deep-dive/01-cli-entry-commands.md` | 5계층 아키텍처, lazy-loading, fast-path 라우팅, CliDeps DI, Pre-Action Hooks |

### 적용할 핵심 패턴

**1) Lazy SubCLI Registration (OpenClaw 290줄 register.subclis.ts)**

- OpenClaw: 24개 서브CLI를 placeholder로 등록, 호출 시에만 동적 import
- FinClaw: 10개 명령어 그룹을 동일 패턴으로 등록. 규모가 작으므로 재파싱 없이 단순 lazy import로 구현

**2) Fast-Path Routing (OpenClaw route.ts 32줄)**

- OpenClaw: 5개 명령어(health, status, sessions, agents list, memory status)를 Commander 없이 직접 실행
- FinClaw: 2개 명령어(health, status)만 fast-path. 나머지는 Commander를 통한 정상 경로

**3) CliDeps DI Container (OpenClaw deps.ts 41줄)**

- OpenClaw: 6개 채널 전송 함수를 번들링한 의존성 객체
- FinClaw: 설정 로더, 로거, Gateway RPC 클라이언트를 포함한 의존성 객체

**4) Pre-Action Hooks (OpenClaw preaction.ts 50줄)**

- Commander `hook("preAction")` 으로 모든 명령어 실행 전 공통 전처리
- FinClaw: 배너 출력, 설정 검증, verbose 모드 설정을 preAction으로 구현

**5) createDefaultDeps() Factory (OpenClaw deps.ts)**

- 프로덕션 의존성 팩토리와 테스트용 mock 분리

---

## 3. 생성할 파일

### 소스 파일 (12개)

| 파일 경로                     | 역할                                                         | 예상 줄 수 |
| ----------------------------- | ------------------------------------------------------------ | ---------- |
| `src/cli/index.ts`            | CLI 모듈 barrel export                                       | ~15        |
| `src/cli/program.ts`          | Commander 프로그램 빌드 & 글로벌 옵션 설정                   | ~80        |
| `src/cli/deps.ts`             | CliDeps 타입 정의 & createDefaultDeps() 팩토리               | ~60        |
| `src/cli/route.ts`            | Fast-path 라우팅 (health, status 직접 실행)                  | ~50        |
| `src/cli/preaction.ts`        | Pre-Action 훅 (배너, 설정검증, verbose)                      | ~40        |
| `src/cli/commands/start.ts`   | `finclaw start` — Gateway 서버 시작                          | ~80        |
| `src/cli/commands/stop.ts`    | `finclaw stop` — Gateway 서버 종료                           | ~50        |
| `src/cli/commands/config.ts`  | `finclaw config get/set/list` — 설정 관리                    | ~90        |
| `src/cli/commands/agent.ts`   | `finclaw agent list/status` — 에이전트 관리                  | ~60        |
| `src/cli/commands/channel.ts` | `finclaw channel list/status` — 채널 관리                    | ~50        |
| `src/cli/commands/market.ts`  | `finclaw market <ticker>` — 시장 데이터 조회 (금융 특화)     | ~70        |
| `src/cli/commands/alert.ts`   | `finclaw alert add/list/remove` — 가격 알림 관리 (금융 특화) | ~80        |

### 테스트 파일 (6개)

| 파일 경로                         | 테스트 대상                             | 테스트 종류 |
| --------------------------------- | --------------------------------------- | ----------- |
| `src/cli/program.test.ts`         | 프로그램 빌드, 글로벌 옵션, 도움말 출력 | unit        |
| `src/cli/deps.test.ts`            | createDefaultDeps(), DI 컨테이너 생성   | unit        |
| `src/cli/route.test.ts`           | fast-path 매칭, 라우팅 분기             | unit        |
| `src/cli/commands/config.test.ts` | config get/set/list 명령어              | unit        |
| `src/cli/commands/market.test.ts` | market 조회 출력 포맷                   | unit        |
| `src/cli/commands/alert.test.ts`  | alert CRUD 명령어                       | unit        |

---

## 4. 핵심 인터페이스/타입

```typescript
// src/cli/deps.ts — CLI 의존성 컨테이너
export interface CliDeps {
  /** 설정 로더 — 현재 FinClaw 설정을 반환 */
  readonly loadConfig: () => Promise<FinClawConfig>;

  /** 로거 인스턴스 */
  readonly log: Logger;

  /** Gateway RPC 호출 함수 */
  readonly callGateway: <T>(method: string, params?: unknown) => Promise<T>;

  /** 프로세스 종료 함수 (테스트에서 mock 가능) */
  readonly exit: (code: number) => never;

  /** 표준 출력 함수 (테스트에서 mock 가능) */
  readonly output: (text: string) => void;

  /** 표준 에러 출력 함수 */
  readonly error: (text: string) => void;
}

// src/cli/deps.ts — 프로덕션 의존성 팩토리
export function createDefaultDeps(overrides?: Partial<CliDeps>): CliDeps;

// src/cli/route.ts — Fast-path 라우트 정의
export interface RouteSpec {
  /** 명령어 경로 매칭 (예: ["health"]) */
  readonly match: (commandPath: string[]) => boolean;

  /** 직접 실행 (Commander 우회) */
  readonly run: (argv: string[], deps: CliDeps) => Promise<boolean>;
}

// src/cli/program.ts — 프로그램 컨텍스트
export interface ProgramContext {
  readonly version: string;
  readonly description: string;
}

// src/cli/commands/market.ts — 시장 데이터 조회 옵션
export interface MarketCommandOptions {
  readonly format: 'table' | 'json';
  readonly currency: string; // 기본 KRW
}

// src/cli/commands/alert.ts — 알림 관리 옵션
export interface AlertAddOptions {
  readonly ticker: string;
  readonly condition: 'above' | 'below';
  readonly price: number;
  readonly channel?: string; // 알림 전송 채널
}
```

---

## 5. 구현 상세

### 5.1 프로그램 빌드 흐름

```typescript
// src/cli/program.ts
import { Command } from 'commander';
import type { ProgramContext } from './deps.js';

export function buildProgram(): Command {
  const program = new Command();
  const ctx = createProgramContext();

  program.name('finclaw').version(ctx.version).description(ctx.description);

  // 글로벌 옵션
  program
    .option('--no-color', '색상 출력 비활성화')
    .option('--verbose', '상세 로그 출력')
    .option('--json', 'JSON 형식 출력');

  // Pre-Action 훅 등록
  registerPreActionHooks(program);

  // 명령어 등록 (lazy-loading)
  registerCommands(program);

  return program;
}
```

### 5.2 Lazy-Loading 명령어 등록

OpenClaw의 24개 서브CLI placeholder + 재파싱 방식을 단순화한다. FinClaw는 10개 명령어 그룹만 존재하므로, Commander의 `.command()` + lazy action 패턴으로 충분하다.

```typescript
// src/cli/program.ts — 명령어 등록부
interface CommandEntry {
  readonly name: string;
  readonly description: string;
  readonly register: (program: Command, deps: CliDeps) => Promise<void>;
}

const commandEntries: CommandEntry[] = [
  {
    name: 'start',
    description: 'Gateway 서버 시작',
    register: (p, d) => import('./commands/start.js').then((m) => m.register(p, d)),
  },
  {
    name: 'stop',
    description: 'Gateway 서버 종료',
    register: (p, d) => import('./commands/stop.js').then((m) => m.register(p, d)),
  },
  {
    name: 'config',
    description: '설정 관리',
    register: (p, d) => import('./commands/config.js').then((m) => m.register(p, d)),
  },
  {
    name: 'agent',
    description: '에이전트 관리',
    register: (p, d) => import('./commands/agent.js').then((m) => m.register(p, d)),
  },
  {
    name: 'channel',
    description: '채널 관리',
    register: (p, d) => import('./commands/channel.js').then((m) => m.register(p, d)),
  },
  {
    name: 'market',
    description: '시장 데이터 조회 (금융)',
    register: (p, d) => import('./commands/market.js').then((m) => m.register(p, d)),
  },
  {
    name: 'alert',
    description: '가격 알림 관리 (금융)',
    register: (p, d) => import('./commands/alert.js').then((m) => m.register(p, d)),
  },
  // memory, plugin, skill은 Phase 14, 5, 7에서 각각 추가
];

function registerLazyCommand(program: Command, entry: CommandEntry, deps: CliDeps): void {
  const placeholder = program
    .command(entry.name)
    .description(entry.description)
    .allowUnknownOption(true)
    .allowExcessArguments(true);

  placeholder.action(async () => {
    // placeholder 제거 후 실제 모듈 로딩
    program.commands = program.commands.filter((c) => c !== placeholder);
    await entry.register(program, deps);
    // Commander가 실제 등록된 명령어를 실행하도록 재파싱
    await program.parseAsync(process.argv);
  });
}
```

### 5.3 Fast-Path 라우팅

```typescript
// src/cli/route.ts
import type { CliDeps, RouteSpec } from './deps.js';

const routes: RouteSpec[] = [
  {
    match: (path) => path[0] === 'health',
    run: async (_argv, deps) => {
      // Gateway 헬스체크 — 설정 로딩 없이 직접 실행
      try {
        const result = await deps.callGateway<{ status: string }>('health.check');
        deps.output(JSON.stringify(result, null, 2));
        return true;
      } catch {
        deps.output(JSON.stringify({ status: 'unreachable' }));
        return true;
      }
    },
  },
  {
    match: (path) => path[0] === 'status',
    run: async (_argv, deps) => {
      const result = await deps.callGateway<GatewayStatus>('gateway.status');
      deps.output(formatGatewayStatus(result));
      return true;
    },
  },
];

/**
 * Commander 파싱 전에 fast-path 매칭을 시도한다.
 * 매칭 성공 시 true를 반환하고 프로그램 종료.
 */
export async function tryFastPath(argv: string[], deps: CliDeps): Promise<boolean> {
  const commandPath = getCommandPath(argv);
  for (const route of routes) {
    if (route.match(commandPath)) {
      return route.run(argv, deps);
    }
  }
  return false;
}

function getCommandPath(argv: string[]): string[] {
  // argv[0] = node, argv[1] = script, argv[2+] = commands
  return argv.slice(2).filter((a) => !a.startsWith('-'));
}
```

### 5.4 CliDeps 의존성 팩토리

```typescript
// src/cli/deps.ts
export function createDefaultDeps(overrides?: Partial<CliDeps>): CliDeps {
  return {
    loadConfig:
      overrides?.loadConfig ??
      (async () => {
        const { loadConfig } = await import('../config/index.js');
        return loadConfig();
      }),
    log: overrides?.log ?? console,
    callGateway:
      overrides?.callGateway ??
      (async (method, params) => {
        const { callGateway } = await import('../gateway/rpc.js');
        return callGateway(method, params);
      }),
    exit: overrides?.exit ?? ((code: number) => process.exit(code)),
    output: overrides?.output ?? ((text: string) => process.stdout.write(text + '\n')),
    error: overrides?.error ?? ((text: string) => process.stderr.write(text + '\n')),
  };
}
```

### 5.5 진입점 통합

```typescript
// src/entry.ts — 수정
import { buildProgram } from './cli/program.js';
import { createDefaultDeps } from './cli/deps.js';
import { tryFastPath } from './cli/route.js';

async function main(): Promise<void> {
  const deps = createDefaultDeps();

  // 1. Fast-path 시도 (health, status)
  if (await tryFastPath(process.argv, deps)) {
    return;
  }

  // 2. Commander 전체 경로
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

### 5.6 금융 특화 명령어 (market)

```typescript
// src/cli/commands/market.ts
import { Command } from 'commander';
import type { CliDeps } from '../deps.js';

export function register(program: Command, deps: CliDeps): void {
  const market = program.command('market').description('시장 데이터 조회');

  market
    .command('quote <ticker>')
    .description('실시간/지연 시세 조회')
    .option('-f, --format <format>', '출력 형식', 'table')
    .option('-c, --currency <currency>', '표시 통화', 'KRW')
    .action(async (ticker: string, opts: MarketCommandOptions) => {
      const result = await deps.callGateway<MarketQuote>('market.quote', { ticker });
      deps.output(formatQuote(result, opts));
    });

  market
    .command('watch <ticker>')
    .description('실시간 시세 모니터링')
    .action(async (ticker: string) => {
      // Gateway SSE 스트림 구독
      deps.output(`Watching ${ticker}... (Ctrl+C to stop)`);
    });
}
```

### 5.7 데이터 흐름 다이어그램

```
사용자 입력: finclaw market quote AAPL --currency KRW

argv 파싱
    │
    ├─→ tryFastPath() → "market"은 fast-path 아님 → false
    │
    └─→ Commander parseAsync()
         │
         ├─→ lazy-loading: import('./commands/market.js')
         │
         └─→ market.quote action()
              │
              ├─→ deps.callGateway('market.quote', { ticker: 'AAPL' })
              │       │
              │       └─→ Gateway WebSocket RPC → market skill 실행
              │
              └─→ formatQuote(result, { format: 'table', currency: 'KRW' })
                       │
                       └─→ deps.output(formattedTable)
```

---

## 6. 선행 조건

| 선행 Phase           | 필요한 산출물                                 | 사용처                         |
| -------------------- | --------------------------------------------- | ------------------------------ |
| Phase 1 (types)      | `FinClawConfig`, `Logger`, `MarketQuote` 타입 | CliDeps 인터페이스 정의        |
| Phase 2 (infra)      | 로거, 경로 유틸리티                           | createDefaultDeps()            |
| Phase 3 (config)     | `loadConfig()` 함수                           | CliDeps.loadConfig             |
| Phase 10 (gateway)   | Gateway 서버, WebSocket RPC                   | CLI ↔ Gateway 통신             |
| Phase 11 (discovery) | health check, 상태 조회 API                   | fast-path health/status 명령어 |

### 새로운 의존성

| 패키지      | 버전      | 용도           |
| ----------- | --------- | -------------- |
| `commander` | `^13.0.0` | CLI 프레임워크 |

---

## 7. 산출물 및 검증

### 기능 검증 항목

| #   | 검증 항목         | 검증 방법                                                         | 기대 결과                            |
| --- | ----------------- | ----------------------------------------------------------------- | ------------------------------------ |
| 1   | 프로그램 빌드     | `buildProgram()` 호출 후 Commander 인스턴스 검증                  | name='finclaw', version 설정 확인    |
| 2   | 글로벌 옵션       | `--no-color`, `--verbose`, `--json` 옵션 파싱                     | 옵션 값 정상 파싱                    |
| 3   | Fast-path health  | `tryFastPath(['node', 'finclaw', 'health'], deps)`                | true 반환, Gateway 헬스체크 호출     |
| 4   | Fast-path status  | `tryFastPath(['node', 'finclaw', 'status'], deps)`                | true 반환, 상태 정보 출력            |
| 5   | Lazy-loading      | 명령어 모듈이 호출 전에 import되지 않음                           | 등록 시점에 dynamic import 실행 확인 |
| 6   | CliDeps 생성      | `createDefaultDeps()`                                             | 모든 필수 필드가 함수인 객체 반환    |
| 7   | CliDeps mock      | `createDefaultDeps({ output: vi.fn() })`                          | mock 함수가 오버라이드               |
| 8   | config 명령어     | `finclaw config list` 시뮬레이션                                  | 설정 키-값 목록 출력                 |
| 9   | market 명령어     | `finclaw market quote AAPL` 시뮬레이션                            | Gateway RPC 호출 및 결과 포맷팅      |
| 10  | alert 명령어      | `finclaw alert add --ticker BTC --condition above --price 100000` | 알림 생성 RPC 호출                   |
| 11  | 도움말            | `finclaw --help`                                                  | 모든 명령어 그룹이 도움말에 표시     |
| 12  | 알 수 없는 명령어 | `finclaw unknown`                                                 | 에러 메시지 및 도움말 힌트 출력      |

### 테스트 커버리지 목표

| 모듈                | 목표 커버리지 |
| ------------------- | ------------- |
| `cli/program.ts`    | 85%+          |
| `cli/deps.ts`       | 90%+          |
| `cli/route.ts`      | 90%+          |
| `cli/commands/*.ts` | 75%+          |

---

## 8. 복잡도 및 예상 파일 수

| 항목               | 값                                |
| ------------------ | --------------------------------- |
| 복잡도             | **L** (Large)                     |
| 소스 파일          | 12개                              |
| 테스트 파일        | 6개                               |
| 총 파일 수         | **~18개**                         |
| 예상 총 코드 줄 수 | ~1,200줄 (소스 ~800, 테스트 ~400) |
| 새 의존성          | `commander`                       |
| 예상 구현 시간     | 4-6시간                           |

### 복잡도 근거

OpenClaw CLI가 322파일/47.5K LOC인 반면, FinClaw CLI는 금융 AI 비서에 필요한 핵심 명령어만 포함한다. Wizard/Terminal/Profile 레이어를 제외하고, lazy-loading과 fast-path의 핵심 패턴만 채택한다. 명령어 구현의 실제 비즈니스 로직은 대부분 Gateway RPC 호출로 위임되므로 CLI 레이어 자체는 상대적으로 가볍다.
