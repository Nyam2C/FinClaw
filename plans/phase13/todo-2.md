# Phase 13 TODO-2: 명령어 구현

> plan.md 단계 5~6 | 소스 8개 + 테스트 4개 = 12개 파일
> 선행: todo-1.md 완료 (deps.ts, gateway-client.ts, program.ts 등)
> 검증: 모든 명령어 시뮬레이션 테스트 통과, `npx finclaw --help`에서 모든 명령어 표시

---

## 1. 비금융 명령어 — start (단계 5)

- [ ] **1-1.** `packages/server/src/cli/commands/start.ts` 생성 (~80줄)
  - `register(program: Command, deps: CliDeps): void`
  - `finclaw start` — Gateway 서버 시작
    - 옵션: `--port <port>` (기본 3000), `--host <host>` (기본 127.0.0.1), `--detach` (백그라운드)
  - action:
    1. `deps.loadConfig()` 로 설정 로드
    2. `--detach` 시: `child_process.spawn`으로 서버 프로세스 분리, PID 출력 후 종료
    3. 포그라운드: `import('../main.js')` 동적 임포트로 서버 직접 시작 (또는 `deps.callGateway` 사용 불가 — 서버가 아직 없으므로 직접 시작)

  ```typescript
  import { Command } from 'commander';
  import type { CliDeps } from '../deps.js';

  export function register(program: Command, deps: CliDeps): void {
    program
      .command('start')
      .description('Gateway 서버 시작')
      .option('-p, --port <port>', '포트 번호', '3000')
      .option('-H, --host <host>', '호스트', '127.0.0.1')
      .option('-d, --detach', '백그라운드 실행')
      .action(async (opts) => {
        // 설정 로드 + 서버 시작 로직
      });
  }
  ```

---

## 2. 비금융 명령어 — stop (단계 5)

- [ ] **2-1.** `packages/server/src/cli/commands/stop.ts` 생성 (~50줄)
  - `register(program: Command, deps: CliDeps): void`
  - `finclaw stop` — Gateway 서버 종료
  - action:
    1. `deps.callGateway('system.shutdown')` RPC 호출
    2. 성공 시: `deps.output('Gateway stopped.')`
    3. 실패 시 (연결 불가): `deps.error('Gateway is not running.')`
  ```typescript
  export function register(program: Command, deps: CliDeps): void {
    program
      .command('stop')
      .description('Gateway 서버 종료')
      .action(async () => {
        const result = await deps.callGateway('system.shutdown');
        if (result.ok) {
          deps.output('Gateway stopped.');
        } else {
          deps.error(`Failed to stop gateway: ${result.error?.message ?? 'unknown'}`);
        }
      });
  }
  ```

---

## 3. 비금융 명령어 — config (단계 5)

- [ ] **3-1.** `packages/server/src/cli/commands/config.ts` 생성 (~90줄)
  - `register(program: Command, deps: CliDeps): void`
  - 서브커맨드 3개:
    - `finclaw config list` — 현재 설정 전체 출력
      - `deps.callGateway('config.get')` → formatKeyValue 또는 JSON
    - `finclaw config get <key>` — 특정 키 값 조회
      - `deps.callGateway('config.get', { key })` → 값 출력
    - `finclaw config set <key> <value>` — 설정 값 변경
      - `deps.callGateway('config.update', { key, value })` → 성공/실패 메시지

  ```typescript
  export function register(program: Command, deps: CliDeps): void {
    const config = program.command('config').description('설정 관리');

    config
      .command('list')
      .description('현재 설정 출력')
      .action(async () => {
        /* ... */
      });

    config
      .command('get <key>')
      .description('설정 값 조회')
      .action(async (key: string) => {
        /* ... */
      });

    config
      .command('set <key> <value>')
      .description('설정 값 변경')
      .action(async (key: string, value: string) => {
        /* ... */
      });
  }
  ```

