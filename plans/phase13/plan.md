# Phase 13: CLI 진입점 & 명령어 체계

> 복잡도: **L** | 소스 파일: ~18 | 테스트 파일: ~9 | 총 ~27 파일

---

## 1. 목표

FinClaw CLI의 **진입점과 명령어 체계**를 구축한다. Commander.js 기반의 프로그램 셋업, lazy-loading 서브커맨드 등록, fast-path 라우팅, 그리고 DI 컨테이너(CliDeps)를 구현하여 사용자가 터미널에서 FinClaw의 모든 기능에 접근할 수 있는 CLI 인터페이스를 제공한다.

**핵심 목표:**

- Commander.js 기반 프로그램 인스턴스 생성 (버전, 도움말, 글로벌 옵션)
- 10개 명령어 그룹의 lazy-loading 등록으로 O(1) 시작 시간 유지
- Fast-path 라우팅: `health`, `status` 명령어가 Commander 파싱 없이 직접 실행
- CliDeps 의존성 컨테이너로 테스트 가능한 명령어 구조
- 금융 특화 명령어 (`market`, `news`, `alert`) 포함
- Gateway HTTP 클라이언트로 CLI ↔ Gateway 통신
- 표준화된 종료 코드 및 터미널 출력 (테이블/JSON 분기)

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
- FinClaw: 설정 로더, 로거, Gateway HTTP 클라이언트를 포함한 의존성 객체

**4) Pre-Action Hooks (OpenClaw preaction.ts 50줄)**

- Commander `hook("preAction")` 으로 모든 명령어 실행 전 공통 전처리
- FinClaw: 배너 출력 (인라인), 설정 검증 (인라인), verbose 모드 설정을 preAction으로 구현

**5) createDefaultDeps() Factory (OpenClaw deps.ts)**

- 프로덕션 의존성 팩토리와 테스트용 mock 분리

---

## 3. 생성할 파일

### 소스 파일 (18개)

| 파일 경로                                     | 역할                                                           | 예상 줄 수 |
| --------------------------------------------- | -------------------------------------------------------------- | ---------- |
| `packages/server/src/cli/index.ts`            | CLI 모듈 barrel export                                         | ~15        |
| `packages/server/src/cli/program.ts`          | Commander 프로그램 빌드 & 글로벌 옵션 설정                     | ~80        |
| `packages/server/src/cli/deps.ts`             | CliDeps 타입 정의 & createDefaultDeps() 팩토리                 | ~70        |
| `packages/server/src/cli/route.ts`            | Fast-path 라우팅 (health, status 직접 실행)                    | ~50        |
| `packages/server/src/cli/preaction.ts`        | Pre-Action 훅 (배너 인라인, 설정검증 인라인, verbose)          | ~50        |
| `packages/server/src/cli/entry.ts`            | CLI 전용 진입점 (main.ts와 분리)                               | ~40        |
| `packages/server/src/cli/exit-codes.ts`       | 종료 코드 상수 (OK, ERROR, USAGE, GATEWAY_ERROR, CONFIG_ERROR) | ~15        |
| `packages/server/src/cli/gateway-client.ts`   | Gateway HTTP 클라이언트 (fetch 기반 RPC + health 호출)         | ~80        |
| `packages/server/src/cli/terminal/theme.ts`   | 터미널 색상 테마 (picocolors 래퍼, NO_COLOR 존중)              | ~30        |
| `packages/server/src/cli/terminal/table.ts`   | 간단한 터미널 테이블 포매터                                    | ~50        |
| `packages/server/src/cli/commands/start.ts`   | `finclaw start` — Gateway 서버 시작                            | ~80        |
| `packages/server/src/cli/commands/stop.ts`    | `finclaw stop` — Gateway 서버 종료                             | ~50        |
| `packages/server/src/cli/commands/config.ts`  | `finclaw config get/set/list` — 설정 관리                      | ~90        |
| `packages/server/src/cli/commands/agent.ts`   | `finclaw agent list/status` — 에이전트 관리                    | ~60        |
| `packages/server/src/cli/commands/channel.ts` | `finclaw channel list/status` — 채널 관리                      | ~50        |
| `packages/server/src/cli/commands/market.ts`  | `finclaw market quote <ticker>` — 시장 데이터 조회 (금융 특화) | ~70        |
| `packages/server/src/cli/commands/news.ts`    | `finclaw news [query]` — 금융 뉴스 검색 (금융 특화)            | ~60        |
| `packages/server/src/cli/commands/alert.ts`   | `finclaw alert add/list/remove` — 가격 알림 관리 (금융 특화)   | ~80        |

