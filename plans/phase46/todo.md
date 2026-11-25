# Phase 46 Todo: 에이전트 코어 재설계 (AgentRuntime + stream-json 드라이버)

> plan.md 의 밀스톤 M1~M12 를 코드 단위로 분해한 작업 가이드.
> 상태: **확정 — /goal 자율 모드에서 메인이 게이트 1 을 대행 승인 (2026-11-26). 사용자 사후 검토 대상.**
> TQ1~TQ19 는 architect 의 권고 답을 전부 채택했다(근거: `_workspace/phase-execute/46-questions.md`). TQ13 보강: 재구성 픽스처 대신 메인이 캡처한 **실측 NDJSON**(`_workspace/phase-execute/fixtures-real/` — text-only · tool-call · resume-not-found · mcp-unavailable · sigint)을 원본으로 쓴다. 커밋 전 사용자 경로·계정명은 중립 값으로 치환한다.
> 작성 2026-11-26 · base = main `01fbec2` + plan 커밋 `e28f7fc` · 브랜치 `feature/phase46-agent-core`
> 결정 출처: `plans/phase46/plan.md`(이하 **plan**). 이 문서는 결정·범위를 확장하지 않는다. plan 과 현재 코드가 어긋나 판단이 필요한 곳은 `_workspace/phase-execute/46-questions.md` 의 **TQ 번호**로 표시하고, 아래 스니펫에는 **권고 답을 적용한 형태**를 적었다(`[TQ#]` 표시 — 메인이 뒤집으면 그 줄만 바꾼다). 맨 `Q#`·`D#`·`S#`·`G#` 는 plan 의 번호다.

---

## 0. 읽는 법 · 공통 규칙

- 단계 헤딩: `### M{n}-{k}. {VERB} \`path\` — 설명`. 밀스톤 마지막 단계는 항상 `M{n}-N. 밀스톤 검증`.
- 모든 밀스톤 공통 게이트(밀스톤 단독으로 통과해야 커밋):
  ```bash
  pnpm format:fix && pnpm build && pnpm typecheck && pnpm lint && pnpm format && pnpm test && pnpm test:storage
  ```
  기준선(phase45 review): unit **960 pass / 134 files**, storage **140 pass / 22 files**, 실패 0. 밀스톤마다 순수치를 커밋 본문에 적는다.
- `pnpm test` 는 `*.live.test.ts`·`*.storage.test.ts` 를 제외한다(`vitest.config.ts` exclude). live 는 `pnpm test:live`(`vitest.live.config.ts` include: `packages/*/test/**/*.live.test.ts` — 파일명 일치 확인됨).
- 테스트는 typecheck 대상이 아니다(`tsc --build` 는 `src` 만). 그래도 타입은 맞게 쓴다.
- `oxfmt` 가 import 순서를 재정렬한다 → 코드 붙인 뒤 `pnpm format:fix` 필수. 아래 스니펫의 import 순서는 신경 쓰지 않아도 된다.
- 커밋: 밀스톤당 1개, `type(phase46): <ASCII subject>`, 본문 = "왜", 트레일러 `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>` [TQ15]. `--no-verify` 금지.
- lint 주의: `curly`(모든 if 에 중괄호), `no-non-null-assertion`, `no-explicit-any`, 미사용 변수 금지(옛 체인 반환값을 destructure 만 하고 안 쓰면 lint 실패 → M4 참고).

## 1. 옛 체인 ↔ 새 체인 공존 표 (M1~M5)

| 시점  | 새 체인 (driver/runtime)                                                    | 옛 체인 (Runner/CliProviderAdapter/RunnerExecutionAdapter)                                                                                            |
| ----- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 후 | `createCliDriver` 존재, 배선 0                                              | 4 경로 + 서브에이전트 모두 옛 체인                                                                                                                    |
| M2 후 | `AgentRuntime` 존재, 배선 0                                                 | 동일                                                                                                                                                  |
| M3 후 | **Discord**(pipeline) · **서브에이전트**(route_task→runSubAgent) 가 새 체인 | Web/TUI(`chat.send`→`executeForTui`) · cron(`runnerFactory`) · `agent.run`(`runnerFactory`) 은 옛 체인. 전역 `#cliSessionId` 는 이제 이 3 경로만 공유 |
| M4 후 | **4 경로 전부** 새 체인                                                     | 소비자 0. `buildExecution` 이 Runner·adapter 를 여전히 **생성만** 함(삭제는 M5 단독 커밋, I10). `buildProviders` 의 `CliProviderAdapter` 도 생성만    |
| M5 후 | 유일 체인                                                                   | 삭제 완료. `cliBackend.timeoutMs/watchdog` config 키도 이때 제거(그 전까지 `providers.ts` 가 읽음)                                                    |

`extractCitedMemoryIds` 는 M2~M4 동안 `execution-adapter.ts` 에서 import 재사용, M5 에서 `agent-runtime/runtime.ts` 로 **이동**.

## 2. 예상 LOC 순증감 (wc -l, 추정)

| M   |   프로덕션 | 테스트·픽스처 | 비고                                                                            |
| --- | ---------: | ------------: | ------------------------------------------------------------------------------- |
| M1  |       +345 |          +430 | types 95 · cli-driver 235 · index/errors +15 / unit 300 · live 95 · fixtures 35 |
| M2  |       +300 |          +390 | runtime 215 · prepare-turn 80 · storage +3                                      |
| M3  |        −35 |           +80 | pipeline −75, execute +20, sub-agent −12, composition +25                       |
| M4  |        −95 |          −170 | agent.ts −75, scheduler −45, chat +35 / agent.test 455→~230                     |
| M5  |     −1,160 |        −1,030 | §5 삭제 목록 + execution-adapter.test(374)                                      |
| M6  |        +75 |           +90 |                                                                                 |
| M7  |        +35 |           +60 |                                                                                 |
| M8  |         +5 |           +45 |                                                                                 |
| M9  |        +22 |           +30 |                                                                                 |
| M10 |        +70 |           +80 |                                                                                 |
| M11 |         −5 |           +25 | requireEnv/MissingEnvError 고아 제거 포함 [TQ11]                                |
| M12 |     (문서) |             — |                                                                                 |
| 계  | **≈ −443** |         ≈ +30 | plan §5 추정 −480 과 같은 규모                                                  |

## 3. 위험 단계 (리뷰·구현 시 집중)

| 단계                                 | 왜 위험한가                                                                                                                                             | 고정 장치                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **M1-3 `cli-driver.ts` `runCli`**    | 정확히 1 종료·SIGINT→2s→SIGKILL·EOF/exit 대기·소비자 이탈이 한 함수에 얽혀 있고, 실 CLI 동작(G3/G4/G5b)은 live 로만 확인된다 (R1·R3)                    | unit 30케이스(픽스처 6종 + abort/idle/overall/ENOENT/EOF/이탈) + M1 live |
| M2-4 `runtime.ts` `run()`/`finish()` | lane 해제 시점(드라이버 exit 뒤)·reset 경쟁·lane 실패 시 transcript 덮어쓰기 방지(`record === undefined`)                                               | runtime.test 16케이스 (직렬화·상한·reset·lane timeout)                   |
| M3-10/11 composition 재배치          | 서브에이전트 dispatcher 가 driver 를 필요로 해 driver 생성이 `registerSkills` 앞으로, memory wiring 이 `buildExecution` 으로 이동 — 부팅 순서 회귀 위험 | `pnpm build` + §7 스모크 1단계 (M11 이후 Discord 없이도)                 |
| M4-3 `chat.send` 백그라운드화        | 응답 의미 변화(R7·S8), 미처리 rejection 시 프로세스 경고                                                                                                | `streamRun` 전체 try/catch + chat.test D9 3케이스                        |

---

## 사전 준비

### P-1. 기준선 확인

```bash
git status            # clean, branch feature/phase46-agent-core
pnpm install --frozen-lockfile
pnpm build && pnpm test && pnpm test:storage   # 960 / 140 기록
which claude && claude --version               # live 테스트·M3 부팅 로그용 (없어도 unit 게이트는 통과)
```

새 npm 의존성 0 (I1). 스키마 마이그레이션 0 (`conversations.metadata` 재사용, plan §3-3).

---

## 밀스톤 M1 — 드라이버 seam (go/no-go 스파이크)

목적: stream-json 드라이버를 **배선 없이** 추가하고 G3·G4·G5b·G6 를 실측한다. 옛 체인 무변경.

### M1-1. CREATE `packages/agent/src/runtime/types.ts`

plan §3-1 확정안 그대로.

```ts
// packages/agent/src/runtime/types.ts
// Phase 46 M1: 채널 무관 에이전트 런타임의 이벤트·드라이버·포트 계약 (plan §3-1).
import type { AgentId, SessionKey } from '@finclaw/types';

export type AgentErrorReason =
  | 'aborted'
  | 'timeout' // 무출력/overall 워치독, lane 대기 실패
  | 'auth'
  | 'rate_limit' // rate_limit_event.status === 'rejected' 일 때만
  | 'max_turns' // result.subtype === 'error_max_turns'
  | 'session_not_found' // runtime 이 잡아 1회 재시도. 재시도도 실패할 때만 바깥으로 나감
  | 'mcp_unavailable' // init.mcp_servers 의 finclaw.status !== 'connected'
  | 'spawn' // ENOENT 등 프로세스 시작 실패
  | 'unknown';

export interface AgentUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export type AgentEvent =
  | {
      readonly type: 'start';
      readonly runId: string;
      readonly cliSessionId: string;
      readonly model: string;
    }
  | { readonly type: 'text_delta'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | { readonly type: 'tool_result'; readonly id: string; readonly isError: boolean }
  | {
      readonly type: 'done';
      readonly runId: string;
      readonly cliSessionId: string;
      readonly text: string; // result.result (G2)
      readonly usage: AgentUsage;
      readonly costUsd?: number; // total_cost_usd (클라이언트 추정치)
      readonly durationMs: number;
      readonly numTurns: number;
      // ↓ runtime 이 덧붙임
      readonly usedMemoryIds?: readonly string[];
      readonly captured?: {
        readonly memoryId: string;
        readonly type: 'fact' | 'preference';
        readonly content: string;
        readonly duplicate: boolean;
      };
    }
  | {
      readonly type: 'error';
      readonly runId: string;
      readonly reason: AgentErrorReason;
      readonly message: string; // 드라이버가 만든 짧은 요약. raw stderr 는 로그에만
      readonly usage?: AgentUsage;
    };

export interface DriverRequest {
  readonly runId: string;
  readonly prompt: string; // 조립 완료된 user 메시지 (argv 로 전달)
  readonly systemPrompt: string; // 정적. --system-prompt (교체)
  readonly model: string;
  readonly session:
    | { readonly kind: 'new'; readonly id: string } // --session-id
    | { readonly kind: 'resume'; readonly id: string } // --resume
    | { readonly kind: 'none' }; // --no-session-persistence (1-shot)
  readonly mcp?: { readonly url: string; readonly token: string }; // 없으면 MCP 없음 (서브에이전트)
  readonly maxTurns?: number; // 메인만 10
  readonly autocompact?: boolean; // 메인 chat 만 true → --autocompact 200000
  readonly idleTimeoutMs: number;
  readonly overallTimeoutMs: number;
  readonly signal: AbortSignal;
}

/** 실 구현 1(createCliDriver) + 테스트 fake 1(async generator). 인터페이스 클래스 없음 (I6). */
export type AgentDriver = (req: DriverRequest) => AsyncIterable<AgentEvent>;

export interface AgentRunRequest {
  readonly sessionKey: SessionKey;
  readonly agentId: AgentId;
  readonly input: string; // 사용자 원문 (컨텍스트 블록 제외)
  readonly mode: 'chat' | 'oneShot'; // chat: 세션 resume + capture·retrieval / oneShot: 비영속, <context> 는 시각만 (cron·agent.run)
  readonly model?: string; // 없으면 runtime 기본 (TUI chat.start 모델 선택 유지)
  readonly runId?: string; // D1
  readonly signal: AbortSignal;
}

/** gateway 가 import 하는 DIP 포트 (ChatExecutionPort 대체). 구현 = server AgentRuntime 1개. */
export interface AgentRunPort {
  run(req: AgentRunRequest): AsyncIterable<AgentEvent>;
  /** per-session lane 경유 conversations 행 삭제. 삭제했으면 true. */
  reset(sessionKey: SessionKey): Promise<boolean>;
}
```

### M1-2. EDIT `packages/agent/src/providers/claude-cli/errors.ts` — `classifyCliError` 반환 타입만 축소 [TQ2]

드라이버가 M1 에서 이 함수를 쓰므로 D5 의 "반환 타입 교체"를 M1 로 당긴다(삭제 부분 — `CliFailoverReason`/`CliFailoverError` — 은 계획대로 M5). 축소된 타입은 `CliFailoverReason` 의 부분집합이라 `runner.ts` 는 그대로 컴파일된다.

```ts
// packages/agent/src/providers/claude-cli/errors.ts
import type { AgentErrorReason } from '../../runtime/types.js';

// ... 기존 CliFailoverReason / CliFailoverError / *_RE 그대로 ...

export function classifyCliError(
  message: string,
): Extract<AgentErrorReason, 'auth' | 'rate_limit' | 'timeout' | 'unknown'> {
  // 본문 그대로
}
```

### M1-3. CREATE `packages/agent/src/runtime/cli-driver.ts`

plan §3-1 하단·§3-6. 원천 이벤트 매핑은 순수 함수 `mapStreamEvent`, argv 는 `buildCliArgs` 로 분리(둘 다 테스트 대상, `buildCliArgs` 는 M3 서브에이전트 N1 테스트도 사용).

```ts
// packages/agent/src/runtime/cli-driver.ts
// Phase 46 M1: `claude -p` stream-json 드라이버. 격리 argv 를 강제하고 NDJSON 을 AgentEvent 로 매핑한다.
// 종료 규칙: result 를 받아도 stdout EOF + exit 까지 기다린 뒤 종료 이벤트를 정확히 1번 낸다 (I11).
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { FinClawLogger } from '@finclaw/infra';
import { classifyCliError } from '../providers/claude-cli/errors.js';
import type {
  AgentDriver,
  AgentErrorReason,
  AgentEvent,
  AgentUsage,
  DriverRequest,
} from './types.js';

export interface CliDriverOptions {
  /** config `cliBackend.command ?? 'claude'` */
  readonly command: string;
  /** 고정 중립 cwd (`~/.finclaw/agent`) — 생성 시 mkdir. */
  readonly cwd: string;
  readonly logger: FinClawLogger;
}

/** abort·timeout: SIGINT 후 이 시간 안에 안 끝나면 SIGKILL ([L4] §6 — SIGTERM 은 result 를 남기지 않음). */
const KILL_GRACE_MS = 2_000;
const AUTOCOMPACT_TOKENS = '200000';
const SESSION_NOT_FOUND_RE = /no conversation found/i;
const STDERR_TAIL_CHARS = 4_096;
/** [TQ1] 구 backends.ts 의 비항등 alias 1개 보존 (DEFAULT_MODEL id → CLI alias). 그 외 id 는 그대로 전달. */
const MODEL_ALIASES: Readonly<Record<string, string>> = { 'claude-sonnet-4-6': 'sonnet' };
const ZERO_USAGE: AgentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type Terminal = Extract<AgentEvent, { type: 'done' | 'error' }>;

/** mapStreamEvent 가 읽고 쓰는 run 단위 상태. stderr 는 드라이버가 채운다 (session_not_found 판정용). */
export interface StreamState {
  readonly runId: string;
  readonly expectMcp: boolean;
  cliSessionId: string;
  stderr: string;
}

/**
 * 격리 argv (plan §3-6). 호출자가 끌 수 없다.
 * 프롬프트는 `-p` 바로 뒤 [TQ14] — `--allowedTools`/`--mcp-config` 같은 가변 인자 옵션이 뒤따르는 위치 인자를 삼키지 않게.
 * (메인 프롬프트는 항상 `<context>`/`<recent_conversation>` 로 시작하므로 `-` 로 시작해 옵션으로 오인될 일이 없다.)
 * 금지: --dangerously-skip-permissions (N1) · --bare (OAuth 미로드) · --append-system-prompt (N2).
 */
export function buildCliArgs(req: DriverRequest): string[] {
  const args = [
    '-p',
    req.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools',
    '',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--disable-slash-commands',
    '--system-prompt',
    req.systemPrompt,
    '--model',
    MODEL_ALIASES[req.model] ?? req.model,
    '--permission-prompts', // G5b — no-go 면 이 2줄 삭제
    'none',
  ];
  if (req.session.kind === 'new') {
    args.push('--session-id', req.session.id);
  } else if (req.session.kind === 'resume') {
    args.push('--resume', req.session.id);
  } else {
    args.push('--no-session-persistence');
  }
  if (req.mcp) {
    const mcpConfig = {
      mcpServers: {
        finclaw: {
          type: 'http',
          url: req.mcp.url,
          headers: { Authorization: `Bearer ${req.mcp.token}` },
        },
      },
    };
    args.push('--mcp-config', JSON.stringify(mcpConfig), '--allowedTools', 'mcp__finclaw__*');
  }
  if (req.maxTurns !== undefined) {
    args.push('--max-turns', String(req.maxTurns));
  }
  if (req.autocompact) {
    args.push('--autocompact', AUTOCOMPACT_TOKENS); // G5b — no-go 면 이 분기 삭제
  }
  return args;
}

/**
 * stream-json 원천 이벤트 1줄 → AgentEvent 0..n 개. 아는 type 만 처리하고 나머지는 무시 (R1 전방 호환):
 * system:status·thinking_tokens·compact_boundary·api_retry, rate_limit_event(status≠rejected),
 * stream_event 중 text_delta 외, 모르는 type.
 */
export function mapStreamEvent(raw: unknown, state: StreamState): AgentEvent[] {
  if (!isRecord(raw)) {
    return [];
  }
  switch (raw.type) {
    case 'system':
      return raw.subtype === 'init' ? mapInit(raw, state) : [];
    case 'stream_event': {
      const event = asRecord(raw.event);
      const delta = asRecord(event?.delta);
      const isMainText =
        event?.type === 'content_block_delta' &&
        delta?.type === 'text_delta' &&
        typeof delta.text === 'string' &&
        raw.parent_tool_use_id == null;
      return isMainText ? [{ type: 'text_delta', text: delta.text as string }] : [];
    }
    case 'assistant':
      return contentBlocks(raw).flatMap((b): AgentEvent[] =>
        b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string'
          ? [{ type: 'tool_use', id: b.id, name: b.name, input: b.input }]
          : [],
      );
    case 'user':
      return contentBlocks(raw).flatMap((b): AgentEvent[] =>
        b.type === 'tool_result' && typeof b.tool_use_id === 'string'
          ? [{ type: 'tool_result', id: b.tool_use_id, isError: b.is_error === true }]
          : [],
      );
    case 'rate_limit_event':
      return asRecord(raw.rate_limit_info)?.status === 'rejected'
        ? [fail(state.runId, 'rate_limit', 'subscription rate limit rejected')]
        : [];
    case 'result':
      return [mapResult(raw, state)];
    default:
      return [];
  }
}

function mapInit(raw: Record<string, unknown>, state: StreamState): AgentEvent[] {
  if (typeof raw.session_id === 'string') {
    state.cliSessionId = raw.session_id;
  }
  const start: AgentEvent = {
    type: 'start',
    runId: state.runId,
    cliSessionId: state.cliSessionId,
    model: typeof raw.model === 'string' ? raw.model : '',
  };
  if (!state.expectMcp) {
    return [start];
  }
  const servers = Array.isArray(raw.mcp_servers) ? raw.mcp_servers : [];
  const finclaw = servers.map(asRecord).find((s) => s?.name === 'finclaw');
  if (finclaw?.status === 'connected') {
    return [start];
  }
  return [
    start,
    fail(
      state.runId,
      'mcp_unavailable',
      `finclaw MCP status=${String(finclaw?.status ?? 'missing')}`,
    ),
  ];
}

function mapResult(raw: Record<string, unknown>, state: StreamState): Terminal {
  const usage = toUsage(raw.usage);
  if (raw.subtype === 'success' && raw.is_error !== true) {
    return {
      type: 'done',
      runId: state.runId,
      cliSessionId: typeof raw.session_id === 'string' ? raw.session_id : state.cliSessionId,
      text: typeof raw.result === 'string' ? raw.result : '', // G2 — no-go 폴백은 M1-9 참고
      usage,
      ...(typeof raw.total_cost_usd === 'number' ? { costUsd: raw.total_cost_usd } : {}),
      durationMs: num(raw.duration_ms),
      numTurns: num(raw.num_turns),
    };
  }
  const errors = Array.isArray(raw.errors)
    ? raw.errors.filter((e): e is string => typeof e === 'string').join('\n')
    : '';
  const detail = [errors, typeof raw.result === 'string' ? raw.result : '', state.stderr].join(
    '\n',
  );
  let reason: AgentErrorReason;
  if (raw.subtype === 'error_max_turns') {
    reason = 'max_turns';
  } else if (
    raw.subtype === 'error_during_execution' &&
    raw.num_turns === 0 &&
    SESSION_NOT_FOUND_RE.test(detail)
  ) {
    reason = 'session_not_found'; // [L4] §1 실측 형태
  } else {
    reason = classifyCliError(detail);
  }
  return {
    type: 'error',
    runId: state.runId,
    reason,
    message: `claude result ${String(raw.subtype)}`,
    usage,
  };
}

export function createCliDriver(opts: CliDriverOptions): AgentDriver {
  mkdirSync(opts.cwd, { recursive: true });
  return (req) => runCli(opts, req);
}

async function* runCli(opts: CliDriverOptions, req: DriverRequest): AsyncGenerator<AgentEvent> {
  if (req.signal.aborted) {
    yield fail(req.runId, 'aborted', 'aborted before spawn');
    return;
  }
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    // stdin 은 ignore — 파이프로 열려 있으면 CLI 가 3s 대기한다 ([L4] §2). detached 아님 (G3 no-go 시 M1-9).
    child = spawn(opts.command, buildCliArgs(req), {
      cwd: opts.cwd,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    yield fail(req.runId, 'spawn', errorMessage(err));
    return;
  }
  opts.logger.debug('cli.spawned', {
    event: 'cli.spawned',
    runId: req.runId,
    session: req.session.kind,
    model: req.model,
  });

  const state: StreamState = {
    runId: req.runId,
    expectMcp: req.mcp !== undefined,
    cliSessionId: req.session.kind === 'none' ? '' : req.session.id,
    stderr: '',
  };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    state.stderr = (state.stderr + chunk).slice(-STDERR_TAIL_CHARS);
  });
  child.stdout.setEncoding('utf8'); // B11: 청크 경계의 멀티바이트를 StringDecoder 가 보존
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

  let spawnError: Error | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
    child.once('error', (err) => {
      spawnError = err; // ENOENT 등 — stdout 이 안 닫힐 수 있어 readline 을 직접 닫는다
      rl.close();
      resolve();
    });
  });

  let terminal: Terminal | undefined;
  let stopReason: 'aborted' | 'timeout' | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const halt = (reason: 'aborted' | 'timeout'): void => {
    if (!terminal && !stopReason) {
      stopReason = reason; // 종료 이벤트를 이미 받았으면 그 이벤트를 유지하고 프로세스만 정리
    }
    if (killTimer) {
      return;
    }
    child.kill('SIGINT');
    killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
  };
  const onAbort = (): void => halt('aborted');
  req.signal.addEventListener('abort', onAbort, { once: true });
  let idleTimer = setTimeout(() => halt('timeout'), req.idleTimeoutMs);
  const overallTimer = setTimeout(() => halt('timeout'), req.overallTimeoutMs);

  try {
    for await (const line of rl) {
      clearTimeout(idleTimer); // 줄 수신마다 무출력 워치독 재설정
      idleTimer = setTimeout(() => halt('timeout'), req.idleTimeoutMs);
      // abort·종료 확정 이후 줄은 버리고 EOF 까지 드레인 ([L4] §6: SIGINT 후 부분 assistant·result 가 더 온다)
      if (stopReason || terminal || line.trim() === '') {
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        // raw 줄은 로그 금지 (credential 섞임 위험) — 길이만
        opts.logger.debug('cli.stream.unparsable', {
          event: 'cli.stream.unparsable',
          length: line.length,
        });
        continue;
      }
      for (const ev of mapStreamEvent(raw, state)) {
        if (ev.type === 'done' || ev.type === 'error') {
          terminal = ev;
          if (asRecord(raw)?.type !== 'result') {
            halt('aborted'); // init(mcp_unavailable)·rate_limit 에서 확정된 종료 — CLI 가 계속 돌지 않게
          }
          break;
        }
        yield ev;
      }
    }
    await exited;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(overallTimer);
    clearTimeout(killTimer);
    req.signal.removeEventListener('abort', onAbort);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL'); // 소비자가 중간에 이탈(return) — 고아 방지
    }
  }

  let final: Terminal;
  if (stopReason) {
    final = fail(
      req.runId,
      stopReason,
      stopReason === 'timeout' ? 'CLI idle/overall timeout' : 'aborted',
    );
  } else if (terminal) {
    final = terminal;
  } else if (spawnError) {
    final = fail(req.runId, 'spawn', spawnError.message);
  } else {
    final = fail(req.runId, classifyCliError(state.stderr), 'CLI exited without result');
  }
  if (final.type === 'error' && final.reason !== 'aborted') {
    // raw stderr 는 로그에만 (Discord/WS 로는 reason·짧은 요약만 나간다)
    opts.logger.warn('cli.run.error', {
      event: 'cli.run.error',
      runId: req.runId,
      reason: final.reason,
      exitCode: child.exitCode,
      stderrTail: state.stderr.slice(-500),
    });
  }
  yield final;
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  delete env.ANTHROPIC_API_KEY; // I1: 키가 있으면 -p 는 항상 키를 쓴다 → 구독 OAuth 강제
  delete env.ANTHROPIC_API_KEY_OLD; // 구 DEFAULT_CLAUDE_BACKEND.clearEnv 와 동일
  return env;
}

function fail(runId: string, reason: AgentErrorReason, message: string): Terminal {
  return { type: 'error', runId, reason, message };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return isRecord(v) ? v : undefined;
}

function contentBlocks(raw: Record<string, unknown>): Record<string, unknown>[] {
  const content = asRecord(raw.message)?.content;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function toUsage(v: unknown): AgentUsage {
  const u = asRecord(v);
  if (!u) {
    return ZERO_USAGE;
  }
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

검증: `pnpm --filter @finclaw/agent exec tsc --build` (또는 루트 `pnpm build`)

### M1-4. EDIT `packages/agent/src/index.ts` — runtime export 추가 (기존 export 유지)

파일 끝에 추가:

```ts
// ── Phase 46: AgentRuntime driver seam ──
export { buildCliArgs, createCliDriver, type CliDriverOptions } from './runtime/cli-driver.js';
export type {
  AgentDriver,
  AgentErrorReason,
  AgentEvent,
  AgentRunPort,
  AgentRunRequest,
  AgentUsage,
  DriverRequest,
} from './runtime/types.js';
```

### M1-5. CREATE `packages/agent/test/runtime/fixtures/*.ndjson` (6종)

출처: `text-only` 는 메인 실측 캡처(`claude 2.1.332`, haiku — 이전 세션 scratchpad `cli/out.jsonl`)에서 **필드만 덜어낸** 것(필드명·중첩·값 그대로, `capabilities`·`modelUsage` 등 무관 필드와 개인 경로 제외). 나머지는 [05]·[L4] §1·§3·§6·§7 의 실측 형태를 같은 필드 규약으로 옮겼다 [TQ13]. 한 줄 = 한 JSON (주석 불가).

**`text-only.ndjson`** (15줄)

```
{"type":"system","subtype":"init","cwd":"/home/user/.finclaw/agent","session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","tools":[],"mcp_servers":[],"model":"claude-haiku-5-5","permissionMode":"default","slash_commands":[],"apiKeySource":"none","claude_code_version":"2.1.332","output_style":"default","agents":["claude","Explore","general-purpose","Plan","statusline-setup","web-fetch"],"skills":[],"plugins":[{"name":"cc-plugin-agents-md","path":"builtin","source":"cc-plugin-agents-md@builtin"},{"name":"cc-plugin-telemetry","path":"builtin","source":"cc-plugin-telemetry@builtin"}],"uuid":"f76358a7-49db-4efa-a2e6-ae849d1637a2"}
{"type":"system","subtype":"status","status":"requesting","session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","uuid":"0cb7bdd9-4a88-49be-ba4d-4b99f2f2ac65"}
{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-haiku-5-5","id":"msg_011ChQ24TouaCwr936oJSTo6","type":"message","role":"assistant","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":659,"cache_read_input_tokens":0,"output_tokens":7}}},"session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","parent_tool_use_id":null,"uuid":"3c6501ca-c4ac-4846-b14f-f40962c0247d"}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},"session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","parent_tool_use_id":null,"uuid":"04c1c7d1-9793-4c95-bff3-174938179df5"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"안녕하세요!"}},"session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","parent_tool_use_id":null,"uuid":"922be59d-c873-4fd9-b10c-e582378a39fd"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" 테"}},"session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","parent_tool_use_id":null,"uuid":"d5049559-a91d-4042-9268-b11b674f1f90"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"스트용 비서입"}},"session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","parent_tool_use_id":null,"uuid":"dc3dd36d-7674-4ba1-8aac-5c5ea11fea06"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"니다,"}},"session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","parent_tool_use_id":null,"uuid":"af1a4802-7e64-46d4-9376-d86d5f8931c1"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" 무"}},"session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","parent_tool_use_id":null,"uuid":"ed354d91-1326-4d4e-9f04-56306b1e67ba"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"엇을 도와드"}},"session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","parent_tool_use_id":null,"uuid":"b322a6dd-1486-4f25-a0eb-cd7380652d28"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"릴까요?"}},"session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","parent_tool_use_id":null,"uuid":"280baa4b-73f5-4b00-be51-ed62ac398fe8"}
{"type":"assistant","message":{"model":"claude-haiku-5-5","id":"msg_011ChQ24TouaCwr936oJSTo6","type":"message","role":"assistant","content":[{"type":"text","text":"안녕하세요! 테스트용 비서입니다, 무엇을 도와드릴까요?"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":659,"cache_read_input_tokens":0,"output_tokens":7}},"parent_tool_use_id":null,"session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","uuid":"ec2b7cd2-cca4-4bfa-9d50-2c33f7eab84a"}
{"type":"stream_event","event":{"type":"content_block_stop","index":0},"session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","parent_tool_use_id":null,"uuid":"e71760fe-25ce-4597-af93-75ae02f76a60"}
{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":2,"cache_creation_input_tokens":659,"cache_read_input_tokens":0,"output_tokens":35}},"session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","parent_tool_use_id":null,"uuid":"32705fc4-90d3-4227-93ea-a7e221969088"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":1839,"duration_api_ms":1077,"num_turns":1,"result":"안녕하세요! 테스트용 비서입니다, 무엇을 도와드릴까요?","stop_reason":"end_turn","session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","total_cost_usd":0.0001495,"usage":{"input_tokens":2,"cache_creation_input_tokens":659,"cache_read_input_tokens":0,"output_tokens":35},"permission_denials":[],"terminal_reason":"completed","uuid":"bdf00ead-5a5e-4b43-9301-560b3c583e70"}
```

(실측 원본은 `message_delta` 뒤에 `{"type":"stream_event","event":{"type":"message_stop"},...}` 가 있다 — `text-only` 에는 넣어도 되고 빼도 된다. 무시 대상.)

**`rate-limit-allowed.ndjson`** = `text-only.ndjson` 의 14번째 줄(`message_delta`) 뒤, `result` 앞에 실측 그대로 1줄 삽입:

```
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1795838400,"rateLimitType":"seven_day","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false},"uuid":"8e0b8525-0d06-48ba-9053-9582cc2822b0","session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39"}
```

주의: `overageStatus:"rejected"` 가 들어 있다 — 매퍼는 `rate_limit_info.status` 만 본다(이 픽스처가 그 함정을 고정).

**`tool-call.ndjson`** ([L4] §3: init `tools`/`mcp_servers` connected → `assistant{tool_use}` → `user{tool_result tool_use_id, content:[{type:"text",text}]}` → `assistant{text}` → `result{num_turns:2}`)

```
{"type":"system","subtype":"init","cwd":"/home/user/.finclaw/agent","session_id":"5f3c2a10-7d4e-4b8a-9c1f-2e6d8b0a4c71","tools":["mcp__finclaw__get_current_datetime","mcp__finclaw__route_task"],"mcp_servers":[{"name":"finclaw","status":"connected"}],"model":"claude-haiku-5-5","permissionMode":"default","slash_commands":[],"apiKeySource":"none","claude_code_version":"2.1.332","output_style":"default","agents":["claude","Explore","general-purpose","Plan","statusline-setup","web-fetch"],"skills":[],"plugins":[{"name":"cc-plugin-agents-md","path":"builtin","source":"cc-plugin-agents-md@builtin"}],"uuid":"a1000000-0000-4000-8000-000000000001"}
{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-haiku-5-5","id":"msg_01TOOL1","type":"message","role":"assistant","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"cache_creation_input_tokens":1210,"cache_read_input_tokens":0,"output_tokens":1}}},"session_id":"5f3c2a10-7d4e-4b8a-9c1f-2e6d8b0a4c71","parent_tool_use_id":null,"uuid":"a1000000-0000-4000-8000-000000000002"}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01RouteTask","name":"mcp__finclaw__route_task","input":{}}},"session_id":"5f3c2a10-7d4e-4b8a-9c1f-2e6d8b0a4c71","parent_tool_use_id":null,"uuid":"a1000000-0000-4000-8000-000000000003"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"intent\":\"price_lookup\",\"query\":\"애플 주가\",\"symbol\":\"AAPL\"}"}},"session_id":"5f3c2a10-7d4e-4b8a-9c1f-2e6d8b0a4c71","parent_tool_use_id":null,"uuid":"a1000000-0000-4000-8000-000000000004"}
{"type":"assistant","message":{"model":"claude-haiku-5-5","id":"msg_01TOOL1","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01RouteTask","name":"mcp__finclaw__route_task","input":{"intent":"price_lookup","query":"애플 주가","symbol":"AAPL"}}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"cache_creation_input_tokens":1210,"cache_read_input_tokens":0,"output_tokens":1}},"parent_tool_use_id":null,"session_id":"5f3c2a10-7d4e-4b8a-9c1f-2e6d8b0a4c71","uuid":"a1000000-0000-4000-8000-000000000005"}
{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"input_tokens":3,"cache_creation_input_tokens":1210,"cache_read_input_tokens":0,"output_tokens":48}},"session_id":"5f3c2a10-7d4e-4b8a-9c1f-2e6d8b0a4c71","parent_tool_use_id":null,"uuid":"a1000000-0000-4000-8000-000000000006"}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01RouteTask","type":"tool_result","content":[{"type":"text","text":"{\"price\":231.5,\"change\":1.2,\"changePercent\":0.52}"}]}]},"parent_tool_use_id":null,"session_id":"5f3c2a10-7d4e-4b8a-9c1f-2e6d8b0a4c71","uuid":"a1000000-0000-4000-8000-000000000007"}
{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-haiku-5-5","id":"msg_01TOOL2","type":"message","role":"assistant","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"cache_creation_input_tokens":90,"cache_read_input_tokens":1210,"output_tokens":1}}},"session_id":"5f3c2a10-7d4e-4b8a-9c1f-2e6d8b0a4c71","parent_tool_use_id":null,"uuid":"a1000000-0000-4000-8000-000000000008"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"애플(AAPL) 현재가는 "}},"session_id":"5f3c2a10-7d4e-4b8a-9c1f-2e6d8b0a4c71","parent_tool_use_id":null,"uuid":"a1000000-0000-4000-8000-000000000009"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"231.5달러입니다."}},"session_id":"5f3c2a10-7d4e-4b8a-9c1f-2e6d8b0a4c71","parent_tool_use_id":null,"uuid":"a1000000-0000-4000-8000-00000000000a"}
{"type":"assistant","message":{"model":"claude-haiku-5-5","id":"msg_01TOOL2","type":"message","role":"assistant","content":[{"type":"text","text":"애플(AAPL) 현재가는 231.5달러입니다."}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"cache_creation_input_tokens":90,"cache_read_input_tokens":1210,"output_tokens":20}},"parent_tool_use_id":null,"session_id":"5f3c2a10-7d4e-4b8a-9c1f-2e6d8b0a4c71","uuid":"a1000000-0000-4000-8000-00000000000b"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":4210,"duration_api_ms":3300,"num_turns":2,"result":"애플(AAPL) 현재가는 231.5달러입니다.","stop_reason":"end_turn","session_id":"5f3c2a10-7d4e-4b8a-9c1f-2e6d8b0a4c71","total_cost_usd":0.00042,"usage":{"input_tokens":8,"cache_creation_input_tokens":1300,"cache_read_input_tokens":1210,"output_tokens":68},"permission_denials":[],"terminal_reason":"completed","uuid":"a1000000-0000-4000-8000-00000000000c"}
```

**`resume-not-found.ndjson`** ([L4] §1 — stdout 은 result 1줄. stderr 는 테스트가 `No conversation found with session ID: …` 를 따로 흘린다)

```
{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":0,"duration_api_ms":0,"num_turns":0,"session_id":"0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0},"permission_denials":[],"errors":["No conversation found with session ID: 00000000-0000-4000-8000-000000000000"],"uuid":"b2000000-0000-4000-8000-000000000001"}
```

**`sigint-abort.ndjson`** — 두 부분으로 쓴다(테스트가 첫 부분을 흘리고 `SIGINT` 를 받은 뒤 둘째 부분을 흘린다). 첫 9줄 = `text-only.ndjson` 의 1~9번째 줄(init·status·message_start·content_block_start·delta 5개). 이어서 [L4] §6 SIGINT 실측 순서(부분 assistant → user(interrupt) → result:error_during_execution):

```
{"type":"assistant","message":{"model":"claude-haiku-5-5","id":"msg_011ChQ24TouaCwr936oJSTo6","type":"message","role":"assistant","content":[{"type":"text","text":"안녕하세요! 테스트용 비서입니다, 무"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":659,"cache_read_input_tokens":0,"output_tokens":12}},"parent_tool_use_id":null,"session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","uuid":"c3000000-0000-4000-8000-000000000001"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"parent_tool_use_id":null,"session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","uuid":"c3000000-0000-4000-8000-000000000002"}
{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":2210,"duration_api_ms":900,"num_turns":1,"session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","total_cost_usd":0.0001,"usage":{"input_tokens":2,"cache_creation_input_tokens":659,"cache_read_input_tokens":0,"output_tokens":12},"permission_denials":[],"errors":["[ede_diagnostic] result_type=user"],"uuid":"c3000000-0000-4000-8000-000000000003"}
```

테스트 편의상 파일 안 구분자는 두지 않고, 테스트가 "처음 9줄 / 나머지" 로 자른다(`SIGINT_SPLIT = 9`).

**`unknown-types.ndjson`** ([L4] §7 "문서에 없는 타입이 섞인다" — 무시 대상은 `type`/`subtype` 만 의미 있고 나머지 필드 형태는 미실측)

```
{"type":"system","subtype":"init","cwd":"/home/user/.finclaw/agent","session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","tools":[],"mcp_servers":[],"model":"claude-haiku-5-5","permissionMode":"default","slash_commands":[],"apiKeySource":"none","claude_code_version":"2.1.332","output_style":"default","agents":[],"skills":[],"plugins":[],"uuid":"d4000000-0000-4000-8000-000000000001"}
{"type":"system","subtype":"status","status":"requesting","session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","uuid":"d4000000-0000-4000-8000-000000000002"}
{"type":"system","subtype":"thinking_tokens","session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","uuid":"d4000000-0000-4000-8000-000000000003"}
{"type":"system","subtype":"api_retry","attempt":1,"session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","uuid":"d4000000-0000-4000-8000-000000000004"}
{"type":"system","subtype":"compact_boundary","session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","uuid":"d4000000-0000-4000-8000-000000000005"}
{"type":"some_future_event","session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","uuid":"d4000000-0000-4000-8000-000000000006"}
this line is not json
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"..."}},"session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","parent_tool_use_id":null,"uuid":"d4000000-0000-4000-8000-000000000007"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"안녕"}},"session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","parent_tool_use_id":null,"uuid":"d4000000-0000-4000-8000-000000000008"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":900,"duration_api_ms":700,"num_turns":1,"result":"안녕","stop_reason":"end_turn","session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","total_cost_usd":0.00001,"usage":{"input_tokens":2,"cache_creation_input_tokens":0,"cache_read_input_tokens":659,"output_tokens":3},"permission_denials":[],"uuid":"d4000000-0000-4000-8000-000000000009"}
```

### M1-6. CREATE `packages/agent/test/runtime/cli-driver.test.ts`

`node:child_process` 를 `vi.mock` 으로 바꾸고 가짜 child(PassThrough stdout/stderr + `close` emit)로 픽스처를 재생한다. 실 CLI 호출 0 (I7).

```ts
// packages/agent/test/runtime/cli-driver.test.ts
// Phase 46 M1: stream-json 드라이버 — argv 격리·이벤트 매핑·정확히 1 종료·abort/timeout·B11. mock-only.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { FinClawLogger } from '@finclaw/infra';
import { describe, expect, it, vi } from 'vitest';
import { buildCliArgs, createCliDriver } from '../../src/runtime/cli-driver.js';
import type { AgentEvent, DriverRequest } from '../../src/runtime/types.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const TEXT = '안녕하세요! 테스트용 비서입니다, 무엇을 도와드릴까요?';
const TEXT_SESSION = '8a2494ed-5e2a-4f50-a83d-c2f2a972ec39';
const SIGINT_SPLIT = 9;
const FIXTURES = [
  'text-only',
  'tool-call',
  'resume-not-found',
  'sigint-abort',
  'rate-limit-allowed',
  'unknown-types',
] as const;

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: string[] = [];
  /** 기본: 어떤 시그널이든 즉시 종료. hang 시나리오는 테스트가 교체한다. */
  onSignal: (signal: string) => void = (signal) => this.finish(null, signal as NodeJS.Signals);

  kill(signal: string): boolean {
    this.signals.push(signal);
    this.onSignal(signal);
    return true;
  }

  lines(lines: readonly string[]): void {
    if (this.exitCode !== null || this.signalCode !== null) {
      return;
    }
    for (const line of lines) {
      this.stdout.write(`${line}\n`);
    }
  }

  finish(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) {
      return;
    }
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code, signal));
  }
}

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
  flush: vi.fn(),
} as unknown as FinClawLogger;