- [ ] **3-2.** `packages/server/src/cli/commands/__tests__/config.test.ts` 생성 (~70줄)
  - `createTestDeps()` 사용
  - config list:
    - `callGateway` mock → `{ ok: true, data: { gateway: { port: 3000 } } }`
    - `output` 호출 확인 (JSON 또는 key-value 포맷)
  - config get:
    - 키 `'gateway.port'` → 값 출력
  - config set:
    - `callGateway` 호출 인자: `'config.update', { key: 'gateway.port', value: '4000' }`
    - 성공 메시지 확인
  - 검증: `pnpm test -- packages/server/src/cli/commands/__tests__/config.test.ts`

---

## 4. 비금융 명령어 — agent (단계 5)

- [ ] **4-1.** `packages/server/src/cli/commands/agent.ts` 생성 (~60줄)
  - `register(program: Command, deps: CliDeps): void`
  - 서브커맨드 2개:
    - `finclaw agent list` — 등록된 에이전트 목록
      - `deps.callGateway('agent.list')` → formatTable
    - `finclaw agent status <name>` — 특정 에이전트 상태
      - `deps.callGateway('agent.status', { name })` → formatKeyValue

  ```typescript
  export function register(program: Command, deps: CliDeps): void {
    const agent = program.command('agent').description('에이전트 관리');

    agent
      .command('list')
      .description('에이전트 목록')
      .action(async () => {
        /* ... */
      });

    agent
      .command('status <name>')
      .description('에이전트 상태 조회')
      .action(async (name: string) => {
        /* ... */
      });
  }
  ```

---

## 5. 비금융 명령어 — channel (단계 5)

- [ ] **5-1.** `packages/server/src/cli/commands/channel.ts` 생성 (~50줄)
  - `register(program: Command, deps: CliDeps): void`
  - 서브커맨드 2개:
    - `finclaw channel list` — 등록된 채널 목록
      - `deps.callGateway('channel.list')` → formatTable
    - `finclaw channel status <name>` — 특정 채널 상태
      - `deps.callGateway('channel.status', { name })` → formatKeyValue

  ```typescript
  export function register(program: Command, deps: CliDeps): void {
    const channel = program.command('channel').description('채널 관리');

    channel
      .command('list')
      .description('채널 목록')
      .action(async () => {
        /* ... */
      });

    channel
      .command('status <name>')
      .description('채널 상태 조회')
      .action(async (name: string) => {
        /* ... */
      });
  }
  ```

---

## 6. 금융 명령어 — market (단계 6)

- [ ] **6-1.** `packages/server/src/cli/commands/market.ts` 생성 (~70줄)
  - `register(program: Command, deps: CliDeps): void`
  - `MarketCommandOptions`: `format: 'table' | 'json'`, `currency: string`
  - 서브커맨드:
    - `finclaw market quote <ticker>` — 시세 조회
      - 옵션: `-f, --format <format>` (기본 `'table'`), `-c, --currency <currency>` (기본 `'KRW'`)
      - `deps.callGateway<MarketQuote>('finance.quote', { symbol: ticker })` 호출
      - `--json` 또는 `-f json` → JSON, 아니면 테이블
    - `finclaw market watch <ticker>` — 실시간 모니터링 (placeholder, 스트림 미구현)
  - `formatQuote(data: MarketQuote, opts: MarketCommandOptions): string` — 내부 포맷 함수
    - symbol, price, change, changePercent, volume, marketCap 표시

  ```typescript
  import { Command } from 'commander';
  import type { CliDeps } from '../deps.js';
  import { formatKeyValue } from '../terminal/table.js';

  interface MarketCommandOptions {
    readonly format: 'table' | 'json';
    readonly currency: string;
  }

  export function register(program: Command, deps: CliDeps): void;
  ```

- [ ] **6-2.** `packages/server/src/cli/commands/__tests__/market.test.ts` 생성 (~70줄)
  - `createTestDeps()` 사용
  - market quote:
    - `callGateway` mock → `{ ok: true, data: { symbol: 'AAPL', price: 150.0, change: 2.5, changePercent: 1.69, volume: 1000000 } }`
    - output 호출 확인 — 'AAPL', '150' 포함
    - format=json 시 JSON.stringify 출력
  - market quote 실패:
    - `callGateway` mock → `{ ok: false, error: { code: -1, message: 'timeout' } }`
    - error 호출 확인
  - 검증: `pnpm test -- packages/server/src/cli/commands/__tests__/market.test.ts`