### 바이너리 래퍼 (1개)

| 파일 경로                        | 역할                                               |
| -------------------------------- | -------------------------------------------------- |
| `packages/server/bin/finclaw.js` | `#!/usr/bin/env node` 래퍼 → `cli/entry.js` import |

### 테스트 파일 (9개)

| 파일 경로                                                   | 테스트 대상                                 | 테스트 종류 |
| ----------------------------------------------------------- | ------------------------------------------- | ----------- |
| `packages/server/src/cli/__tests__/program.test.ts`         | 프로그램 빌드, 글로벌 옵션, 도움말 출력     | unit        |
| `packages/server/src/cli/__tests__/deps.test.ts`            | createDefaultDeps(), DI 컨테이너 생성       | unit        |
| `packages/server/src/cli/__tests__/route.test.ts`           | fast-path 매칭, 라우팅 분기                 | unit        |
| `packages/server/src/cli/__tests__/gateway-client.test.ts`  | HTTP fetch RPC 호출, health 호출, 에러 처리 | unit        |
| `packages/server/src/cli/__tests__/test-helpers.ts`         | createTestDeps() 팩토리 (공용 테스트 유틸)  | helper      |
| `packages/server/src/cli/commands/__tests__/config.test.ts` | config get/set/list 명령어                  | unit        |
| `packages/server/src/cli/commands/__tests__/market.test.ts` | market 조회 출력 포맷                       | unit        |
| `packages/server/src/cli/commands/__tests__/news.test.ts`   | news 조회 출력 포맷                         | unit        |
| `packages/server/src/cli/terminal/__tests__/table.test.ts`  | 테이블 포매팅, 빈 데이터, 정렬              | unit        |

---

## 4. 핵심 인터페이스/타입

```typescript
// packages/server/src/cli/exit-codes.ts — 종료 코드 상수
export type ExitCode = 0 | 1 | 2 | 3 | 4;
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  GATEWAY_ERROR: 3,
  CONFIG_ERROR: 4,
} as const satisfies Record<string, ExitCode>;

// packages/server/src/cli/gateway-client.ts — RPC 결과 래퍼
export interface RpcResult<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: { code: number; message: string };
}

// packages/server/src/cli/deps.ts — CLI 의존성 컨테이너
export interface CliDeps {
  /** 설정 로더 — 현재 FinClaw 설정을 반환 */
  readonly loadConfig: () => Promise<FinClawConfig>;

  /** 로거 인스턴스 (Phase 2 infra) */
  readonly log: FinClawLogger;

  /** Gateway RPC 호출 함수 (HTTP POST /rpc) */
  readonly callGateway: <T>(method: string, params?: unknown) => Promise<RpcResult<T>>;

  /** Gateway 헬스체크 (HTTP GET /health) */
  readonly getGatewayHealth: () => Promise<RpcResult<{ status: string; uptime: number }>>;

  /** 프로세스 종료 함수 (테스트에서 mock 가능) */
  readonly exit: (code: ExitCode) => never;

  /** 표준 출력 함수 (테스트에서 mock 가능) */
  readonly output: (text: string) => void;

  /** 표준 에러 출력 함수 */
  readonly error: (text: string) => void;
}

// packages/server/src/cli/deps.ts — 프로덕션 의존성 팩토리
export function createDefaultDeps(overrides?: Partial<CliDeps>): CliDeps;

// packages/server/src/cli/route.ts — Fast-path 라우트 정의
export interface RouteSpec {
  /** 명령어 경로 매칭 (예: ["health"]) */
  readonly match: (commandPath: string[]) => boolean;

  /** 직접 실행 (Commander 우회) */
  readonly run: (argv: string[], deps: CliDeps) => Promise<boolean>;
}

// packages/server/src/cli/program.ts — 프로그램 컨텍스트
export interface ProgramContext {
  readonly version: string;
  readonly description: string;
}

// packages/server/src/cli/commands/market.ts — 시장 데이터 조회 옵션
export interface MarketCommandOptions {
  readonly format: 'table' | 'json';
  readonly currency: string; // 기본 KRW
}

// packages/server/src/cli/commands/alert.ts — 알림 관리 옵션
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
// packages/server/src/cli/program.ts
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
// packages/server/src/cli/program.ts — 명령어 등록부
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
    name: 'news',
    description: '금융 뉴스 검색',
    register: (p, d) => import('./commands/news.js').then((m) => m.register(p, d)),
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

> **주의:** `health` fast-path는 RPC가 아니라 HTTP `GET /health` 엔드포인트를 직접 호출한다. `status`는 `system.info` RPC 메서드를 사용한다.

```typescript
// packages/server/src/cli/route.ts
import type { CliDeps, RouteSpec } from './deps.js';