function fixture(name: string): string[] {
  return readFileSync(new URL(`./fixtures/${name}.ndjson`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

function request(overrides: Partial<DriverRequest> = {}): DriverRequest {
  return {
    runId: 'run-1',
    prompt: '<context>\n현재 시각: 2026-11-26T10:00:00+09:00 (Asia/Seoul)\n</context>\n\n안녕',
    systemPrompt: 'SYS',
    model: 'haiku',
    session: { kind: 'new', id: '11111111-1111-4111-8111-111111111111' },
    idleTimeoutMs: 120_000,
    overallTimeoutMs: 300_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** spawn 이 child 를 돌려준 다음 tick(드라이버가 리스너를 붙인 뒤)에 script 실행. */
function serve(script: (child: FakeChild) => void): FakeChild {
  const child = new FakeChild();
  vi.mocked(spawn).mockImplementation(() => {
    setImmediate(() => script(child));
    return child as never;
  });
  return child;
}

function replay(name: string, opts: { stderr?: string } = {}): FakeChild {
  return serve((c) => {
    if (opts.stderr) {
      c.stderr.write(opts.stderr);
    }
    c.lines(fixture(name));
    c.finish(0);
  });
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of events) {
    out.push(ev);
  }
  return out;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function driver() {
  return createCliDriver({ command: 'claude', cwd: mkdtempSync(join(tmpdir(), 'drv-')), logger });
}

const types = (events: AgentEvent[]) => events.map((e) => e.type);
const terminals = (events: AgentEvent[]) =>
  events.filter((e) => e.type === 'done' || e.type === 'error');
const deltas = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === 'text_delta' ? [e.text] : []));
const valueOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('buildCliArgs — 격리 argv (plan §3-6)', () => {
  it('격리 플래그가 모두 있고 금지 플래그는 없다', () => {
    const req = request();
    const args = buildCliArgs(req);
    expect(args.slice(0, 2)).toEqual(['-p', req.prompt]);
    expect(valueOf(args, '--output-format')).toBe('stream-json');
    expect(valueOf(args, '--tools')).toBe('');
    expect(valueOf(args, '--setting-sources')).toBe('');
    expect(valueOf(args, '--system-prompt')).toBe('SYS');
    expect(valueOf(args, '--model')).toBe('haiku');
    expect(valueOf(args, '--permission-prompts')).toBe('none');
    expect(args).toEqual(
      expect.arrayContaining([
        '--verbose',
        '--include-partial-messages',
        '--strict-mcp-config',
        '--disable-slash-commands',
      ]),
    );
    for (const banned of ['--dangerously-skip-permissions', '--append-system-prompt', '--bare']) {
      expect(args).not.toContain(banned);
    }
  });

  it('session 3종을 각각의 플래그로 낸다', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    expect(valueOf(buildCliArgs(request({ session: { kind: 'new', id } })), '--session-id')).toBe(
      id,
    );
    expect(valueOf(buildCliArgs(request({ session: { kind: 'resume', id } })), '--resume')).toBe(
      id,
    );
    const none = buildCliArgs(request({ session: { kind: 'none' } }));
    expect(none).toContain('--no-session-persistence');
    expect(none).not.toContain('--session-id');
    expect(none).not.toContain('--resume');
  });

  it('mcp 가 있으면 http MCP + Bearer + allowedTools, 없으면 둘 다 없다', () => {
    const args = buildCliArgs(request({ mcp: { url: 'http://127.0.0.1:3000/mcp', token: 'tok' } }));
    expect(JSON.parse(valueOf(args, '--mcp-config'))).toEqual({
      mcpServers: {
        finclaw: {
          type: 'http',
          url: 'http://127.0.0.1:3000/mcp',
          headers: { Authorization: 'Bearer tok' },
        },
      },
    });
    expect(valueOf(args, '--allowedTools')).toBe('mcp__finclaw__*');
    const bare = buildCliArgs(request());
    expect(bare).not.toContain('--mcp-config');
    expect(bare).not.toContain('--allowedTools');
  });

  it('maxTurns·autocompact 는 지정할 때만', () => {
    const args = buildCliArgs(request({ maxTurns: 10, autocompact: true }));
    expect(valueOf(args, '--max-turns')).toBe('10');
    expect(valueOf(args, '--autocompact')).toBe('200000');
    const plain = buildCliArgs(request());
    expect(plain).not.toContain('--max-turns');
    expect(plain).not.toContain('--autocompact');
  });

  it('DEFAULT_MODEL id 만 alias 로 바꾸고 나머지는 그대로 [TQ1]', () => {
    expect(valueOf(buildCliArgs(request({ model: 'claude-sonnet-4-6' })), '--model')).toBe(
      'sonnet',
    );
    expect(valueOf(buildCliArgs(request({ model: 'claude-opus-4-7' })), '--model')).toBe(
      'claude-opus-4-7',
    );
  });
});

describe('createCliDriver — 스트림 매핑', () => {
  it('spawn: stdin ignore, 고정 cwd, env 에 ANTHROPIC_API_KEY 없음 + auto memory off', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      replay('text-only');
      await collect(driver()(request()));
      const [command, , options] = vi.mocked(spawn).mock.calls[0] as unknown as [
        string,
        string[],
        { cwd: string; env: NodeJS.ProcessEnv; stdio: unknown },
      ];
      expect(command).toBe('claude');
      expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
      expect(options.cwd).toContain('drv-');
      expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('text-only: start → text_delta×7 → done(result.result·usage·cost)', async () => {
    replay('text-only');
    const events = await collect(driver()(request()));
    expect(types(events)).toEqual(['start', ...Array(7).fill('text_delta'), 'done']);
    expect(events[0]).toEqual({
      type: 'start',
      runId: 'run-1',
      cliSessionId: TEXT_SESSION,
      model: 'claude-haiku-5-5',
    });
    expect(deltas(events).join('')).toBe(TEXT);
    expect(events.at(-1)).toEqual({
      type: 'done',
      runId: 'run-1',
      cliSessionId: TEXT_SESSION,
      text: TEXT,
      usage: { input: 2, output: 35, cacheRead: 0, cacheWrite: 659 },
      costUsd: 0.0001495,
      durationMs: 1839,
      numTurns: 1,
    });
  });

  it('rate_limit_event status=allowed 는 무시된다 (overageStatus=rejected 함정 포함)', async () => {
    replay('text-only');
    const plain = await collect(driver()(request()));
    replay('rate-limit-allowed');
    const withAllowed = await collect(driver()(request()));
    expect(withAllowed).toEqual(plain);
  });

  it('tool-call: tool_use(id·name·input) → tool_result(isError=false) → text → done(numTurns=2)', async () => {
    replay('tool-call');
    const events = await collect(
      driver()(request({ mcp: { url: 'http://127.0.0.1:3000/mcp', token: 't' } })),
    );
    expect(types(events)).toEqual([
      'start',
      'tool_use',
      'tool_result',
      'text_delta',
      'text_delta',
      'done',
    ]);
    expect(events[1]).toEqual({
      type: 'tool_use',
      id: 'toolu_01RouteTask',
      name: 'mcp__finclaw__route_task',
      input: { intent: 'price_lookup', query: '애플 주가', symbol: 'AAPL' },
    });
    expect(events[2]).toEqual({ type: 'tool_result', id: 'toolu_01RouteTask', isError: false });
    expect(events.at(-1)).toMatchObject({ type: 'done', numTurns: 2 });
  });

  it('resume-not-found → error{session_not_found} (start 없음)', async () => {
    replay('resume-not-found', {
      stderr: 'No conversation found with session ID: 00000000-0000-4000-8000-000000000000\n',
    });
    const events = await collect(
      driver()(
        request({ session: { kind: 'resume', id: '00000000-0000-4000-8000-000000000000' } }),
      ),
    );
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', reason: 'session_not_found', runId: 'run-1' }),
    ]);
  });

  it('unknown-types: 모르는 type·system 하위타입·비 text delta·깨진 JSON 줄은 무시', async () => {
    replay('unknown-types');
    const events = await collect(driver()(request()));
    expect(types(events)).toEqual(['start', 'text_delta', 'done']);
    expect(deltas(events)).toEqual(['안녕']);
  });

  it('result error_max_turns → error{max_turns}', async () => {
    serve((c) => {
      c.lines([
        fixture('text-only')[0],
        '{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":10,"session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","usage":{"input_tokens":1,"output_tokens":1}}',
      ]);
      c.finish(0);
    });
    const events = await collect(driver()(request({ maxTurns: 10 })));
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'max_turns' });
  });

  it('B11: 한글 멀티바이트가 청크 경계에서 깨지지 않는다', async () => {
    serve((c) => {
      const lines = fixture('text-only');
      const head = Buffer.from(`${lines.slice(0, 5).join('\n')}\n`); // 5번째 줄 = "안녕하세요!" delta
      const cut = head.indexOf(Buffer.from('녕')) + 1; // '녕'(3바이트) 한가운데
      c.stdout.write(head.subarray(0, cut));
      c.stdout.write(head.subarray(cut));
      c.lines(lines.slice(5));
      c.finish(0);
    });
    const events = await collect(driver()(request()));
    expect(deltas(events)[0]).toBe('안녕하세요!');
  });
});

describe('createCliDriver — 정확히 1 종료 (I11)', () => {
  it.each(FIXTURES)('%s: 종료 이벤트가 정확히 1개이고 마지막이다', async (name) => {
    replay(name);
    const events = await collect(driver()(request()));
    expect(terminals(events)).toHaveLength(1);
    expect(['done', 'error']).toContain(events.at(-1)?.type);
  });

  it('spawn ENOENT → error{spawn}', async () => {
    serve((c) =>
      c.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })),
    );
    const events = await collect(driver()(request()));
    expect(events).toEqual([expect.objectContaining({ type: 'error', reason: 'spawn' })]);
  });

  it('result 없이 EOF → error{unknown}', async () => {
    serve((c) => {
      c.lines(fixture('text-only').slice(0, 6));
      c.finish(1);
    });
    const events = await collect(driver()(request()));
    expect(terminals(events)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'unknown' });
  });

  it('이미 abort 된 signal → spawn 없이 error{aborted}', async () => {
    const ac = new AbortController();
    ac.abort();
    vi.mocked(spawn).mockClear();
    const events = await collect(driver()(request({ signal: ac.signal })));
    expect(events).toEqual([expect.objectContaining({ type: 'error', reason: 'aborted' })]);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('createCliDriver — abort · timeout', () => {
  it('abort → SIGINT, 2s 안 끝나면 SIGKILL, 이후 도착한 delta 는 버리고 error{aborted} 1회', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const lines = fixture('sigint-abort');
    const ac = new AbortController();
    const child = serve((c) => c.lines(lines.slice(0, SIGINT_SPLIT)));
    child.onSignal = (signal) => {
      if (signal === 'SIGKILL') {
        child.finish(null, 'SIGKILL');
      }
    };
    const pending = collect(driver()(request({ signal: ac.signal })));
    await settle();
    ac.abort();
    expect(child.signals).toEqual(['SIGINT']);
    child.lines([...lines.slice(SIGINT_SPLIT), fixture('text-only')[8]]); // 시그널 후 도착분
    await settle();
    await vi.advanceTimersByTimeAsync(2_000);
    const events = await pending;
    expect(child.signals).toEqual(['SIGINT', 'SIGKILL']);
    expect(types(events)).toEqual(['start', ...Array(5).fill('text_delta'), 'error']);
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'aborted' });
  });

  it('SIGINT 로 grace 안에 끝나면 SIGKILL 을 보내지 않는다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ac = new AbortController();
    const child = serve((c) => c.lines(fixture('text-only').slice(0, 6)));
    const pending = collect(driver()(request({ signal: ac.signal })));
    await settle();
    ac.abort();
    const events = await pending;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.signals).toEqual(['SIGINT']);
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'aborted' });
  });

  it('무출력 idleTimeoutMs 경과 → SIGINT + error{timeout}', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const child = serve((c) => c.lines([fixture('text-only')[0]]));
    const pending = collect(driver()(request({ idleTimeoutMs: 1_000 })));
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    const events = await pending;
    expect(child.signals[0]).toBe('SIGINT');
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'timeout' });
  });

  it('줄이 계속 와도 overallTimeoutMs 경과 → error{timeout}', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const [init, status] = fixture('text-only');
    serve((c) => {
      c.lines([init]);
      const tick = (): void => {
        c.lines([status]);
        setTimeout(tick, 600);
      };
      setTimeout(tick, 600);
    });
    const pending = collect(driver()(request({ idleTimeoutMs: 1_000, overallTimeoutMs: 2_500 })));
    await settle();
    await vi.advanceTimersByTimeAsync(2_500);
    const events = await pending;
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'timeout' });
  });

  it('줄 수신마다 idle 타이머가 재설정된다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const lines = fixture('text-only');
    const child = serve((c) => {
      c.lines([lines[0]]);
      setTimeout(() => c.lines([lines[1]]), 600);
      setTimeout(() => c.lines([lines[2]]), 1_200);
      setTimeout(() => {
        c.lines(lines.slice(3));
        c.finish(0);
      }, 1_800);
    });
    const pending = collect(driver()(request({ idleTimeoutMs: 1_000 })));
    await settle();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(600);
      await settle();
    }
    const events = await pending;
    expect(child.signals).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('rate_limit_event status=rejected → error{rate_limit} + 프로세스 정리', async () => {
    const rejected = fixture('rate-limit-allowed').map((l) =>
      l.replace('"status":"allowed"', '"status":"rejected"'),
    );
    const child = serve((c) => c.lines(rejected)); // 스스로 안 끝남 → 드라이버가 SIGINT
    const events = await collect(driver()(request()));
    expect(terminals(events)).toEqual([
      expect.objectContaining({ type: 'error', reason: 'rate_limit' }),
    ]);
    expect(child.signals[0]).toBe('SIGINT');
  });

  it('init 에서 finclaw MCP 가 connected 가 아니면 start → error{mcp_unavailable} + 정리', async () => {
    const failed = fixture('tool-call').map((l) =>
      l.replace('"status":"connected"', '"status":"failed"'),
    );
    const child = serve((c) => c.lines(failed));
    const events = await collect(
      driver()(request({ mcp: { url: 'http://127.0.0.1:3000/mcp', token: 't' } })),
    );
    expect(types(events)).toEqual(['start', 'error']);
    expect(events.at(-1)).toMatchObject({ reason: 'mcp_unavailable' });
    expect(child.signals[0]).toBe('SIGINT');
  });

  it('소비자가 중간에 이탈하면 child 를 SIGKILL 로 정리한다', async () => {
    const child = serve((c) => c.lines(fixture('text-only').slice(0, 6)));
    child.onSignal = (signal) => {
      if (signal === 'SIGKILL') {
        child.finish(null, 'SIGKILL');
      }
    };
    for await (const ev of driver()(request())) {
      if (ev.type === 'start') {
        break;
      }
    }
    expect(child.signals).toContain('SIGKILL');
  });
});
```

검증: `pnpm vitest run packages/agent/test/runtime/cli-driver.test.ts`

### M1-7. CREATE `packages/agent/test/runtime/cli-driver.live.test.ts`

`pnpm test:live` 전용(기본 `pnpm test` 제외 — `vitest.config.ts` exclude `**/*.live.test.ts`). haiku, `describe.skipIf(!claudeAvailable)`. G3·G4·G5b·G6·격리를 **console 로 출력**해 review.md §검증 "G1~G7 표"(D11)에 옮긴다.

```ts
// packages/agent/test/runtime/cli-driver.live.test.ts
// Phase 46 M1 live (수동 · CI 제외): G3 SIGINT 정리 · G4 resume 실패 형태 · G5b 플래그 수용 · G6 resume 첫 delta 지연 · 격리.
import { execSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FinClawLogger } from '@finclaw/infra';
import { describe, expect, it } from 'vitest';
import { buildCliArgs, createCliDriver } from '../../src/runtime/cli-driver.js';
import type { AgentEvent, DriverRequest } from '../../src/runtime/types.js';

const claudeAvailable = (() => {
  try {
    execSync('which claude', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

const noop = (): void => {};
const logger = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  fatal: noop,
  child: () => logger,
  flush: async () => {},
} as unknown as FinClawLogger;

// R9: test-env.ts 가 HOME 을 tmpdir 로 바꾼다. macOS 는 키체인 인증이라 무관(구 runner.live.test 와 동일 조건).
// 인증 실패가 나면 이 파일 상단에서 process.env.HOME = os.userInfo().homedir 로 되돌린다.
const cwd = mkdtempSync(join(tmpdir(), 'finclaw-live-agent-'));
const driver = createCliDriver({ command: 'claude', cwd, logger });

function req(overrides: Partial<DriverRequest>): DriverRequest {
  return {
    runId: randomUUID(),
    prompt: '<context>\n현재 시각: live\n</context>\n\n"안녕"이라고만 답해.',
    systemPrompt: '짧게 답한다.',
    model: 'haiku',
    session: { kind: 'none' },
    idleTimeoutMs: 60_000,
    overallTimeoutMs: 90_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of events) {
    out.push(ev);
  }
  return out;
}

/** 드라이버를 거치지 않고 argv 그대로 1회 실행 — 마지막 result 줄과 init 줄을 돌려준다. */
function runRaw(args: string[]): {
  init?: Record<string, unknown>;
  result?: Record<string, unknown>;
  status: number | null;
} {
  const env = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  delete env.ANTHROPIC_API_KEY;
  const out = spawnSync('claude', args, { cwd, env, encoding: 'utf8', timeout: 90_000 });
  const parsed = out.stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  return {
    init: parsed.find((p) => p.type === 'system' && p.subtype === 'init'),
    result: parsed.findLast((p) => p.type === 'result'),
    status: out.status,
  };
}

describe.skipIf(!claudeAvailable)('cli-driver (live, haiku)', () => {
  it('격리 + 기본 턴: init tools=[] · 플러그인 builtin 만 · skills=[] · done.text 비어 있지 않음', async () => {
    const raw = runRaw(buildCliArgs(req({})));
    console.log(
      '[isolation] tools=%j skills=%j plugins=%j',
      raw.init?.tools,
      raw.init?.skills,
      raw.init?.plugins,
    );
    expect(raw.init?.tools).toEqual([]);
    expect(raw.init?.skills).toEqual([]);
    for (const p of (raw.init?.plugins as Array<{ path: string }> | undefined) ?? []) {
      expect(p.path).toBe('builtin');
    }
    const events = await collect(driver(req({})));
    expect(events[0]?.type).toBe('start');
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect((events.at(-1) as { text: string }).text.length).toBeGreaterThan(0);
  }, 120_000);

  it('G5b: --permission-prompts none · --autocompact 200000 를 각각 수용', () => {
    const base = buildCliArgs(req({})).filter(
      (a, i, all) => a !== '--permission-prompts' && all[i - 1] !== '--permission-prompts',
    );
    for (const extra of [
      ['--permission-prompts', 'none'],
      ['--autocompact', '200000'],
    ]) {
      const raw = runRaw([...base, ...extra]);
      console.log(
        '[G5b] %s → status=%s subtype=%s',
        extra.join(' '),
        raw.status,
        raw.result?.subtype,
      );
      expect(raw.result?.subtype).toBe('success');
    }
  }, 240_000);

  it('G4: 없는 uuid resume → error{session_not_found}', async () => {
    const events = await collect(driver(req({ session: { kind: 'resume', id: randomUUID() } })));
    console.log('[G4] %j', events.at(-1));
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'session_not_found' });
  }, 60_000);

  it('G3: 스트리밍 중 abort → 2.5s 안 종료 + 고아 0', async () => {
    const marker = `g3-${randomUUID()}`;
    const ac = new AbortController();
    const startedAt = Date.now();
    let abortedAt = 0;
    const events: AgentEvent[] = [];
    let seen = 0;
    for await (const ev of driver(
      req({
        prompt: `<context>\n${marker}\n</context>\n\n1부터 200까지 숫자를 한 줄에 하나씩 한글로 써줘`,
        signal: ac.signal,
      }),
    )) {
      events.push(ev);
      if (ev.type === 'text_delta' && ++seen === 5) {
        abortedAt = Date.now();
        ac.abort();
      }
    }
    const exitMs = Date.now() - abortedAt;
    await new Promise((r) => setTimeout(r, 500));
    const orphans = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).stdout.trim();
    console.log(
      '[G3] exitAfterAbortMs=%d totalMs=%d orphans=%j last=%j',
      exitMs,
      Date.now() - startedAt,
      orphans,
      events.at(-1),
    );
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'aborted' });
    expect(exitMs).toBeLessThan(2_500);
    expect(orphans).toBe('');
  }, 90_000);

  it('G6: resume 턴 첫 text_delta 지연 p50 (측정만)', async () => {
    const id = randomUUID();
    await collect(
      driver(
        req({
          session: { kind: 'new', id },
          prompt: '<context>\n-\n</context>\n\n내 이름은 자두야. "응"이라고만 답해.',
        }),
      ),
    );
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      let first = 0;
      for await (const ev of driver(
        req({
          session: { kind: 'resume', id },
          prompt: '<context>\n-\n</context>\n\n내 이름이 뭐지? 이름만.',
        }),
      )) {
        if (ev.type === 'text_delta' && first === 0) {
          first = Date.now() - t0;
        }
      }
      samples.push(first);
    }
    const p50 = samples.toSorted((a, b) => a - b)[1];
    console.log('[G6] resume first text_delta ms samples=%j p50=%d', samples, p50);
    expect(p50).toBeGreaterThan(0);
  }, 240_000);
});
```

### M1-8. 밀스톤 M1 검증

```bash
pnpm format:fix && pnpm build && pnpm typecheck && pnpm lint && pnpm format && pnpm test && pnpm test:storage
pnpm vitest run packages/agent/test/runtime/cli-driver.test.ts   # 신규 30 케이스 green
pnpm test:live -- packages/agent/test/runtime/cli-driver.live.test.ts   # 수동. 출력 [isolation]/[G3]/[G4]/[G5b]/[G6] 를 메모
```

- unit: 960 + 신규 30 pass, storage 140.
- **go/no-go (M1 live)** — 판정·폴백:

| #    | 판정 기준                                                    | no-go 시 폴백 (같은 M1 커밋 안에서)                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G3   | abort 후 exit < 2.5s 이고 `pgrep -f <marker>` 결과 비어 있음 | `spawn(..., { ..., detached: true })` 로 바꾸고 `halt`/`finally` 의 `child.kill(sig)` 를 `process.kill(-(child.pid ?? 0), sig)`(try/catch) 로 교체 — 프로세스 그룹 전체 종료. unit 테스트는 `kill` 대신 `process.kill` spy 로 갱신 |
| G4   | `error{session_not_found}`                                   | 출력([G4] 로그의 errors/stderr)에 맞춰 `SESSION_NOT_FOUND_RE` 조정 + `resume-not-found.ndjson` 갱신. 형태가 불안정하면 M2 의 `ROTATE_IDLE_MS = 0`(S3 stateless) 로 확정하고 review 기록                                            |
| G5b  | 각 플래그 단독 실행 `result.subtype === 'success'`           | 거부된 플래그만 `buildCliArgs` 에서 삭제(주석 `// G5b` 줄) + 해당 unit 단언 삭제. review 기록. 비차단                                                                                                                              |
| G6   | 측정만                                                       | — (review 에 p50 기록, phase47 상주 프로세스 판단 근거)                                                                                                                                                                            |
| 격리 | init `tools=[]`·`skills=[]`·플러그인 `path=builtin` 만       | R2: `CLAUDE_CONFIG_DIR=~/.finclaw/claude` + `claude setup-token` 은 phase47 항목 — phase46 은 중단 후 메인 판단                                                                                                                    |