---

## 7. 금융 명령어 — news (단계 6)

- [ ] **7-1.** `packages/server/src/cli/commands/news.ts` 생성 (~60줄)
  - `register(program: Command, deps: CliDeps): void`
  - `finclaw news [query]` — 금융 뉴스 검색
    - 옵션: `-s, --symbols <symbols>` (쉼표 구분 종목 필터), `-f, --format <format>` (기본 `'table'`)
  - action:
    1. params 구성: `query?`, `symbols?` (`.split(',')`)
    2. `deps.callGateway('finance.news', params)` 호출
    3. 결과 포맷: `--json` 시 JSON, 아니면 테이블 (title, source, publishedAt, sentiment)

  ```typescript
  export function register(program: Command, deps: CliDeps): void {
    program
      .command('news [query]')
      .description('금융 뉴스 검색')
      .option('-s, --symbols <symbols>', '관련 종목 필터 (쉼표 구분)')
      .option('-f, --format <format>', '출력 형식', 'table')
      .action(async (query: string | undefined, opts) => {
        /* ... */
      });
  }
  ```

- [ ] **7-2.** `packages/server/src/cli/commands/__tests__/news.test.ts` 생성 (~60줄)
  - `createTestDeps()` 사용
  - news 검색 (query 있음):
    - `callGateway` mock → `{ ok: true, data: [{ title: 'Earnings Report', source: 'Reuters', ... }] }`
    - callGateway 호출 인자: `'finance.news', { query: 'earnings' }`
    - output 포함 확인: 'Earnings Report'
  - news 검색 (query 없음, symbols 필터):
    - callGateway 호출 인자: `'finance.news', { symbols: ['AAPL', 'GOOG'] }`
  - news 실패:
    - error 호출 확인
  - 검증: `pnpm test -- packages/server/src/cli/commands/__tests__/news.test.ts`

---

## 8. 금융 명령어 — alert (단계 6)

- [ ] **8-1.** `packages/server/src/cli/commands/alert.ts` 생성 (~80줄)
  - `register(program: Command, deps: CliDeps): void`
  - `AlertAddOptions`: `ticker`, `condition: 'above' | 'below'`, `price`, `channel?`
  - 서브커맨드 3개:
    - `finclaw alert add` — 알림 생성
      - 옵션: `--ticker <ticker>` (필수), `--condition <condition>` (필수, above/below), `--price <price>` (필수), `--channel <channel>` (선택)
      - `deps.callGateway('finance.alert.create', { ticker, condition, price, channel })` 호출
    - `finclaw alert list` — 알림 목록
      - `deps.callGateway('finance.alert.list')` → formatTable
    - `finclaw alert remove <id>` — 알림 삭제
      - `deps.callGateway('finance.alert.remove', { id })` → 성공/실패 메시지

  ```typescript
  export function register(program: Command, deps: CliDeps): void {
    const alert = program.command('alert').description('가격 알림 관리');

    alert
      .command('add')
      .description('알림 생성')
      .requiredOption('--ticker <ticker>', '종목 심볼')
      .requiredOption('--condition <condition>', 'above 또는 below')
      .requiredOption('--price <price>', '기준 가격')
      .option('--channel <channel>', '알림 채널')
      .action(async (opts) => {
        /* ... */
      });

    alert
      .command('list')
      .description('알림 목록')
      .action(async () => {
        /* ... */
      });

    alert
      .command('remove <id>')
      .description('알림 삭제')
      .action(async (id: string) => {
        /* ... */
      });
  }
  ```

---

## 9. program.ts 명령어 목록 업데이트

- [ ] **9-1.** todo-1에서 만든 `program.ts`의 `commandEntries` 배열이 8개 명령어를 모두 포함하는지 확인
  - start, stop, config, agent, channel, market, news, alert
  - 각 entry의 `register` 경로가 올바른지 확인