const routes: RouteSpec[] = [
  {
    match: (path) => path[0] === 'health',
    run: async (_argv, deps) => {
      // Gateway 헬스체크 — HTTP GET /health 직접 호출 (설정 로딩 없이)
      const result = await deps.getGatewayHealth();
      if (result.ok) {
        deps.output(JSON.stringify(result.data, null, 2));
      } else {
        deps.error(JSON.stringify({ status: 'unreachable', error: result.error?.message }));
      }
      return true;
    },
  },
  {
    match: (path) => path[0] === 'status',
    run: async (_argv, deps) => {
      // system.info RPC 호출
      const result = await deps.callGateway<{
        name: string;
        version: string;
        capabilities: string[];
      }>('system.info');
      if (result.ok) {
        deps.output(JSON.stringify(result.data, null, 2));
      } else {
        deps.error(`Gateway unreachable: ${result.error?.message ?? 'unknown'}`);
      }
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

### 5.4 Gateway HTTP 클라이언트

> CLI는 Gateway 서버의 **외부 클라이언트**이다. 서버사이드 RPC 디스패처(`gateway/rpc/index.ts`)를 직접 import하지 않고, HTTP `fetch`로 Gateway에 접속한다.

```typescript
// packages/server/src/cli/gateway-client.ts
import type { RpcResult } from './deps.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';

export interface GatewayClientOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

/**
 * Gateway HTTP GET /health 호출
 */
export async function getGatewayHealth(
  opts?: GatewayClientOptions,
): Promise<RpcResult<{ status: string; uptime: number }>> {
  const base = opts?.baseUrl ?? DEFAULT_BASE_URL;
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 5_000),
    });
    if (!res.ok) return { ok: false, error: { code: res.status, message: res.statusText } };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: { code: -1, message: (err as Error).message } };
  }
}

/**
 * Gateway JSON-RPC 호출 (HTTP POST /rpc)
 */
export async function callGateway<T>(
  method: string,
  params?: unknown,
  opts?: GatewayClientOptions,
): Promise<RpcResult<T>> {
  const base = opts?.baseUrl ?? DEFAULT_BASE_URL;
  try {
    const res = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? {} }),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 30_000),
    });
    const json = await res.json();
    if (json.error) return { ok: false, error: json.error };
    return { ok: true, data: json.result as T };
  } catch (err) {
    return { ok: false, error: { code: -1, message: (err as Error).message } };
  }
}
```

### 5.5 CliDeps 의존성 팩토리

```typescript
// packages/server/src/cli/deps.ts
import type { FinClawLogger } from '@finclaw/infra';
import type { ExitCode } from './exit-codes.js';
import type { RpcResult } from './gateway-client.js';

export function createDefaultDeps(overrides?: Partial<CliDeps>): CliDeps {
  return {
    loadConfig:
      overrides?.loadConfig ??
      (async () => {
        const { loadConfig } = await import('@finclaw/config');
        return loadConfig();
      }),
    log:
      overrides?.log ??
      (await import('@finclaw/infra').then((m) => m.createLogger({ name: 'cli', level: 'info' }))),
    callGateway:
      overrides?.callGateway ??
      (async (method, params) => {
        const { callGateway } = await import('./gateway-client.js');
        return callGateway(method, params);
      }),
    getGatewayHealth:
      overrides?.getGatewayHealth ??
      (async () => {
        const { getGatewayHealth } = await import('./gateway-client.js');
        return getGatewayHealth();
      }),
    exit: overrides?.exit ?? ((code: ExitCode) => process.exit(code)),
    output: overrides?.output ?? ((text: string) => process.stdout.write(text + '\n')),
    error: overrides?.error ?? ((text: string) => process.stderr.write(text + '\n')),
  };
}
```

### 5.6 CLI 전용 진입점

> `packages/server/src/main.ts`는 Gateway 서버 전용이다. CLI는 별도 진입점을 사용한다.

```typescript
// packages/server/src/cli/entry.ts
import { buildProgram } from './program.js';
import { createDefaultDeps } from './deps.js';
import { tryFastPath } from './route.js';
import { EXIT } from './exit-codes.js';

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
  process.exit(EXIT.ERROR);
});
```

```javascript
// packages/server/bin/finclaw.js
#!/usr/bin/env node
import '../dist/cli/entry.js';
```

```jsonc
// packages/server/package.json에 추가할 필드
{
  "bin": {
    "finclaw": "./bin/finclaw.js",
  },
}
```

### 5.7 Pre-Action 훅

> 배너, 설정 검증은 별도 파일 없이 `preaction.ts`에 인라인으로 구현한다.

```typescript
// packages/server/src/cli/preaction.ts
import type { Command } from 'commander';
import type { CliDeps } from './deps.js';

export function registerPreActionHooks(program: Command, deps: CliDeps): void {
  program.hook('preAction', async (_thisCommand, actionCommand) => {
    // 배너 (인라인)
    if (!program.opts().json) {
      deps.error(`FinClaw CLI v${program.version()}`);
    }

    // 설정 검증 (인라인) — start/config 외 명령어는 설정 필수
    const name = actionCommand.name();
    if (name !== 'start' && name !== 'config') {
      try {
        await deps.loadConfig();
      } catch {
        deps.error('Config not found. Run `finclaw config set` first.');
      }
    }

    // verbose 모드
    if (program.opts().verbose) {
      deps.log.info(`Executing: ${name}`);
    }
  });
}
```

### 5.8 금융 특화 명령어 (market)

```typescript
// packages/server/src/cli/commands/market.ts
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
      const result = await deps.callGateway<MarketQuote>('finance.quote', { symbol: ticker });
      if (!result.ok) {
        deps.error(`Failed to fetch quote: ${result.error?.message}`);
        return;
      }
      deps.output(formatQuote(result.data!, opts));
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

### 5.9 금융 뉴스 명령어 (news)

```typescript
// packages/server/src/cli/commands/news.ts
import { Command } from 'commander';
import type { CliDeps } from '../deps.js';

export function register(program: Command, deps: CliDeps): void {
  program
    .command('news [query]')
    .description('금융 뉴스 검색')
    .option('-s, --symbols <symbols>', '관련 종목 필터 (쉼표 구분)')
    .option('-f, --format <format>', '출력 형식', 'table')
    .action(async (query: string | undefined, opts) => {
      const params: Record<string, unknown> = {};
      if (query) params.query = query;
      if (opts.symbols) params.symbols = opts.symbols.split(',');

      const result = await deps.callGateway('finance.news', params);
      if (!result.ok) {
        deps.error(`Failed to fetch news: ${result.error?.message}`);
        return;
      }
      // --json 글로벌 옵션 또는 -f json → JSON 출력, 아니면 테이블
      deps.output(JSON.stringify(result.data, null, 2));
    });
}
```

### 5.10 `--json` 출력 패턴

각 명령어 action에서 일관된 JSON/table 분기:

```typescript
// 명령어 action 내부 공통 패턴
const globalOpts = program.opts(); // { json: boolean, ... }
if (globalOpts.json || opts.format === 'json') {
  deps.output(JSON.stringify(result.data, null, 2));
} else {
  deps.output(formatTable(result.data));
}
```

### 5.11 데이터 흐름 다이어그램

```
사용자 입력: finclaw market quote AAPL --currency KRW

argv 파싱
    |
    +---> tryFastPath() --> "market"은 fast-path 아님 --> false
    |
    +---> Commander parseAsync()
           |
           +---> lazy-loading: import('./commands/market.js')
           |
           +---> market.quote action()
                  |
                  +---> deps.callGateway('finance.quote', { symbol: 'AAPL' })
                  |       |
                  |       +---> HTTP POST http://127.0.0.1:3000/rpc
                  |       |     Body: { jsonrpc: '2.0', id: 1, method: 'finance.quote', params: { symbol: 'AAPL' } }
                  |       |
                  |       +---> RpcResult<T> { ok, data?, error? }
                  |
                  +---> formatQuote(result.data, { format: 'table', currency: 'KRW' })
                           |
                           +---> deps.output(formattedTable)

사용자 입력: finclaw health

argv 파싱
    |
    +---> tryFastPath() --> "health" fast-path 매칭!
           |
           +---> deps.getGatewayHealth()
           |       |
           |       +---> HTTP GET http://127.0.0.1:3000/health
           |       |
           |       +---> 연결 실패 시: { ok: false, error: { code: -1, message: 'fetch failed' } }
           |       |     --> deps.error('{ status: "unreachable", ... }')
           |       |
           |       +---> 성공 시: { ok: true, data: { status: 'ok', uptime: 1234, ... } }
           |             --> deps.output(JSON.stringify(data))
           |
           +---> return true (Commander 우회)

사용자 입력: finclaw status

argv 파싱
    |
    +---> tryFastPath() --> "status" fast-path 매칭!
           |
           +---> deps.callGateway('system.info')
                  |
                  +---> HTTP POST /rpc { method: 'system.info' }
                  +---> 결과: { name, version, capabilities }
```

---

## 6. 선행 조건

| 선행 Phase         | 필요한 산출물                                    | 사용처                         |
| ------------------ | ------------------------------------------------ | ------------------------------ |
| Phase 1 (types)    | `FinClawConfig`, `MarketQuote`, `RpcMethod` 타입 | CliDeps 인터페이스, RPC 호출   |
| Phase 2 (infra)    | `FinClawLogger`, `createLogger()`, 경로 유틸리티 | CliDeps.log, createDefaultDeps |
| Phase 3 (config)   | `loadConfig()` 함수                              | CliDeps.loadConfig             |
| Phase 10 (gateway) | Gateway HTTP 서버, RPC 디스패처                  | CLI ↔ Gateway HTTP 통신        |

### Phase 10 필요 엔드포인트/메서드 상세

| 엔드포인트/메서드                                | 프로토콜      | CLI 사용처                  |
| ------------------------------------------------ | ------------- | --------------------------- |
| `GET /health`                                    | HTTP          | fast-path `health` 명령어   |
| `GET /info`                                      | HTTP          | (선택) 서버 정보 직접 조회  |
| `POST /rpc`                                      | HTTP JSON-RPC | 모든 RPC 명령어의 전송 경로 |
| `system.health`                                  | RPC           | (대안) health 상세 정보     |
| `system.info`                                    | RPC           | fast-path `status` 명령어   |
| `finance.quote`                                  | RPC           | `market quote` 명령어       |
| `finance.news`                                   | RPC           | `news` 명령어               |
| `finance.alert.create`                           | RPC           | `alert add` 명령어          |
| `finance.alert.list`                             | RPC           | `alert list` 명령어         |
| `config.get` / `config.update` / `config.reload` | RPC           | `config` 명령어             |
| `agent.list` / `agent.status`                    | RPC           | `agent` 명령어              |
| `channel.list` / `channel.status`                | RPC           | `channel` 명령어            |

### 새로운 의존성

| 패키지       | 버전      | 용도                                   |
| ------------ | --------- | -------------------------------------- |
| `commander`  | `^14.0.0` | CLI 프레임워크 (Commander.js v14 최신) |
| `picocolors` | `^1.1.1`  | 터미널 색상 (3.8kB, NO_COLOR 존중)     |

---

## 7. 산출물 및 검증

### 기능 검증 항목

| #   | 검증 항목          | 검증 방법                                                         | 기대 결과                                      |
| --- | ------------------ | ----------------------------------------------------------------- | ---------------------------------------------- |
| 1   | 프로그램 빌드      | `buildProgram()` 호출 후 Commander 인스턴스 검증                  | name='finclaw', version 설정 확인              |
| 2   | 글로벌 옵션        | `--no-color`, `--verbose`, `--json` 옵션 파싱                     | 옵션 값 정상 파싱                              |
| 3   | Fast-path health   | `tryFastPath(['node', 'finclaw', 'health'], deps)`                | true 반환, HTTP GET /health 호출               |
| 4   | Fast-path status   | `tryFastPath(['node', 'finclaw', 'status'], deps)`                | true 반환, `system.info` RPC 호출              |
| 5   | Lazy-loading       | 명령어 모듈이 호출 전에 import되지 않음                           | 등록 시점에 dynamic import 실행 확인           |
| 6   | CliDeps 생성       | `createDefaultDeps()`                                             | 모든 필수 필드가 함수인 객체 반환              |
| 7   | CliDeps mock       | `createDefaultDeps({ output: vi.fn() })`                          | mock 함수가 오버라이드                         |
| 8   | config 명령어      | `finclaw config list` 시뮬레이션                                  | `config.get` RPC 호출, 설정 키-값 목록 출력    |
| 9   | market 명령어      | `finclaw market quote AAPL` 시뮬레이션                            | `finance.quote` RPC 호출 및 결과 포맷팅        |
| 10  | news 명령어        | `finclaw news "earnings"` 시뮬레이션                              | `finance.news` RPC 호출 및 결과 출력           |
| 11  | alert 명령어       | `finclaw alert add --ticker BTC --condition above --price 100000` | `finance.alert.create` RPC 호출                |
| 12  | 도움말             | `finclaw --help`                                                  | 모든 명령어 그룹이 도움말에 표시               |
| 13  | 알 수 없는 명령어  | `finclaw unknown`                                                 | 에러 메시지 및 도움말 힌트 출력                |
| 14  | Gateway 클라이언트 | `callGateway('system.health')` 호출                               | HTTP POST /rpc로 JSON-RPC 요청 전송            |
| 15  | Gateway 연결 실패  | Gateway 미실행 시 `getGatewayHealth()` 호출                       | `{ ok: false, error: { code: -1, ... } }` 반환 |
| 16  | NO_COLOR 존중      | `NO_COLOR=1 finclaw health`                                       | 색상 코드 없는 출력                            |
| 17  | --json 모드        | `finclaw market quote AAPL --json`                                | JSON 형식으로만 출력                           |
| 18  | 종료 코드          | Gateway 미실행 시 health 명령어                                   | exit code 3 (GATEWAY_ERROR)                    |
| 19  | 바이너리 실행      | `npx finclaw --version`                                           | 버전 번호 출력                                 |

### 테스트 커버리지 목표

| 모듈                    | 목표 커버리지 |
| ----------------------- | ------------- |
| `cli/program.ts`        | 85%+          |
| `cli/deps.ts`           | 90%+          |
| `cli/route.ts`          | 90%+          |
| `cli/gateway-client.ts` | 90%+          |
| `cli/terminal/table.ts` | 85%+          |
| `cli/commands/*.ts`     | 75%+          |

---

## 8. 복잡도 및 예상 파일 수

| 항목               | 값                                  |
| ------------------ | ----------------------------------- |
| 복잡도             | **L** (Large)                       |
| 소스 파일          | 18개                                |
| 테스트 파일        | 9개                                 |
| 총 파일 수         | **~27개** (+1 bin 래퍼)             |
| 예상 총 코드 줄 수 | ~1,600줄 (소스 ~1,050, 테스트 ~550) |
| 새 의존성          | `commander`, `picocolors`           |

### 복잡도 근거

OpenClaw CLI가 322파일/47.5K LOC인 반면, FinClaw CLI는 금융 AI 비서에 필요한 핵심 명령어만 포함한다. Wizard/Terminal/Profile 레이어를 제외하고, lazy-loading과 fast-path의 핵심 패턴만 채택한다. 명령어 구현의 실제 비즈니스 로직은 대부분 Gateway HTTP RPC 호출로 위임되므로 CLI 레이어 자체는 상대적으로 가볍다. 기존 plan 대비 gateway-client, terminal 레이어, news 명령어, 종료 코드 등이 추가되어 ~400줄 증가.

---

## 9. 권장 구현 순서

TDD 흐름으로 7단계 구현을 권장한다.

| 단계      | 파일                                                                          | 검증                                                 |
| --------- | ----------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1. 기반   | `exit-codes.ts`, `terminal/theme.ts`, `terminal/table.ts`                     | `table.test.ts` 통과                                 |
| 2. 통신   | `gateway-client.ts`                                                           | `gateway-client.test.ts` 통과 (fetch mock)           |
| 3. DI     | `deps.ts`                                                                     | `deps.test.ts` 통과                                  |
| 4. 라우팅 | `route.ts`, `preaction.ts`                                                    | `route.test.ts` 통과                                 |
| 5. 비금융 | `commands/start.ts`, `stop.ts`, `config.ts`, `agent.ts`, `channel.ts`         | `config.test.ts` 통과                                |
| 6. 금융   | `commands/market.ts`, `news.ts`, `alert.ts`                                   | `market.test.ts`, `news.test.ts` 통과                |
| 7. 진입점 | `program.ts`, `entry.ts`, `index.ts`, `bin/finclaw.js`, package.json bin 필드 | `program.test.ts` 통과, `npx finclaw --version` 실행 |