- `pnpm test:live` 를 돌릴 수 없는 환경이면 G3/G4/G5b/G6 는 "미측정" 으로 review 에 남기고 진행(모두 비차단 — plan §1-4 하단).

### M1-9. (조건부) G2 폴백 — M4/최종 스모크에서 no-go 일 때만 적용

`done.text` 가 비었거나 마지막 assistant text 와 다를 때만(plan §2-2 G2). `cli-driver.ts` 에 +10줄:

```ts
// StreamState 에 필드 추가
  lastAssistantText: string;
// runCli 의 state 초기값에 lastAssistantText: '' 추가

// mapStreamEvent 'assistant' 분기 — tool_use 처리 전에:
    case 'assistant': {
      const text = contentBlocks(raw)
        .flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
        .join('');
      if (text) {
        state.lastAssistantText = text;
      }
      return contentBlocks(raw).flatMap(/* 기존 tool_use 매핑 그대로 */);
    }

// mapResult done.text:
      text: (typeof raw.result === 'string' && raw.result) || state.lastAssistantText,
```

- unit 1케이스: `result` 를 `""` 로 바꾼 tool-call 픽스처 → `done.text === '애플(AAPL) 현재가는 231.5달러입니다.'`.

### M1-10. 커밋

```
feat(phase46): add stream-json CLI driver behind AgentDriver seam

The Runner chain spawns `claude -p --output-format json` without isolation
flags, so every turn inherits the developer's global CLAUDE.md, hooks and
plugins (~12K tokens, L4 §8) and Web/TUI never see real token streaming.
Add a driver that always assembles the isolation argv, parses NDJSON with
readline (multibyte safe), and guarantees exactly one done/error per run
with SIGINT -> 2s -> SIGKILL cancellation. Not wired yet.

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
```

---

## 밀스톤 M2 — AgentRuntime (배선 없음)

목적: 세션·컨텍스트·동시성·감사를 소유하는 runtime 추가. 아직 아무 경로도 쓰지 않는다.

### M2-1. EDIT `packages/storage/src/agent-runs.ts` — `AddAgentRunInput.id?` (D1)

```ts
/** addAgentRun 입력 — id 미지정 시 함수 내부에서 생성, createdAt 은 항상 내부 생성 */
export interface AddAgentRunInput {
  /** Phase 46 D1: runtime 이 발급한 runId 를 PK 로 (종료 이벤트 yield 전 1행 기록). */
  id?: string;
  agentId: AgentId;
  // ... 기존 필드 그대로 ...
}

export function addAgentRun(db: DatabaseSync, input: AddAgentRunInput): AgentRunLog {
  const id = input.id ?? randomUUID();
  // ... 이하 그대로 ...
```

### M2-2. EDIT `packages/storage/src/agent-runs.storage.test.ts` — 1케이스

`describe('agent_runs CRUD')` 안, `'addAgentRun — error 필드 기록'` 다음에:

```ts
it('addAgentRun — id 지정 시 그 값을 PK 로 쓴다 (phase46 D1)', () => {
  const run = addAgentRun(database.db, {
    id: 'run-fixed-id',
    agentId: AGENT_A,
    prompt: 'q',
    output: 'a',
  });
  expect(run.id).toBe('run-fixed-id');
  expect(getAgentRun(database.db, 'run-fixed-id')?.prompt).toBe('q');
});
```

### M2-3. CREATE `packages/server/src/agent-runtime/prepare-turn.ts`

D4: `stages/memory-capture.ts`·`stages/memory-retrieval.ts` 를 import 재사용(이동 없음). pipeline 의 rerank 감사 로그(`memory.rerank.observed`)·retrieval 실패 warn(`memory.retrieval.stage_error`)은 이벤트명 그대로 여기로 옮긴다(실제 pipeline 쪽 삭제는 M3).

```ts
// packages/server/src/agent-runtime/prepare-turn.ts
// Phase 46 M2: 턴별 가변 컨텍스트(시각·회상·거래·recap)를 user 메시지 앞 블록으로 조립 (I9 — 시스템 프롬프트는 정적).
import type { FinClawLogger } from '@finclaw/infra';
import type { ConversationMessage, SessionKey } from '@finclaw/types';
import {
  memoryCaptureStage,
  type MemoryCaptureResult,
  type MemoryCaptureService,
} from '../auto-reply/stages/memory-capture.js';
import {
  formatBackgroundSection,
  type MemoryRetrievalService,
  type RetrievalResult,
} from '../auto-reply/stages/memory-retrieval.js';

/** D8: recap 최근 6 메시지 × 500자, recap+context 합계 6,000자. */
const RECAP_MESSAGES = 6;
const RECAP_MESSAGE_CHARS = 500;
const BLOCK_BUDGET_CHARS = 6_000;
/** ponytail: KST 고정 오프셋 (한국은 DST 없음). 타임존 설정이 생기면 Intl 로 교체. */
const KST_OFFSET_MS = 9 * 60 * 60_000;

export interface PrepareTurnInput {
  readonly input: string;
  readonly sessionKey: SessionKey;
  readonly mode: 'chat' | 'oneShot';
  readonly now: number;
  readonly capture?: MemoryCaptureService;
  readonly retrieval?: MemoryRetrievalService;
  readonly logger: FinClawLogger;
  readonly traceId?: string;
}

export interface PreparedTurn {
  /** `<context>…</context>` 블록 (항상 시각 1줄 포함). */
  readonly context: string;
  readonly captured?: MemoryCaptureResult;
  /** 인용 추출 후보 (`extractCitedMemoryIds`). */
  readonly snippets: RetrievalResult['snippets'];
}

/** capture(정규식 5종) → retrieval → `<context>` 조립. oneShot 은 시각만 (Q4·S10). */
export async function prepareTurn(p: PrepareTurnInput): Promise<PreparedTurn> {
  const lines = [`현재 시각: ${formatKst(p.now)} (Asia/Seoul)`];
  let captured: MemoryCaptureResult | undefined;
  let snippets: RetrievalResult['snippets'] = [];
  if (p.mode === 'chat') {
    captured = (await memoryCaptureStage(p.input, p.sessionKey, p.capture, p.logger)) ?? undefined;
    const retrieval = await retrieve(p);
    if (retrieval) {
      snippets = retrieval.snippets;
      const section = formatBackgroundSection(retrieval); // I5: 헤더·[mem:]/[txn:] 마커 그대로
      if (section) {
        lines.push(section);
      }
    }
  }
  return { context: `<context>\n${lines.join('\n')}\n</context>`, captured, snippets };
}

/**
 * user 메시지 조립 (plan §3-4): [<recent_conversation>] + <context> + 원문.
 * recap 은 conversations 원문(user 원문 + done.text)에서 만든다 → 회상 블록 재주입 순환 없음.
 */
export function composePrompt(
  context: string,
  recap: readonly ConversationMessage[],
  input: string,
): string {
  const lines = recap
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-RECAP_MESSAGES)
    .map(
      (m) =>
        `${m.role === 'user' ? '사용자' : 'FinClaw'}: ${(typeof m.content === 'string' ? m.content : '').slice(0, RECAP_MESSAGE_CHARS)}`,
    );
  // ponytail: 합계 상한 초과 시 recap 을 오래된 것부터 버린다 — 배경지식은 상류에서 이미 상한(3건·거래 3건).
  while (lines.length > 0 && recapBlock(lines).length + context.length > BLOCK_BUDGET_CHARS) {
    lines.shift();
  }
  const head = lines.length > 0 ? `${recapBlock(lines)}\n\n` : '';
  return `${head}${context}\n\n${input}`;
}

function recapBlock(lines: readonly string[]): string {
  return `<recent_conversation>\n${lines.join('\n')}\n</recent_conversation>`;
}

async function retrieve(p: PrepareTurnInput): Promise<RetrievalResult | undefined> {
  if (!p.retrieval) {
    return undefined;
  }
  try {
    const result = await p.retrieval.searchRelevant({
      userQuery: p.input,
      sessionKey: p.sessionKey,
    });
    if (result.rerankMeta) {
      p.logger.info('memory.rerank.observed', {
        event: 'memory.rerank.observed',
        sessionKey: p.sessionKey,
        traceId: p.traceId,
        model: result.rerankMeta.model,
        topK: result.rerankMeta.scoresAfter.length,
        swaps: result.rerankMeta.swaps,
      });
    }
    return result;
  } catch (err) {
    p.logger.warn('memory retrieval failed (suppressed)', {
      event: 'memory.retrieval.stage_error',
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function formatKst(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().replace(/\.\d{3}Z$/, '+09:00');
}
```

### M2-4. CREATE `packages/server/src/agent-runtime/runtime.ts`

plan §3-2 run 순서 ①~⑨, D1·D6·D8·D9. `extractCitedMemoryIds` 는 이 밀스톤에선 `execution-adapter.ts` 에서 import(이동은 M5).

```ts
// packages/server/src/agent-runtime/runtime.ts
// Phase 46 M2: 채널 무관 에이전트 런타임 — 세션 바인딩·컨텍스트 주입·동시성·감사 1행을 소유한다.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AgentDriver,
  AgentErrorReason,
  AgentEvent,
  AgentRunPort,
  AgentRunRequest,
  DriverRequest,
  ProfileHealthMonitor,
} from '@finclaw/agent';
import { ConcurrencyLane, FinClawError, type FinClawLogger, type LaneHandle } from '@finclaw/infra';
import { addAgentRun } from '@finclaw/storage';
import type {
  ConversationMessage,
  ConversationRecord,
  SessionKey,
  StorageAdapter,
  Timestamp,
} from '@finclaw/types';
import { extractCitedMemoryIds } from '../auto-reply/execution-adapter.js';
import type { MemoryCaptureService } from '../auto-reply/stages/memory-capture.js';
import type { MemoryRetrievalService } from '../auto-reply/stages/memory-retrieval.js';
import { composePrompt, prepareTurn, type PreparedTurn } from './prepare-turn.js';

/** D8 수치 — 코드 상수 (config 키 없음). ROTATE_IDLE_MS = 0 이면 매 턴 새 세션(S3 폴백). */
const ROTATE_IDLE_MS = 6 * 60 * 60_000;
const TRANSCRIPT_KEEP = 40;
const MAIN_IDLE_TIMEOUT_MS = 120_000;
const MAIN_OVERALL_TIMEOUT_MS = 300_000;
const MAIN_MAX_TURNS = 10;
const GLOBAL_LANE_KEY = 'agent';
const PROFILE_ID = 'default';

type TerminalEvent = Extract<AgentEvent, { type: 'done' | 'error' }>;

/** conversations.metadata 의 CLI 세션 바인딩 (plan §3-3, 마이그레이션 0). */
interface CliSessionBinding {
  readonly cliSessionId: string;
  readonly lastTurnAt: number;
}

interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  isError?: boolean; // S14: 결과 내용은 싣지 않는다
}

interface Attempt {
  started: boolean;
  cliSessionId?: string;
  model?: string;
  readonly tools: Map<string, ToolCall>;
}

interface RunContext {
  readonly req: AgentRunRequest;
  readonly runId: string;
  readonly startedAt: number;
  readonly trace?: { readonly traceId: string; readonly spanId: string };
  attempt: Attempt;
  /** undefined = 아직 안 읽음(lane 실패 등) → transcript 를 덮어쓰지 않는다. null = 행 없음. */
  record?: ConversationRecord | null;
  prepared?: PreparedTurn;
}

export interface AgentRuntimeDeps {
  readonly driver: AgentDriver;
  readonly storage: StorageAdapter; // getConversation / upsertConversation / deleteConversation
  readonly db: DatabaseSync; // addAgentRun
  readonly systemPrompt: string;
  readonly defaultModel: string;
  /** N3: per-run JWT {sub:'finclaw', sessionId: sessionKey} */
  readonly mcp: { readonly url: string; readonly mintToken: (sessionKey: SessionKey) => string };
  readonly capture?: MemoryCaptureService;
  readonly retrieval?: MemoryRetrievalService;
  readonly profileHealth?: ProfileHealthMonitor;
  readonly tracer?: { getCurrentContext(): { traceId: string; spanId: string } | undefined }; // agent_runs.trace_id
  readonly logger: FinClawLogger;
  readonly now?: () => number; // 테스트용 시계
}

export class AgentRuntime implements AgentRunPort {
  // D6: 기존 infra lane 재사용 (새 lock 코드 0). 획득 순서 session → 전역.
  // ponytail: 대기열 20·대기 타임아웃 고정 — 초과 시 error{timeout}. 부하가 생기면 상수 조정.
  private readonly globalLane = new ConcurrencyLane({
    maxConcurrent: 2,
    maxQueueSize: 20,
    waitTimeoutMs: 300_000,
  });
  private readonly sessionLane = new ConcurrencyLane({
    maxConcurrent: 1,
    maxQueueSize: 20,
    waitTimeoutMs: 600_000,
  });
  private readonly inflight = new Set<AbortController>();
  private readonly now: () => number;

  constructor(private readonly deps: AgentRuntimeDeps) {
    this.now = deps.now ?? Date.now;
  }

  async *run(req: AgentRunRequest): AsyncGenerator<AgentEvent> {
    const ctx: RunContext = {
      req,
      runId: req.runId ?? randomUUID(), // D1
      startedAt: this.now(),
      trace: this.deps.tracer?.getCurrentContext(),
      attempt: newAttempt(),
    };
    const internal = new AbortController(); // abortAll() 용
    this.inflight.add(internal);
    const signal = AbortSignal.any([req.signal, internal.signal]);
    const handles: LaneHandle[] = [];
    try {
      let terminal: TerminalEvent;
      try {
        // ① chat 만 per-session lane (oneShot 키는 run 마다 고유라 불필요) → 최상위 run 전역 lane
        if (req.mode === 'chat') {
          handles.push(await this.sessionLane.acquire(req.sessionKey));
        }
        handles.push(await this.globalLane.acquire(GLOBAL_LANE_KEY));
        if (signal.aborted) {
          terminal = fail(ctx.runId, 'aborted', 'aborted before start');
        } else {
          terminal = yield* this.execute(ctx, signal);
        }
      } catch (err) {
        // lane 대기 실패(LANE_TIMEOUT/LANE_QUEUE_FULL) → timeout, 그 외 준비 단계 예외 → unknown (I11)
        terminal = fail(ctx.runId, isLaneError(err) ? 'timeout' : 'unknown', errorMessage(err));
      }
      // ⑦ agent_runs 1행 + (chat) conversations upsert → ⑧ 종료 이벤트 yield
      yield await this.finish(ctx, terminal);
    } finally {
      // ⑨ 드라이버를 끝까지 소비(= exit 이후)한 뒤에만 도달. 전역 → 세션 순 해제.
      for (const handle of handles.toReversed()) {
        handle.release();
      }
      this.inflight.delete(internal);
    }
  }

  /** Q14: per-session lane 경유 — 진행 중 run 의 종료 기록 뒤에 삭제되어 바인딩이 되살아나지 않는다. */
  async reset(sessionKey: SessionKey): Promise<boolean> {
    const handle = await this.sessionLane.acquire(sessionKey);
    try {
      return await this.deps.storage.deleteConversation(sessionKey);
    } finally {
      handle.release();
    }
  }

  /** lifecycle 종료 훅 — 진행 중 run 의 내부 controller 일괄 abort. */
  abortAll(): void {
    for (const controller of this.inflight) {
      controller.abort();
    }
  }

  private async *execute(
    ctx: RunContext,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, TerminalEvent> {
    const { req } = ctx;
    const now = this.now();
    // ② 세션 바인딩 조회 (chat 만)
    if (req.mode === 'chat') {
      ctx.record = await this.deps.storage.getConversation(req.sessionKey);
    }
    // ③ prepareTurn — capture·retrieval·시각
    const prepared = await prepareTurn({
      input: req.input,
      sessionKey: req.sessionKey,
      mode: req.mode,
      now,
      capture: this.deps.capture,
      retrieval: this.deps.retrieval,
      logger: this.deps.logger,
      traceId: ctx.trace?.traceId,
    });
    ctx.prepared = prepared;
    const history = ctx.record?.messages ?? [];
    const binding = readBinding(ctx.record?.metadata);
    let session: DriverRequest['session'];
    if (req.mode === 'oneShot') {
      session = { kind: 'none' };
    } else if (binding && now - binding.lastTurnAt < ROTATE_IDLE_MS) {
      session = { kind: 'resume', id: binding.cliSessionId };
    } else {
      session = { kind: 'new', id: randomUUID() }; // 세션 id 선지정 (회전을 정하는 쪽이 id 도 정함)
    }
    // ④ 드라이버 이벤트 패스스루
    let terminal = yield* this.drive(
      ctx,
      this.driverRequest(ctx, prepared, session, history, signal),
    );
    // ⑤ Q3: session_not_found 에서만 새 세션 + recap 으로 1회 재시도.
    //    실패한 resume 은 stdout 이 result 1줄뿐이라 바깥으로 나간 이벤트가 없다 ([L4] §1).
    if (terminal.type === 'error' && terminal.reason === 'session_not_found') {
      this.deps.logger.info('agent.session.not_found', {
        event: 'agent.session.not_found',
        runId: ctx.runId,
        sessionKey: req.sessionKey,
      });
      terminal = yield* this.drive(
        ctx,
        this.driverRequest(ctx, prepared, { kind: 'new', id: randomUUID() }, history, signal),
      );
    }
    return terminal;
  }

  private driverRequest(
    ctx: RunContext,
    prepared: PreparedTurn,
    session: DriverRequest['session'],
    history: readonly ConversationMessage[],
    signal: AbortSignal,
  ): DriverRequest {
    const { req } = ctx;
    return {
      runId: ctx.runId,
      // recap 은 new 세션이고 직전 메시지가 있을 때만 (회전·session_not_found 재시도)
      prompt: composePrompt(prepared.context, session.kind === 'new' ? history : [], req.input),
      systemPrompt: this.deps.systemPrompt,
      model: req.model ?? this.deps.defaultModel,
      session,
      mcp: { url: this.deps.mcp.url, token: this.deps.mcp.mintToken(req.sessionKey) },
      maxTurns: MAIN_MAX_TURNS,
      autocompact: req.mode === 'chat',
      idleTimeoutMs: MAIN_IDLE_TIMEOUT_MS,
      overallTimeoutMs: MAIN_OVERALL_TIMEOUT_MS,
      signal,
    };
  }

  private async *drive(
    ctx: RunContext,
    dreq: DriverRequest,
  ): AsyncGenerator<AgentEvent, TerminalEvent> {
    const attempt = newAttempt();
    ctx.attempt = attempt;
    try {
      for await (const ev of this.deps.driver(dreq)) {
        if (ev.type === 'done' || ev.type === 'error') {
          return ev;
        }
        if (ev.type === 'start') {
          attempt.started = true;
          attempt.cliSessionId = ev.cliSessionId;
          attempt.model = ev.model;
        } else if (ev.type === 'tool_use') {
          attempt.tools.set(ev.id, { id: ev.id, name: ev.name, input: ev.input });
        } else if (ev.type === 'tool_result') {
          const call = attempt.tools.get(ev.id);
          if (call) {
            call.isError = ev.isError;
          }
        }
        yield ev;
      }
      return fail(dreq.runId, 'unknown', 'driver ended without terminal event');
    } catch (err) {
      return fail(dreq.runId, 'unknown', errorMessage(err)); // 드라이버 throw 도 정확히 1 종료로
    }
  }

  private async finish(ctx: RunContext, terminal: TerminalEvent): Promise<TerminalEvent> {
    const { req, attempt } = ctx;
    const endedAt = this.now();
    let final: TerminalEvent = terminal;
    if (terminal.type === 'done') {
      // ⑥ 인용 추출·capture 꼬리표 부착
      const used = ctx.prepared ? extractCitedMemoryIds(terminal.text, ctx.prepared.snippets) : [];
      const captured = ctx.prepared?.captured;
      final = {
        ...terminal,
        ...(used.length > 0 ? { usedMemoryIds: used } : {}),
        ...(captured ? { captured } : {}),
      };
    }
    try {
      addAgentRun(this.deps.db, {
        id: ctx.runId,
        agentId: req.agentId,
        prompt: req.input,
        output: final.type === 'done' ? final.text : '',
        toolCalls: attempt.tools.size > 0 ? JSON.stringify([...attempt.tools.values()]) : undefined,
        tokensInput: final.usage?.input,
        tokensOutput: final.usage?.output,
        durationMs: endedAt - ctx.startedAt,
        modelUsed: attempt.model ?? req.model ?? this.deps.defaultModel,
        usedMemoryIds:
          final.type === 'done' && final.usedMemoryIds ? [...final.usedMemoryIds] : undefined,
        traceId: ctx.trace?.traceId,
        parentSpanId: ctx.trace?.spanId,
        cliSessionId: attempt.started ? attempt.cliSessionId : undefined,
        error: final.type === 'error' ? `${final.reason}: ${final.message}` : undefined,
      });
    } catch (err) {
      this.deps.logger.warn('agent.run.store_failed', {
        event: 'agent.run.store_failed',
        runId: ctx.runId,
        error: errorMessage(err),
      });
    }
    if (req.mode === 'chat' && ctx.record !== undefined) {
      await this.saveConversation(ctx, final, endedAt);
    }
    if (final.type === 'error') {
      this.deps.logger.warn('agent.run.error', {
        event: 'agent.run.error',
        runId: ctx.runId,
        mode: req.mode,
        reason: final.reason,
        message: final.message,
      });
    }
    if (final.type === 'done' || final.reason !== 'aborted') {
      this.deps.profileHealth?.recordResult(PROFILE_ID, {
        success: final.type === 'done',
        modelId: attempt.model ?? req.model ?? this.deps.defaultModel,
      });
    }
    return final;
  }

  /** D9: run 종료 시 1회 upsert. 원문은 항상, assistant 는 done 일 때만. 바인딩은 start 를 받았을 때만 갱신. */
  private async saveConversation(
    ctx: RunContext,
    final: TerminalEvent,
    endedAt: number,
  ): Promise<void> {
    const { req, record, attempt } = ctx;
    const messages: ConversationMessage[] = [
      ...(record?.messages ?? []),
      { role: 'user', content: req.input },
      ...(final.type === 'done' ? [{ role: 'assistant' as const, content: final.text }] : []),
    ].slice(-TRANSCRIPT_KEEP);
    const binding: CliSessionBinding | undefined =
      attempt.started && attempt.cliSessionId
        ? { cliSessionId: attempt.cliSessionId, lastTurnAt: endedAt }
        : undefined;
    try {
      await this.deps.storage.upsertConversation({
        sessionKey: req.sessionKey,
        agentId: req.agentId,
        messages,
        createdAt: (record?.createdAt ?? endedAt) as Timestamp,
        updatedAt: endedAt as Timestamp,
        metadata: binding ? { ...record?.metadata, ...binding } : record?.metadata,
      });
    } catch (err) {
      this.deps.logger.warn('agent.conversation.store_failed', {
        event: 'agent.conversation.store_failed',
        sessionKey: req.sessionKey,
        error: errorMessage(err),
      });
    }
  }
}

function newAttempt(): Attempt {
  return { started: false, tools: new Map() };
}

function readBinding(metadata: Record<string, unknown> | undefined): CliSessionBinding | undefined {
  const cliSessionId = metadata?.cliSessionId;
  const lastTurnAt = metadata?.lastTurnAt;
  return typeof cliSessionId === 'string' && typeof lastTurnAt === 'number'
    ? { cliSessionId, lastTurnAt }
    : undefined;
}

function fail(runId: string, reason: AgentErrorReason, message: string): TerminalEvent {
  return { type: 'error', runId, reason, message };
}

function isLaneError(err: unknown): boolean {
  return (
    err instanceof FinClawError && (err.code === 'LANE_TIMEOUT' || err.code === 'LANE_QUEUE_FULL')
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

메모: `profileHealth` 기록을 runtime 이 맡으므로 M4 에서 agent.ts·scheduler 의 `recordResult` 는 삭제한다(이중 기록 방지) [TQ12].

### M2-5. CREATE `packages/server/src/agent-runtime/prepare-turn.test.ts`

```ts
// packages/server/src/agent-runtime/prepare-turn.test.ts
// Phase 46 M2: 컨텍스트 블록 형식·빈 섹션 생략·oneShot·recap 상한.
import type { FinClawLogger } from '@finclaw/infra';
import { createSessionKey, type ConversationMessage } from '@finclaw/types';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryCaptureService } from '../auto-reply/stages/memory-capture.js';
import type {
  MemoryRetrievalService,
  RetrievalResult,
} from '../auto-reply/stages/memory-retrieval.js';
import { composePrompt, prepareTurn } from './prepare-turn.js';

const NOW = Date.UTC(2026, 10, 26, 1, 0, 0); // = 2026-11-26 10:00 KST
const SK = createSessionKey('s1');
const TIME_LINE = '현재 시각: 2026-11-26T10:00:00+09:00 (Asia/Seoul)';

function makeLogger(): FinClawLogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    flush: vi.fn(),
  } as unknown as FinClawLogger;
}

function retrievalOf(snippets: RetrievalResult['snippets']): MemoryRetrievalService {
  const result: RetrievalResult = {
    snippets,
    transactions: [],
    mode: 'fts-only',
    auditLog: {
      event: 'memory.injected',
      sessionKey: 's1',
      userQuery: 'q',
      memoryIds: snippets.map((s) => s.id),
      rawScores: [],
      adjustedScores: [],
      mode: 'fts-only',
      transactionSymbols: [],
      timestamp: NOW,
    },
  };
  return { searchRelevant: vi.fn().mockResolvedValue(result) };
}

const SNIPPET = {
  id: 'abcdef12-0000-4000-8000-000000000000',
  content: '나는 배당주를 선호한다',
  type: 'preference' as const,
  createdAt: Date.UTC(2026, 10, 25),
  rawScore: 0.8,
  adjustedScore: 0.79,
  daysOld: 1,
};