---

## 10. 최종 검증

- [ ] **10-1.** 타입체크: `pnpm typecheck` 통과
- [ ] **10-2.** 린트: `pnpm lint` 통과
- [ ] **10-3.** 포맷: `pnpm format:fix` 실행
- [ ] **10-4.** 명령어별 유닛 테스트 통과:

  ```bash
  pnpm test -- packages/server/src/cli/commands/
  ```

  - `config.test.ts` ✓
  - `market.test.ts` ✓
  - `news.test.ts` ✓

- [ ] **10-5.** 전체 CLI 테스트 통과:
  ```bash
  pnpm test -- packages/server/src/cli/
  ```
- [ ] **10-6.** 빌드 후 도움말 확인:

  ```bash
  pnpm build && npx finclaw --help
  ```

  - 출력에 start, stop, config, agent, channel, market, news, alert 모두 표시

- [ ] **10-7.** 명령어 시뮬레이션 (Gateway 없이 에러 확인):
  ```bash
  npx finclaw market quote AAPL     # → Gateway 연결 실패 에러
  npx finclaw config list           # → Gateway 연결 실패 에러
  npx finclaw alert list            # → Gateway 연결 실패 에러
  ```

---

## 파일 생성 순서 요약

| 순서 | 파일                                    | 의존 대상                             |
| ---- | --------------------------------------- | ------------------------------------- |
| 1    | `cli/commands/start.ts`                 | deps.ts, commander                    |
| 2    | `cli/commands/stop.ts`                  | deps.ts, commander                    |
| 3    | `cli/commands/config.ts`                | deps.ts, terminal/table.ts, commander |
| 4    | `cli/commands/__tests__/config.test.ts` | config.ts, test-helpers.ts            |
| 5    | `cli/commands/agent.ts`                 | deps.ts, terminal/table.ts, commander |
| 6    | `cli/commands/channel.ts`               | deps.ts, terminal/table.ts, commander |
| 7    | `cli/commands/market.ts`                | deps.ts, terminal/table.ts, commander |
| 8    | `cli/commands/__tests__/market.test.ts` | market.ts, test-helpers.ts            |
| 9    | `cli/commands/news.ts`                  | deps.ts, terminal/table.ts, commander |
| 10   | `cli/commands/__tests__/news.test.ts`   | news.ts, test-helpers.ts              |
| 11   | `cli/commands/alert.ts`                 | deps.ts, terminal/table.ts, commander |
| 12   | (검증) program.ts commandEntries 확인   | 모든 commands/\*.ts                   |

> 모든 경로의 접두사: `packages/server/src/` (테스트 포함)

---

## RPC 메서드 매핑 참조

| 명령어                     | RPC 메서드                   | params                                   |
| -------------------------- | ---------------------------- | ---------------------------------------- |
| `start`                    | (직접 서버 시작, RPC 불필요) | —                                        |
| `stop`                     | `system.shutdown`            | `{}`                                     |
| `config list`              | `config.get`                 | `{}`                                     |
| `config get <key>`         | `config.get`                 | `{ key }`                                |
| `config set <key> <value>` | `config.update`              | `{ key, value }`                         |
| `agent list`               | `agent.list`                 | `{}`                                     |
| `agent status <name>`      | `agent.status`               | `{ name }`                               |
| `channel list`             | `channel.list`               | `{}`                                     |
| `channel status <name>`    | `channel.status`             | `{ name }`                               |
| `market quote <ticker>`    | `finance.quote`              | `{ symbol: ticker }`                     |
| `market watch <ticker>`    | (SSE 스트림, 미구현)         | —                                        |
| `news [query]`             | `finance.news`               | `{ query?, symbols? }`                   |
| `alert add`                | `finance.alert.create`       | `{ ticker, condition, price, channel? }` |
| `alert list`               | `finance.alert.list`         | `{}`                                     |
| `alert remove <id>`        | `finance.alert.remove`       | `{ id }`                                 |