describe('prepareTurn', () => {
  it('chat: <context> = 시각 + formatBackgroundSection 그대로', async () => {
    const p = await prepareTurn({
      input: '내 투자 선호?',
      sessionKey: SK,
      mode: 'chat',
      now: NOW,
      retrieval: retrievalOf([SNIPPET]),
      logger: makeLogger(),
    });
    expect(p.context).toBe(
      [
        '<context>',
        TIME_LINE,
        '## 사용자 배경지식 (자동 주입)',
        '- [preference] 나는 배당주를 선호한다 (2026-11-25 저장) [mem:abcdef]',
        '</context>',
      ].join('\n'),
    );
    expect(p.snippets).toHaveLength(1);
  });

  it('회상이 비면 섹션을 생략한다', async () => {
    const p = await prepareTurn({
      input: 'q',
      sessionKey: SK,
      mode: 'chat',
      now: NOW,
      retrieval: retrievalOf([]),
      logger: makeLogger(),
    });
    expect(p.context).toBe(`<context>\n${TIME_LINE}\n</context>`);
  });

  it('oneShot: 시각만, capture·retrieval 미호출', async () => {
    const capture: MemoryCaptureService = { capture: vi.fn() };
    const retrieval = retrievalOf([SNIPPET]);
    const p = await prepareTurn({
      input: '기억해: 나는 성장주를 싫어한다',
      sessionKey: SK,
      mode: 'oneShot',
      now: NOW,
      capture,
      retrieval,
      logger: makeLogger(),
    });
    expect(p.context).toBe(`<context>\n${TIME_LINE}\n</context>`);
    expect(capture.capture).not.toHaveBeenCalled();
    expect(retrieval.searchRelevant).not.toHaveBeenCalled();
  });

  it('capture 를 retrieval 보다 먼저 호출하고 결과를 돌려준다', async () => {
    const captured = {
      memoryId: 'm-1',
      type: 'fact' as const,
      content: '나는 자두',
      duplicate: false,
    };
    const capture: MemoryCaptureService = { capture: vi.fn().mockResolvedValue(captured) };
    const retrieval = retrievalOf([]);
    const p = await prepareTurn({
      input: '기억해: 나는 자두',
      sessionKey: SK,
      mode: 'chat',
      now: NOW,
      capture,
      retrieval,
      logger: makeLogger(),
    });
    expect(p.captured).toEqual(captured);
    expect(vi.mocked(capture.capture).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(retrieval.searchRelevant).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('retrieval 실패는 삼키고 warn(memory.retrieval.stage_error)', async () => {
    const logger = makeLogger();
    const p = await prepareTurn({
      input: 'q',
      sessionKey: SK,
      mode: 'chat',
      now: NOW,
      retrieval: { searchRelevant: vi.fn().mockRejectedValue(new Error('boom')) },
      logger,
    });
    expect(p.context).toBe(`<context>\n${TIME_LINE}\n</context>`);
    expect(logger.warn).toHaveBeenCalledWith(
      'memory retrieval failed (suppressed)',
      expect.objectContaining({ event: 'memory.retrieval.stage_error' }),
    );
  });
});

describe('composePrompt', () => {
  const CTX = `<context>\n${TIME_LINE}\n</context>`;
  const msg = (role: 'user' | 'assistant', content: string): ConversationMessage => ({
    role,
    content,
  });

  it('recap 이 없으면 <context> 로 시작하고 원문으로 끝난다', () => {
    expect(composePrompt(CTX, [], '질문')).toBe(`${CTX}\n\n질문`);
  });

  it('recap: 최근 6 메시지, 메시지당 500자, 역할 라벨', () => {
    const history = Array.from({ length: 8 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', `${i}`.padEnd(600, 'x')),
    );
    const prompt = composePrompt(CTX, history, '질문');
    const block = prompt.slice(0, prompt.indexOf('</recent_conversation>'));
    const lines = block.split('\n').slice(1, -1); // 머리 태그·끝 빈 줄 제외
    expect(lines).toHaveLength(6);
    expect(lines[0]?.startsWith('사용자: 2')).toBe(true);
    expect(lines[1]?.startsWith('FinClaw: 3')).toBe(true);
    expect(lines[0]?.length).toBe('사용자: '.length + 500);
    expect(prompt.endsWith(`${CTX}\n\n질문`)).toBe(true);
  });

  it('recap+context 가 6,000자를 넘으면 recap 을 오래된 것부터 버린다', () => {
    const bigContext = `<context>\n${'가'.repeat(5_000)}\n</context>`;
    const history = Array.from({ length: 6 }, (_, i) => msg('user', `${i}`.padEnd(400, 'y')));
    const prompt = composePrompt(bigContext, history, '질문');
    const recap = prompt.slice(0, prompt.indexOf(bigContext));
    expect(recap.length + bigContext.length).toBeLessThanOrEqual(6_000 + 2);
    expect(recap).not.toContain('사용자: 0');
    expect(recap).toContain('사용자: 5');
  });
});
```

### M2-6. CREATE `packages/server/src/agent-runtime/runtime.test.ts`

fake `AgentDriver`(async generator) + 실 SQLite(`createStorage(':memory:')`, unit tier — `scheduler.test.ts` 와 같은 방식).

```ts
// packages/server/src/agent-runtime/runtime.test.ts
// Phase 46 M2: AgentRuntime — 바인딩·resume·회전·recap·1회 재시도·정확히 1 종료·직렬화·상한·감사·oneShot·reset.
import type {
  AgentDriver,
  AgentErrorReason,
  AgentEvent,
  AgentRunRequest,
  DriverRequest,
} from '@finclaw/agent';
import type { FinClawLogger } from '@finclaw/infra';
import { createStorage, getAgentRun, type FinClawStorage } from '@finclaw/storage';
import { createAgentId, createSessionKey } from '@finclaw/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryCaptureService } from '../auto-reply/stages/memory-capture.js';
import type {
  MemoryRetrievalService,
  RetrievalResult,
} from '../auto-reply/stages/memory-retrieval.js';
import { AgentRuntime, type AgentRuntimeDeps } from './runtime.js';

const AGENT = createAgentId('default');
const T0 = Date.UTC(2026, 10, 26, 1, 0, 0);
const HOUR = 60 * 60_000;
const USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
  flush: vi.fn(),
} as unknown as FinClawLogger;

const cliId = (req: DriverRequest): string =>
  req.session.kind === 'none' ? 'ephemeral-session' : req.session.id;

function ok(req: DriverRequest, text = 'ok', middle: AgentEvent[] = []): AgentEvent[] {
  return [
    { type: 'start', runId: req.runId, cliSessionId: cliId(req), model: 'claude-sonnet-4-6' },
    ...middle,
    {
      type: 'done',
      runId: req.runId,
      cliSessionId: cliId(req),
      text,
      usage: USAGE,
      durationMs: 1,
      numTurns: 1,
    },
  ];
}

const err = (req: DriverRequest, reason: AgentErrorReason): AgentEvent[] => [
  { type: 'error', runId: req.runId, reason, message: reason },
];

function scripted(script: (req: DriverRequest, n: number) => AgentEvent[] | Promise<AgentEvent[]>) {
  const calls: DriverRequest[] = [];
  const driver: AgentDriver = async function* (req) {
    calls.push(req);
    for (const ev of await script(req, calls.length)) {
      yield ev;
    }
  };
  return { driver, calls };
}

function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of events) {
    out.push(ev);
  }
  return out;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const terminals = (events: AgentEvent[]) =>
  events.filter((e) => e.type === 'done' || e.type === 'error');
const sessionId = (req: DriverRequest | undefined): string | undefined =>
  req && req.session.kind !== 'none' ? req.session.id : undefined;

function retrievalOf(id: string, content: string): MemoryRetrievalService {
  const result: RetrievalResult = {
    snippets: [
      {
        id,
        content,
        type: 'preference',
        createdAt: T0 - HOUR,
        rawScore: 0.8,
        adjustedScore: 0.8,
        daysOld: 1,
      },
    ],
    transactions: [],
    mode: 'fts-only',
    auditLog: {
      event: 'memory.injected',
      sessionKey: 's1',
      userQuery: 'q',
      memoryIds: [id],
      rawScores: [0.8],
      adjustedScores: [0.8],
      mode: 'fts-only',
      transactionSymbols: [],
      timestamp: T0,
    },
  };
  return { searchRelevant: vi.fn().mockResolvedValue(result) };
}

let storage: FinClawStorage;
let clock: number;

beforeEach(() => {
  storage = createStorage({ dbPath: ':memory:', enableWAL: false });
  clock = T0;
});

afterEach(async () => {
  await storage.close();
});

function makeRuntime(driver: AgentDriver, overrides: Partial<AgentRuntimeDeps> = {}): AgentRuntime {
  return new AgentRuntime({
    driver,
    storage,
    db: storage.db,
    systemPrompt: 'SYS',
    defaultModel: 'claude-sonnet-4-6',
    mcp: { url: 'http://127.0.0.1:0/mcp', mintToken: (sk) => `jwt:${sk}` },
    logger,
    now: () => clock,
    ...overrides,
  });
}

function chat(key: string, input: string, extra: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    sessionKey: createSessionKey(key),
    agentId: AGENT,
    input,
    mode: 'chat',
    signal: new AbortController().signal,
    ...extra,
  };
}

describe('AgentRuntime — CLI 세션 바인딩', () => {
  it('첫 턴: new(선지정 uuid) + 바인딩·원문·응답 저장 + per-run JWT(sessionKey)', async () => {
    const { driver, calls } = scripted((req) => ok(req, '반가워'));
    const events = await collect(makeRuntime(driver).run(chat('s1', '안녕')));
    expect(calls[0]?.session.kind).toBe('new');
    expect(calls[0]?.mcp).toEqual({ url: 'http://127.0.0.1:0/mcp', token: 'jwt:s1' });
    expect(calls[0]).toMatchObject({
      maxTurns: 10,
      autocompact: true,
      idleTimeoutMs: 120_000,
      overallTimeoutMs: 300_000,
    });
    expect(terminals(events)).toEqual([expect.objectContaining({ type: 'done', text: '반가워' })]);
    const rec = await storage.getConversation(createSessionKey('s1'));
    expect(rec?.metadata).toEqual({ cliSessionId: sessionId(calls[0]), lastTurnAt: T0 });
    expect(rec?.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', '안녕'],
      ['assistant', '반가워'],
    ]);
  });

  it('B1 회귀: 2턴째는 같은 세션 resume 이고 prompt 에 <context>·배경지식이 들어간다', async () => {
    const { driver, calls } = scripted((req) => ok(req));
    const rt = makeRuntime(driver, {
      retrieval: retrievalOf('abcdef12-0000-4000-8000-000000000000', '나는 배당주를 선호한다'),
    });
    await collect(rt.run(chat('s1', '첫 질문')));
    clock += HOUR;
    await collect(rt.run(chat('s1', '내 투자 선호 알려줘')));
    expect(calls[1]?.session).toEqual({ kind: 'resume', id: sessionId(calls[0]) });
    expect(calls[1]?.prompt).toContain('<context>');
    expect(calls[1]?.prompt).toContain('## 사용자 배경지식 (자동 주입)');
    expect(calls[1]?.prompt).toContain('[mem:abcdef]');
    expect(calls[1]?.prompt).not.toContain('<recent_conversation>');
    expect(calls[1]?.prompt.endsWith('내 투자 선호 알려줘')).toBe(true);
  });

  it('6h 유휴 → 새 세션 + <recent_conversation> recap', async () => {
    const { driver, calls } = scripted((req, n) => ok(req, n === 1 ? '반가워 자두' : 'ok'));
    const rt = makeRuntime(driver);
    await collect(rt.run(chat('s1', '내 이름은 자두야')));
    clock += 6 * HOUR + 1;
    await collect(rt.run(chat('s1', '내 이름이 뭐지?')));
    expect(calls[1]?.session.kind).toBe('new');
    expect(sessionId(calls[1])).not.toBe(sessionId(calls[0]));
    expect(calls[1]?.prompt).toContain(
      '<recent_conversation>\n사용자: 내 이름은 자두야\nFinClaw: 반가워 자두\n</recent_conversation>',
    );
  });

  it('session_not_found → 새 세션 + recap 으로 1회 재시도, 종료 이벤트 1개, 바인딩 교체', async () => {
    const { driver, calls } = scripted((req, n) =>
      n === 2 ? err(req, 'session_not_found') : ok(req),
    );
    const rt = makeRuntime(driver);
    await collect(rt.run(chat('s1', '첫 질문')));
    const events = await collect(rt.run(chat('s1', '둘째 질문')));
    expect(calls.map((c) => c.session.kind)).toEqual(['new', 'resume', 'new']);
    expect(calls[2]?.prompt).toContain('<recent_conversation>');
    expect(terminals(events)).toEqual([expect.objectContaining({ type: 'done' })]);
    const rec = await storage.getConversation(createSessionKey('s1'));
    expect(rec?.metadata?.cliSessionId).toBe(sessionId(calls[2]));
  });

  it('session_not_found 가 아닌 reason 은 재시도하지 않는다', async () => {
    const { driver, calls } = scripted((req, n) => (n === 2 ? err(req, 'rate_limit') : ok(req)));
    const rt = makeRuntime(driver);
    await collect(rt.run(chat('s1', '첫 질문')));
    const events = await collect(rt.run(chat('s1', '둘째 질문')));
    expect(calls).toHaveLength(2);
    expect(terminals(events)).toEqual([
      expect.objectContaining({ type: 'error', reason: 'rate_limit' }),
    ]);
  });

  it('error 턴: 원문만 남기고, start 가 없었으면 바인딩은 그대로', async () => {
    const { driver, calls } = scripted((req, n) => (n === 2 ? err(req, 'spawn') : ok(req, 'a1')));
    const rt = makeRuntime(driver);
    await collect(rt.run(chat('s1', 'q1')));
    clock += HOUR;
    await collect(rt.run(chat('s1', 'q2')));
    const rec = await storage.getConversation(createSessionKey('s1'));
    expect(rec?.messages.map((m) => m.content)).toEqual(['q1', 'a1', 'q2']);
    expect(rec?.metadata).toEqual({ cliSessionId: sessionId(calls[0]), lastTurnAt: T0 });
  });
});

describe('AgentRuntime — 정확히 1 종료 (I11)', () => {
  it('드라이버 throw → error{unknown} 1개', async () => {
    const { driver } = scripted(() => {
      throw new Error('boom');
    });
    const events = await collect(makeRuntime(driver).run(chat('s1', 'q')));
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', reason: 'unknown', message: 'boom' }),
    ]);
  });

  it('이미 abort 된 signal → error{aborted}, 드라이버 호출 0', async () => {
    const { driver, calls } = scripted((req) => ok(req));
    const ac = new AbortController();
    ac.abort();
    const events = await collect(makeRuntime(driver).run(chat('s1', 'q', { signal: ac.signal })));
    expect(events).toEqual([expect.objectContaining({ type: 'error', reason: 'aborted' })]);
    expect(calls).toHaveLength(0);
  });

  it('전역 lane 대기 타임아웃 → error{timeout} 1개', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const g = gate();
    const { driver, calls } = scripted(async (req) => {
      await g.opened;
      return ok(req);
    });
    const rt = makeRuntime(driver);
    const a = collect(rt.run(chat('a', 'q')));
    const b = collect(rt.run(chat('b', 'q')));
    await settle();
    expect(calls).toHaveLength(2);
    const c = collect(rt.run(chat('c', 'q')));
    await settle();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(terminals(await c)).toEqual([
      expect.objectContaining({ type: 'error', reason: 'timeout' }),
    ]);
    g.open();
    await Promise.all([a, b]);
  });

  it('abortAll() → 진행 중 run 의 드라이버 signal 이 abort 된다', async () => {
    const { driver } = scripted(async (req) => {
      await new Promise((resolve) => req.signal.addEventListener('abort', resolve, { once: true }));
      return err(req, 'aborted');
    });
    const rt = makeRuntime(driver);
    const pending = collect(rt.run(chat('s1', 'q')));
    await settle();
    rt.abortAll();
    expect(terminals(await pending)).toEqual([expect.objectContaining({ reason: 'aborted' })]);
  });
});

describe('AgentRuntime — 동시성 (D6)', () => {
  it('같은 sessionKey 는 직렬화된다 (둘째는 첫째의 바인딩으로 resume)', async () => {
    const g = gate();
    const { driver, calls } = scripted(async (req) => {
      await g.opened;
      return ok(req);
    });
    const rt = makeRuntime(driver);
    const first = collect(rt.run(chat('s1', 'q1')));
    const second = collect(rt.run(chat('s1', 'q2')));
    await settle();
    expect(calls).toHaveLength(1);
    g.open();
    await Promise.all([first, second]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.session).toEqual({ kind: 'resume', id: sessionId(calls[0]) });
  });

  it('전역 상한 2 — 3번째는 앞 run 이 끝날 때까지 대기', async () => {
    const g = gate();
    const { driver, calls } = scripted(async (req) => {
      await g.opened;
      return ok(req);
    });
    const rt = makeRuntime(driver);
    const runs = ['a', 'b', 'c'].map((k) => collect(rt.run(chat(k, 'q'))));
    await settle();
    expect(calls).toHaveLength(2);
    g.open();
    await Promise.all(runs);
    expect(calls).toHaveLength(3);
  });

  it('Q14: reset 은 진행 중 run 의 종료 기록 뒤에 실행되어 바인딩이 되살아나지 않는다', async () => {
    const g = gate();
    const { driver } = scripted(async (req) => {
      await g.opened;
      return ok(req);
    });
    const rt = makeRuntime(driver);
    const run = collect(rt.run(chat('s1', 'q')));
    await settle();
    const reset = rt.reset(createSessionKey('s1'));
    await settle();
    g.open();
    await run;
    expect(await reset).toBe(true); // run 이 만든 행을 지웠다 = run 뒤에 실행됨
    expect(await storage.getConversation(createSessionKey('s1'))).toBeNull();
  });
});

describe('AgentRuntime — 감사 · oneShot', () => {
  it('agent_runs 1행(id=runId·tool_calls·used_memory_ids·cli_session_id)이 종료 이벤트 yield 전에 존재', async () => {
    const memId = 'abcdef12-0000-4000-8000-000000000000';
    const { driver, calls } = scripted((req) =>
      ok(req, '선호는 배당주 [mem:abcdef]', [
        {
          type: 'tool_use',
          id: 't1',
          name: 'mcp__finclaw__route_task',
          input: { intent: 'price_lookup' },
        },
        { type: 'tool_result', id: 't1', isError: false },
      ]),
    );
    const rt = makeRuntime(driver, { retrieval: retrievalOf(memId, '나는 배당주를 선호한다') });
    let checked = false;
    for await (const ev of rt.run(chat('s1', 'q', { runId: 'run-xyz' }))) {
      if (ev.type === 'done') {
        const row = getAgentRun(storage.db, 'run-xyz');
        expect(row).not.toBeNull();
        expect(JSON.parse(row?.toolCalls ?? '[]')).toEqual([
          {
            id: 't1',
            name: 'mcp__finclaw__route_task',
            input: { intent: 'price_lookup' },
            isError: false,
          },
        ]);
        expect(row?.usedMemoryIds).toEqual([memId]);
        expect(row?.cliSessionId).toBe(sessionId(calls[0]));
        expect(row?.tokensInput).toBe(10);
        expect(ev.usedMemoryIds).toEqual([memId]);
        checked = true;
      }
    }
    expect(checked).toBe(true);
    const count = storage.db.prepare('SELECT COUNT(*) AS c FROM agent_runs').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('capture 결과가 done.captured 로 붙는다', async () => {
    const captured = {
      memoryId: 'm-1',
      type: 'preference' as const,
      content: '배당주',
      duplicate: false,
    };
    const capture: MemoryCaptureService = { capture: vi.fn().mockResolvedValue(captured) };
    const { driver } = scripted((req) => ok(req));
    const events = await collect(makeRuntime(driver, { capture }).run(chat('s1', '선호: 배당주')));
    expect(events.at(-1)).toMatchObject({ type: 'done', captured });
  });

  it('oneShot: 대화 조회·저장 0, session none, <context> 시각만, autocompact 없음, MCP 는 붙음', async () => {
    const get = vi.spyOn(storage, 'getConversation');
    const upsert = vi.spyOn(storage, 'upsertConversation');
    const capture: MemoryCaptureService = { capture: vi.fn() };
    const retrieval = retrievalOf('abcdef12-0000-4000-8000-000000000000', 'x');
    const { driver, calls } = scripted((req) => ok(req, '리포트'));
    const events = await collect(
      makeRuntime(driver, { capture, retrieval }).run({
        sessionKey: createSessionKey('schedule-1-abc'),
        agentId: AGENT,
        input: '오늘 시장 요약',
        mode: 'oneShot',
        signal: new AbortController().signal,
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: 'done', text: '리포트' });
    expect(calls[0]?.session).toEqual({ kind: 'none' });
    expect(calls[0]?.prompt).toBe(
      '<context>\n현재 시각: 2026-11-26T10:00:00+09:00 (Asia/Seoul)\n</context>\n\n오늘 시장 요약',
    );
    expect(calls[0]?.autocompact).toBe(false);
    expect(calls[0]?.mcp?.token).toBe('jwt:schedule-1-abc');
    expect(get).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(capture.capture).not.toHaveBeenCalled();
    expect(retrieval.searchRelevant).not.toHaveBeenCalled();
  });
});
```

### M2-7. 밀스톤 M2 검증

```bash
pnpm format:fix && pnpm build && pnpm typecheck && pnpm lint && pnpm format && pnpm test && pnpm test:storage
pnpm vitest run packages/server/src/agent-runtime
pnpm test:storage -- packages/storage/src/agent-runs.storage.test.ts
```

- unit +≈25 (runtime 16 · prepare-turn 8), storage +1 (141). 실패 0.
- 배선 0 확인: `rg -n "AgentRuntime|createCliDriver" packages/*/src --glob '!**/agent-runtime/**' --glob '!**/runtime/**'` → index.ts export 외 0.

### M2-8. 커밋

```
feat(phase46): add AgentRuntime with per-session CLI sessions

Every channel shares one process-wide CLI session today, so from the second
turn the RAG block composed into the system prompt is dropped on resume (B1).
Introduce a runtime that binds sessionKey -> CLI session uuid in
conversations.metadata (no migration), rotates after 6h idle with a recap,
retries once only on session_not_found, injects time/recall as a user-side
<context> block, serializes per session, caps top-level runs at 2 and writes
one agent_runs row before the terminal event. Not wired yet.

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
```

---

## 밀스톤 M3 — Discord·서브에이전트를 runtime 으로

목적: Discord pipeline 과 route_task 서브에이전트를 새 체인으로. Web/TUI·cron·agent.run 은 옛 체인 그대로(공존 표 §1).

### M3-1. EDIT `packages/types/src/router.ts` — Dispatcher 에 signal (D2)

```ts
// before
export type Dispatcher = (req: RouteRequest) => Promise<RouteResult>;
// after
/** D2: signal = registry 가 timeout·외부 abort 를 합친 ctx.abortSignal — 서브에이전트 spawn 까지 전달. */
export type Dispatcher = (req: RouteRequest, signal?: AbortSignal) => Promise<RouteResult>;
```

### M3-2. EDIT `packages/skills-general/src/route-task.ts` — executor 가 `ctx.abortSignal` 전달

```ts
  // before: const executor: ToolExecutor = async (input) => {
  const executor: ToolExecutor = async (input, ctx) => {
    // ... intent/query/symbol 검증 그대로 ...
    try {
      const result = await dispatcher({ intent, query, symbol }, ctx.abortSignal);
      // ... 그대로 ...
```

`timeoutMs: 90_000` 은 그대로(Q13 "route_task 90s 현행 유지").

### M3-3. EDIT `packages/skills-finance/src/news/analysis/market-analysis.ts` — 고아 `timeoutMs` 제거 (§3-5)

dispatch 가 더 이상 읽지 않는다(서브 타임아웃은 driver 45s/75s 상수).

```ts
export interface AnalyzeRunnerRequest {
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly modelId: string;
  // 삭제: readonly timeoutMs?: number;
}
// ...
const result = await runAnalysis({
  systemPrompt,
  prompt: userPrompt,
  modelId: modelRef.model,
  // 삭제: timeoutMs: 30_000,
});
```

### M3-4. EDIT `packages/server/src/router/sub-agent.ts` — 드라이버 1-shot (전체 교체)

N1: 내장 도구 0(`--tools ""` — 드라이버가 강제)·MCP 없음·비영속. 상한(Q7) 밖 — runtime 을 거치지 않고 드라이버 직접 호출(교착 방지).

```ts
// packages/server/src/router/sub-agent.ts
// Phase 46 M3: route_task 서브에이전트 = 드라이버 동기 1-shot. 격리 argv 는 드라이버가 강제(N1),
// MCP 없음·--no-session-persistence. 전역 상한 밖(최상위 run 이 슬롯을 쥔 채 기다리므로 포함하면 교착 — Q7).
import { randomUUID } from 'node:crypto';
import type { AgentDriver } from '@finclaw/agent';

export interface SubAgentRequest {
  readonly systemPrompt: string;
  readonly query: string;
  readonly modelId?: string;
}

export interface SubAgentResponse {
  readonly text: string;
}

const DEFAULT_SUB_AGENT_MODEL = 'claude-opus-4-7';
/** Q13: 서브 무출력 45s / overall 75s < route_task 90s < 메인 무출력 120s. */
const SUB_IDLE_TIMEOUT_MS = 45_000;
const SUB_OVERALL_TIMEOUT_MS = 75_000;

export async function runSubAgent(
  driver: AgentDriver,
  req: SubAgentRequest,
  signal?: AbortSignal,
): Promise<SubAgentResponse> {
  for await (const ev of driver({
    runId: randomUUID(),
    prompt: req.query,
    systemPrompt: req.systemPrompt,
    model: req.modelId ?? DEFAULT_SUB_AGENT_MODEL,
    session: { kind: 'none' },
    idleTimeoutMs: SUB_IDLE_TIMEOUT_MS,
    overallTimeoutMs: SUB_OVERALL_TIMEOUT_MS,
    signal: signal ?? new AbortController().signal,
  })) {
    if (ev.type === 'done') {
      return { text: ev.text };
    }
    if (ev.type === 'error') {
      throw new Error(`sub-agent ${ev.reason}: ${ev.message}`);
    }
  }
  throw new Error('sub-agent ended without result');
}
```

### M3-5. EDIT `packages/server/src/router/dispatch.ts` — `DispatcherDeps.driver` + signal 전달

```ts
import type { AgentDriver } from '@finclaw/agent';
// ... 기존 import ...

export interface DispatcherDeps {
  readonly quoteService: QuoteService;
  readonly chartService: ChartService;
  readonly newsAggregator?: NewsAggregator;
  readonly portfolioStore?: PortfolioStore;
  /** Phase 46: market_analysis 서브에이전트 1-shot 드라이버. */
  readonly driver: AgentDriver;
}

// 삭제: const ANALYSIS_QUEUE_KEY = 'claude-sub-agent-analysis';  (enqueueCliRun 큐 키 — 고아)

export function buildRouteDispatcher(deps: DispatcherDeps): Dispatcher {
  // ... 프로필 로드 그대로 ...
  return async (req: RouteRequest, signal?: AbortSignal): Promise<RouteResult> => {
    switch (req.intent) {
      case 'market_analysis':
        return dispatchMarketAnalysis(req, deps, marketAnalysisProfile, signal);
      // ... 나머지 case 그대로 ...
    }
  };
}

async function dispatchMarketAnalysis(
  req: RouteRequest,
  deps: DispatcherDeps,
  profile: AgentProfile,
  signal?: AbortSignal,
): Promise<RouteResult> {
  // ... news 조회 그대로 ...
  try {
    const analysis = await analyzeMarket(
      async (runReq) =>
        runSubAgent(
          deps.driver,
          { systemPrompt: runReq.systemPrompt, query: runReq.prompt, modelId: runReq.modelId },
          signal,
        ),
      news,
      options,
      profile.model,
    );
    // ... 그대로 ...
```

### M3-6. EDIT `packages/server/src/auto-reply/stages/execute.ts` — runtime 끝까지 소비 (전체 교체)

```ts
import type { AgentEvent, AgentRunPort } from '@finclaw/agent';
import { createAgentId } from '@finclaw/types';
import { extractControlTokens, type ControlTokenResult } from '../control-tokens.js';
// packages/server/src/auto-reply/stages/execute.ts
import type { PipelineMsgContext } from '../pipeline-context.js';
import type { StageResult } from '../pipeline.js';

/** 구 RunnerExecutionAdapter.defaultAgentId 와 동일. */
const DISCORD_AGENT_ID = createAgentId('default');

type TerminalEvent = Extract<AgentEvent, { type: 'done' | 'error' }>;

export interface ExecuteStageResult {
  readonly content: string;
  readonly controlTokens: ControlTokenResult;
  readonly usage?: { inputTokens: number; outputTokens: number };
  /** Phase 46: runtime prepareTurn 의 capture 결과 → deliver 꼬리표 (deliver.ts:40-46 계약 유지). */
  readonly captured?: PipelineMsgContext['capturedMemory'];
}

/**
 * AI 실행 단계 — AgentRuntime 을 mode:'chat' 으로 끝까지 소비해 done.text 에 제어 토큰 후처리.
 * (capture·retrieval·시각 주입은 runtime.prepareTurn 이 소유.)
 */
export async function executeStage(
  ctx: PipelineMsgContext,
  runtime: AgentRunPort,
  signal: AbortSignal,
): Promise<StageResult<ExecuteStageResult>> {
  let terminal: TerminalEvent | undefined;
  for await (const ev of runtime.run({
    sessionKey: ctx.sessionKey,
    agentId: DISCORD_AGENT_ID,
    input: ctx.normalizedBody,
    mode: 'chat',
    signal,
  })) {
    if (ev.type === 'done' || ev.type === 'error') {
      terminal = ev;
    }
  }

  if (terminal?.type !== 'done') {
    // M7 에서 reason 별 고정 한국어 문구 전송으로 바뀐다 (Q10).
    return {
      action: 'abort',
      reason: terminal ? `agent ${terminal.reason}` : 'agent ended without result',
    };
  }

  const tokenResult = extractControlTokens(terminal.text);
  if (tokenResult.hasNoReply) {
    return { action: 'skip', reason: 'AI decided not to reply (NO_REPLY token)' };
  }

  return {
    action: 'continue',
    data: {
      content: tokenResult.cleanContent,
      controlTokens: tokenResult,
      usage: { inputTokens: terminal.usage.input, outputTokens: terminal.usage.output },
      captured: terminal.captured,
    },
  };
}
```

### M3-7. EDIT `packages/server/src/auto-reply/pipeline.ts` — capture(2.5)·retrieval(4.5) 제거, runtime 주입

(a) import — 삭제: `TraceContext`(rerank 로그용 rootTraceContext 고아), `ExecutionAdapter`, `memoryCaptureStage`/`MemoryCaptureResult`/`MemoryCaptureService`, `MemoryRetrievalService`. 추가:

```ts
import type { AgentRunPort } from '@finclaw/agent';
import type { ChannelPlugin, MsgContext } from '@finclaw/types';
```

(b) `PipelineDependencies`:

```ts
export interface PipelineDependencies {
  /** Phase 46: 실행은 AgentRuntime (capture·retrieval 은 runtime.prepareTurn 소유 — D4). */
  readonly runtime: AgentRunPort;
  readonly commandRegistry: CommandRegistry;
  readonly logger: FinClawLogger;
  readonly getChannel: (
    channelId: string,
  ) => Pick<ChannelPlugin, 'send' | 'sendTyping'> | undefined;
  /** Phase 30 A6: 옵셔널 OTel tracer — 주입 시 각 stage 가 span 으로 묶임. */
  readonly tracer?: FinclawTracer;
}
```

클래스 doc 의 데이터 흐름 주석은 `-> [execute] -> ExecuteResult (via AgentRuntime)` 로 1줄 수정.

(c) `runPipeline` 앞부분 — `rootTraceContext` 삭제, `stageSpan` 단순화:

```ts
  private async runPipeline(ctx: MsgContext): Promise<void> {
    const tracer = this.deps.tracer;

    // 파이프라인 타임아웃
    const combinedSignal = AbortSignal.timeout(this.config.timeoutMs);

    // tracer 미주입 환경 (test 등) 은 fn 을 그대로 실행 — 의미적 동등.
    const stageSpan = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      if (!tracer) {
        return fn();
      }
      return tracer.withSpan(`stage.${name}`, { sessionKey: ctx.sessionKey }, async () => fn());
    };
```

(d) `// Stage 2.5: Memory Capture` 블록 전체 삭제(`let capturedMemory ... }` 까지).

(e) Stage 4 이후 — `let enrichedCtx = capturedMemory ? {...} : ctxResult.data;` 와 `// Stage 4.5: Memory Retrieval` 블록 전체를 아래로 교체:

```ts
const enrichedCtx = ctxResult.data;
```

(f) Stage 5·6:

```ts
// Stage 5: Execute
if (combinedSignal.aborted) {
  typing?.seal();
  this.logAbort('execute');
  return;
}
const execResult = await stageSpan('execute', async () =>
  executeStage(enrichedCtx, this.deps.runtime, combinedSignal),
);

if (execResult.action !== 'continue') {
  typing?.seal();
  return;
}

// Stage 6: Deliver — capture 꼬리표는 done.captured 로 돌아온다 (D4)
typing?.seal();
if (combinedSignal.aborted) {
  this.logAbort('deliver');
  return;
}
const deliverCtx = execResult.data.captured
  ? { ...enrichedCtx, capturedMemory: execResult.data.captured }
  : enrichedCtx;
await stageSpan('deliver', async () =>
  deliverResponse(execResult.data, deliverCtx, channel ?? noopChannel, this.deps.logger),
);
```

`PipelineMsgContext.retrievalResult` 필드는 M5 까지 남긴다(옛 `execution-adapter.execute` 가 아직 읽음 — 이제 아무도 채우지 않음).

### M3-8. EDIT `packages/server/prompts/finclaw.system.ko.md` — 규칙 6

```md
6. **회상 인용.** user 메시지 앞 `<context>` 블록의 "사용자 배경지식 (자동 주입)" 섹션에서 회상한 사실을 인용하면 해당 문장 끝에 `[mem:xxxxxx]` (회상된 마커 그대로 복사). 거래 인용은 `[txn:...]`. 추측이나 일반 지식은 인용하지 마라. 복수 인용은 `[mem:aaa,bbb]`. 대화에 `<context>` 가 여러 번 보이면 가장 최근 `<context>` 가 정본이다.
```

(`**/prompts/` 는 oxfmt 무시 대상.)

### M3-9. EDIT `packages/server/src/composition/skills.ts` — driver 전달

```ts
import type { AgentDriver, InMemoryToolRegistry } from '@finclaw/agent';

export interface RegisterSkillsDeps {
  readonly toolRegistry: InMemoryToolRegistry;
  readonly storage: Storage;
  readonly logger: FinClawLogger;
  readonly discordAdapter: DiscordAdapter;
  readonly lifecycle: ProcessLifecycle;
  /** Phase 46 M3: route_task market_analysis 서브에이전트 1-shot. */
  readonly driver: AgentDriver;
}

export async function registerSkills(deps: RegisterSkillsDeps): Promise<SkillsBundle> {
  const { toolRegistry, storage, logger, discordAdapter, lifecycle, driver } = deps;
  // ...
    const dispatcher = buildRouteDispatcher({
      quoteService: marketHandle.quoteService,
      chartService: marketHandle.chartService,
      newsAggregator: newsHandle?.aggregator,
      portfolioStore: newsHandle?.portfolioStore,
      driver,
    });
```

### M3-10. EDIT `packages/server/src/composition/runtime.ts` — runtime 조립, memory wiring 을 buildExecution 으로 이동

runtime 이 capture/retrieval 을 소유하므로 `wireMemoryServices` 호출을 `buildPipeline` → `buildExecution` 으로 옮긴다(순수 이동 + runtime 생성). `runnerFactory`/`adapter` 는 Web/TUI·cron·agent.run 이 M4 까지 쓴다.

```ts
import {
  InMemoryToolRegistry,
  ProfileHealthMonitor,
  Runner,
  type AgentDriver,
  type AgentRunPort,
  type ProviderAdapter,
  type RunnerFactory,
  type RunnerTracerAdapter,
} from '@finclaw/agent';
import { signToken } from '@finclaw/gateway';
// ... 기존 import 그대로 + ...
import type { ChannelPlugin, FinClawConfig, ModelRef, Schedule } from '@finclaw/types';
import { AgentRuntime } from '../agent-runtime/runtime.js';

/** [TQ3] N7: Discord pipeline 타임아웃 > 메인 overall 300s — runtime 의 timeout 분류(고정 문구)가 먼저 나도록. */
const PIPELINE_TIMEOUT_MS = 330_000;

export interface BuildExecutionDeps {
  readonly storage: Storage;
  readonly providerAdapter: ProviderAdapter;
  readonly lanes: ConcurrencyLaneManager;
  readonly profileHealth: ProfileHealthMonitor;
  readonly logger: FinClawLogger;
  readonly defaultModel: ModelRef;
  readonly systemPrompt: string;
  /** Phase 46 M3 */
  readonly driver: AgentDriver;
  readonly embeddingProvider: EmbeddingProvider | undefined;
  readonly finclawConfig: FinClawConfig;
  /** per-run JWT mint 용 (/mcp 와 같은 secret). */
  readonly mcp: { readonly url: string; readonly jwtSecret: string };
}

export interface ExecutionBundle {
  readonly tracer: Tracer;
  readonly runnerFactory: RunnerFactory; // M5 삭제
  readonly adapter: RunnerExecutionAdapter; // M5 삭제
  readonly runtime: AgentRuntime;
  readonly attachMemoryService: DefaultAttachMemoryService;
}

export function buildExecution(deps: BuildExecutionDeps): ExecutionBundle {
  const {
    storage,
    providerAdapter,
    lanes,
    profileHealth,
    logger,
    defaultModel,
    systemPrompt,
    driver,
    embeddingProvider,
    finclawConfig,
    mcp,
  } = deps;

  // ... tracer / tracerAdapter / runnerFactory / adapter 기존 그대로 ...

  // Phase 26 B/C/D + Phase 30 D5 (buildPipeline 에서 이동): capture / retrieval / attach 3 service.
  const rerankCfg = finclawConfig.rag?.rerank;
  const rerankEnabled = rerankCfg?.enabled !== false;
  const reranker = rerankEnabled ? createRerankerWithFallback(new LocalReranker()) : undefined;
  const { memoryCaptureService, memoryRetrievalService, attachMemoryService } = wireMemoryServices(
    { db: storage.db, embeddingProvider, logger },
    { reranker, rerankTopKFirst: rerankCfg?.topKFirst },
  );

  // Phase 46 M3: 채널 무관 런타임 — Discord(pipeline) 부터 사용. M4 에서 chat·cron·agent.run 도 합류.
  const runtime = new AgentRuntime({
    driver,
    storage,
    db: storage.db,
    systemPrompt,
    defaultModel: defaultModel.model,
    mcp: {
      url: mcp.url,
      // N3: 도구 ctx.sessionId = sessionKey (bridge identity)
      mintToken: (sessionKey) =>
        signToken({ sub: 'finclaw', sessionId: sessionKey }, mcp.jwtSecret),
    },
    capture: memoryCaptureService,
    retrieval: memoryRetrievalService,
    profileHealth,
    tracer,
    logger,
  });

  return { tracer, runnerFactory, adapter, runtime, attachMemoryService };
}

export interface BuildPipelineDeps {
  readonly runtime: AgentRunPort;
  readonly toolRegistry: InMemoryToolRegistry;
  readonly storage: Storage;
  readonly profileHealth: ProfileHealthMonitor;
  readonly marketHandle: MarketSkillHandle | undefined;
  readonly newsHandle: NewsSkillHandle | undefined;
  readonly tracer: Tracer;
  readonly logger: FinClawLogger;
  readonly defaultModel: ModelRef;
  readonly channelPluginRegistry: Map<string, ChannelPlugin>;
}

export interface PipelineBundle {
  readonly pipeline: AutoReplyPipeline;
}

export function buildPipeline(deps: BuildPipelineDeps): PipelineBundle {
  const {
    runtime,
    toolRegistry,
    storage,
    profileHealth,
    marketHandle,
    newsHandle,
    tracer,
    logger,
    defaultModel,
    channelPluginRegistry,
  } = deps;

  // 5. 파이프라인
  const commandRegistry = new InMemoryCommandRegistry();
  registerBuiltInCommands(commandRegistry, {
    toolRegistry,
    storage,
    profileHealth,
    profileId: 'default',
    defaultModel,
    marketHandle,
    newsHandle,
  });

  const pipeline = new AutoReplyPipeline(
    {
      commandPrefix: '!finclaw ',
      timeoutMs: PIPELINE_TIMEOUT_MS,
    },
    {
      runtime,
      commandRegistry,
      logger,
      getChannel: (id) => channelPluginRegistry.get(id),
      tracer,
    },
  );

  return { pipeline };
}
```

`buildPipeline` 에서 rerank/wireMemoryServices 코드와 `embeddingProvider`·`finclawConfig` deps, `PipelineBundle.attachMemoryService` 를 제거(이동). `DefaultAttachMemoryService` 는 타입으로 계속 import.

### M3-11. EDIT `packages/server/src/main.ts` — driver·runtime 조립, `claude --version` 로그, abortAll

```ts
import { execFile } from 'node:child_process'; // 추가 (homedir·join 은 이미 import 돼 있음)
import { createCliDriver, ProfileHealthMonitor } from '@finclaw/agent'; // createCliDriver 추가
```

`// 4a. 프로필 건강 모니터.` 바로 다음(=`registerSkills` 전 — 서브에이전트 dispatcher 가 driver 를 필요로 함)에 추가:

```ts
// Phase 46 M3: stream-json 드라이버 (격리 cwd 고정, Q12). 버전 로그는 스키마 drift(R1) 추적용 — 실패해도 부팅 계속.
const cliCommand = finclawConfig.cliBackend?.command ?? 'claude';
const driver = createCliDriver({
  command: cliCommand,
  cwd: join(homedir(), '.finclaw', 'agent'),
  logger,
});
execFile(cliCommand, ['--version'], { timeout: 10_000 }, (err, stdout) => {
  if (err) {
    logger.warn('cli.version_unavailable', {
      event: 'cli.version_unavailable',
      error: err.message,
    });
    return;
  }
  logger.info('cli.version', { event: 'cli.version', version: stdout.trim() });
});
```

호출부:

```ts
const { marketHandle, newsHandle, alertHandle, brokerageSyncService, kisEnv } =
  await registerSkills({ toolRegistry, storage, logger, discordAdapter, lifecycle, driver });

const { tracer, runnerFactory, adapter, runtime, attachMemoryService } = buildExecution({
  storage,
  providerAdapter,
  lanes,
  profileHealth,
  logger,
  defaultModel: DEFAULT_MODEL,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  driver,
  embeddingProvider,
  finclawConfig,
  mcp: {
    url: `http://127.0.0.1:${gatewayPort}/mcp`,
    jwtSecret: defaultConfig.auth.jwtSecret, // M10 에서 resolveJwtSecret() 로 교체
  },
});
lifecycle.register(() => runtime.abortAll());

const channelPluginRegistry = new Map<string, ChannelPlugin>();
const { pipeline } = buildPipeline({
  runtime,
  toolRegistry,
  storage,
  profileHealth,
  marketHandle,
  newsHandle,
  tracer,
  logger,
  defaultModel: DEFAULT_MODEL,
  channelPluginRegistry,
});
```

나머지(`runnerFactory`·`adapter`·`attachMemoryService` 를 gateway/automation 에 넘기는 부분)는 그대로 — 이제 `attachMemoryService` 의 출처만 buildExecution.

### M3-12. EDIT `packages/server/src/auto-reply/__tests__/pipeline.test.ts` — runtime fake

`ExecutionAdapter`/`PipelineMsgContext`/`MemoryRetrievalService` import 삭제. 헬퍼 교체:

```ts
import type { AgentEvent, AgentRunPort, AgentRunRequest } from '@finclaw/agent';

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function fakeRuntime(
  text: string,
  extra: Partial<Extract<AgentEvent, { type: 'done' }>> = {},
): AgentRunPort & { calls: AgentRunRequest[] } {
  const calls: AgentRunRequest[] = [];
  return {
    calls,
    async *run(req) {
      calls.push(req);
      yield {
        type: 'done',
        runId: 'r1',
        cliSessionId: 'c1',
        text,
        usage: ZERO,
        durationMs: 1,
        numTurns: 1,
        ...extra,
      };
    },
    reset: async () => false,
  };
}

function errorRuntime(
  reason: 'auth' | 'rate_limit' | 'timeout' | 'aborted' | 'unknown',
  message = 'raw stderr: token=secret',
): AgentRunPort {
  return {
    async *run(req) {
      yield { type: 'error', runId: req.runId ?? 'r1', reason, message };
    },
    reset: async () => false,
  };
}
```

`makeDeps` 의 `executionAdapter: mockAdapter('AI response')` → `runtime: fakeRuntime('AI response')`. 기존 케이스 매핑:

- `adapter.execute` 호출 단언 → `runtime.calls.length` 단언. 첫 케이스에 `expect(runtime.calls[0]).toMatchObject({ mode: 'chat', input: 'hello finclaw', sessionKey: 'test-session' })` 추가.
- NO_REPLY / SILENT_REPLY / 채널 없음: `fakeRuntime(CONTROL_TOKENS.NO_REPLY)` 등으로 그대로.
- 타임아웃 케이스: `runtime: { async *run() { await new Promise((r) => setTimeout(r, 30)); yield { type: 'done', runId: 'r', cliSessionId: 'c', text: 'late', usage: ZERO, durationMs: 1, numTurns: 1 }; }, reset: async () => false }`.
- `'ExecutionAdapter 에러 시 예외를 전파한다'` → `'runtime error 이벤트면 아무것도 전송하지 않는다 (M7 에서 고정 문구)'`: `errorRuntime('unknown')` → `channel.send` 미호출, `pipeline.process` 는 resolve.
- `describe('AutoReplyPipeline + MemoryRetrieval (Phase 26 C)')` 3케이스 **삭제** — retrieval 은 runtime 소관(→ `runtime.test.ts`·`prepare-turn.test.ts` 가 대체). `makeRetrievalResult` 헬퍼도 삭제.
- 신규 1케이스:

```ts
it('done.captured 가 있으면 deliver 가 기억 꼬리표를 붙인다', async () => {
  const channel = makeChannel();
  const runtime = fakeRuntime('네', {
    captured: { memoryId: 'abcdef1234', type: 'fact', content: '나는 자두', duplicate: false },
  });
  const pipeline = new AutoReplyPipeline(
    makeConfig(),
    makeDeps({ runtime, getChannel: () => channel }),
  );
  await pipeline.process(makeCtx({ body: '기억해: 나는 자두' }));
  expect(channel.send).toHaveBeenCalledWith(
    expect.objectContaining({
      payloads: [
        expect.objectContaining({
          text: expect.stringContaining('_기억했습니다 (fact, #abcdef12)_'),
        }),
      ],
    }),
  );
});
```

### M3-13. EDIT `packages/server/src/auto-reply/__tests__/trace.e2e.storage.test.ts`

```ts
      {
        runtime: {
          async *run() {
            yield {
              type: 'done',
              runId: 'r1',
              cliSessionId: 'c1',
              text: 'AI response',
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              durationMs: 1,
              numTurns: 1,
            };
          },
          reset: async () => false,
        },
        commandRegistry: new InMemoryCommandRegistry(),
        // ... 그대로 ...
```

(span 단언은 그대로 — memory-capture/retrieval span 은 원래 이 테스트에 없음.)

### M3-14. EDIT `packages/server/src/router/dispatch.test.ts` — `driver` dep + D2 케이스

```ts
import type { AgentDriver, DriverRequest } from '@finclaw/agent';
import type { NewsItem, Portfolio } from '@finclaw/types';

const idleDriver: AgentDriver = async function* (req) {
  yield { type: 'error', runId: req.runId, reason: 'unknown', message: 'not used' };
};

const deps: DispatcherDeps = {
  newsAggregator,
  quoteService,
  chartService,
  portfolioStore,
  driver: idleDriver,
};
// marketOnly 도: const marketOnly: DispatcherDeps = { quoteService, chartService, driver: idleDriver };

describe('route_task dispatcher — market_analysis 서브에이전트 (D2)', () => {
  it('dispatcher 의 signal 이 서브에이전트 드라이버까지 전달된다', async () => {
    const seen: DriverRequest[] = [];
    const driver: AgentDriver = async function* (req) {
      seen.push(req);
      yield { type: 'error', runId: req.runId, reason: 'aborted', message: 'aborted' };
    };
    const news = [
      { title: 't', source: 's', publishedAt: '2026-11-26', summary: 'x' },
    ] as unknown as NewsItem[];
    const ac = new AbortController();
    ac.abort();
    const r = await buildRouteDispatcher({
      ...deps,
      driver,
      newsAggregator: { fetchNews: async () => news },
    })({ intent: 'market_analysis', query: 'x' }, ac.signal);
    expect(seen[0]?.signal.aborted).toBe(true);
    expect(seen[0]?.session).toEqual({ kind: 'none' });
    expect(r.isError).toBe(true);
  });
});
```

### M3-15. CREATE `packages/server/src/router/sub-agent.test.ts` — N1

```ts
// packages/server/src/router/sub-agent.test.ts
// Phase 46 M3: 서브에이전트 1-shot 격리 (N1) — MCP 없음·비영속·내장 도구 0·무승인 플래그 없음.
import {
  buildCliArgs,
  type AgentDriver,
  type AgentEvent,
  type DriverRequest,
} from '@finclaw/agent';
import { describe, expect, it } from 'vitest';
import { runSubAgent } from './sub-agent.js';

function fake(events: (req: DriverRequest) => AgentEvent[]) {
  const calls: DriverRequest[] = [];
  const driver: AgentDriver = async function* (req) {
    calls.push(req);
    for (const ev of events(req)) {
      yield ev;
    }
  };
  return { driver, calls };
}

const done = (req: DriverRequest, text: string): AgentEvent => ({
  type: 'done',
  runId: req.runId,
  cliSessionId: 'x',
  text,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  durationMs: 1,
  numTurns: 1,
});

describe('runSubAgent', () => {
  it('N1: session none · MCP 없음 · maxTurns 없음 · 45s/75s, argv 에 --tools "" + --no-session-persistence', async () => {
    const { driver, calls } = fake((req) => [done(req, '{"ok":1}')]);
    const res = await runSubAgent(driver, {
      systemPrompt: 'ANALYST',
      query: 'Analyze',
      modelId: 'claude-opus-4-7',
    });
    expect(res.text).toBe('{"ok":1}');
    const req = calls[0];
    expect(req?.session).toEqual({ kind: 'none' });
    expect(req?.mcp).toBeUndefined();
    expect(req?.maxTurns).toBeUndefined();
    expect(req?.idleTimeoutMs).toBe(45_000);
    expect(req?.overallTimeoutMs).toBe(75_000);
    const args = buildCliArgs(req as DriverRequest);
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--no-session-persistence');
    for (const banned of [
      '--mcp-config',
      '--allowedTools',
      '--dangerously-skip-permissions',
      '--append-system-prompt',
    ]) {
      expect(args).not.toContain(banned);
    }
  });

  it('error 이벤트면 reason 을 담아 throw', async () => {
    const { driver } = fake((req) => [
      { type: 'error', runId: req.runId, reason: 'timeout', message: 'idle' },
    ]);
    await expect(runSubAgent(driver, { systemPrompt: 's', query: 'q' })).rejects.toThrow(
      'sub-agent timeout',
    );
  });

  it('D2: 넘긴 signal 을 그대로 드라이버에 전달', async () => {
    const { driver, calls } = fake((req) => [done(req, 'x')]);
    const ac = new AbortController();
    await runSubAgent(driver, { systemPrompt: 's', query: 'q' }, ac.signal);
    expect(calls[0]?.signal).toBe(ac.signal);
  });
});
```

### M3-16. CREATE `packages/skills-general/src/route-task.test.ts` — executor → dispatcher signal (D2)

```ts
// packages/skills-general/src/route-task.test.ts
import type { RegisteredToolDefinition, ToolExecutor, ToolRegistry } from '@finclaw/agent';
import type { Dispatcher } from '@finclaw/types';
import { describe, expect, it, vi } from 'vitest';
import { registerRouteTaskTool } from './route-task.js';

describe('route_task executor', () => {
  it('D2: ctx.abortSignal 을 dispatcher 로 넘긴다', async () => {
    let executor: ToolExecutor | undefined;
    const registry = {
      register: (_def: RegisteredToolDefinition, exec: ToolExecutor) => {
        executor = exec;
      },
    } as unknown as ToolRegistry;
    const dispatcher = vi
      .fn<Dispatcher>()
      .mockResolvedValue({ content: 'ok', source: 'function', isError: false });
    registerRouteTaskTool(registry, dispatcher);
    const ac = new AbortController();
    await executor?.(
      { intent: 'price_lookup', query: 'AAPL 시세', symbol: 'AAPL' },
      { sessionId: 's', userId: 'u', channelId: 'mcp', abortSignal: ac.signal },
    );
    expect(dispatcher).toHaveBeenCalledWith(
      { intent: 'price_lookup', query: 'AAPL 시세', symbol: 'AAPL' },
      ac.signal,
    );
  });
});
```

### M3-17. 밀스톤 M3 검증

```bash
pnpm format:fix && pnpm build && pnpm typecheck && pnpm lint && pnpm format && pnpm test && pnpm test:storage
pnpm vitest run packages/server/src/auto-reply packages/server/src/router packages/skills-general
rg -n "runCliAgent" packages/server/src   # 0 (sub-agent 가 더 이상 쓰지 않음)
```

- pipeline: −3(retrieval wiring) +1(captured) 케이스, sub-agent +3, dispatch +1, route-task +1.
- 옛 경로 green: `packages/server/src/auto-reply/__tests__/execution-adapter.test.ts`·`packages/agent/test/**` 는 그대로 통과해야 한다(삭제는 M5).
- 수동(선택, 실 CLI·Discord 토큰 있을 때): Discord DM 1턴 → `agent_runs` 최신 행의 `cli_session_id` 채워짐(N5). 다음 턴 같은 `cli_session_id`.

### M3-18. 커밋

```
refactor(phase46): route Discord and sub-agent through AgentRuntime

Discord turns now go through the runtime, so the second turn resumes the
right CLI session and still receives the recall block, and each turn leaves
an agent_runs row with cited memory ids (B1, N5). The market_analysis
sub-agent is spawned through the driver as an isolated one-shot with no
built-in tools and no MCP, instead of --dangerously-skip-permissions (N1),
and the route_task abort signal now reaches it (D2). Web/TUI, cron and
agent.run still use the Runner chain until the next commit.

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
```

---

## 밀스톤 M4 — chat·scheduler·agent.run 을 runtime 으로

목적: 나머지 3 경로 이전. 이 커밋 후 옛 체인은 **생성만 되고 소비자 0**(삭제는 M5).

### M4-1. EDIT `packages/types/src/notification.ts` — delta/end/error 필드 (plan §3-7)

```ts
/** chat.stream.delta — 증분 텍스트 조각 (150ms 배치, += 로 누적) */
export interface ChatStreamDeltaParams {
  readonly sessionId: string;
  readonly runId: string;
  readonly delta: string;
}

/** chat.stream.end — 확정. 클라이언트는 스트림 버퍼를 result.text 로 교체한다 (Q9: 화면 = 저장본). */
export interface ChatStreamEndParams {
  readonly sessionId: string;
  readonly runId: string;
  readonly result: {
    readonly text: string;
    readonly usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
    readonly costUsd?: number;
  };
}

/** chat.stream.error — 종료 신호(abort 포함 — reason:'aborted'). raw 메시지가 아니라 드라이버 요약. */
export interface ChatStreamErrorParams {
  readonly sessionId: string;
  readonly runId: string;
  readonly error: string;
  readonly reason: string;
}
```

### M4-2. EDIT `packages/gateway/src/broadcaster.ts` — AgentEvent 입력 + runId

```ts
// packages/server/src/gateway/broadcaster.ts
import type { AgentEvent } from '@finclaw/agent';
import type { ChatStreamDeltaParams, ChatStreamEndParams, ChatStreamErrorParams } from '@finclaw/types';
import type { WsConnection, JsonRpcNotification } from './rpc/types.js';

/**
 * GatewayBroadcaster — AgentEvent → WebSocket 알림 변환
 *
 * | AgentEvent.type | WS method         | 전송 정책                      |
 * |-----------------|-------------------|--------------------------------|
 * | text_delta      | chat.stream.delta | 150ms 배치                     |
 * | done            | chat.stream.end   | 즉시 (남은 delta flush 후)     |
 * | error           | chat.stream.error | 즉시 (남은 delta flush 후)     |
 * | start           | (전송 안 함)      |                                |
 */
export class GatewayBroadcaster {
  private readonly deltaBuffers = new Map<
    string,
    { runId: string; text: string; timer: ReturnType<typeof setTimeout> }
  >();
  // ... BATCH_INTERVAL_MS / MAX_BUFFER 그대로 ...

  /** AgentEvent 를 연결에 전송 (모든 chat.stream.* 에 runId). */
  send(conn: WsConnection, sessionId: string, runId: string, event: AgentEvent): void {
    switch (event.type) {
      case 'text_delta':
        this.bufferDelta(conn, sessionId, runId, event.text);
        break;
      case 'done':
        this.flushDelta(conn.id, sessionId, conn);
        this.sendImmediate(conn, 'chat.stream.end', {
          sessionId,
          runId,
          result: { text: event.text, usage: event.usage, costUsd: event.costUsd },
        } satisfies ChatStreamEndParams);
        break;
      case 'error':
        this.flushDelta(conn.id, sessionId, conn);
        this.sendImmediate(conn, 'chat.stream.error', {
          sessionId,
          runId,
          error: event.message,
          reason: event.reason,
        } satisfies ChatStreamErrorParams);
        break;
      default:
        break; // start·tool_use·tool_result — M6 전까지 미전송
    }
  }

  private bufferDelta(conn: WsConnection, sessionId: string, runId: string, delta: string): void {
    const key = `${conn.id}:${sessionId}`;
    const existing = this.deltaBuffers.get(key);
    if (existing) {
      existing.text += delta;
      return;
    }
    this.deltaBuffers.set(key, {
      runId,
      text: delta,
      timer: setTimeout(
        () => this.flushDelta(conn.id, sessionId, conn),
        GatewayBroadcaster.BATCH_INTERVAL_MS,
      ),
    });
  }

  private flushDelta(connId: string, sessionId: string, conn: WsConnection): void {
    const key = `${connId}:${sessionId}`;
    const buf = this.deltaBuffers.get(key);
    if (!buf) {
      return;
    }
    clearTimeout(buf.timer);
    this.deltaBuffers.delete(key);
    if (buf.text.length > 0) {
      this.sendImmediate(conn, 'chat.stream.delta', {
        sessionId,
        runId: buf.runId,
        delta: buf.text,
      } satisfies ChatStreamDeltaParams);
    }
  }
  // ... sendImmediate / broadcastToChannel / broadcastShutdown / flushAll 그대로 ...
```

(`satisfies` 로 리터럴을 넘긴다 — 인터페이스 타입 변수는 `Record<string, unknown>` 파라미터에 대입 불가.)

### M4-3. EDIT `packages/gateway/src/rpc/methods/chat.ts` — D9 즉시 `{runId}`, `CHAT_SEND_TIMEOUT_MS` 삭제, `activeRuns`

```ts
// packages/server/src/gateway/rpc/methods/chat.ts
import { randomUUID } from 'node:crypto';
import type { AgentRunPort } from '@finclaw/agent';
import type { FinClawLogger } from '@finclaw/infra';
import type { ModelRef, SessionKey } from '@finclaw/types';
import { createAgentId, createSessionKey } from '@finclaw/types';
import { z } from 'zod/v4';
import type { GatewayBroadcaster } from '../../broadcaster.js';
import type { ChatRegistry } from '../../registry.js';
import type { MethodRegistry } from '../index.js';
import type { ActiveSession, RpcMethodHandler, WsConnection } from '../types.js';

// 삭제: const CHAT_SEND_TIMEOUT_MS = 60_000;  (Q13 — 타임아웃은 runtime 의 무출력 120s / overall 300s)

export interface ChatMethodsDeps {
  readonly registry: ChatRegistry;
  readonly connections: Map<string, WsConnection>;
  readonly broadcaster: GatewayBroadcaster;
  readonly defaultModel: ModelRef;
  /** Phase 46: ChatExecutionPort 대체 — AgentRuntime 포트. */
  readonly runtime: AgentRunPort;
  readonly logger?: FinClawLogger;
}

/** D9: sessionId 당 최근 run 1개 (실행 직렬화는 runtime per-session lane). chat.abort(M6)가 controller 를 쓴다. */
interface ActiveRun {
  readonly runId: string;
  readonly controller: AbortController;
}

// deriveTuiSessionKey 그대로

export function createChatMethods(deps: ChatMethodsDeps): readonly RpcMethodHandler[] {
  const activeRuns = new Map<string, ActiveRun>();

  /** run 을 끝까지 소비하며 WS 로 중계. 연결은 이벤트마다 조회 — 끊겨도 run 은 끝까지 돌아 저장된다 (S9). */
  async function streamRun(session: ActiveSession, message: string, run: ActiveRun): Promise<void> {
    try {
      for await (const ev of deps.runtime.run({
        sessionKey: session.sessionKey,
        agentId: createAgentId(session.agentId),
        input: message,
        mode: 'chat',
        model: session.model.model,
        runId: run.runId,
        // 세션 stop·서버 종료(registry.abortAll) 또는 chat.abort 로만 중단
        signal: AbortSignal.any([session.abortController.signal, run.controller.signal]),
      })) {
        const conn = deps.connections.get(session.connectionId);
        if (conn) {
          deps.broadcaster.send(conn, session.sessionId, run.runId, ev);
        }
      }
    } catch (err) {
      deps.logger?.error('chat.run.failed', {
        event: 'chat.run.failed',
        runId: run.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (activeRuns.get(session.sessionId) === run) {
        activeRuns.delete(session.sessionId);
      }
    }
  }

  const startHandler = /* 그대로 */;

  const sendHandler: RpcMethodHandler<
    { sessionId: string; message: string; idempotencyKey?: string },
    { runId: string }
  > = {
    method: 'chat.send',
    description: '활성 세션에 메시지를 전송합니다 (실행은 백그라운드 — 진행·결과는 chat.stream.*)',
    authLevel: 'token', // ← 'session' 에서 강등 (Phase 37 A: session 레벨은 부여 코드 부재 → 영구 도달 불가)
    schema: z.object({
      sessionId: z.string(),
      message: z.string(),
      idempotencyKey: z.string().optional(),
    }),
    async execute(params) {
      const session = deps.registry.getSession(params.sessionId);
      if (!session) {
        throw new Error('session not found');
      }
      const run: ActiveRun = { runId: randomUUID(), controller: new AbortController() };
      activeRuns.set(session.sessionId, run);
      // D9: 즉시 반환 — Web/TUI 는 chat.send 를 30s 요청 타임아웃으로 await 한다 (app-gateway.ts:177, gateway-client.ts:153)
      void streamRun(session, params.message, run);
      return { runId: run.runId };
    },
  };

  return [startHandler, sendHandler];
}
```

`SessionKey`·`createSessionKey` 는 `deriveTuiSessionKey` 가 계속 쓴다. `AgentId` 타입 import 는 고아 → 삭제.

### M4-4. EDIT `packages/gateway/src/server.ts` — deps `runtime: AgentRunPort`

```ts
import type { AgentRunPort } from '@finclaw/agent'; // ChatExecutionPort import 교체

export interface GatewayServerDeps {
  readonly defaultModel: ModelRef;
  /** Phase 46: chat.* 실행 포트 (AgentRuntime). */
  readonly runtime: AgentRunPort;
  // ... 나머지 그대로 ...
}
// ...
registerChatMethods(
  {
    registry: ctx.registry,
    connections: ctx.connections,
    broadcaster: ctx.broadcaster,
    defaultModel: deps.defaultModel,
    runtime: deps.runtime,
    logger: deps.agentDeps?.logger,
  },
  ctx.methods,
);
// ...
// [TQ9] AgentRpcDeps.db 제거(M4-5) → agent.runs.* 는 financeDeps.db (main 에서 같은 storage.db)
registerAgentRunsMethods({ db: deps.financeDeps?.db }, ctx.methods);
```

### M4-5. EDIT `packages/gateway/src/rpc/methods/agent.ts` — oneShot 소비, attach 만 (전체 교체 범위: import·deps·persist 헬퍼·runHandler)

```ts
// packages/server/src/gateway/rpc/methods/agent.ts
import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentRunPort, ProfileHealthMonitor, ToolRegistry } from '@finclaw/agent';
import type { ConcurrencyLane, FinClawLogger } from '@finclaw/infra';
import type { AttachMemoryInput, AttachMemoryPort, TracerPort } from '@finclaw/types';
import { createAgentId, createSessionKey } from '@finclaw/types';
import { z } from 'zod/v4';
import type { MethodRegistry } from '../index.js';
import type { RpcMethodHandler } from '../types.js';

type TerminalEvent = Extract<AgentEvent, { type: 'done' | 'error' }>;

/** agent.* RPC 메서드 의존성 (main.ts 에서 주입) */
export interface AgentRpcDeps {
  readonly toolRegistry: ToolRegistry;
  /** main.ts 가 finclaw.system.ko.md frontmatter (id/name/description) 로부터 로드해 주입. */
  readonly agents: readonly AgentInfo[];
  /** Phase 46: agent.run = runtime oneShot. agent_runs 1행·profileHealth 기록은 runtime 소관 (D10). */
  readonly runtime: AgentRunPort;
  /** agent.run 전용 큐잉 lane (main.ts 에서 maxConcurrent:1 로 주입) — 현 동작 유지 (D6) */
  readonly agentRunLane: ConcurrencyLane;
  /** agent.status 의 health 표시용. */
  readonly profileHealth: ProfileHealthMonitor;
  readonly logger: FinClawLogger;
  readonly profileId?: string;
  /** Phase 26 D: agent.run 종료 후 output → memory 저장 훅. 현 동작 유지 (S2·R6 — phase47 존폐 결정). */
  readonly attachMemoryService?: AttachMemoryPort;
  /** Phase 30 hotfix P0-1: agent.run 진입 span — runtime 이 그 traceId 를 agent_runs 에 부착. */
  readonly tracer?: TracerPort;
}
// 삭제된 deps: runnerFactory · systemPrompt · defaultModel · db (고아)

/** Best-effort: attach 실패는 swallow + warn. RPC 응답엔 영향 X. */
async function attachMemory(
  deps: Pick<AgentRpcDeps, 'attachMemoryService' | 'logger'>,
  input: AttachMemoryInput,
): Promise<void> {
  if (!deps.attachMemoryService || !input.output) {
    return;
  }
  try {
    await deps.attachMemoryService.attach(input);
  } catch (attachErr) {
    deps.logger.warn('agent.run.memory.attach_failed', {
      event: 'agent.run.memory.attach_failed',
      agentRunId: input.agentRunId,
      error: (attachErr as Error).message,
    });
  }
}
// 삭제: persistAgentRunAndAttach (addAgentRun 은 runtime 이 한다) + addAgentRun/AddAgentRunInput/extractAssistantText/DatabaseSync/SessionKey/ModelRef import

// activeRuns/totalCalls/lastCallAt/lastError/resetAgentStats · listHandler · statusHandler 그대로

  // ── agent.run ── (schema·검증·started 로그 그대로)
    async execute(params) {
      if (!deps.agents.find((a) => a.id === params.agentId)) {
        throw new Error(`unknown_agent: ${params.agentId}`);
      }
      if (params.stream) {
        throw new Error('stream_unsupported: use chat.* for streaming responses');
      }

      const startedAt = Date.now();
      deps.logger.info('agent.run.started', {
        agentId: params.agentId,
        promptLength: params.prompt.length,
      });

      // tracer 주입 시 span 으로 감싸 active trace context 강제 → runtime 이 traceId 를 agent_runs 에 부착.
      const runWithSpan = <T>(fn: () => Promise<T>): Promise<T> =>
        deps.tracer
          ? deps.tracer.withSpan('rpc.agent.run', { agentId: params.agentId }, async () => fn())
          : fn();

      return runWithSpan(async () => {
        const handle = await deps.agentRunLane.acquire(params.agentId);
        activeRuns.set(params.agentId, (activeRuns.get(params.agentId) ?? 0) + 1);
        const sessionKey = createSessionKey(`agent-run-${randomUUID()}`);
        try {
          let terminal: TerminalEvent | undefined;
          for await (const ev of deps.runtime.run({
            sessionKey,
            agentId: createAgentId(params.agentId),
            input: params.prompt,
            mode: 'oneShot',
            // [TQ5] timeoutMs 를 주면 그 시각에 abort, 없으면 runtime 무출력 120s / overall 300s 만
            signal: params.timeoutMs
              ? AbortSignal.timeout(params.timeoutMs)
              : new AbortController().signal,
          })) {
            if (ev.type === 'done' || ev.type === 'error') {
              terminal = ev;
            }
          }
          if (terminal?.type !== 'done') {
            throw new Error(
              terminal ? `${terminal.reason}: ${terminal.message}` : 'agent run ended without result',
            );
          }

          const durationMs = Date.now() - startedAt;
          totalCalls.set(params.agentId, (totalCalls.get(params.agentId) ?? 0) + 1);
          lastCallAt.set(params.agentId, Date.now());
          lastError.delete(params.agentId);
          deps.logger.info('agent.run.completed', {
            agentId: params.agentId,
            runId: terminal.runId,
            durationMs,
            tokensInput: terminal.usage.input,
            tokensOutput: terminal.usage.output,
          });

          // Phase 26 D: output → memory (현 동작 유지). agent_runs 행은 runtime 이 이미 기록 → link 가능.
          await attachMemory(deps, {
            agentRunId: terminal.runId,
            agentId: params.agentId,
            prompt: params.prompt,
            output: terminal.text,
            sessionKey,
            createdAt: Date.now(),
          });

          return {
            agentId: params.agentId,
            output: terminal.text,
            tokenUsage: { input: terminal.usage.input, output: terminal.usage.output },
            durationMs,
            stopReason: 'completed',
            runId: terminal.runId,
          };
        } catch (err) {
          const msg = (err as Error).message;
          lastError.set(params.agentId, msg);
          deps.logger.warn('agent.run.failed', {
            agentId: params.agentId,
            error: msg,
            durationMs: Date.now() - startedAt,
          });
          throw err;
        } finally {
          activeRuns.set(params.agentId, Math.max(0, (activeRuns.get(params.agentId) ?? 1) - 1));
          handle.release();
        }
      });
    },
```

`params.timeoutMs` 스키마(`1_000..120_000`)는 그대로.

### M4-6. EDIT `packages/server/src/automation/scheduler.ts` — runtime oneShot, 중복 addAgentRun 2곳 삭제

```ts
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentRunPort } from '@finclaw/agent';
import type { ConcurrencyLane, FinClawLogger } from '@finclaw/infra';
import { nextRunAt as computeNextRunAt, parseCron } from '@finclaw/infra';
import { findDueSchedules, getSchedule, markScheduleRun, updateSchedule } from '@finclaw/storage';
import type { Schedule, SchedulerPort } from '@finclaw/types';
import { createAgentId, createSessionKey } from '@finclaw/types';
// (addAgentRun · extractAssistantText · ProfileHealthMonitor · RunnerFactory · ModelRef import 삭제)

export interface SchedulerDeps extends SchedulerCallbacks {
  readonly db: DatabaseSync;
  /** Phase 46: cron = runtime oneShot (비영속·recall 없음 — Q4). agent_runs 1행은 runtime 이 기록. */
  readonly runtime: AgentRunPort;
  readonly lane: ConcurrencyLane;
  readonly logger: FinClawLogger;
  readonly maxConsecutiveFailures?: number;
  /** schedule.timeoutMs 가 없을 때의 상한(ms). 미지정 시 runtime 타임아웃만 [TQ4]. */
  readonly defaultTimeoutMs?: number;
  readonly tracer?: FinclawTracer;
}
// 삭제된 deps: runnerFactory · defaultModel · systemPrompt · profileHealth · profileId (고아 — health 기록은 runtime)
```

`runOne` 의 span 래퍼와 실행부:

```ts
    const tracer = this.deps.tracer;
    const withSchedSpan = <T>(fn: () => Promise<T>): Promise<T> =>
      tracer
        ? tracer.withSpan(
            'scheduler.run',
            { scheduleId: s.id, agentId: s.agentId as string, manual: opts.manual },
            async () => fn(),
          )
        : fn();
    return withSchedSpan(async () => {
      try {
        const sessionKey = createSessionKey(`schedule-${s.id}-${randomUUID()}`);
        const timeoutMs = s.timeoutMs ?? this.deps.defaultTimeoutMs;
        for await (const ev of this.deps.runtime.run({
          sessionKey,
          agentId: createAgentId(s.agentId as string),
          input: s.prompt,
          mode: 'oneShot',
          signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : new AbortController().signal,
        })) {
          if (ev.type === 'done') {
            runId = ev.runId;
            output = ev.text;
          } else if (ev.type === 'error') {
            runId = ev.runId;
            error = `${ev.reason}: ${ev.message}`;
          }
        }
        // D1: runtime 이 종료 이벤트 yield 전에 agent_runs 1행을 남김 → runId 로 schedule 연결
        if (runId) {
          this.deps.db.prepare('UPDATE agent_runs SET schedule_id = ? WHERE id = ?').run(s.id, runId);
        }

        // schedule.last_run + next_run_at 갱신. ← 이하(backoff·markScheduleRun·연속 실패·로그·onRunComplete) 그대로
```

`startedAt` 은 로그 `durationMs` 에 계속 쓰인다(유지). 삭제: try/catch 안의 `addAgentRun` 2회·`profileHealth.recordResult` 2회·`abortController`/`setTimeout`/`clearTimeout(timer)`.

### M4-7. EDIT `packages/server/src/composition/runtime.ts` — `buildAutomation` deps

```ts
export interface BuildAutomationDeps {
  readonly storage: Storage;
  readonly runtime: AgentRunPort;
  readonly logger: FinClawLogger;
  readonly tracer: Tracer;
  readonly lifecycle: { register(fn: () => void | Promise<void>): void };
}

export function buildAutomation(deps: BuildAutomationDeps): AutomationBundle {
  const { storage, runtime, logger, tracer, lifecycle } = deps;
  // ... scheduleLane / deliveryHook / maxConsecutiveFailures 그대로 ...
  const scheduler = new SchedulerService({
    db: storage.db,
    runtime,
    lane: scheduleLane,
    logger,
    maxConsecutiveFailures,
    tracer,
    onRunComplete: async (args) => {
      if (deliveryHook) {
        await deliveryHook(args);
      }
    },
  });
```

### M4-8. EDIT `packages/server/src/main.ts` — gateway·scheduler·agent.run 에 runtime 주입

```ts
// runnerFactory/adapter 는 M5 삭제 전까지 buildExecution 이 생성만 한다 — destructure 하지 않음(미사용 lint)
const { tracer, runtime, attachMemoryService } = buildExecution({
  /* M3 그대로 */
});
// ...
const { scheduler, setDeliveryHook } = buildAutomation({
  storage,
  runtime,
  logger,
  tracer,
  lifecycle,
});

const gateway = createGatewayServer(gatewayConfig, {
  defaultModel: DEFAULT_MODEL,
  runtime,
  toolRegistry,
  financeDeps: {
    /* 그대로 (db: storage.db 포함 — agent.runs.* 가 이 db 를 씀) */
  },
  memoryDeps: { db: storage.db, embeddingProvider },
  agentDeps: {
    toolRegistry,
    agents: AGENT_METADATA,
    runtime,
    agentRunLane,
    profileHealth,
    logger,
    profileId: 'default',
    attachMemoryService,
    tracer,
  },
  // ... 나머지 그대로 ...
});
```

### M4-9. EDIT `packages/web/src/app-chat.ts` — end 에서 버퍼를 `result.text` 로 교체 (Q9)

```ts
      case 'chat.stream.end': {
        const endParams = p as unknown as ChatStreamEndParams;
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: endParams.result.text, // Q9: 화면 = 저장본 = Discord (S5)
          timestamp: Date.now(),
        };
        // ... setState / processQueue 그대로 ...
```

큐(`processing`) 로직은 변경 없음 [TQ6].

### M4-10. EDIT `packages/tui/src/App.tsx` — 동일

```ts
import type {
  ChatStreamDeltaParams,
  ChatStreamEndParams,
  ChatStreamErrorParams,
} from '@finclaw/types';
// ...
        case 'chat.stream.end': {
          const { result } = params as unknown as ChatStreamEndParams;
          setStreamText('');
          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: 'assistant', content: result.text },
          ]);
          break;
        }
```

### M4-11. EDIT `packages/gateway/src/rpc/methods/chat.test.ts` — runtime fake + D9

`ChatExecutionPort`/`makeStubAdapter` 제거. 헬퍼:

```ts
import type { AgentEvent, AgentRunPort, AgentRunRequest } from '@finclaw/agent';
import type { WsConnection } from '../types.js';

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function gatedRuntime() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const calls: AgentRunRequest[] = [];
  const runtime: AgentRunPort = {
    async *run(req) {
      calls.push(req);
      yield { type: 'text_delta', text: '안녕' } satisfies AgentEvent;
      await opened;
      yield {
        type: 'done',
        runId: req.runId ?? '',
        cliSessionId: 'c',
        text: '안녕하세요',
        usage: ZERO,
        durationMs: 1,
        numTurns: 1,
      };
    },
    reset: vi.fn().mockResolvedValue(true),
  };
  return { runtime, calls, open: () => open() };
}

function mockConn(
  id = 'conn-1',
): WsConnection & { sent: Array<{ method: string; params: Record<string, unknown> }> } {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    id,
    ws: {
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 0,
      send: (data: string) => sent.push(JSON.parse(data)),
    } as unknown as WsConnection['ws'],
    auth: { level: 'token' as const },
    connectedAt: Date.now(),
    lastPongAt: Date.now(),
    subscriptions: new Set<string>(),
    sent,
  } as WsConnection & { sent: Array<{ method: string; params: Record<string, unknown> }> };
}
```

`beforeEach` 의 `adapter: makeStubAdapter()` → `runtime: gatedRuntime().runtime`. 기존 schema/auth 케이스는 그대로. 신규 describe:

```ts
describe('chat.send (D9)', () => {
  async function startSession(runtime: AgentRunPort, conn?: WsConnection) {
    ctx = makeServerCtx();
    registerChatMethods(
      {
        registry: ctx.registry,
        connections: ctx.connections,
        broadcaster: ctx.broadcaster,
        defaultModel: TEST_MODEL,
        runtime,
      },
      ctx.methods,
    );
    if (conn) {
      ctx.connections.set(conn.id, conn);
    }
    const session = ctx.registry.startSession({
      agentId: 'default',
      connectionId: conn?.id ?? 'gone',
      model: TEST_MODEL,
      sessionKey: createSessionKey('tui:local:default'),
    });
    return session.sessionId;
  }

  const send = (sessionId: string) =>
    dispatchRpc(
      { jsonrpc: '2.0', id: 1, method: 'chat.send', params: { sessionId, message: '안녕' } },
      { auth: { level: 'token' }, remoteAddress: '127.0.0.1' },
      ctx,
    );

  it('run 종료 전에 {runId} 를 즉시 돌려준다', async () => {
    const g = gatedRuntime();
    const sessionId = await startSession(g.runtime, mockConn());
    const res = (await send(sessionId)) as { result: { runId: string } };
    expect(res.result.runId).toMatch(/[0-9a-f-]{36}/);
    expect(g.calls[0]).toMatchObject({
      mode: 'chat',
      input: '안녕',
      runId: res.result.runId,
      model: 'claude-test',
    });
    g.open();
  });

  it('delta(runId) → end(result.text) 로 브로드캐스트', async () => {
    const g = gatedRuntime();
    const conn = mockConn();
    const sessionId = await startSession(g.runtime, conn);
    const { result } = (await send(sessionId)) as { result: { runId: string } };
    g.open();
    await vi.waitFor(() => expect(conn.sent.map((m) => m.method)).toContain('chat.stream.end'));
    expect(conn.sent[0]).toEqual({
      jsonrpc: '2.0',
      method: 'chat.stream.delta',
      params: { sessionId, runId: result.runId, delta: '안녕' },
    });
    expect(conn.sent.at(-1)?.params).toMatchObject({
      sessionId,
      runId: result.runId,
      result: { text: '안녕하세요' },
    });
  });

  it('연결이 없어도 run 은 끝까지 돈다 (S9)', async () => {
    const g = gatedRuntime();
    const done = vi.fn();
    const runtime: AgentRunPort = {
      async *run(req) {
        for await (const ev of g.runtime.run(req)) {
          yield ev;
        }
        done();
      },
      reset: g.runtime.reset,
    };
    const sessionId = await startSession(runtime);
    await send(sessionId);
    g.open();
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
  });
});
```

(`createSessionKey` 는 `@finclaw/types` 에서 import, `vi` 추가 import.)

### M4-12. EDIT `packages/gateway/src/broadcaster.test.ts` — 새 시그니처

`StreamEvent` import → `AgentEvent`. 모든 `broadcaster.send(conn, 'sess-1', X)` → `broadcaster.send(conn, 'sess-1', 'run-1', X)`, 이벤트 리터럴 교체:

- `{ type: 'text_delta', delta: 'Hello' }` → `{ type: 'text_delta', text: 'Hello' }`
- done → `{ type: 'done', runId: 'run-1', cliSessionId: 'c', text: 'final', usage: ZERO, durationMs: 100, numTurns: 1 }`
- error → `{ type: 'error', runId: 'run-1', reason: 'unknown', message: 'something broke' }`

단언 추가: delta params `{ sessionId: 'sess-1', runId: 'run-1', delta: 'Hello World' }` · end params `result.text === 'final'` · error params `reason === 'unknown'`. 신규 1케이스: `start` 이벤트는 아무것도 보내지 않는다.

### M4-13. EDIT `packages/gateway/src/server.test.ts`, `packages/server/src/main.test.ts` — stub 교체

```ts
import type { AgentRunPort } from '@finclaw/agent';

const stubRuntime: AgentRunPort = {
  async *run() {
    yield* [];
  },
  reset: async () => false,
};
// makeTestDeps / createGatewayServer 인자: adapter: makeStubAdapter() → runtime: stubRuntime
```

`main.test.ts` 의 `import type { RunnerExecutionAdapter }`·`makeStubAdapter` 삭제.

### M4-14. EDIT `packages/gateway/src/rpc/methods/agent.test.ts` — port fake 로 재작성 (D10)

`makeServerCtx`·`tokenCtx`·`call` 헬퍼는 그대로. `getAgentRun`/`openDatabase`/`Database` import·`makeRunnerResult` 삭제. 헬퍼:

```ts
import type { AgentEvent, AgentRunPort, AgentRunRequest } from '@finclaw/agent';

const USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };

function fakeRuntime(outcome: 'done' | 'error' = 'done', gate?: Promise<void>) {
  const calls: AgentRunRequest[] = [];
  const runtime: AgentRunPort = {
    async *run(req) {
      calls.push(req);
      if (gate && calls.length === 1) {
        await gate;
      }
      const runId = `run-${calls.length}`;
      const ev: AgentEvent =
        outcome === 'done'
          ? {
              type: 'done',
              runId,
              cliSessionId: 'c',
              text: 'hello world',
              usage: USAGE,
              durationMs: 1,
              numTurns: 1,
            }
          : { type: 'error', runId, reason: 'unknown', message: 'runner exploded' };
      yield ev;
    },
    reset: async () => false,
  };
  return { runtime, calls };
}

function makeDeps(overrides: Partial<AgentRpcDeps> = {}): AgentRpcDeps {
  return {
    toolRegistry: { list: () => [] } as never,
    agents: [
      {
        id: 'finclaw-partner',
        name: 'FinClaw Personal Finance Partner',
        description: '개인 금융 파트너. 시세 조회·뉴스·포트폴리오·알림 관리.',
      },
    ],
    runtime: fakeRuntime().runtime,
    agentRunLane: new ConcurrencyLane({ maxConcurrent: 1, maxQueueSize: 10, waitTimeoutMs: 5_000 }),
    profileHealth: {
      getHealth: vi.fn().mockReturnValue('healthy'),
      recordResult: vi.fn(),
    } as never,
    logger: {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
      flush: vi.fn(),
    } as never,
    profileId: 'default',
    ...overrides,
  };
}
```

케이스 (D10 목록 — registration·list·status×2 는 본문 그대로, 아래는 agent.run):

```ts
it('rejects unknown agentId' /* 그대로 */);
it('rejects stream=true' /* 그대로 */);

it('fake done → output·runId·tokenUsage 반환 + oneShot 요청 + stats 갱신', async () => {
  const { runtime, calls } = fakeRuntime();
  registerAgentMethods(makeDeps({ runtime }), methods);
  const result = await call('agent.run', { agentId: 'finclaw-partner', prompt: 'hi' });
  const r = (
    result as { result: { output: string; runId: string; tokenUsage: unknown; stopReason: string } }
  ).result;
  expect(r).toMatchObject({
    output: 'hello world',
    runId: 'run-1',
    tokenUsage: { input: 10, output: 5 },
    stopReason: 'completed',
  });
  expect(calls[0]).toMatchObject({ mode: 'oneShot', input: 'hi', agentId: 'finclaw-partner' });
  expect(String(calls[0]?.sessionKey)).toMatch(/^agent-run-/);
  const status = (await call('agent.status', { agentId: 'finclaw-partner' })) as {
    result: { totalCalls: number; lastError: string | null };
  };
  expect(status.result).toMatchObject({ totalCalls: 1, lastError: null });
});

it('fake error → lastError 기록 + RPC 에러', async () => {
  registerAgentMethods(makeDeps({ runtime: fakeRuntime('error').runtime }), methods);
  const result = await call('agent.run', { agentId: 'finclaw-partner', prompt: 'hi' });
  expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INTERNAL_ERROR);
  const status = (await call('agent.status', { agentId: 'finclaw-partner' })) as {
    result: { lastError: string | null; totalCalls: number };
  };
  expect(status.result.lastError).toContain('runner exploded');
  expect(status.result.totalCalls).toBe(0);
});

it('done 이면 attach({agentRunId: done.runId, sessionKey}) 호출, error 면 미호출', async () => {
  const attach = vi.fn().mockResolvedValue(undefined);
  registerAgentMethods(makeDeps({ attachMemoryService: { attach } as AttachMemoryPort }), methods);
  await call('agent.run', { agentId: 'finclaw-partner', prompt: 'hi' });
  expect(attach).toHaveBeenCalledWith(
    expect.objectContaining({
      agentRunId: 'run-1',
      prompt: 'hi',
      output: 'hello world',
      agentId: 'finclaw-partner',
      sessionKey: expect.stringMatching(/^agent-run-/),
    }),
  );
  methods = new MethodRegistry();
  attach.mockClear();
  registerAgentMethods(
    makeDeps({
      runtime: fakeRuntime('error').runtime,
      attachMemoryService: { attach } as AttachMemoryPort,
    }),
    methods,
  );
  await call('agent.run', { agentId: 'finclaw-partner', prompt: 'hi' });
  expect(attach).not.toHaveBeenCalled();
});

it('attach 실패는 swallow — RPC 는 runId 와 함께 성공', async () => {
  const attach = vi.fn().mockRejectedValue(new Error('embed down'));
  const deps = makeDeps({ attachMemoryService: { attach } as AttachMemoryPort });
  registerAgentMethods(deps, methods);
  const result = await call('agent.run', { agentId: 'finclaw-partner', prompt: 'hi' });
  expect((result as { result: { runId: string } }).result.runId).toBe('run-1');
  expect(deps.logger.warn).toHaveBeenCalledWith(
    'agent.run.memory.attach_failed',
    expect.anything(),
  );
});

it('queues concurrent requests on agent-run lane (maxConcurrent=1)', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { runtime, calls } = fakeRuntime('done', gate);
  registerAgentMethods(makeDeps({ runtime }), methods);
  const p1 = call('agent.run', { agentId: 'finclaw-partner', prompt: 'first' });
  const p2 = call('agent.run', { agentId: 'finclaw-partner', prompt: 'second' });
  await new Promise((r) => setTimeout(r, 10));
  expect(calls).toHaveLength(1);
  release();
  await Promise.all([p1, p2]);
  expect(calls).toHaveLength(2);
});
```

**삭제:** `describe('persistence (Phase 26 D)')` 5케이스(agent_runs 행 기록 3건·db 미주입 1건·attach 1건 — 기록은 runtime 소관, attach 는 위로 대체)와 `updates stats` 의 `profileHealth.recordResult` 단언.

### M4-15. EDIT `packages/server/src/automation/scheduler.test.ts` — runtime fake

```ts
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentRunPort, AgentRunRequest } from '@finclaw/agent';
import { ConcurrencyLane, type FinClawLogger } from '@finclaw/infra';
import {
  addAgentRun,
  addSchedule,
  getSchedule,
  openDatabase,
  type Database,
} from '@finclaw/storage';
import { createAgentId } from '@finclaw/types';
// (ProfileHealthMonitor · ModelRef · DEFAULT_MODEL 삭제)

/** runtime 계약(D1)을 흉내 — 종료 이벤트 yield 전에 agent_runs 1행. outcomes[i] 가 i번째 호출 결과. */
function fakeRuntime(db: DatabaseSync, outcomes: Array<'ok' | 'fail'>) {
  const calls: AgentRunRequest[] = [];
  const runtime: AgentRunPort = {
    async *run(req) {
      calls.push(req);
      const runId = randomUUID();
      const failed = (outcomes[calls.length - 1] ?? 'ok') === 'fail';
      addAgentRun(db, {
        id: runId,
        agentId: req.agentId,
        prompt: req.input,
        output: failed ? '' : 'hello',
        error: failed ? 'unknown: boom' : undefined,
      });
      yield failed
        ? { type: 'error', runId, reason: 'unknown', message: 'boom' }
        : {
            type: 'done',
            runId,
            cliSessionId: 'c',
            text: 'hello',
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
            durationMs: 1,
            numTurns: 1,
          };
    },
    reset: async () => false,
  };
  return { runtime, calls };
}
```

`new SchedulerService({ db, runnerFactory, lane, defaultModel, systemPrompt, logger, profileHealth, ... })` → `new SchedulerService({ db: database.db, runtime, lane, logger: makeLogger(), ... })`. 기존 4케이스 유지(`row.error` 기대값 `'unknown: boom'`), 신규 2케이스:

```ts
it('runtime 에 oneShot · schedule-{id}- sessionKey · prompt 를 넘긴다', async () => {
  const s = addSchedule(database.db, {
    name: 't',
    cron: '* * * * *',
    agentId: createAgentId('finclaw-partner'),
    prompt: '아침 브리핑',
    deliveryChannel: 'web',
    deliveryTarget: 'broadcast',
  });
  const { runtime, calls } = fakeRuntime(database.db, ['ok']);
  await new SchedulerService({ db: database.db, runtime, lane, logger: makeLogger() }).triggerNow(
    s.id,
  );
  expect(calls[0]).toMatchObject({ mode: 'oneShot', input: '아침 브리핑' });
  expect(String(calls[0]?.sessionKey)).toMatch(new RegExp(`^schedule-${s.id}-`));
});

it('agent_runs 는 run 당 1행 (중복 0) + schedule_id 연결', async () => {
  const s = addSchedule(database.db, {
    name: 't',
    cron: '* * * * *',
    agentId: createAgentId('finclaw-partner'),
    prompt: 'p',
    deliveryChannel: 'web',
    deliveryTarget: 'broadcast',
  });
  const { runtime } = fakeRuntime(database.db, ['ok']);
  const { runId } = await new SchedulerService({
    db: database.db,
    runtime,
    lane,
    logger: makeLogger(),
  }).triggerNow(s.id);
  const rows = database.db.prepare('SELECT id, schedule_id FROM agent_runs').all() as Array<{
    id: string;
    schedule_id: string;
  }>;
  expect(rows).toEqual([{ id: runId, schedule_id: s.id }]);
});
```

### M4-16. EDIT `packages/server/src/__tests__/gateway-integration/agent-runs.integration.test.ts` — runtime fake [TQ8]

plan 파일 목록엔 없지만 `AgentRpcDeps` 가 바뀌어 깨진다. 경계 의미(agent.run → agent_runs + memories → agent.runs.get)는 유지:

```ts
import type { AgentRunPort } from '@finclaw/agent';

/** runtime 계약(D1): 종료 이벤트 yield 전에 agent_runs 1행 → attach 가 link 할 수 있다. */
function runtimeWriting(db: Database['db'], output: string): AgentRunPort {
  return {
    async *run(req) {
      const runId = `run-${Math.random().toString(36).slice(2)}`;
      addAgentRun(db, { id: runId, agentId: req.agentId, prompt: req.input, output });
      yield {
        type: 'done',
        runId,
        cliSessionId: 'c',
        text: output,
        usage: { input: 30, output: 60, cacheRead: 0, cacheWrite: 0 },
        durationMs: 400,
        numTurns: 1,
      };
    },
    reset: async () => false,
  };
}
```

`makeAgentDeps` 에서 `runnerFactory`·`systemPrompt`·`defaultModel` 제거하고 `runtime: runtimeWriting(...)` 를 override 로. 본문의 `registerAgentMethods(makeAgentDeps({ runnerFactory, db, attachMemoryService, logger }))` → `makeAgentDeps({ runtime: runtimeWriting(database.db, longOutput), attachMemoryService: attachService, logger })`. `makeAgentRunResult` 헬퍼 삭제. 단언 그대로.

### M4-17. EDIT `packages/web/src/__tests__/app-chat.test.ts` · `packages/tui/src/__tests__/chat.test.ts`

- web: `'should finalize assistant message on stream end'` — delta `'Response'` 후 end params `{ sessionId: SESSION, runId: 'r1', result: { text: 'Final answer', usage: ZERO } }` → `messages[1].content === 'Final answer'`(버퍼가 아니라 result.text). 다른 케이스의 `result: null` 도 `result: { text: '', usage: ZERO }` 로.
- tui `chat.test.ts` 는 App 로직의 사본 — `chat.stream.end` 분기를 `content: (params as unknown as ChatStreamEndParams).result.text` 로 맞추고 케이스 params 에 `result: { text: 'Hello World', usage: … }`.

### M4-18. 밀스톤 M4 검증

```bash
pnpm format:fix && pnpm build && pnpm typecheck && pnpm lint && pnpm format && pnpm test && pnpm test:storage
rg -n "runnerFactory|executeForTui|ChatExecutionPort|StreamEvent\b" packages/gateway/src packages/server/src/automation packages/web/src packages/tui/src   # 0
```

- 옛 체인 소비자 0 확인: `rg -n "runnerFactory|RunnerExecutionAdapter|CliProviderAdapter" packages/*/src` 결과가 `composition/{runtime,providers}.ts`·`auto-reply/execution-adapter.ts`·`packages/agent/src/**` 뿐이어야 한다(= M5 삭제 대상).
- **go/no-go G2·G7 — 첫 실측 시점(수동, 실 CLI 있을 때 권장, 최종 스모크 §7 에서 재확인):**
  ```bash
  pnpm build && node packages/server/dist/main.js        # (M11 전이라 DISCORD_BOT_TOKEN 필요)
  pnpm --filter @finclaw/web dev   # http://localhost:5173/?token=<jwt>  — M10 전에는 GATEWAY_JWT_SECRET 로 signToken 한 값
  ```
  "애플 주가 알려줘" →
  | # | 판정 | no-go 폴백 |
  | --- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | G2 | WS `chat.stream.end.result.text` 가 비어 있지 않고 마지막 assistant 텍스트와 같음 | **M1-9** 적용(+10줄, 이 M4 커밋 또는 별도 `fix(phase46)` 커밋) |
  | G7 | 서버 로그에 `cli.run.error{mcp_unavailable}` 없음 · `agent_runs` 최신 행 `tool_calls_json` 에 `route_task` · 도구 ctx `sessionId` = `tui:<sub>:default`(`tool:execute:*` 이벤트·감사 로그) | MCP 미연결: `error{mcp_unavailable}` 가 WS `chat.stream.error` 로 1회 나가는지 확인(경로 검증) 후 `/mcp` 인증 secret 일치 확인. identity 가 `mcp` 면 N3 미해결 → `composition/runtime.ts` 의 `mintToken` 재작업 |

### M4-19. 커밋

```
refactor(phase46): route chat, scheduler and agent.run through AgentRuntime

chat.send now returns {runId} immediately and streams real token deltas,
then confirms with chat.stream.end carrying the canonical text; it used to
await a 60s run behind a 30s client request timeout and never emitted done
(B3). Cron and agent.run become one-shot runtime runs, so agent_runs gets
exactly one row per run (the scheduler wrote duplicates) and Web/TUI turns
get recall and capture (N6). The Runner chain is now unused; removed next.

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
```

---

## 밀스톤 M5 — 옛 실행 체인 삭제 (삭제만, 단독 커밋)

### M5-1. 삭제 전 재검증 (phase44 원칙)

각 심볼의 비-self·비-test 소비처가 0 이어야 삭제한다. 나오면 그 심볼만 보류 + review 기록.

```bash
for s in Runner RunnerFactory RunnerTracerAdapter ChatExecutionPort StreamEvent StreamEventListener ExecutionResult \
         extractAssistantText ProviderAdapter CliProviderAdapter runCliAgent DEFAULT_CLAUDE_BACKEND \
         spawnWithWatchdog enqueueCliRun parseCliJson resolveCliNoOutputTimeoutMs StreamChunk NormalizedUsage \
         CliFailoverError CliFailoverReason RunnerExecutionAdapter ExecutionAdapter executeForTui AgentRunParams; do
  echo "== $s"; rg -n "\b$s\b" packages/*/src --glob '!**/*.test.ts' \
    | grep -v -E "packages/agent/src/(execution|providers|models)/|auto-reply/execution-adapter.ts"
done
```

기대: `packages/agent/src/index.ts`(M5-4 에서 정리)·`packages/server/src/composition/{runtime,providers}.ts`(M5-9/10)·`packages/types/src/agent.ts`(M5-8) 외 0.

### M5-2. DELETE 프로덕션 (plan §5)

| 파일                                                                                                         | 비고                                         |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `packages/agent/src/execution/{runner,streaming,chat-execution-port,message-utils,index}.ts`                 | 디렉터리째                                   |
| `packages/agent/src/providers/adapter.ts`                                                                    |                                              |
| `packages/agent/src/providers/claude-cli/{adapter,runner,parsers,spawn,backends,types,reliability,queue}.ts` | `errors.ts` 만 남김 (M5-3)                   |
| `packages/agent/src/models/provider-normalize.ts`                                                            | 디렉터리째                                   |
| `packages/server/src/auto-reply/execution-adapter.ts`                                                        | `extractCitedMemoryIds` 는 M5-6 에서 이동 후 |

### M5-3. EDIT `packages/agent/src/providers/claude-cli/errors.ts` — D5 완료

```ts
// packages/agent/src/providers/claude-cli/errors.ts
// Phase 46 D5: CliFailoverError/Reason 삭제(유일 사용처 runner.ts 삭제). stderr·result 분류만 — cli-driver 가 사용.
import type { AgentErrorReason } from '../../runtime/types.js';

const TIMEOUT_RE = /timeout|timed out|deadline exceeded|no output for/i;
const AUTH_RE = /(unauthor|forbid|invalid.+token|please log ?in|claude login)/i;
const RATE_LIMIT_RE = /(rate ?limit|too many req|quota)/i;

export function classifyCliError(
  message: string,
): Extract<AgentErrorReason, 'auth' | 'rate_limit' | 'timeout' | 'unknown'> {
  if (AUTH_RE.test(message)) {
    return 'auth';
  }
  if (RATE_LIMIT_RE.test(message)) {
    return 'rate_limit';
  }
  if (TIMEOUT_RE.test(message)) {
    return 'timeout';
  }
  return 'unknown';
}
```

### M5-4. EDIT `packages/agent/src/index.ts` — 옛 export 제거 (최종형)

```ts
// @finclaw/agent — complete barrel export

// ─── auth: health ───
export { ProfileHealthMonitor } from './auth/health.js';
export type { ModelStats } from './auth/health.js';

// ── Phase 7: Tools ──
export type {
  ToolGroupId,
  RegisteredToolDefinition,
  ToolExecutor,
  ToolExecutionContext,
  ToolRegistry,
} from './agents/tools/index.js';
export { InMemoryToolRegistry, jsonSchemaToZod } from './agents/tools/index.js';

// ── Phase 46: AgentRuntime driver seam ──
export { buildCliArgs, createCliDriver, type CliDriverOptions } from './runtime/cli-driver.js';
export type {
  AgentDriver,
  AgentErrorReason,
  AgentEvent,
  AgentRunPort,
  AgentRunRequest,
  AgentUsage,
  DriverRequest,
} from './runtime/types.js';
```

### M5-5. DELETE 테스트 (plan §5)

`packages/agent/test/runner.test.ts` · `packages/agent/test/providers/claude-cli/{adapter,backends,parsers,queue,queue-override,reliability,runner,spawn,runner.live}.test.ts`(디렉터리째) · `packages/server/src/auto-reply/__tests__/execution-adapter.test.ts`.

### M5-6. MOVE `extractCitedMemoryIds` → `packages/server/src/agent-runtime/runtime.ts`

`execution-adapter.ts:47-69` 의 함수(주석 포함)를 `runtime.ts` 하단 헬퍼 영역에 **그대로** 붙이고 `export` 유지. `runtime.ts` 의 `import { extractCitedMemoryIds } from '../auto-reply/execution-adapter.js';` 삭제.

```ts
/**
 * Phase 29 B: 응답 텍스트의 `[mem:xxxxxx]` 마커 (id 첫 6-8자, 또는 콤마 구분 다중)
 * 를 추출하여 candidates 의 실제 id 와 prefix-match. (phase46 M5: execution-adapter.ts 에서 이동)
 * ... 기존 주석 ...
 */
export function extractCitedMemoryIds(/* 본문 그대로 */);
```

`packages/server/src/auto-reply/__tests__/memory-citation.test.ts`:

```ts
import { extractCitedMemoryIds } from '../../agent-runtime/runtime.js';
```

### M5-7. EDIT `packages/server/src/auto-reply/pipeline-context.ts` — 고아 `retrievalResult` 제거

```ts
// packages/server/src/auto-reply/pipeline-context.ts
import type { ChannelCapabilities, MsgContext } from '@finclaw/types';
// 삭제: import type { RetrievalResult } from './stages/memory-retrieval.js';

export interface PipelineMsgContext extends MsgContext {
  // ... normalizedBody / mentions / urls / channelCapabilities / capturedMemory 그대로 ...
  // 삭제: --- 기억 retrieval (Phase 26 C) --- retrievalResult?: RetrievalResult;
}
```

### M5-8. EDIT `packages/types/src/agent.ts` — `AgentRunParams` 삭제 [TQ10]

- `AgentRunParams` 인터페이스와 그 위 NOTE(phase43) 주석 블록 삭제.
- `AgentProfile` doc 의 "이 프로필로 서브에이전트를 선택·호출하고, AgentRunParams 로 실행한다." → "이 프로필로 서브에이전트를 선택·호출한다 (실행은 AgentDriver 1-shot)."
- `TokenUsage` 는 이 삭제로 소비자 0 이 된다 → 같이 삭제(권고, TQ10). 보류하면 review 에 dead type 으로 기록.

### M5-9. EDIT `packages/server/src/composition/providers.ts` (+ test) — 레지스트리만

```ts
// packages/server/src/composition/providers.ts
// Phase 36: main.ts 274-303 에서 추출. Phase 46: CLI 실행은 agent-runtime 드라이버로 이동 — 도구 레지스트리만 남음.

import { InMemoryToolRegistry } from '@finclaw/agent';
import type { FinClawLogger } from '@finclaw/infra';

export interface BuildProvidersDeps {
  readonly logger: FinClawLogger;
}

export interface ProvidersBundle {
  readonly toolRegistry: InMemoryToolRegistry;
}

export function buildProviders({ logger }: BuildProvidersDeps): ProvidersBundle {
  logger.info('provider.initialized', {
    event: 'provider.initialized',
    providerKind: 'claude-cli',
  });
  return { toolRegistry: new InMemoryToolRegistry() };
}
```

`providers.test.ts`: `buildProviders({ logger })` → `expect(b.toolRegistry).toBeDefined()` 만. 제목 `'creates toolRegistry (phase46: CLI 실행은 runtime 드라이버)'`.

### M5-10. EDIT `packages/server/src/composition/runtime.ts` — Runner/adapter 제거

- import 에서 `Runner`·`ProviderAdapter`·`RunnerFactory`·`RunnerTracerAdapter`·`ConcurrencyLaneManager`·`RunnerExecutionAdapter` 삭제(`ConcurrencyLane` 은 buildAutomation 이 계속 씀).
- `BuildExecutionDeps` 에서 `providerAdapter`·`lanes` 삭제. `ExecutionBundle` 에서 `runnerFactory`·`adapter` 삭제.
- `buildExecution` 본문에서 `tracerAdapter`·`runnerFactory`·`adapter` 생성 블록 삭제(→ `agent.turn`/`provider.stream` span 은 사라진다. trace_id 는 runtime 이 agent_runs 에 계속 부착 — TQ16).

```ts
export function buildExecution(deps: BuildExecutionDeps): ExecutionBundle {
  const {
    storage,
    profileHealth,
    logger,
    defaultModel,
    systemPrompt,
    driver,
    embeddingProvider,
    finclawConfig,
    mcp,
  } = deps;

  // Phase 30 A6: OTel tracer — span 을 SQLite spans 테이블에 SQL exporter 로 기록.
  const tracer = createTracer({ db: storage.db });

  // ... M3 의 rerank / wireMemoryServices / new AgentRuntime 그대로 ...

  return { tracer, runtime, attachMemoryService };
}
```

### M5-11. EDIT `packages/server/src/main.ts`

```ts
const { toolRegistry } = buildProviders({ logger });
// ...
const { tracer, runtime, attachMemoryService } = buildExecution({
  storage,
  profileHealth,
  logger,
  defaultModel: DEFAULT_MODEL,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  driver,
  embeddingProvider,
  finclawConfig,
  mcp: { url: `http://127.0.0.1:${gatewayPort}/mcp`, jwtSecret: defaultConfig.auth.jwtSecret },
});
```

`// 4. Agent 레이어 (툴 레지스트리 + 러너 팩토리)` 주석 → `(툴 레지스트리)`.

### M5-12. EDIT config — `cliBackend.timeoutMs`·`cliBackend.watchdog` 제거 (S12)

`packages/config/src/zod-schema.ts`:

```ts
  cliBackend: z
    .strictObject({
      command: z.string().optional(),
    })
    .optional(),
```

`config.example.json5`:

```json5
  cliBackend: {
    command: 'claude', // claude CLI 실행 경로
  },
```

`packages/types/src/config.ts` [TQ10] — 스키마와 짝:

```ts
/** Phase 32 W6: claude-cli 백엔드 config 오버라이드. Phase 46: 타임아웃·워치독은 코드 상수 (D8). */
export interface CliBackendOptions {
  command?: string;
}
```

`packages/config/test/zod-schema.test.ts`: `'유효한 전체 설정'` 의 `cliBackend` 를 `{ command: 'claude' }` 로, 신규 1케이스:

```ts
it('phase46: cliBackend.timeoutMs·watchdog 는 거부된다 (strict, S12)', () => {
  expect(FinClawConfigSchema.safeParse({ cliBackend: { timeoutMs: 60_000 } }).success).toBe(false);
  expect(
    FinClawConfigSchema.safeParse({
      cliBackend: { watchdog: { fresh: { noOutputTimeoutRatio: 0.5 } } },
    }).success,
  ).toBe(false);
});
```

### M5-13. 밀스톤 M5 검증

```bash
pnpm format:fix && pnpm build && pnpm typecheck && pnpm lint && pnpm format && pnpm test && pnpm test:storage
pnpm test:ci   # 삭제 커밋이라 병렬 러너로 한 번 더
rg -n "\bRunner\b|CliProviderAdapter|runCliAgent|ChatExecutionPort|StreamEvent\b|executeForTui" packages/*/src   # 0
rg -n "execution-adapter|providers/claude-cli/(adapter|runner|spawn|parsers|backends|types|reliability|queue)|execution/" packages/*/src packages/*/test  # 0
```

- unit 수치: 삭제 테스트(claude-cli 9파일 · runner · execution-adapter) 만큼 감소 + config 1 증가. 순수치를 커밋 본문·review 에 기록.
- 되돌리기: 이 커밋 하나 `git revert` 로 옛 체인 복구 가능(M3·M4 는 옛 체인에 의존하지 않으므로 revert 후에도 green — R5).

### M5-14. 커밋

```
refactor(phase46): remove Runner and provider adapter chain

All four entry points and the sub-agent run through AgentRuntime and the
stream-json driver since the previous two commits, so the Runner,
CliProviderAdapter, the json-mode spawn/queue/watchdog helpers,
RunnerExecutionAdapter and their tests have no consumers left. Kept as a
deletion-only commit so it can be reverted on its own. The removed
cliBackend.timeoutMs/watchdog keys are now rejected by the strict config
schema; timeouts are code constants (plan D8).

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
```

---

## 밀스톤 M6 — 도구 이벤트 + chat.abort / chat.reset

클라이언트 변경 없음(D3 — Web `app-chat.ts`·TUI `App.tsx` 의 `switch(method)` 에 default 가 없어 `chat.stream.tool` 은 무시됨).

### M6-1. EDIT `packages/types/src/notification.ts` — `ChatStreamToolParams`

```ts
/** chat.stream.tool — 도구 진행 (입력/결과 내용 미포함 — S14). tool_use→start, tool_result→end. */
export interface ChatStreamToolParams {
  readonly sessionId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly phase: 'start' | 'end';
  readonly isError?: boolean; // end 만
}
```

### M6-2. EDIT `packages/types/src/gateway.ts` — RpcMethod 유니온 [TQ7]

```ts
  | 'chat.start'
  | 'chat.send'
  | 'chat.abort'
  | 'chat.reset'
```

### M6-3. EDIT `packages/gateway/src/broadcaster.ts` — tool_use/tool_result → `chat.stream.tool`

```ts
import type {
  ChatStreamDeltaParams,
  ChatStreamEndParams,
  ChatStreamErrorParams,
  ChatStreamToolParams,
} from '@finclaw/types';

  // ponytail: tool_result 가 오지 않은 채 끝난 run(abort) 의 항목은 남는다 — 엔트리당 수십 바이트, 프로세스 수명 동안 무시 가능.
  private readonly toolNames = new Map<string, string>();

  // send() switch 에 추가 (표 주석에도 tool_use/tool_result → chat.stream.tool 즉시 1줄 추가):
      case 'tool_use':
        this.flushDelta(conn.id, sessionId, conn); // 순서 보존: 앞선 서술 delta 를 먼저
        this.toolNames.set(event.id, event.name);
        this.sendImmediate(conn, 'chat.stream.tool', {
          sessionId,
          runId,
          toolCallId: event.id,
          name: event.name,
          phase: 'start',
        } satisfies ChatStreamToolParams);
        break;
      case 'tool_result':
        this.flushDelta(conn.id, sessionId, conn);
        this.sendImmediate(conn, 'chat.stream.tool', {
          sessionId,
          runId,
          toolCallId: event.id,
          name: this.toolNames.get(event.id) ?? '',
          phase: 'end',
          isError: event.isError,
        } satisfies ChatStreamToolParams);
        this.toolNames.delete(event.id);
        break;
      default:
        break; // start 는 WS 로 보내지 않음 (plan §3-7)
```

### M6-4. EDIT `packages/gateway/src/rpc/methods/chat.ts` — `chat.abort`·`chat.reset` (plan §3-8)

`createChatMethods` 안, `sendHandler` 다음:

```ts
const abortHandler: RpcMethodHandler<{ sessionId: string; runId?: string }, { aborted: boolean }> =
  {
    method: 'chat.abort',
    description:
      '진행 중인 채팅 실행을 중단합니다 (종료 신호는 chat.stream.error{reason:aborted} 1회)',
    authLevel: 'token',
    schema: z.object({ sessionId: z.string(), runId: z.string().optional() }),
    async execute(params) {
      const active = activeRuns.get(params.sessionId);
      if (!active || (params.runId !== undefined && params.runId !== active.runId)) {
        return { aborted: false };
      }
      active.controller.abort(); // → driver SIGINT → 2s → SIGKILL → runtime 이 error{aborted} 1회 (I11)
      return { aborted: true };
    },
  };

const resetHandler: RpcMethodHandler<{ sessionId: string }, { reset: boolean }> = {
  method: 'chat.reset',
  description: '세션의 대화·CLI 세션 바인딩을 초기화합니다',
  authLevel: 'token',
  schema: z.object({ sessionId: z.string() }),
  async execute(params) {
    const session = deps.registry.getSession(params.sessionId);
    if (!session) {
      throw new Error('session not found');
    }
    // Q14: per-session lane 경유 — 진행 중 run 의 종료 기록 뒤에 삭제된다
    return { reset: await deps.runtime.reset(session.sessionKey) };
  },
};

return [startHandler, sendHandler, abortHandler, resetHandler];
```

### M6-5. EDIT `packages/gateway/src/broadcaster.test.ts` — tool 짝

```ts
describe('tool events (M6)', () => {
  it('tool_use → start, tool_result → end (같은 toolCallId·name, isError)', () => {
    const conn = createMockConn();
    broadcaster.send(conn, 'sess-1', 'run-1', { type: 'text_delta', text: '확인해 볼게요' });
    broadcaster.send(conn, 'sess-1', 'run-1', {
      type: 'tool_use',
      id: 't1',
      name: 'mcp__finclaw__route_task',
      input: { intent: 'price_lookup' },
    });
    broadcaster.send(conn, 'sess-1', 'run-1', { type: 'tool_result', id: 't1', isError: true });
    const msgs = (conn.ws.send as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      JSON.parse(c[0] as string),
    );
    expect(msgs.map((m) => m.method)).toEqual([
      'chat.stream.delta',
      'chat.stream.tool',
      'chat.stream.tool',
    ]);
    expect(msgs[1].params).toEqual({
      sessionId: 'sess-1',
      runId: 'run-1',
      toolCallId: 't1',
      name: 'mcp__finclaw__route_task',
      phase: 'start',
    });
    expect(msgs[2].params).toEqual({
      sessionId: 'sess-1',
      runId: 'run-1',
      toolCallId: 't1',
      name: 'mcp__finclaw__route_task',
      phase: 'end',
      isError: true,
    });
    expect(JSON.stringify(msgs)).not.toContain('price_lookup'); // 입력 내용 미포함 (S14)
  });
});
```

### M6-6. EDIT `packages/gateway/src/rpc/methods/chat.test.ts` — abort·reset

```ts
describe('chat.abort / chat.reset (M6)', () => {
  function abortableRuntime() {
    const reset = vi.fn().mockResolvedValue(true);
    const runtime: AgentRunPort = {
      async *run(req) {
        yield { type: 'text_delta', text: '분석 중' };
        await new Promise((resolve) =>
          req.signal.addEventListener('abort', resolve, { once: true }),
        );
        yield { type: 'error', runId: req.runId ?? '', reason: 'aborted', message: 'aborted' };
      },
      reset,
    };
    return { runtime, reset };
  }

  const rpc = (method: string, params: Record<string, unknown>) =>
    dispatchRpc(
      { jsonrpc: '2.0', id: 1, method: method as RpcMethod, params },
      { auth: { level: 'token' }, remoteAddress: '127.0.0.1' },
      ctx,
    );

  it('abort → {aborted:true} + chat.stream.error{reason:aborted} 정확히 1회', async () => {
    const { runtime } = abortableRuntime();
    const conn = mockConn();
    const sessionId = await startSession(runtime, conn); // M4-11 헬퍼를 describe 밖으로 올려 공유
    const { result } = (await rpc('chat.send', { sessionId, message: '길게 분석해줘' })) as {
      result: { runId: string };
    };
    const aborted = (await rpc('chat.abort', { sessionId })) as { result: { aborted: boolean } };
    expect(aborted.result.aborted).toBe(true);
    await vi.waitFor(() =>
      expect(conn.sent.some((m) => m.method === 'chat.stream.error')).toBe(true),
    );
    const errors = conn.sent.filter((m) => m.method === 'chat.stream.error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.params).toMatchObject({ sessionId, runId: result.runId, reason: 'aborted' });
  });

  it('runId 가 다르면 {aborted:false}', async () => {
    const { runtime } = abortableRuntime();
    const sessionId = await startSession(runtime, mockConn());
    await rpc('chat.send', { sessionId, message: 'x' });
    const res = (await rpc('chat.abort', { sessionId, runId: 'other' })) as {
      result: { aborted: boolean };
    };
    expect(res.result.aborted).toBe(false);
    await rpc('chat.abort', { sessionId }); // 정리
  });

  it('진행 중 run 이 없으면 {aborted:false}', async () => {
    const { runtime } = abortableRuntime();
    const sessionId = await startSession(runtime, mockConn());
    const res = (await rpc('chat.abort', { sessionId })) as { result: { aborted: boolean } };
    expect(res.result.aborted).toBe(false);
  });

  it('reset → runtime.reset(session.sessionKey)', async () => {
    const { runtime, reset } = abortableRuntime();
    const sessionId = await startSession(runtime, mockConn());
    const res = (await rpc('chat.reset', { sessionId })) as { result: { reset: boolean } };
    expect(res.result.reset).toBe(true);
    expect(reset).toHaveBeenCalledWith('tui:local:default');
  });
});
```

(`RpcMethod` 를 `@finclaw/types` 에서 import.)

### M6-7. 밀스톤 M6 검증

```bash
pnpm format:fix && pnpm build && pnpm typecheck && pnpm lint && pnpm format && pnpm test && pnpm test:storage
pnpm vitest run packages/gateway/src/broadcaster.test.ts packages/gateway/src/rpc/methods/chat.test.ts
```

### M6-8. 커밋

```
feat(phase46): stream tool events and add chat.abort and chat.reset

Clients could not see that a tool was running (a route_task call is silent
for up to 90s) and had no way to stop a run or start over. Forward
tool_use/tool_result as chat.stream.tool start/end keyed by toolCallId
(no tool inputs or results on the wire), abort the active run through its
own AbortController so the client gets exactly one chat.stream.error
{reason:'aborted'}, and reset through the runtime's per-session lane so a
finishing run cannot resurrect the deleted session.

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
```

---

## 밀스톤 M7 — 명령 응답 + Discord 실행 에러 전달 (B4, Q10)

### M7-1. EDIT `packages/server/src/auto-reply/stages/command.ts` — 결과를 `CommandStageResult` 로 반환

```ts
// packages/server/src/auto-reply/stages/command.ts
import type { MsgContext } from '@finclaw/types';
import type { CommandRegistry, CommandResult } from '../commands/registry.js';
// 삭제: import type { StageResult } from '../pipeline.js';

export interface CommandStageResult {
  readonly handled: boolean;
  readonly commandResult?: CommandResult;
}

/**
 * 명령어 단계 — 명령이면 실행 결과를 돌려주고(B4: 예전엔 버렸다) pipeline 이 채널로 보낸다.
 * 코드 펜스 안·미등록·비명령은 handled:false (일반 메시지로 AI 에 전달).
 */
export async function commandStage(
  normalizedBody: string,
  registry: CommandRegistry,
  prefix: string,
  ctx: MsgContext,
): Promise<CommandStageResult> {
  if (isInsideCodeFence(normalizedBody, prefix)) {
    return { handled: false };
  }
  const parsed = registry.parse(normalizedBody, prefix);
  if (!parsed) {
    return { handled: false };
  }
  const command = registry.get(parsed.name);
  if (!command) {
    return { handled: false };
  }
  return { handled: true, commandResult: await command.executor(parsed.args, ctx) };
}

// isInsideCodeFence 그대로
```

### M7-2. EDIT `packages/server/src/auto-reply/pipeline.ts` — 명령 응답 전송

```ts
import type { CommandRegistry, CommandResult } from './commands/registry.js';

      // Stage 2: Command
      if (combinedSignal.aborted) {
        this.logAbort('command');
        return;
      }
      const cmdResult = await stageSpan('command', async () =>
        commandStage(normalized.normalizedBody, this.deps.commandRegistry, this.config.commandPrefix, ctx),
      );

      if (cmdResult.handled) {
        await this.replyToCommand(ctx, cmdResult.commandResult);
        return;
      }

  // 클래스 private 메서드로 추가 (logAbort 옆)
  /** B4: 명령 결과를 채널로 보낸다. 실패는 로그만 (명령 자체는 이미 실행됨). */
  private async replyToCommand(ctx: MsgContext, result: CommandResult | undefined): Promise<void> {
    const channel = this.deps.getChannel(ctx.channelId as string);
    if (!result || !channel?.send) {
      return;
    }
    try {
      await channel.send({
        channelId: ctx.channelId,
        targetId: ctx.chatId ?? ctx.senderId,
        payloads: [{ text: result.content, replyToId: ctx.messageThreadId }],
      });
    } catch (error) {
      this.deps.logger.error('Command reply failed', { error });
    }
  }
```

### M7-3. EDIT `packages/server/src/auto-reply/stages/execute.ts` — reason → 고정 한국어 문구 (plan §3-8)

```ts
import type { AgentErrorReason, AgentEvent, AgentRunPort } from '@finclaw/agent';

/** Q10: raw message 는 보내지 않는다(credential 섞임 위험). aborted 는 무응답. 문구 = plan §3-8 그대로. */
const ERROR_REPLY: Partial<Record<AgentErrorReason, string>> = {
  auth: 'Claude 로그인이 필요합니다. 서버에서 `claude login` 을 실행해 주세요.',
  rate_limit: 'Claude 사용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.',
  timeout: '응답 시간이 초과되었습니다. 질문을 나눠서 다시 시도해 주세요.',
};
const FALLBACK_ERROR_REPLY = '응답 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';

// executeStage 의 M3 abort 분기 교체:
if (terminal?.type !== 'done') {
  const reason: AgentErrorReason = terminal?.reason ?? 'unknown';
  if (reason === 'aborted') {
    return { action: 'skip', reason: 'agent run aborted' };
  }
  const reply = ERROR_REPLY[reason] ?? FALLBACK_ERROR_REPLY;
  return {
    action: 'continue',
    data: { content: reply, controlTokens: extractControlTokens(reply) },
  };
}
```

### M7-4. EDIT 테스트

`command.test.ts` — `result.action` 단언을 `handled` 로:

```ts
it('명령어가 아닌 메시지는 handled=false', async () => {
  const result = await commandStage('hello world', new InMemoryCommandRegistry(), '/', makeCtx());
  expect(result).toEqual({ handled: false });
});

it('등록된 명령어를 실행하고 결과를 돌려준다 (B4)', async () => {
  const registry = new InMemoryCommandRegistry();
  registerBuiltInCommands(registry, { storage: {} as StorageAdapter });
  const result = await commandStage('/help', registry, '/', makeCtx());
  expect(result.handled).toBe(true);
  expect(result.commandResult?.content).toContain('사용 가능한 명령어');
});
// 미등록 → handled:false, 코드펜스 → handled:false, 별칭 '/h' → handled:true 로 같은 방식 치환
```

`pipeline.test.ts` — 추가:

```ts
it('B4: 명령 결과를 채널로 보내고 AI 는 호출하지 않는다', async () => {
  const channel = makeChannel();
  const runtime = fakeRuntime('AI response');
  const pipeline = new AutoReplyPipeline(
    makeConfig(),
    makeDeps({ runtime, getChannel: () => channel }),
  );
  await pipeline.process(makeCtx({ body: '/help' }));
  expect(runtime.calls).toHaveLength(0);
  expect(channel.send).toHaveBeenCalledWith(
    expect.objectContaining({
      payloads: [expect.objectContaining({ text: expect.stringContaining('사용 가능한 명령어') })],
    }),
  );
});

it.each([
  ['auth', 'Claude 로그인이 필요합니다'],
  ['rate_limit', 'Claude 사용 한도에 도달했습니다'],
  ['timeout', '응답 시간이 초과되었습니다'],
  ['unknown', '응답 생성 중 오류가 발생했습니다'],
] as const)('Q10: %s → 고정 문구, raw message 미포함', async (reason, phrase) => {
  const channel = makeChannel();
  const pipeline = new AutoReplyPipeline(
    makeConfig(),
    makeDeps({ runtime: errorRuntime(reason), getChannel: () => channel }),
  );
  await pipeline.process(makeCtx());
  const text = vi.mocked(channel.send).mock.calls[0]?.[0].payloads[0]?.text ?? '';
  expect(text).toContain(phrase);
  expect(text).not.toContain('token=secret');
});

it('Q10: aborted 는 무응답', async () => {
  const channel = makeChannel();
  const pipeline = new AutoReplyPipeline(
    makeConfig(),
    makeDeps({ runtime: errorRuntime('aborted'), getChannel: () => channel }),
  );
  await pipeline.process(makeCtx());
  expect(channel.send).not.toHaveBeenCalled();
});
```

M3 에서 바꾼 `'runtime error 이벤트면 아무것도 전송하지 않는다'` 케이스는 삭제(위 it.each 가 대체). 기존 `'명령어 메시지 시 command 스테이지에서 끝나고 AI 를 호출하지 않는다'` 는 위 B4 케이스로 흡수.

### M7-5. 밀스톤 M7 검증

```bash
pnpm format:fix && pnpm build && pnpm typecheck && pnpm lint && pnpm format && pnpm test && pnpm test:storage
pnpm vitest run packages/server/src/auto-reply
```

### M7-6. 커밋

```
fix(phase46): reply to commands and report run errors on Discord

`!finclaw help/status/reset` executed but their result was dropped, so the
user saw nothing (B4). Return the command result from the command stage
and send it to the channel. Runtime errors are now reported with a fixed
Korean sentence per reason instead of silence; the raw CLI message is never
sent because it can carry credentials, and aborted runs stay silent.

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
```

---

## 밀스톤 M8 — 결정적 cron stagger (B5)

현재 tick 은 정각 cron 마다 `Math.random() * 5분` 이 0 이 아닐 때 skip → 다음 분에도 같은 확률로 skip → 사실상 영영 안 돈다.

### M8-1. EDIT `packages/server/src/automation/stagger.ts` — 단일 지점 추가

```ts
// packages/server/src/automation/stagger.ts
import { createHash } from 'node:crypto';
import { nextRunAt as computeNextRunAt, parseCron } from '@finclaw/infra';

// ... 기존 DEFAULT_TOP_OF_HOUR_STAGGER_MS / isRecurringTopOfHourCronExpr / normalizeCronStaggerMs /
//     resolveDefaultCronStaggerMs / resolveCronStaggerMs 그대로 ...

/** B5: schedule.id 해시로 결정적 오프셋. 같은 id → 같은 오프셋, stagger 0 → 0. */
export function staggerOffsetMs(scheduleId: string, staggerMs: number): number {
  if (staggerMs <= 0) {
    return 0;
  }
  return createHash('sha256').update(scheduleId).digest().readUInt32BE(0) % staggerMs;
}

/**
 * 다음 실행 시각의 단일 지점 — cron 다음 발화 + 결정적 stagger 오프셋.
 * ponytail: 오프셋 < staggerMs(기본 5분) < cron 간격(정각 cron 은 1h) 을 가정. 명시 staggerMs 가 간격보다 크면 발화가 밀린다.
 * 파싱 실패는 throw (호출자가 기존처럼 처리).
 */
export function nextStaggeredRunAt(
  schedule: { readonly id: string; readonly cron: string; readonly staggerMs?: number | string },
  fromMs: number,
): number | null {
  const next = computeNextRunAt(parseCron(schedule.cron), fromMs);
  return next === null ? null : next + staggerOffsetMs(schedule.id, resolveCronStaggerMs(schedule));
}
```

### M8-2. EDIT `packages/server/src/automation/scheduler.ts` — random skip 삭제, 두 계산 지점을 `nextStaggeredRunAt` 으로

```ts
import { nextStaggeredRunAt } from './stagger.js';   // resolveCronStaggerMs import 교체
// nextRunAt/parseCron import 는 고아가 되면 제거

  // tick() — tick_skipped_active 분기:
        try {
          const next = nextStaggeredRunAt(s, now);
          markScheduleRun(this.deps.db, s.id, s.lastRunId ?? null, s.lastRunAt ?? now, next);
        } catch {
          /* swallow */
        }
        continue;
      }
      // 삭제: const staggerMs = resolveCronStaggerMs(s); if (staggerMs > 0) { ... Math.random ... continue; }
      void this.runOne(s, { manual: false });

  // runOne() — next_run_at 갱신:
        let nextMs: number | null = null;
        try {
          nextMs = nextStaggeredRunAt(s, Date.now());
        } catch (cronErr) {
          // ... scheduler.cron_invalid 로그 그대로 ...
        }
```

`schedule.staggered` debug 로그는 skip 경로와 함께 삭제. RPC `schedule.create/update` 의 최초 `nextRunAt` 은 오프셋 없이 그대로(첫 발화만 정각 — TQ17).

### M8-3. CREATE `packages/server/src/automation/stagger.test.ts`

```ts
// packages/server/src/automation/stagger.test.ts
// Phase 46 M8 (B5): 결정적 stagger.
import { describe, expect, it } from 'vitest';
import { DEFAULT_TOP_OF_HOUR_STAGGER_MS, nextStaggeredRunAt, staggerOffsetMs } from './stagger.js';

const T = Date.UTC(2026, 10, 26, 1, 30, 0); // 01:30 UTC

describe('staggerOffsetMs', () => {
  it('같은 id → 같은 오프셋, 범위 [0, staggerMs)', () => {
    const a = staggerOffsetMs('sched-a', DEFAULT_TOP_OF_HOUR_STAGGER_MS);
    expect(staggerOffsetMs('sched-a', DEFAULT_TOP_OF_HOUR_STAGGER_MS)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });

  it('stagger 0 이면 0', () => {
    expect(staggerOffsetMs('sched-a', 0)).toBe(0);
  });
});

describe('nextStaggeredRunAt', () => {
  it('정각 cron: 다음 정각 + 결정적 오프셋', () => {
    const next = nextStaggeredRunAt({ id: 'sched-a', cron: '0 * * * *' }, T);
    expect(next).toBe(
      Date.UTC(2026, 10, 26, 2, 0, 0) + staggerOffsetMs('sched-a', DEFAULT_TOP_OF_HOUR_STAGGER_MS),
    );
  });

  it('정각이 아닌 cron 은 오프셋 0', () => {
    expect(nextStaggeredRunAt({ id: 'sched-a', cron: '15 * * * *' }, T)).toBe(
      Date.UTC(2026, 10, 26, 1, 15, 0) + 60 * 60_000,
    );
  });
});
```

(`'15 * * * *'` 의 다음 발화 = 02:15 UTC. `infra/cron` 의 시간대 해석이 UTC 가 아니면 implementer 가 `nextRunAt` 실제 값 기준으로 기대값을 맞춘다 — 검증 대상은 "오프셋 0".)

### M8-4. EDIT `packages/server/src/automation/scheduler.test.ts` — 정각 cron 이 매시 실행됨

```ts
describe('SchedulerService — 결정적 stagger (B5)', () => {
  it('정각 cron 은 due 가 되면 skip 없이 실행되고 next_run_at 은 다음 정각 + 같은 오프셋', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const s = addSchedule(database.db, {
      name: 'hourly',
      cron: '0 * * * *',
      agentId: createAgentId('finclaw-partner'),
      prompt: 'p',
      deliveryChannel: 'web',
      deliveryTarget: 'broadcast',
      nextRunAt: Date.UTC(2026, 10, 26, 1, 0, 0) as Timestamp,
    });
    const offset = staggerOffsetMs(s.id, DEFAULT_TOP_OF_HOUR_STAGGER_MS);
    vi.setSystemTime(Date.UTC(2026, 10, 26, 1, 0, 0) + offset);
    const random = vi.spyOn(Math, 'random');
    const { runtime, calls } = fakeRuntime(database.db, ['ok', 'ok']);
    const sched = new SchedulerService({ db: database.db, runtime, lane, logger: makeLogger() });
    const tick = () => (sched as unknown as { tick(): Promise<void> }).tick();

    await tick();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(random).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(getSchedule(database.db, s.id)?.nextRunAt).toBe(
        Date.UTC(2026, 10, 26, 2, 0, 0) + offset,
      ),
    );

    vi.setSystemTime(Date.UTC(2026, 10, 26, 2, 0, 0) + offset);
    await tick();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
  });
});
```

(`Timestamp` 는 `@finclaw/types`, `staggerOffsetMs`/`DEFAULT_TOP_OF_HOUR_STAGGER_MS` 는 `./stagger.js` 에서 import. `addSchedule` 의 `nextRunAt` 입력 키는 `storage/schedules.ts:65` 확인.)

### M8-5. 밀스톤 M8 검증

```bash
pnpm format:fix && pnpm build && pnpm typecheck && pnpm lint && pnpm format && pnpm test && pnpm test:storage
rg -n "Math.random" packages/server/src/automation   # 0
```

### M8-6. 커밋

```
fix(phase46): make cron stagger deterministic

The poller skipped a top-of-hour schedule whenever a random jitter in
[0, 5min) was non-zero and re-rolled every minute, so hourly cron jobs
practically never ran (B5). Drop the random skip and add a per-schedule
offset derived from a hash of the schedule id to the computed next run,
so the load is still spread but each job runs exactly once per slot.

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
```

---

## 밀스톤 M9 — MCP 유휴 세션 만료 (B12)

CLI 는 종료 시 `DELETE` 를 보내지 않고 transport `onclose` 도 안 불린다([L4] §3) → spawn 마다 transport 가 영구 누적.

### M9-1. EDIT `packages/gateway/src/mcp/host.ts` — `{transport, lastSeenAt}` + lazy sweep

```ts
/** B12: 유휴 TTL 10분 (> 메인 overall 300s — 진행 중 run 의 세션은 지우지 않는다). 타이머 없이 새 initialize 때 정리. */
export const MCP_IDLE_TTL_MS = 10 * 60_000;

interface TrackedTransport<T> {
  readonly transport: T;
  lastSeenAt: number;
}

/** 유휴 TTL 을 넘긴 transport 를 close + 삭제. (close → onclose 의 delete 와 중복돼도 무해.) */
export function sweepIdleTransports<T extends { close(): Promise<void> }>(
  transports: Map<string, TrackedTransport<T>>,
  now: number,
): void {
  for (const [sid, entry] of transports) {
    if (now - entry.lastSeenAt > MCP_IDLE_TTL_MS) {
      transports.delete(sid);
      void entry.transport.close().catch(() => {});
    }
  }
}

export function createMcpHost(toolRegistry: ToolRegistry, config: GatewayServerConfig): McpHost {
  const transports = new Map<string, TrackedTransport<StreamableHTTPServerTransport>>();

  return {
    async handleRequest(req, res): Promise<void> {
      // ① 인증 · ② body 파싱 그대로

      // ③ 세션 라우팅
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const entry = sessionId ? transports.get(sessionId) : undefined;
      if (entry) {
        entry.lastSeenAt = Date.now();
      }
      let transport = entry?.transport;

      if (!transport) {
        if (sessionId || !isInitializeRequest(parsedBody)) {
          // ... 400 그대로 ...
        }
        sweepIdleTransports(transports, Date.now());
        const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, { transport: created, lastSeenAt: Date.now() });
          },
        });
        // ... onclose(delete) · McpServer · registerBridgedTools · connect 그대로 ...
        transport = created;
      }

      await transport.handleRequest(req, res, parsedBody);
    },
  };
}
```

### M9-2. EDIT `packages/gateway/src/mcp/host.test.ts` — sweep

```ts
import { createMcpHost, MCP_IDLE_TTL_MS, sweepIdleTransports } from './host.js';

describe('sweepIdleTransports (B12)', () => {
  it('10분 넘게 유휴인 transport 만 close·삭제, 활성은 유지', () => {
    const idle = { close: vi.fn().mockResolvedValue(undefined) };
    const active = { close: vi.fn().mockResolvedValue(undefined) };
    const transports = new Map([
      ['idle', { transport: idle, lastSeenAt: 0 }],
      ['active', { transport: active, lastSeenAt: 9 * 60_000 }],
    ]);
    sweepIdleTransports(transports, MCP_IDLE_TTL_MS + 1);
    expect([...transports.keys()]).toEqual(['active']);
    expect(idle.close).toHaveBeenCalledOnce();
    expect(active.close).not.toHaveBeenCalled();
  });

  it('경계: 정확히 10분은 유지', () => {
    const t = { close: vi.fn().mockResolvedValue(undefined) };
    const transports = new Map([['s', { transport: t, lastSeenAt: 0 }]]);
    sweepIdleTransports(transports, MCP_IDLE_TTL_MS);
    expect(transports.size).toBe(1);
  });
});
```

(시계는 `now` 인자로 주입 — 가짜 시계와 동치.)

### M9-3. 밀스톤 M9 검증

```bash
pnpm format:fix && pnpm build && pnpm typecheck && pnpm lint && pnpm format && pnpm test && pnpm test:storage
pnpm vitest run packages/gateway/src/mcp
```

### M9-4. 커밋

```
fix(phase46): expire idle MCP sessions

The claude CLI never sends DELETE or closes its HTTP MCP session when it
exits (L4 §3), so the gateway kept one transport per spawn forever (B12).
Track lastSeenAt per transport and close sessions idle for more than 10
minutes whenever a new session initializes; no timer, and 10 minutes stays
above the 300s run ceiling so live runs are never cut.

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
```

---

## 밀스톤 M10 — loopback 바인딩 + 로컬 인증 토큰 (B6, B10)

### M10-1. CREATE `packages/server/src/composition/local-auth.ts`

D7. 경로는 **호출 시점**에 `homedir()` 로 계산한다(테스트는 `test-env.ts` 가 `beforeAll` 에서 `HOME` 을 tmpdir 로 바꾸므로 import 시점 상수면 실제 HOME 에 쓴다).

```ts
// packages/server/src/composition/local-auth.ts
// Phase 46 M10 (B6/B10): gateway JWT secret 해석·영속 + 로컬 토큰 파일 발급. 토큰·secret 은 로그에 남기지 않는다.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { signToken } from '@finclaw/gateway';

/** D7: sessionTtlMs(30분)는 로컬 토큰에 짧다 → 30일, 부팅마다 재발급. */
const LOCAL_TOKEN_TTL_S = 30 * 24 * 60 * 60;

const finclawDir = (): string => join(homedir(), '.finclaw');
const secretPath = (): string => join(finclawDir(), 'gateway.secret');
const tokenPath = (): string => join(finclawDir(), 'gateway.token');

/**
 * `GATEWAY_JWT_SECRET` 우선. 비었거나 없으면 `~/.finclaw/gateway.secret`
 * (최초 1회 32바이트 hex 생성, 0600, 이후 재사용). [TQ19] 빈 문자열은 미설정으로 본다 — 빈 secret 이면 토큰 위조가 가능.
 */
export function resolveJwtSecret(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GATEWAY_JWT_SECRET) {
    return env.GATEWAY_JWT_SECRET;
  }
  const existing = readOptional(secretPath());
  if (existing) {
    return existing;
  }
  const secret = randomBytes(32).toString('hex');
  writePrivate(secretPath(), secret);
  return secret;
}

/** 부팅마다 `{sub:'local', exp: now+30일}` 토큰을 `~/.finclaw/gateway.token`(0600) 에 재기록. */
export function issueLocalToken(secret: string, nowMs: number = Date.now()): void {
  writePrivate(
    tokenPath(),
    signToken({ sub: 'local', exp: Math.floor(nowMs / 1000) + LOCAL_TOKEN_TTL_S }, secret),
  );
}

/** TUI·CLI 용 — 파일이 없으면 undefined. */
export function readLocalToken(): string | undefined {
  return readOptional(tokenPath());
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function writePrivate(path: string, content: string): void {
  mkdirSync(finclawDir(), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600); // 이미 있던 파일은 writeFileSync 의 mode 가 적용되지 않는다
}
```

### M10-2. EDIT `packages/server/src/composition/constants.ts` — import 시점 env 평가 제거

```ts
// packages/server/src/composition/constants.ts
// Phase 36: main.ts 에서 추출한 공유 상수. Phase 46 M10: host·secret 은 부팅 시 main 이 해석(GATEWAY_HOST / local-auth).

import type { GatewayServerConfig } from '@finclaw/gateway';
import type { ModelRef } from '@finclaw/types';

/** 기본 게이트웨이 설정 — jwtSecret 은 타입으로 빠져 있어 main 이 반드시 채운다. */
export const defaultConfig: Omit<GatewayServerConfig, 'auth'> & {
  readonly auth: Omit<GatewayServerConfig['auth'], 'jwtSecret'>;
} = {
  host: '127.0.0.1', // B6: 0.0.0.0 → loopback. Docker 는 GATEWAY_HOST=0.0.0.0 (R8)
  port: 3000,
  cors: {
    // D7: vite dev/preview 포트. WS 는 vite proxy 경유라 CORS 무관.
    origins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    maxAge: 600,
  },
  auth: {
    apiKeys: [],
    sessionTtlMs: 30 * 60_000,
  },
  ws: {
    /* 그대로 */
  },
  rpc: {
    /* 그대로 */
  },
};

// DEFAULT_MODEL 그대로
```

### M10-3. EDIT `packages/server/src/main.ts` — secret·토큰·host 를 부팅 시 해석

```ts
import { issueLocalToken, resolveJwtSecret } from './composition/local-auth.js';

// 2a. 전체 config 로드 + strict 재검증 (그대로)
// ...
// Phase 46 M10 (B6/B10): JWT secret (env → ~/.finclaw/gateway.secret) + 로컬 토큰 파일. 값은 로그 금지.
const jwtSecret = resolveJwtSecret();
issueLocalToken(jwtSecret);

// buildExecution 의 mcp.jwtSecret: defaultConfig.auth.jwtSecret → jwtSecret
// buildProviders 는 M5 이후 jwtSecret 을 받지 않음

const gatewayConfig: GatewayServerConfig = {
  ...defaultConfig,
  host: process.env.GATEWAY_HOST || defaultConfig.host,
  port: gatewayPort,
  auth: {
    ...defaultConfig.auth,
    jwtSecret,
    apiKeys: process.env.FINCLAW_API_KEY ? [process.env.FINCLAW_API_KEY] : [],
  },
};
```

부팅 로그 `Gateway listening on ${host}:${port}` 는 그대로(URL·토큰 미포함 — D7).

### M10-4. EDIT `packages/server/src/cli/gateway-client.ts` — `Authorization: Bearer` (B10) [TQ18]

```ts
import { readLocalToken } from '../composition/local-auth.js';

export interface GatewayClientOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** 미지정 시 ~/.finclaw/gateway.token */
  readonly token?: string;
}

// callGateway 안:
  const token = opts?.token ?? readLocalToken();
  // ...
    const res = await fetch(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      // ... 그대로
```

(`getGatewayHealth` 는 public 엔드포인트라 변경 없음.)

### M10-5. EDIT `packages/server/src/cli/commands/tui.ts` — config → 토큰 파일

```ts
import { readLocalToken } from '../../composition/local-auth.js';
// ...
const token = config.gateway?.auth?.token ?? readLocalToken() ?? '';
```

### M10-6. EDIT `Dockerfile` · `docker-compose.yml` · `.env.example`

`Dockerfile` (runner stage, `ENV GATEWAY_PORT=3000` 아래):

```dockerfile
# B6: 기본은 loopback — 컨테이너 밖에서 publish 하려면 전 인터페이스 바인딩 (R8)
ENV GATEWAY_HOST=0.0.0.0
```

`docker-compose.yml` server `environment:` 에 `- GATEWAY_HOST=0.0.0.0` 추가.

`.env.example` Gateway 블록:

```bash
# Gateway (optional)
FINCLAW_API_KEY=
# 생략 시 ~/.finclaw/gateway.secret 을 자동 생성·재사용(0600). 빈 값도 미설정으로 본다.
# GATEWAY_JWT_SECRET=change-me
# GATEWAY_PORT=3000
# 바인딩 호스트 (기본 127.0.0.1). Docker 는 0.0.0.0.
# GATEWAY_HOST=127.0.0.1
```

### M10-7. CREATE `packages/server/src/composition/local-auth.test.ts`

```ts
// packages/server/src/composition/local-auth.test.ts
// Phase 46 M10: secret 0600·재사용·env 우선, 토큰 0600·검증 가능, defaultConfig loopback.
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from './constants.js';
import { issueLocalToken, readLocalToken, resolveJwtSecret } from './local-auth.js';

const dir = () => join(homedir(), '.finclaw'); // HOME = tmpdir (test-env.ts)
const mode = (p: string) => statSync(p).mode & 0o777;

beforeEach(() => {
  rmSync(dir(), { recursive: true, force: true });
});

describe('resolveJwtSecret', () => {
  it('env 가 없으면 32바이트 hex secret 을 0600 으로 만들고, 다음 부팅에 재사용', () => {
    const first = resolveJwtSecret({});
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(mode(join(dir(), 'gateway.secret'))).toBe(0o600);
    expect(resolveJwtSecret({})).toBe(first);
  });

  it('GATEWAY_JWT_SECRET 이 우선 — 파일을 만들지 않는다', () => {
    expect(resolveJwtSecret({ GATEWAY_JWT_SECRET: 'from-env' })).toBe('from-env');
    expect(existsSync(join(dir(), 'gateway.secret'))).toBe(false);
  });

  it('빈 GATEWAY_JWT_SECRET 은 미설정으로 본다 [TQ19]', () => {
    expect(resolveJwtSecret({ GATEWAY_JWT_SECRET: '' })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('issueLocalToken / readLocalToken', () => {
  it('0600 토큰 파일, sub=local · exp=+30일 · HS256 서명 검증', () => {
    const now = Date.UTC(2026, 10, 26);
    issueLocalToken('s3cret', now);
    const path = join(dir(), 'gateway.token');
    expect(mode(path)).toBe(0o600);
    const token = readLocalToken() ?? '';
    const [h, p, sig] = token.split('.');
    expect(createHmac('sha256', 's3cret').update(`${h}.${p}`).digest('base64url')).toBe(sig);
    const payload = JSON.parse(Buffer.from(p ?? '', 'base64url').toString('utf8'));
    expect(payload).toEqual({ sub: 'local', exp: now / 1000 + 30 * 24 * 60 * 60 });
    expect(readFileSync(path, 'utf8')).toBe(token);
  });

  it('파일이 없으면 undefined', () => {
    expect(readLocalToken()).toBeUndefined();
  });
});

describe('defaultConfig (B6)', () => {
  it('host 기본 127.0.0.1 · CORS 는 vite 5173 두 origin 만', () => {
    expect(defaultConfig.host).toBe('127.0.0.1');
    expect(defaultConfig.cors?.origins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });
});
```

### M10-8. EDIT `packages/server/src/cli/__tests__/gateway-client.test.ts` — 인증 헤더

```ts
import { issueLocalToken } from '../../composition/local-auth.js';

it('B10: opts.token 이 있으면 Authorization: Bearer', async () => {
  mockFetch.mockResolvedValue(new Response(JSON.stringify({ result: {} }), { status: 200 }));
  await callGateway('agent.list', undefined, { token: 'tok' });
  const init = mockFetch.mock.calls[0]?.[1];
  expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
});

it('B10: token 미지정이면 ~/.finclaw/gateway.token 을 쓴다', async () => {
  issueLocalToken('s');
  mockFetch.mockResolvedValue(new Response(JSON.stringify({ result: {} }), { status: 200 }));
  await callGateway('agent.list');
  const init = mockFetch.mock.calls[0]?.[1];
  expect((init?.headers as Record<string, string>).Authorization).toMatch(
    /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/,
  );
});
```

### M10-9. 밀스톤 M10 검증

```bash
pnpm format:fix && pnpm build && pnpm typecheck && pnpm lint && pnpm format && pnpm test && pnpm test:storage
rg -n "dev-secret|'0.0.0.0'|origins: \['\*'\]" packages/server/src --glob '!**/*.test.ts'   # 0 (테스트 픽스처 config 는 대상 아님)
```

### M10-10. 커밋

```
fix(phase46): bind gateway to loopback and issue local auth token

The gateway listened on 0.0.0.0 with CORS '*' and fell back to the JWT
secret 'dev-secret', so anyone on the network could mint tokens (B6), and
the CLI never sent auth headers (B10). Default to 127.0.0.1 (GATEWAY_HOST
overrides; Docker sets 0.0.0.0), allow only the vite origins, generate a
random secret once into ~/.finclaw/gateway.secret (0600) unless
GATEWAY_JWT_SECRET is set, and write a 30-day local token to
~/.finclaw/gateway.token (0600) that the TUI and CLI read. Tokens are never
logged.

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
```

---

## 밀스톤 M11 — Discord 없이 부팅 (I8)

### M11-1. EDIT `packages/server/src/main.ts` — `setupDiscord` 추출, 토큰 optional [TQ11]

```ts
import type { FinClawLogger } from '@finclaw/infra';
import type { ProcessLifecycle } from './process/lifecycle.js'; // (값 import 가 이미 있으면 그대로 사용)

/**
 * Phase 46 M11 (I8): DISCORD_BOT_TOKEN 이 없으면 Discord 만 비활성 — gateway·scheduler·Web/TUI 는 그대로.
 * 테스트 가능하도록 export (main() 은 VITEST 에서 실행되지 않음).
 */
export async function setupDiscord(
  token: string | undefined,
  deps: { readonly logger: FinClawLogger; readonly lifecycle: Pick<ProcessLifecycle, 'register'> },
): Promise<DiscordAdapter | undefined> {
  if (!token) {
    deps.logger.warn('discord.disabled', {
      event: 'discord.disabled',
      reason: 'DISCORD_BOT_TOKEN not set',
    });
    return undefined;
  }
  const adapter = new DiscordAdapter();
  const cleanup = await adapter.setup(DiscordAccountSchema.parse({ botToken: token }));
  deps.lifecycle.register(cleanup);
  deps.logger.info('Discord adapter logged in');
  return adapter;
}
```

`main()` 안:

```ts
  // 1. env 검증 — 삭제: const discordToken = requireEnv('DISCORD_BOT_TOKEN');
  // ...
  // 3. Discord (선택) — alerts DM 핸들 때문에 skills 등록 전에 로그인
  const discordAdapter = await setupDiscord(process.env.DISCORD_BOT_TOKEN, { logger, lifecycle });
  // (기존 3번 블록: new DiscordAdapter / parse / setup / register / 'logged in' 로그 삭제)

  const { ... } = await registerSkills({
    toolRegistry,
    storage,
    logger,
    discordClient: discordAdapter?.getClient() ?? undefined,
    lifecycle,
    driver,
  });

  // 7. Discord onMessage 등록 — 토큰이 있을 때만
  if (discordAdapter) {
    channelPluginRegistry.set(discordAdapter.id as string, discordAdapter);
    discordAdapter.onMessage(async (msg) => {
      await router.route(msg);
    });
    logger.info('Discord adapter connected');
  }

  // delivery hook:
      discordClient: discordAdapter?.getClient() ?? undefined,
```

고아 제거: `requireEnv`·`MissingEnvError` 의 유일한 프로덕션 사용처가 사라진다 → 두 export 와 `main().catch` 의 `MissingEnvError` 분기 삭제 [TQ11]. `MessageRouter` 는 Discord 가 없어도 생성(무해).

### M11-2. EDIT `packages/server/src/composition/skills.ts` — `discordClient?`

```ts
export interface RegisterSkillsDeps {
  readonly toolRegistry: InMemoryToolRegistry;
  readonly storage: Storage;
  readonly logger: FinClawLogger;
  /** Phase 46 M11: Discord 비활성이면 undefined — alerts 는 Discord DM 핸들러 없이 동작. */
  readonly discordClient?: NonNullable<ReturnType<DiscordAdapter['getClient']>>;
  readonly lifecycle: ProcessLifecycle;
  readonly driver: AgentDriver;
}

export async function registerSkills(deps: RegisterSkillsDeps): Promise<SkillsBundle> {
  const { toolRegistry, storage, logger, discordClient, lifecycle, driver } = deps;
  // ...
  if (marketHandle && newsHandle) {
    alertHandle = await registerAlertTools(toolRegistry, {
      // ...
      discordClient,
    });
```

(`const discordClient = discordAdapter.getClient();` 줄 삭제.)

### M11-3. EDIT `packages/server/src/main.test.ts` — Discord 게이트

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupDiscord } from './main.js';

// vi.mock 은 import 보다 먼저 호이스팅된다 → 팩토리가 쓰는 값은 vi.hoisted 로.
const { setup } = vi.hoisted(() => ({ setup: vi.fn().mockResolvedValue(async () => {}) }));
vi.mock('@finclaw/channel-discord', () => ({
  DiscordAccountSchema: { parse: (v: unknown) => v },
  // new 로 호출되므로 화살표 함수가 아니라 function (vitest 4)
  DiscordAdapter: vi.fn(function () {
    return { setup, id: 'discord', getClient: () => null };
  }),
}));

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
  flush: vi.fn(),
} as never;

describe('setupDiscord (I8)', () => {
  it('토큰이 없으면 discord.disabled warn 후 undefined — 로그인·cleanup 등록 없음', async () => {
    const register = vi.fn();
    const adapter = await setupDiscord(undefined, { logger, lifecycle: { register } });
    expect(adapter).toBeUndefined();
    expect((logger as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
      'discord.disabled',
      expect.objectContaining({ event: 'discord.disabled' }),
    );
    expect(setup).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('토큰이 있으면 기존처럼 로그인하고 cleanup 을 lifecycle 에 등록', async () => {
    const register = vi.fn();
    const adapter = await setupDiscord('bot-token', { logger, lifecycle: { register } });
    expect(adapter).toBeDefined();
    expect(setup).toHaveBeenCalledWith({ botToken: 'bot-token' });
    expect(register).toHaveBeenCalledOnce();
  });
});
```

`describe('requireEnv')` 3케이스 삭제(고아 함수 제거와 함께). `main boot wiring (Phase 29 E)` 케이스는 그대로(M4 의 `stubRuntime`).

### M11-4. 밀스톤 M11 검증

```bash
pnpm format:fix && pnpm build && pnpm typecheck && pnpm lint && pnpm format && pnpm test && pnpm test:storage
rg -n "requireEnv|MissingEnvError" packages/server/src   # 0
# 수동(§7 스모크 1단계와 동일): unset DISCORD_BOT_TOKEN; node packages/server/dist/main.js → 로그 discord.disabled · cli.version · Gateway listening on 127.0.0.1:3000
```

전체 `main()` 부팅을 단위 테스트로 돌리지 않는다(포트·실 config·process.exit 결합) — 게이트 함수 단위 + §7 스모크로 갈음 [TQ11].

### M11-5. 커밋

```
feat(phase46): boot without Discord token

The server refused to start without DISCORD_BOT_TOKEN even though the
gateway, scheduler and Web/TUI do not need Discord, which blocks the
phase47 desktop client (I8). Make the token optional: without it only the
Discord adapter is skipped and a discord.disabled warning is logged.
requireEnv/MissingEnvError lose their only caller and are removed.

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
```

---

## 밀스톤 M12 — 문서 동기화

### M12-1. EDIT `README.md`

plan M12 의 줄 번호(현 main 기준)를 따라 사실만 갱신한다 — 새 섹션 추가 없음.

| 줄       | 현재                                                          | 바꿀 내용                                                                                                                                                          |
| -------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| :10      | `agent.run` 결과 영속화 설명                                  | "모든 실행(Discord·Web/TUI·cron·agent.run)이 run 당 `agent_runs` 1행" 으로                                                                                         |
| :57      | `claude -p --output-format json`                              | `claude -p --output-format stream-json` 턴당 spawn + 격리 플래그(`--tools ""`·`--setting-sources ""`·`--strict-mcp-config`), cwd `~/.finclaw/agent`                |
| :92      | cron 이 `agent.run` 을 직접 실행                              | `AgentRuntime` oneShot(비영속, 직전 대화 없음, `<context>` 는 현재 시각만)                                                                                         |
| :122     | WS notification 목록                                          | `chat.stream.{delta,tool,end,error}` (모두 `runId`), RPC `chat.abort`·`chat.reset` 추가                                                                            |
| :128     | agent.run → memory                                            | 그대로(현 동작 유지) + "phase47 존폐 결정" 1구절                                                                                                                   |
| :191     | host `0.0.0.0`                                                | host `127.0.0.1` (`GATEWAY_HOST`)                                                                                                                                  |
| :192     | `--output-format json`                                        | stream-json                                                                                                                                                        |
| :207-235 | 시퀀스 다이어그램 `Rn as Runner`                              | `RT as AgentRuntime` · `DRV as cli-driver` — prepareTurn(capture·retrieval) 가 RT 안, `--resume`/`--session-id`, 스트림 이벤트. 부수 흐름 2줄도 runtime 으로       |
| :245     | agent 패키지 설명                                             | "stream-json 드라이버(`runtime/cli-driver.ts`), tool registry"                                                                                                     |
| :260     | 읽기 순서 5번 `execution/runner.ts` + `providers/claude-cli/` | `packages/agent/src/runtime/cli-driver.ts` + `packages/server/src/agent-runtime/{runtime,prepare-turn}.ts`                                                         |
| :273     | `DISCORD_BOT_TOKEN` 필수                                      | 선택 — 없으면 Discord 만 비활성(`discord.disabled`)                                                                                                                |
| :275     | `[fatal] Missing required env`                                | 해당 문장 삭제(필수 env 없음)                                                                                                                                      |
| :341     | 바인딩 호스트 코드 고정 `0.0.0.0`                             | `GATEWAY_HOST`(기본 `127.0.0.1`)                                                                                                                                   |
| :431     | `Missing required env: DISCORD_BOT_TOKEN` 트러블슈팅 행       | 행 삭제                                                                                                                                                            |
| :432     | 빈 `GATEWAY_JWT_SECRET=` 행                                   | "빈 값은 미설정 → `~/.finclaw/gateway.secret` 사용" 으로                                                                                                           |
| :445-447 | `'dev-secret'` fallback · `0.0.0.0` + CORS `*`                | secret 자동 생성(0600)·토큰 파일 30일·CORS 5173 2개·loopback. **Web 접속:** `http://localhost:5173/?token=$(cat ~/.finclaw/gateway.token)` (토큰은 로그에 안 찍힘) |

### M12-2. EDIT `.env.example` — `DISCORD_BOT_TOKEN` 선택 표기

```bash
# Discord (optional — 없으면 Discord 채널만 비활성, Web/TUI/cron 은 동작)
DISCORD_BOT_TOKEN=
```

### M12-3. EDIT `.claude/agents/runtime-tools-auditor.md`

- :3 description 의 `packages/agent/src/{execution,agents,providers}` → `packages/agent/src/{runtime,agents}, packages/server/src/agent-runtime/`
- :17 `packages/agent/src/execution/runner.ts` → `packages/agent/src/runtime/cli-driver.ts` + `packages/server/src/agent-runtime/runtime.ts`
- :19 `packages/agent/src/providers/{adapter.ts,claude-cli/*}` → `packages/agent/src/runtime/cli-driver.ts` (드라이버 seam: 실 구현 1 + 테스트 fake 1)

### M12-4. 그 외 삭제 파일 참조 정리

```bash
rg -n --hidden "execution/runner|execution-adapter|providers/claude-cli/(runner|adapter|spawn|parsers)|RunnerExecutionAdapter|CliProviderAdapter" \
   -g '!plans/**' -g '!_workspace/**' -g '!node_modules' -g '!**/dist/**' .
```

결과 줄마다 새 경로로 바꾼다(현재 기준 `README.md:260`·`runtime-tools-auditor.md:17` 외 0 — M5 가 소스 주석까지 지움).

### M12-5. 밀스톤 M12 검증

```bash
pnpm format:fix && pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm test:storage
# 위 M12-4 rg 결과 0
```

### M12-6. 커밋

```
docs(phase46): sync README, env and agent docs with agent runtime

README still described the json-mode Runner, a 0.0.0.0 gateway with a
dev-secret fallback and a mandatory Discord token. Describe the stream-json
driver, AgentRuntime sessions, the new chat.stream.tool / chat.abort /
chat.reset surface, loopback binding with the local token file (including
how to open Web with ?token=) and optional Discord; point the runtime
auditor agent at the new files.

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
```

---

## 최종 검증

phase 전체 완료 후:

- [ ] `pnpm build && pnpm typecheck && pnpm lint && pnpm format && pnpm test:ci && pnpm test:storage` (PR 전 CONTRIBUTING 게이트)
- [ ] mock-only 격리: `ANTHROPIC_API_KEY` 등 unset 상태에서 `pnpm test` 통과(`test-env.ts` 가 보장) · 실 CLI 는 `*.live.test.ts` 뿐(`rg -l "spawn\(|execSync\('claude" packages/*/test packages/*/src --glob '*.test.ts' | grep -v live` 결과가 mock 사용 파일뿐)
- [ ] 마이그레이션 0 (스키마 버전 불변 — `conversations.metadata` 재사용)
- [ ] 순수치 기록: unit(기준 960) / storage(기준 140) — 삭제·신규 내역을 review.md 에
- [ ] `pnpm test:live` (수동) → G3/G4/G5b/G6·격리 출력 → review.md §검증 **G1~G7 표**(D11)

### 수동 스모크 (plan §7 — 결과를 review.md §검증에)

1. **Discord 없이 부팅** — `unset DISCORD_BOT_TOKEN; pnpm build && node packages/server/dist/main.js` → 로그 `discord.disabled`·`cli.version`·`Gateway listening on 127.0.0.1:3000`, `ls -l ~/.finclaw/gateway.{secret,token}` = `-rw-------`.
2. **gateway chat 스트리밍** — `pnpm --filter @finclaw/web dev` → `http://localhost:5173/?token=$(cat ~/.finclaw/gateway.token)` → "애플 주가 알려줘": delta 점진 표시 → devtools WS `chat.stream.tool` start/end(`route_task`) → `chat.stream.end` 확정. **G2** end 의 `result.text` 비어 있지 않음(no-go → M1-9). **G7** 서버 로그에 mcp_unavailable 없음, `agent_runs` 최신 행 `tool_calls_json` 에 `route_task`, 도구 ctx `sessionId` = `tui:local:default`.
3. **2턴째 기억** — "내 이름은 자두야" → "내 이름이 뭐지?" → "자두". 두 run 의 `agent_runs.cli_session_id` 동일. "기억해: 나는 배당주를 선호해" → "내 투자 선호 알려줘" 응답에 `[mem:…]` + 해당 run `used_memory_ids` 채워짐 (B1·N5·N6).
4. **reset** — WS `chat.reset {sessionId}` → `{reset:true}` → "내 이름이 뭐지?" → 모름, 새 `cli_session_id`.
5. **abort** — "주요 빅테크 5개 종합 분석" 직후 `chat.abort {sessionId}` → `{aborted:true}`, 2s 안 `chat.stream.error{reason:'aborted'}` 1회, `pgrep -fl "claude -p"` 비어 있음(G3 재확인).
6. (보너스) `finclaw tui` 가 토큰 파일로 접속 · `finclaw agent list` 가 인증 헤더로 성공(B10) · `schedule.runNow` 로 cron 1회 → agent_runs 1행.

WS 수동 호출(4·5)은 `ws` 패키지로 쓴 일회성 `node -e` 스크립트 — 레포에 커밋하지 않음.

## 롤백 절차

밀스톤 = 1커밋, merge commit 으로 머지 → 단계적 revert:

- M12·M11·M10·M9·M8·M7·M6: 각각 독립(`git revert <sha>`). M10 revert 시 `~/.finclaw/gateway.{secret,token}` 파일은 남아도 무해.
- **M5 단독 revert** → 옛 체인 코드·config 키 복구(M3·M4 는 그 위에서도 green — R5). 경로는 새 체인 유지.
- M4 revert(M5 먼저 revert 필요) → chat·cron·agent.run 이 옛 체인으로.
- M3 revert → Discord·서브에이전트가 옛 체인으로(N1 재발 — 비권장).
- M1·M2 는 배선 0 이라 revert 해도 동작 변화 없음(위 커밋들을 먼저 되돌려야 빌드됨).
- 스키마 마이그레이션 없음 — `conversations.metadata.{cliSessionId,lastTurnAt}` 는 옛 코드가 무시한다.
