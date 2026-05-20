# Phase 32 Todo: Backend-as-CLI (Claude Max 구독 활용 → API 비용 0원)

> plan.md 밀스톤 A~H 를 코드 단위로 분해한 작업 가이드.
> **본 draft 는 plan.md 의 "## 인스펙션 결과 (Phase 32 보강 — post-phase31, 2026-05-20)" 섹션을 OVERRIDE 기준으로 삼아 작성** — 밀스톤 본문(F1 가공 인터페이스/G2 Runner fallback 등)이 아니라 보강의 재-grounding + 본문 라인 교정표(12행) + W1~W7 결정을 따른다.
> 모든 경로:라인은 현재 `feature/backend-as-cli` (base = phase31 머지 main) 코드와 직접 대조 확인됨.

> **✅ Q1 확정 = (A) (2026-05-20 사용자 결정):** cliSessionId 는 `CliProviderAdapter` 가 단일 사용자 전역 멤버(`#cliSessionId`)로 자체 보유 — 첫 응답 session_id 저장 → 다음 호출 `--resume`. `StreamChunk`/`ProviderRequestParams` 인터페이스 무변경. F1·G2·G3 가 이 전제로 작성됨.

---

## 사전 준비

### P-1. 디렉터리 + 패키지 의존 확인 (변경 없음)

신규 코드는 전부 `packages/agent` (이미 `@finclaw/types` 의존) 와 `packages/storage`/`packages/config`/`packages/server` 에 들어간다. **신규 workspace dep 없음.** `claude-cli/` 서브디렉터리만 신설:

- `packages/agent/src/providers/claude-cli/` (신규 디렉터리)
- `packages/agent/test/providers/claude-cli/` (신규 디렉터리)

의존 그래프 위반 없음 (types ← agent, types ← storage, types ← config ← server). config 의 top-level `provider`/`cliBackend` 타입은 `@finclaw/types` 의 `FinClawConfig`(`packages/types/src/config.ts:4`) 에 추가 (F3 에서 처리) — types 가 최하위라 역방향 X.

검증: `pnpm typecheck` (현재 0 에러 baseline 확인 후 시작)

---

## 밀스톤 A — CLI Backend Config (Claude backend 정의)

> 목표: OpenClaw `DEFAULT_CLAUDE_BACKEND` (`cli-backends.ts:36`) 를 FinClaw config 형식으로 이식. CLI 호출 방식의 SoT. **보강 변경 없음** — plan A1~A3 그대로.

### A1. CREATE `packages/agent/src/providers/claude-cli/types.ts` — `CliBackendConfig` 타입

```ts
// packages/agent/src/providers/claude-cli/types.ts

export type CliOutputMode = 'json' | 'jsonl' | 'text';

export interface CliWatchdogProfile {
  noOutputTimeoutMs?: number; // 명시 값 (있으면 ratio 무시)
  noOutputTimeoutRatio: number; // 0.05~0.95
  minMs: number;
  maxMs: number;
}

export interface CliReliabilityConfig {
  watchdog?: {
    fresh?: Partial<CliWatchdogProfile>;
    resume?: Partial<CliWatchdogProfile>;
  };
}

export interface CliBackendConfig {
  command: string; // "claude"
  args: string[]; // 첫 호출 시
  resumeArgs?: string[]; // --resume 시
  output: CliOutputMode;
  resumeOutput?: CliOutputMode;
  input: 'arg' | 'stdin';
  modelArg: string; // "--model"
  modelAliases?: Record<string, string>;
  sessionArg?: string; // "--session-id"
  sessionMode?: 'always' | 'existing';
  sessionIdFields?: string[];
  systemPromptArg?: string; // "--append-system-prompt"
  systemPromptMode?: 'append' | 'replace';
  systemPromptWhen?: 'first' | 'always';
  imageArg?: string;
  imageMode?: 'repeat' | 'csv';
  clearEnv?: string[]; // ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD"]
  env?: Record<string, string>;
  reliability?: CliReliabilityConfig;
  serialize?: boolean;
}
```

### A2. CREATE `packages/agent/src/providers/claude-cli/backends.ts` — `DEFAULT_CLAUDE_BACKEND` + resolve/normalize

plan A2 (라인 195-267) 그대로. 핵심: `clearEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_OLD']` (OAuth 구독 인증 강제), `args` 에 `--dangerously-skip-permissions`, watchdog fresh 0.6 / resume 0.4.

```ts
// packages/agent/src/providers/claude-cli/backends.ts
import type { CliBackendConfig } from './types.js';

const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  opus: 'opus',
  'opus-4.6': 'opus',
  'opus-4.5': 'opus',
  'opus-4': 'opus',
  'claude-opus-4-6': 'opus',
  'claude-opus-4-5': 'opus',
  'claude-opus-4': 'opus',
  sonnet: 'sonnet',
  'sonnet-4.6': 'sonnet',
  'sonnet-4.5': 'sonnet',
  'claude-sonnet-4-6': 'sonnet',
  'claude-sonnet-4-5': 'sonnet',
  haiku: 'haiku',
  'haiku-3.5': 'haiku',
  'claude-haiku-3-5': 'haiku',
};

const FRESH_WATCHDOG = { noOutputTimeoutRatio: 0.6, minMs: 30_000, maxMs: 240_000 };
const RESUME_WATCHDOG = { noOutputTimeoutRatio: 0.4, minMs: 15_000, maxMs: 90_000 };

export const DEFAULT_CLAUDE_BACKEND: CliBackendConfig = {
  command: 'claude',
  args: ['-p', '--output-format', 'json', '--dangerously-skip-permissions'],
  resumeArgs: [
    '-p',
    '--output-format',
    'json',
    '--dangerously-skip-permissions',
    '--resume',
    '{sessionId}',
  ],
  output: 'json',
  input: 'arg',
  modelArg: '--model',
  modelAliases: CLAUDE_MODEL_ALIASES,
  sessionArg: '--session-id',
  sessionMode: 'always',
  sessionIdFields: ['session_id', 'sessionId', 'conversation_id', 'conversationId'],
  systemPromptArg: '--append-system-prompt',
  systemPromptMode: 'append',
  systemPromptWhen: 'first',
  clearEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_OLD'],
  reliability: { watchdog: { fresh: FRESH_WATCHDOG, resume: RESUME_WATCHDOG } },
  serialize: true,
};

export function resolveClaudeBackend(override?: Partial<CliBackendConfig>): CliBackendConfig {
  if (!override) return DEFAULT_CLAUDE_BACKEND;
  return {
    ...DEFAULT_CLAUDE_BACKEND,
    ...override,
    args: override.args ?? DEFAULT_CLAUDE_BACKEND.args,
    resumeArgs: override.resumeArgs ?? DEFAULT_CLAUDE_BACKEND.resumeArgs,
    clearEnv: Array.from(
      new Set([...(DEFAULT_CLAUDE_BACKEND.clearEnv ?? []), ...(override.clearEnv ?? [])]),
    ),
    reliability: override.reliability ?? DEFAULT_CLAUDE_BACKEND.reliability,
  };
}

export function normalizeClaudeModel(modelId: string, backend: CliBackendConfig): string {
  const lower = modelId.trim().toLowerCase();
  return backend.modelAliases?.[lower] ?? modelId;
}
```

### A3. CREATE `packages/agent/test/providers/claude-cli/backends.test.ts` — 단위 7개

plan A3 (라인 272-323) 그대로. clearEnv 포함 / `--dangerously-skip-permissions` / output json / `--session-id` always / resolve default identity / clearEnv union merge / normalize 별칭(case-insensitive + passthrough).

검증: `pnpm test --run packages/agent/test/providers/claude-cli/backends.test.ts` (7 pass)

### A4. 밀스톤 A 검증

- `pnpm typecheck` 0 에러
- backends.test 7개 통과
- 회귀 0 (신규 파일만)

---

## 밀스톤 B — Watchdog Ratio (전체 timeout → noOutput timeout 자동 산출)

> 목표: OpenClaw `cli-runner/reliability.ts` 의 `resolveCliNoOutputTimeoutMs` 이식. fresh/resume 다른 ratio + cap = `timeoutMs - 1000`. **보강 변경 없음.**

### B1. CREATE `packages/agent/src/providers/claude-cli/reliability.ts`

plan B1 (라인 356-423) 그대로. `pickWatchdogProfile` (ratio clamp 0.05~0.95, minMs/maxMs 보정, 명시 noOutputTimeoutMs 우선) + `resolveCliNoOutputTimeoutMs` (cap = `max(5000, timeoutMs-1000)`).

```ts
// packages/agent/src/providers/claude-cli/reliability.ts
import type { CliBackendConfig, CliWatchdogProfile } from './types.js';

export const CLI_WATCHDOG_MIN_TIMEOUT_MS = 5_000;
// FRESH_WATCHDOG_DEFAULTS (0.6/30k/240k), RESUME_WATCHDOG_DEFAULTS (0.4/15k/90k)
// pickWatchdogProfile(backend, useResume) → clamp ratio, min(minMs,maxMs), max(minMs,maxMs)
// resolveCliNoOutputTimeoutMs({backend,timeoutMs,useResume}):
//   profile.noOutputTimeoutMs 있으면 min(그값, cap)
//   없으면 floor(timeoutMs*ratio) → min(maxMs, max(minMs, computed)) → min(bounded, cap)
```

(전문은 plan.md:356-423 인용 — 1:1 복사)

### B2. CREATE `packages/agent/test/providers/claude-cli/reliability.test.ts` — 단위 5개

plan B2 (라인 428-494) 그대로:

- fresh ratio 0.6: 60k → 36k
- resume ratio 0.4: 60k → 24k
- cap: 10k → 6k (cap 9k 안 닿음)
- 명시 noOutputTimeoutMs 45k 우선
- ratio clamp: 1.5 → 0.95 → 57k

검증: `pnpm test --run packages/agent/test/providers/claude-cli/reliability.test.ts` (5 pass)

### B3. 밀스톤 B 검증

- `pnpm typecheck` 0 에러
- reliability.test 5개 통과

---

## 밀스톤 C — Process Spawn + Queue + Cleanup

> 목표: child_process spawn + no-output 슬라이딩 윈도우 watchdog + 직렬화 큐.
> **보강 OVERRIDE (`:484` C2):** FinClaw 엔 process supervisor 없음 (`packages/server/src/process/` = Discord 라우팅 모듈). 가장 가까운 `process/spawn.ts:41` `safeSpawn` 은 overall timeout + SIGTERM→2s→SIGKILL 만 있고 **no-output watchdog 없음.** → `spawnWithWatchdog` 는 **`packages/agent/src/providers/claude-cli/spawn.ts` 신규 standalone 작성** (server 확장 X). no-output 윈도우가 핵심 차별.

### C1. CREATE `packages/agent/src/providers/claude-cli/queue.ts` — `enqueueCliRun` + `buildCliQueueKey`

plan C1 (라인 527-552) 그대로. 같은 key 직렬화, unhandled rejection 방지, queue 연속성.

```ts
// packages/agent/src/providers/claude-cli/queue.ts
const CLI_RUN_QUEUE = new Map<string, Promise<unknown>>();

export function enqueueCliRun<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prior = CLI_RUN_QUEUE.get(key) ?? Promise.resolve();
  const chained = prior.catch(() => undefined).then(task);
  const tracked = chained
    .catch(() => undefined)
    .finally(() => {
      if (CLI_RUN_QUEUE.get(key) === tracked) CLI_RUN_QUEUE.delete(key);
    });
  CLI_RUN_QUEUE.set(key, tracked);
  return chained;
}

export function buildCliQueueKey(params: { backendId: string; cliSessionId?: string }): string {
  return params.cliSessionId ? `${params.backendId}:${params.cliSessionId}` : params.backendId;
}
```

### C2. CREATE `packages/agent/src/providers/claude-cli/spawn.ts` — child_process + watchdog (standalone 신규)

plan C2 (라인 560-697) 그대로 — `SpawnRequest` / `SpawnReason`('exit'|'overall-timeout'|'no-output-timeout'|'aborted') / `SpawnResult` / `spawnWithWatchdog`. 핵심: stdout/stderr 수신 시 `lastOutputAt` 갱신 → setInterval(min(noOutput/4, 2000)) 로 idle 검사 → 초과 시 `finalize('no-output-timeout')`. finalize 는 SIGTERM 후 2s 뒤 SIGKILL. abort signal + overall timer 분리.

```ts
// packages/agent/src/providers/claude-cli/spawn.ts
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

export interface SpawnRequest {
  argv: [string, ...string[]];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  noOutputTimeoutMs: number;
  signal?: AbortSignal;
}
export type SpawnReason = 'exit' | 'overall-timeout' | 'no-output-timeout' | 'aborted';
export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  reason: SpawnReason;
  pid?: number;
  noOutputTimedOut: boolean;
  durationMs: number;
}
// export async function spawnWithWatchdog(req): Promise<SpawnResult> { ... }
//   - finalize(final, exitCode): resolved 가드 + SIGTERM + 2s SIGKILL + resolve(SpawnResult)
//   - spawn 실패(try/catch) → exitCode null, reason 'exit'
//   - stdout/stderr 'data' → 누적 + lastOutputAt = Date.now()
//   - 'exit' → finalize('exit', code); 'error' → stderr 추가 + finalize('exit', null)
//   - watchdog setInterval: idle >= noOutputTimeoutMs → noOutputTimedOut=true + finalize('no-output-timeout')
//   - overall setTimeout(timeoutMs) → finalize('overall-timeout')
//   - signal.addEventListener('abort', { once:true }) → finalize('aborted')
//   - child.once('exit') → clearInterval/clearTimeout
```

(전문은 plan.md:560-697 인용 — 1:1 복사. ★ no-output watchdog 이 safeSpawn 대비 신규 핵심.)

### C3. CREATE `packages/agent/test/providers/claude-cli/queue.test.ts` + `spawn.test.ts` — 단위 5개

plan C3 (라인 702-766) 그대로. **실제 `claude` 미실행 — `node -e` 로 가짜 자식 프로세스**:

- queue: 같은 key 직렬화(`['t1','t2']`) / 다른 key 병렬(`['t2','t1']`)
- spawn: short-lived stdout 캡처(`node -e 'process.stdout.write("hello")'` → reason exit, code 0) / overall timeout(`setInterval`) / no-output timeout(write 후 idle → reason 'no-output-timeout', noOutputTimedOut true)

> 유닛 tier: `node` 바이너리만 사용 (CLAUDE.md mock-only 충족 — 외부 API/네트워크 없음). `claude` CLI 미사용.

검증: `pnpm test --run packages/agent/test/providers/claude-cli/queue.test.ts packages/agent/test/providers/claude-cli/spawn.test.ts` (5 pass)

### C4. 밀스톤 C 검증

- `pnpm typecheck` 0 에러
- queue+spawn 테스트 5개 통과
- watchdog SIGTERM→2s→SIGKILL 동작 검증 (no-output 케이스)

---

## 밀스톤 D — JSON / JSONL Output Parsers

> 목표: `--output-format json` (단일 object) / jsonl (줄당) 출력을 `CliOutput` 으로 표준화. **보강 변경 없음.**

### D1. CREATE `packages/agent/src/providers/claude-cli/parsers.ts`

plan D1 (라인 797-926) 그대로. `CliUsage`(input/output/cacheRead/cacheWrite/total) + `CliOutput`(text/sessionId/usage). `parseCliJson` / `parseCliJsonl` + 내부 `pickText`(result|text|content[].text|message) / `pickSessionId`(backend.sessionIdFields) / `pickUsage`(input_tokens|input 등 snake/camel) / `mergeUsage`.

```ts
// packages/agent/src/providers/claude-cli/parsers.ts
import type { CliBackendConfig } from './types.js';
export interface CliUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}
export interface CliOutput {
  text: string;
  sessionId?: string;
  usage?: CliUsage;
}
// export function parseCliJson(stdout, backend): CliOutput | undefined  (JSON.parse → pickText/pickSessionId/pickUsage)
// export function parseCliJsonl(stdout, backend): CliOutput | undefined (줄별 누적 + first sessionId + mergeUsage)
// pickUsage 매핑: input_tokens|input, output_tokens|output, cache_read_input_tokens|cacheRead, cache_creation_input_tokens|cacheWrite, total_tokens|total
```

(전문은 plan.md:797-926 인용 — 1:1 복사)

### D2. CREATE `packages/agent/test/providers/claude-cli/parsers.test.ts` — 단위 5개

plan D2 (라인 933-977) 그대로. claude result 형식 fixture(`{type:'result', result, session_id, usage}`) / 빈 stdout undefined / invalid JSON undefined / jsonl 누적+first sessionId(`thread_id`).

검증: `pnpm test --run packages/agent/test/providers/claude-cli/parsers.test.ts` (5 pass)

### D3. 밀스톤 D 검증

- `pnpm typecheck` 0 에러
- parsers.test 5개 통과

---

## 밀스톤 E — `runCliAgent` Core (조합 + CliFailoverError 변환)

> 목표: A/B/C/D 조합. backend resolve → model 정규화 → args/env(clearEnv) 빌드 → queue → spawn → parse → 에러 분류.
> **보강 OVERRIDE (E FailoverError):** 기존 `FailoverError`(`errors.ts:13-25`, dash reason) 와 **별개 신규 타입** `CliFailoverError`(underscore, auth/rate_limit/timeout/format/model_not_found/unknown). W3: CLI 에러를 상위 retry/fallback 루프에 흘리지 않음 — adapter 내부 완결.

### E1. CREATE `packages/agent/src/providers/claude-cli/errors.ts` — `CliFailoverError` + `classifyCliError`

plan E1 (라인 1016-1059) 그대로. `CliFailoverReason` union + `CliFailoverError extends Error`(reason/provider/model/status) + `classifyCliError`(AUTH_RE/RATE_LIMIT_RE/TIMEOUT_RE 정규식).

```ts
// packages/agent/src/providers/claude-cli/errors.ts
export type CliFailoverReason =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'format'
  | 'model_not_found'
  | 'unknown';
export class CliFailoverError extends Error {
  readonly reason: CliFailoverReason;
  readonly provider: string;
  readonly model: string;
  readonly status?: number;
  constructor(
    message: string,
    opts: { reason: CliFailoverReason; provider: string; model: string; status?: number },
  ) {
    super(message);
    this.name = 'CliFailoverError';
    this.reason = opts.reason;
    this.provider = opts.provider;
    this.model = opts.model;
    this.status = opts.status;
  }
}
const TIMEOUT_RE = /timeout|timed out|deadline exceeded|no output for/i;
const AUTH_RE = /(unauthor|forbid|invalid.+token|please log ?in|claude login)/i;
const RATE_LIMIT_RE = /(rate ?limit|too many req|quota)/i;
export function classifyCliError(message: string): CliFailoverReason {
  if (AUTH_RE.test(message)) return 'auth';
  if (RATE_LIMIT_RE.test(message)) return 'rate_limit';
  if (TIMEOUT_RE.test(message)) return 'timeout';
  return 'unknown';
}
```

### E2. CREATE `packages/agent/src/providers/claude-cli/runner.ts` — `runCliAgent`

plan E2 (라인 1067-1185) 그대로. `RunCliAgentRequest`(prompt/systemPrompt/modelId/cliSessionId/timeoutMs/abortSignal/cwd/backend) → `RunCliAgentResponse`(text/sessionId/usage/durationMs). 흐름: resolve backend → normalizeClaudeModel → useResume = Boolean(cliSessionId) → args 빌드(`{sessionId}` 치환 + modelArg + systemPromptArg first 조건 + input==='arg' 시 prompt push) → **env clearEnv 적용(★ ANTHROPIC_API_KEY delete)** → resolveCliNoOutputTimeoutMs → buildCliQueueKey → enqueueCliRun(spawnWithWatchdog) → 에러 분기(no-output/overall→timeout 408, aborted→unknown, else classifyCliError) → outputMode 별 parse.

```ts
// packages/agent/src/providers/claude-cli/runner.ts
// import: ./types, ./errors(CliFailoverError, classifyCliError), ./reliability(resolveCliNoOutputTimeoutMs),
//         ./spawn(spawnWithWatchdog), ./queue(buildCliQueueKey, enqueueCliRun),
//         ./parsers(parseCliJson, parseCliJsonl, CliOutput), ./backends(DEFAULT_CLAUDE_BACKEND, normalizeClaudeModel)
// export async function runCliAgent(req: RunCliAgentRequest): Promise<RunCliAgentResponse>
//   const env = { ...process.env, ...backend.env }; for (key of backend.clearEnv ?? []) delete env[key];  // ★ 핵심
//   에러 분기 → throw new CliFailoverError(...)
```

(전문은 plan.md:1067-1185 인용 — 1:1 복사. queueKey 의 backendId 는 `'claude'` 하드코딩 그대로.)

### E3. CREATE `packages/agent/test/providers/claude-cli/runner.test.ts` — 단위 5개 (mock spawn)

plan E3 (라인 1192-1284) 그대로. `vi.spyOn(spawnMod, 'spawnWithWatchdog')` 로 결과 분기:

- claude json 성공 → text/sessionId/usage.input
- no-output-timeout → CliFailoverError(reason 'timeout')
- auth stderr(`Please log in via claude login`) → reason 'auth'
- **clearEnv 검증: `process.env.ANTHROPIC_API_KEY='sk-test'` 세팅 후 capturedEnv.ANTHROPIC_API_KEY === undefined** (★ 핵심 — Backend-as-CLI 의 OAuth 강제 입증)
- cliSessionId 주어지면 argv 에 `--resume` + sessionId 포함

> 유닛 tier: spawn mock — 실제 `claude`/네트워크 없음 (CLAUDE.md 충족).

검증: `pnpm test --run packages/agent/test/providers/claude-cli/runner.test.ts` (5 pass)

### E4. 밀스톤 E 검증

- `pnpm typecheck` 0 에러
- runner.test 5개 통과
- clearEnv 검증(spawn 직전 env 에 ANTHROPIC_API_KEY 없음) + `--resume` 분기 검증

---

## 밀스톤 F — ProviderAdapter Dual-Path 통합

> 목표: `anthropic.ts`(SDK) 와 `claude-cli/runner.ts` 를 공통 `ProviderAdapter` 뒤에 dual-path 배치. config `provider: 'anthropic-sdk' | 'claude-cli'` 한 줄 전환.
>
> **보강 OVERRIDE (F 전면 재-grounding — 본문 라인 교정표 8행 반영):**
>
> - `ProviderAdapter`(`adapter.ts:24-29`) 실제 = `{ readonly providerId: ProviderId; chatCompletion(params): Promise<unknown>; streamCompletion(params): AsyncIterable<StreamChunk> }`. plan F1 의 `id`/`supportsStreaming`/`supportsPromptCaching`/`supportsToolUse` + `StreamCompletionRequest`/`StreamCompletionResponse` 는 **전부 미존재 — 버림.**
> - `streamCompletion` 은 **`async *` generator** (Runner `runner.ts:263` `for await` 호환). `runCliAgent` 일괄 결과를 `text_delta → usage → done` 순으로 yield.
> - import: `import type { ProviderAdapter, ProviderRequestParams } from '../adapter.js'; import type { StreamChunk } from '../models/provider-normalize.js';`
> - `ProviderRequestParams`(`adapter.ts:8-21`) = `model`(modelId 아님)·`messages`·`tools`·`systemPrompt`·`temperature`·`maxTokens`·`abortSignal`·`forceToolChoice`. **`metadata`/`timeoutMs` 없음.**
> - **W5:** `catalog.ts:4` `ProviderId` 에 `'claude-cli'` 추가. factory 의 plan 타입 `ProviderId` → **`ProviderKind`** 로 rename(충돌 회피).
> - **W6:** config 는 `schema.ts` 아니라 **`zod-schema.ts`**(`FinClawConfigSchema`, `z.strictObject` :154) + `FinClawConfig` 타입(`types/src/config.ts:4`) + `defaults.ts`. top-level `provider`/`cliBackend` 명시 추가, 기존 `agents.defaults.provider`(벤더 의미)와 분리.
> - **F2 anthropic 생성:** `new AnthropicAdapter(cfg.apiKey)` (생성자 `(apiKey: string, baseUrl?: string)`, `anthropic.ts:64`. defaultTimeoutMs 미지원).

### F1. CREATE `packages/agent/src/providers/claude-cli/adapter.ts` — `CliProviderAdapter` (async generator)

> **✅ Q1 = (A) 확정:** cliSessionId in/out 채널 없음 → **adapter 가 단일 사용자 전역 cliSessionId 멤버(`#cliSessionId`) 보유**. 첫 호출 응답의 sessionId 를 저장 → 다음 호출 시 `--resume`. 인터페이스 무변경.

```ts
// packages/agent/src/providers/claude-cli/adapter.ts
import type { ConversationMessage } from '@finclaw/types';
import type { ProviderAdapter, ProviderRequestParams } from '../adapter.js';
import type { ProviderId } from '../models/catalog.js'; // W5: 'claude-cli' 포함
import type { StreamChunk } from '../models/provider-normalize.js';
import { runCliAgent } from './runner.js';
import type { CliBackendConfig } from './types.js';

export interface CliProviderAdapterOptions {
  backend?: CliBackendConfig;
  defaultTimeoutMs?: number;
  /** W2: auth 만료 시 위임할 SDK adapter (옵션). */
  sdkFallback?: ProviderAdapter;
}

export class CliProviderAdapter implements ProviderAdapter {
  readonly providerId: ProviderId = 'claude-cli'; // ★ 멤버명 providerId (id 아님), capability 플래그 제거
  #cliSessionId: string | undefined; // Q1 (A): 단일 사용자 전역 세션 (게이트 후 확정)
  constructor(private readonly opts: CliProviderAdapterOptions = {}) {}

  // 비스트리밍 1회 호출 — Runner 는 streamCompletion 만 쓰지만 인터페이스상 필요
  async chatCompletion(params: ProviderRequestParams): Promise<unknown> {
    const result = await this.#run(params);
    return { text: result.text, usage: result.usage, sessionId: result.sessionId };
  }

  // ★ async generator: text_delta → usage → done
  async *streamCompletion(params: ProviderRequestParams): AsyncIterable<StreamChunk> {
    const result = await this.#run(params);
    if (result.text) yield { type: 'text_delta', text: result.text };
    if (result.usage) {
      yield {
        type: 'usage',
        usage: {
          inputTokens: result.usage.input ?? 0,
          outputTokens: result.usage.output ?? 0,
          cacheReadTokens: result.usage.cacheRead ?? 0,
          cacheWriteTokens: result.usage.cacheWrite ?? 0,
        },
      };
    }
    yield { type: 'done' };
  }

  async #run(params: ProviderRequestParams) {
    const result = await runCliAgent({
      prompt: extractPrompt(params.messages),
      systemPrompt: params.systemPrompt,
      modelId: params.model, // ★ model (modelId 아님)
      cliSessionId: this.#cliSessionId, // Q1 (A): 직전 세션 주입
      timeoutMs: this.opts.defaultTimeoutMs ?? 60_000, // params.timeoutMs 미존재 → adapter 옵션
      abortSignal: params.abortSignal,
      backend: this.opts.backend,
    }).catch(async (err) => {
      // W2: auth 만료 → sdkFallback 위임 (adapter 내부 완결, Runner 무관)
      // 단 sdkFallback 은 streamCompletion 만 가지므로, #run 단에선 re-throw 하고
      // streamCompletion 에서 sdkFallback.streamCompletion 으로 위임하는 편이 정합적 → 아래 NOTE 참조
      throw err;
    });
    if (result.sessionId) this.#cliSessionId = result.sessionId; // Q1 (A): 세션 갱신
    return result;
  }
}

function extractPrompt(messages: ConversationMessage[]): string {
  return messages
    .map(
      (m) =>
        `${m.role === 'user' ? 'User' : 'Assistant'}: ${typeof m.content === 'string' ? m.content : ''}`,
    )
    .join('\n\n');
}
```

> **NOTE (W2 auth fallback 위치 — implementer 주의):** `sdkFallback` 은 `ProviderAdapter` 라 `streamCompletion`(async generator) 만 안전. auth catch → SDK 위임은 **`streamCompletion` 본문에서** `try { ...#run... } catch (e) { if (e instanceof CliFailoverError && e.reason === 'auth' && this.opts.sdkFallback) { yield* this.opts.sdkFallback.streamCompletion(params); return; } throw e; }` 형태로 구현 (위 `#run` 의 catch 는 placeholder — 실제 위임은 generator 에서). G2 와 일관. **이 위임 코드는 G2 단계에서 확정 작성** (F1 은 정상 경로 + 세션 멤버까지).

### F2. CREATE `packages/agent/src/providers/factory.ts` — `createProviderAdapter`

```ts
// packages/agent/src/providers/factory.ts
import type { ProviderAdapter } from './adapter.js';
import { AnthropicAdapter } from './anthropic.js';
import { CliProviderAdapter } from './claude-cli/adapter.js';
import type { CliBackendConfig } from './claude-cli/types.js';

// ★ W5: plan 의 ProviderId → ProviderKind 로 rename (catalog ProviderId 와 충돌 회피)
export type ProviderKind = 'anthropic-sdk' | 'claude-cli';

export interface ProviderFactoryConfig {
  kind: ProviderKind;
  apiKey?: string; // SDK 모드 전용
  cliBackend?: CliBackendConfig; // CLI 모드 전용
  defaultTimeoutMs?: number;
  sdkFallback?: ProviderAdapter; // W2: CLI auth 만료 시 위임 (CLI 모드에서만)
}

export function createProviderAdapter(cfg: ProviderFactoryConfig): ProviderAdapter {
  switch (cfg.kind) {
    case 'anthropic-sdk':
      if (!cfg.apiKey) throw new Error('ANTHROPIC_API_KEY required for anthropic-sdk provider');
      return new AnthropicAdapter(cfg.apiKey); // ★ (apiKey) 단일 인자
    case 'claude-cli':
      return new CliProviderAdapter({
        backend: cfg.cliBackend,
        defaultTimeoutMs: cfg.defaultTimeoutMs,
        sdkFallback: cfg.sdkFallback,
      });
    default: {
      const _exhaustive: never = cfg.kind;
      throw new Error(`Unknown provider: ${String(_exhaustive)}`);
    }
  }
}
```

### F3. EDIT `packages/agent/src/models/catalog.ts:4` — `ProviderId` 에 `'claude-cli'` 추가 (W5)

```ts
// before:
export type ProviderId = 'anthropic' | 'openai';
// after:
export type ProviderId = 'anthropic' | 'openai' | 'claude-cli';
```

> **파급 검토 (W5):** `getBreakerForProvider`(`adapter.ts:32` `Map<ProviderId, CircuitBreaker>`) 는 string key 라 무영향. `provider-normalize.ts` 의 `NormalizedResponse.provider`/cost 정규화는 'anthropic' 경로 재사용(CLI 는 Anthropic 백엔드) — CLI adapter 는 NormalizedResponse 를 만들지 않으므로(StreamChunk 만 yield) 신규 분기 불필요. catalog-data.ts `BUILT_IN_MODELS` 에 claude-cli 엔트리 **추가 안 함**(CLI 는 모델 카탈로그 미사용). → typecheck 로 누락 분기 검출.

검증: `pnpm typecheck` (catalog ProviderId 확장 후 exhaustive switch 누락 없는지 — 0 에러여야 함)

### F4. EDIT `packages/types/src/config.ts:4` + `packages/config/src/zod-schema.ts:154` + `packages/config/src/defaults.ts` — top-level `provider`/`cliBackend` (W6)

**(a) `packages/types/src/config.ts` `FinClawConfig` 인터페이스에 추가** (types 가 최하위 — config zod 가 이 타입을 만족해야 함):

```ts
export interface FinClawConfig {
  // ... 기존
  /** Phase 32 W6: 백엔드 경로 선택 (모델 벤더 의미의 agents.defaults.provider 와 분리). */
  provider?: 'anthropic-sdk' | 'claude-cli';
  cliBackend?: {
    command?: string;
    timeoutMs?: number;
    watchdog?: {
      fresh?: { noOutputTimeoutRatio?: number };
      resume?: { noOutputTimeoutRatio?: number };
    };
  };
}
```

**(b) `packages/config/src/zod-schema.ts` `FinClawConfigSchema`(z.strictObject :154) 에 top-level 키 추가** (strictObject 라 미선언 키 거부 → 명시 필수):

```ts
export const FinClawConfigSchema = z.strictObject({
  // ... 기존 키들 (gateway, agents, channels, ...)
  // Phase 32 W6:
  provider: z.enum(['anthropic-sdk', 'claude-cli']).optional(),
  cliBackend: z
    .strictObject({
      command: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
      watchdog: z
        .strictObject({
          fresh: z.strictObject({ noOutputTimeoutRatio: z.number().min(0.05).max(0.95).optional() }).partial().optional(),
          resume: z.strictObject({ noOutputTimeoutRatio: z.number().min(0.05).max(0.95).optional() }).partial().optional(),
        })
        .partial()
        .optional(),
    })
    .optional(),
  meta: z.strictObject({ ... }).optional(),  // 기존 meta 는 유지
});
```

**(c) `packages/config/src/defaults.ts` `DEFAULTS` 에 `provider: 'anthropic-sdk'` (회귀 0 — W6):**

```ts
const DEFAULTS = Object.freeze({
  // ... 기존
  provider: 'anthropic-sdk', // ★ 기본 SDK 유지 → CLI opt-in, 회귀 0
}) satisfies FinClawConfig;
```

> oxfmt 가 package.json/일부 키 순서 재정렬 가능 → 단계 끝에 `pnpm format:fix`. defaults `satisfies FinClawConfig` 가 (a) 타입 추가와 일치해야 typecheck 통과.

### F5. EDIT `packages/agent/src/index.ts` — claude-cli + factory barrel export

`packages/agent/src/index.ts` 의 `// ─── providers ───` 블록(현재 :67-71) 뒤에 추가:

```ts
// ─── providers (Phase 32 Backend-as-CLI) ───
export { createProviderAdapter } from './providers/factory.js';
export type { ProviderKind, ProviderFactoryConfig } from './providers/factory.js';
export { CliProviderAdapter } from './providers/claude-cli/adapter.js';
export { runCliAgent } from './providers/claude-cli/runner.js';
export { CliFailoverError, classifyCliError } from './providers/claude-cli/errors.js';
export type { CliFailoverReason } from './providers/claude-cli/errors.js';
export {
  DEFAULT_CLAUDE_BACKEND,
  resolveClaudeBackend,
  normalizeClaudeModel,
} from './providers/claude-cli/backends.js';
export type {
  CliBackendConfig,
  CliWatchdogProfile,
  CliReliabilityConfig,
  CliOutputMode,
} from './providers/claude-cli/types.js';
```

### F6. EDIT `packages/server/src/main.ts:264` — provider 생성을 factory 로 교체

> **보강 OVERRIDE (`:89`):** dual-path 전환 지점 = `main.ts:264 new AnthropicAdapter(anthropicKey)` → factory. runnerFactory(`:438-444`) 의 `provider: anthropicAdapter` 를 `provider: providerAdapter` 로.

```ts
// before (main.ts:264):
const anthropicAdapter = new AnthropicAdapter(anthropicKey);

// after:
const sdkAdapter = new AnthropicAdapter(anthropicKey);
const providerAdapter = createProviderAdapter({
  kind: cfg.provider ?? 'anthropic-sdk',
  apiKey: anthropicKey,
  cliBackend: cfg.cliBackend
    ? {
        ...DEFAULT_CLAUDE_BACKEND,
        command: cfg.cliBackend.command ?? 'claude',
        reliability: cfg.cliBackend.watchdog ? { watchdog: cfg.cliBackend.watchdog } : undefined,
      }
    : undefined,
  defaultTimeoutMs: cfg.cliBackend?.timeoutMs ?? 60_000,
  sdkFallback: sdkAdapter, // W2: CLI auth 만료 시 SDK 위임 (CLI 모드일 때만 쓰임)
});

logger.info('provider.initialized', {
  event: 'provider.initialized',
  providerKind: cfg.provider ?? 'anthropic-sdk',
  ...(cfg.provider === 'claude-cli'
    ? { note: 'CLI mode: streaming/caching/tool_use disabled' }
    : {}),
});
```

그리고 runnerFactory(`:440`):

```ts
// before:  provider: anthropicAdapter,
// after:   provider: providerAdapter,
```

> import 추가: `import { createProviderAdapter, DEFAULT_CLAUDE_BACKEND } from '@finclaw/agent';` (main.ts 상단 @finclaw/agent import 에 합류). `cfg.provider`/`cfg.cliBackend` 는 F4(a) 타입으로 인식됨.

### F7. CREATE `packages/agent/test/providers/claude-cli/adapter.test.ts` — 단위 6개

> **보강 OVERRIDE (F4 test `:1448`):** `.id` 없음 → `expect(a.providerId).toBe('anthropic')` / `'claude-cli'`. capability 플래그 단언 제거.

```ts
import { describe, it, expect, vi } from 'vitest';
import * as runnerMod from '../../../src/providers/claude-cli/runner.js';
import { CliProviderAdapter } from '../../../src/providers/claude-cli/adapter.js';
import { createProviderAdapter } from '../../../src/providers/factory.js';

describe('CliProviderAdapter', () => {
  it('reports providerId claude-cli', () => {
    expect(new CliProviderAdapter().providerId).toBe('claude-cli');
  });

  it('streamCompletion yields text_delta → usage → done', async () => {
    vi.spyOn(runnerMod, 'runCliAgent').mockResolvedValue({
      text: '응답',
      sessionId: 'sess1',
      usage: { input: 10, output: 5 },
      durationMs: 100,
    });
    const a = new CliProviderAdapter();
    const chunks = [];
    for await (const c of a.streamCompletion({
      model: 'sonnet',
      messages: [{ role: 'user', content: '안녕' }],
    } as any)) {
      chunks.push(c);
    }
    expect(chunks).toEqual([
      { type: 'text_delta', text: '응답' },
      {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      { type: 'done' },
    ]);
  });

  it('serializes messages into prompt + passes model', async () => {
    const spy = vi.spyOn(runnerMod, 'runCliAgent').mockResolvedValue({ text: 'x', durationMs: 1 });
    const a = new CliProviderAdapter();
    for await (const _ of a.streamCompletion({
      model: 'sonnet',
      messages: [{ role: 'user', content: '안녕' }],
    } as any)) {
      /* drain */
    }
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('안녕'), modelId: 'sonnet' }),
    );
  });
});

describe('createProviderAdapter factory', () => {
  it('creates anthropic-sdk adapter (providerId anthropic)', () => {
    expect(createProviderAdapter({ kind: 'anthropic-sdk', apiKey: 'sk-test' }).providerId).toBe(
      'anthropic',
    );
  });
  it('creates claude-cli adapter', () => {
    expect(createProviderAdapter({ kind: 'claude-cli' }).providerId).toBe('claude-cli');
  });
  it('throws for anthropic-sdk without apiKey', () => {
    expect(() => createProviderAdapter({ kind: 'anthropic-sdk' })).toThrow(/API_KEY/);
  });
});
```

> 유닛 tier: runCliAgent mock — 실제 CLI/SDK 호출 없음. `AnthropicAdapter('sk-test')` 는 생성자만 호출(네트워크 X).

검증: `pnpm test --run packages/agent/test/providers/claude-cli/adapter.test.ts` (6 pass)

### F8. 밀스톤 F 검증

- `pnpm typecheck` 0 에러 (catalog ProviderId 확장 + config 타입 일치)
- adapter.test 6개 통과
- config 스키마 테스트 회귀 0 (`pnpm test --run packages/config`) — strictObject 가 신규 키 거부 안 하는지
- SDK 모드(기본값) main.ts 부트 회귀 0 (`pnpm test --run packages/server/src/main.test.ts`)
- `pnpm format:fix` 후 재-typecheck

---

## 밀스톤 G — agent_runs.cli_session_id + 인증 만료 fallback

> 목표: cli_session_id audit 컬럼(v10→v11) + auth 만료 SDK fallback.
>
> **보강 OVERRIDE (G 전면 재배치 — 본문 라인 교정표 3행 + W1/W2/W7):**
>
> - `StorageAdapter`(`types/src/storage.ts:5-19`) 에 `updateAgentRun` **없음.** agent_runs 는 free 함수(`storage/src/agent-runs.ts`)로 raw db 조작. → plan G2 `this.storage.updateAgentRun(...)` 는 존재하지 않는 API.
> - `Runner`(`runner.ts:66-83`) 는 storage/runId/logger/fallbackProvider 멤버 **없음.** → plan G2 의 Runner 내부 fallback+persist 설계 불가.
> - **auto-reply 경로는 agent_runs 미기록** (`pipeline`). `addAgentRun` 호출처 = `automation/scheduler.ts`, `gateway/rpc/methods/agent.ts` 뿐.
> - **W1:** 멀티턴 `--resume` session 영속 = **conversations.metadata**(이미 nullable JSON). `agent_runs.cli_session_id` 는 **audit 용**(scheduler/rpc 경로). 단순함 우선.
> - **W2/W7:** auth fallback 은 **CliProviderAdapter 내부**(주입된 sdkFallback)에서 완결. Runner 무관 — Runner.provider 단일 슬롯 유지. `runWithModelFallback` 미사용(401/403 → classifyFallbackError null + cross-provider 차단).
> - SCHEMA_VERSION=10 확인 → v10→v11 정확.

### G1. EDIT `packages/storage/src/database.ts` — SCHEMA_VERSION 10→11 + MIGRATIONS[11] + SCHEMA_DDL

**(a) `SCHEMA_VERSION`(`:23`):**

```ts
// before: const SCHEMA_VERSION = 10;
// after:  const SCHEMA_VERSION = 11;
```

**(b) `MIGRATIONS` 객체(`:254`)에 `11:` 추가 — 기존 `10:`(`:456-461`) 패턴 그대로 (table_info 가드 + ALTER + 인덱스):**

```ts
const MIGRATIONS: Record<number, MigrationStep> = {
  // ... 기존 ~10
  // Phase 32 G1: agent_runs.cli_session_id — CLI 발급 세션 ID (audit). multi-turn 영속은 conversations.metadata(W1).
  11: (db: DatabaseSync) => {
    const cols = db.prepare(`PRAGMA table_info('agent_runs')`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'cli_session_id')) {
      db.exec(`ALTER TABLE agent_runs ADD COLUMN cli_session_id TEXT;`);
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_agent_runs_cli_session ON agent_runs(cli_session_id) WHERE cli_session_id IS NOT NULL;`,
    );
  },
};
```

**(c) SCHEMA_DDL `agent_runs` CREATE TABLE(`:195-214`) 에 컬럼 추가** (fresh DB 용 — `rerank_meta` 다음, `error` 앞):

```sql
  rerank_meta      TEXT,
  cli_session_id   TEXT,        -- Phase 32 G1
  error            TEXT,
```

**(d) `ensurePostMigrationSchema`(`:515`) 에 인덱스 idempotent 보장 추가** (기존 schedule_id/trace_id 인덱스 패턴 — fresh DB SCHEMA_DDL 이 컬럼 만든 뒤 인덱스 보장):

```ts
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_cli_session ON agent_runs(cli_session_id) WHERE cli_session_id IS NOT NULL;`,
);
```

### G2. EDIT `packages/storage/src/agent-runs.ts` — row 타입 + insert 매핑 + `updateAgentRunCliSession`

**(a) `AgentRunRow`(`:7-29`) 에 필드 추가** (`rerank_meta` 다음):

```ts
rerank_meta: string | null;
/** Phase 32 G1: CLI 발급 세션 ID (audit). */
cli_session_id: string | null;
error: string | null;
```

**(b) `AddAgentRunInput`(`:36-61`) 에 필드 추가:**

```ts
  /** Phase 32 G1: CLI 발급 세션 ID (scheduler/rpc 경로에서 audit 기록). */
  cliSessionId?: string;
  error?: string;
```

**(c) `rowToAgentRun`(`:73`) + `addAgentRun` INSERT(`:108-134`) 매핑** — 17→18 컬럼:

```ts
// rowToAgentRun: cliSessionId: row.cli_session_id === null ? undefined : row.cli_session_id,
// INSERT 컬럼 목록에 cli_session_id 추가, VALUES ?(18개), .run(...) 에 input.cliSessionId ?? null 추가
```

**(d) 신규 free 함수 — `linkMemoryToAgentRun`(`:186-195`) 패턴 그대로:**

```ts
/**
 * Phase 32 G1: agent_runs.cli_session_id 를 갱신 (CLI 응답의 session_id audit 기록).
 * @returns 갱신 성공 여부 (해당 id 행 존재 여부)
 */
export function updateAgentRunCliSession(
  db: DatabaseSync,
  agentRunId: string,
  cliSessionId: string,
): boolean {
  const result = db
    .prepare('UPDATE agent_runs SET cli_session_id = ? WHERE id = ?')
    .run(cliSessionId, agentRunId);
  return result.changes > 0;
}
```

> `AgentRun`(`types/src/agent.ts:94`) 타입에도 `cliSessionId?: string;`(rerankMeta 다음) 추가 — rowToAgentRun 반환 일치. storage barrel(`packages/storage/src/index.ts`)에 `updateAgentRunCliSession` export.

### G3. EDIT `packages/agent/src/providers/claude-cli/adapter.ts` — `streamCompletion` 에 W2 auth fallback 확정

> F1 의 NOTE 를 여기서 확정. `streamCompletion` generator 본문에서 auth catch → sdkFallback 위임:

```ts
async *streamCompletion(params: ProviderRequestParams): AsyncIterable<StreamChunk> {
  let result;
  try {
    result = await this.#run(params);          // #run 내부 catch 제거 — 여기서 처리
  } catch (err) {
    if (err instanceof CliFailoverError && err.reason === 'auth' && this.opts.sdkFallback) {
      // W2: CLI auth 만료 → SDK 위임 (adapter 내부 완결, Runner 무관)
      yield* this.opts.sdkFallback.streamCompletion(params);
      return;
    }
    throw err;                                  // W3: 그 외 CLI 에러는 그대로 전파 (상위 retry/fallback 루프 미진입)
  }
  if (result.text) yield { type: 'text_delta', text: result.text };
  if (result.usage) yield { type: 'usage', usage: { /* ...매핑... */ } };
  yield { type: 'done' };
}
```

(F1 의 `#run` 에서 placeholder catch 제거 — `runCliAgent` 결과를 그대로 반환하고 세션 멤버만 갱신.)

> import 추가: `import { CliFailoverError } from './errors.js';`

### G4. CREATE `packages/storage/test/migrations/v10-to-v11.test.ts` — storage tier, 마이그레이션 simulation

```ts
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
// v10 상태 DB 생성 → openDatabase(또는 runMigrations) → v11 → cli_session_id 컬럼 + 인덱스 존재 확인
describe('migration v10 → v11 (cli_session_id)', () => {
  it('adds cli_session_id column to agent_runs', () => {
    // 1. fresh DB (현 SCHEMA_VERSION=11) → PRAGMA table_info('agent_runs') 에 cli_session_id 있음
    // 2. (옵션) v10 meta 로 강제 후 재오픈 → 마이그레이션 적용 → 컬럼 존재 + 인덱스 idx_agent_runs_cli_session
    // 3. addAgentRun({ ..., cliSessionId: 'sess1' }) → getAgentRun → cliSessionId === 'sess1'
    // 4. updateAgentRunCliSession(db, id, 'sess2') === true → getAgentRun.cliSessionId === 'sess2'
  });
});
```

> storage tier (`pnpm test:storage`, `vitest.storage.config.ts`) — node:sqlite 사용. 기존 `packages/storage/test/migrations/` 의 다른 vN 테스트 구조 참조해 idempotency(2회 적용 안전) 포함.

검증: `pnpm test:storage` (v10-to-v11 통과 + 기존 마이그레이션 회귀 0)

### G5. CREATE `packages/agent/test/providers/claude-cli/cli-fallback.test.ts` — 단위 2개 (adapter-level, Runner 무관)

> **보강 OVERRIDE (G3 test `:1530/1541`):** `new Runner({fallbackProvider})` 아님 → `new CliProviderAdapter({ sdkFallback: sdk })` 단위.

```ts
import { describe, it, expect, vi } from 'vitest';
import * as runnerMod from '../../../src/providers/claude-cli/runner.js';
import { CliProviderAdapter } from '../../../src/providers/claude-cli/adapter.js';
import { CliFailoverError } from '../../../src/providers/claude-cli/errors.js';

async function drain(it: AsyncIterable<any>) {
  const out = [];
  for await (const c of it) out.push(c);
  return out;
}

describe('CliProviderAdapter auth fallback (W2)', () => {
  it('delegates to sdkFallback when CLI throws auth error', async () => {
    vi.spyOn(runnerMod, 'runCliAgent').mockRejectedValue(
      new CliFailoverError('Please log in', {
        reason: 'auth',
        provider: 'claude-cli',
        model: 'sonnet',
      }),
    );
    const sdk = {
      providerId: 'anthropic',
      chatCompletion: vi.fn(),
      streamCompletion: vi.fn(async function* () {
        yield { type: 'text_delta', text: 'sdk' };
        yield { type: 'done' };
      }),
    };
    const a = new CliProviderAdapter({ sdkFallback: sdk as any });
    const chunks = await drain(
      a.streamCompletion({ model: 'sonnet', messages: [{ role: 'user', content: 'hi' }] } as any),
    );
    expect(chunks).toContainEqual({ type: 'text_delta', text: 'sdk' });
    expect(sdk.streamCompletion).toHaveBeenCalled();
  });

  it('rethrows (no fallback) when CLI fails with non-auth reason', async () => {
    vi.spyOn(runnerMod, 'runCliAgent').mockRejectedValue(
      new CliFailoverError('timeout', {
        reason: 'timeout',
        provider: 'claude-cli',
        model: 'sonnet',
      }),
    );
    const sdk = { providerId: 'anthropic', chatCompletion: vi.fn(), streamCompletion: vi.fn() };
    const a = new CliProviderAdapter({ sdkFallback: sdk as any });
    await expect(
      drain(
        a.streamCompletion({ model: 'sonnet', messages: [{ role: 'user', content: 'hi' }] } as any),
      ),
    ).rejects.toMatchObject({ reason: 'timeout' });
    expect(sdk.streamCompletion).not.toHaveBeenCalled();
  });
});
```

검증: `pnpm test --run packages/agent/test/providers/claude-cli/cli-fallback.test.ts` (2 pass)

### G6. 밀스톤 G 검증

- `pnpm typecheck` 0 에러 (AgentRunRow/AddAgentRunInput/AgentRun 일치)
- `pnpm test:storage` (v10→v11 + idempotency 통과, 회귀 0)
- cli-fallback.test 2개 통과
- `pnpm format:fix` 후 재-typecheck

---

## 밀스톤 H — Live e2e (실제 claude CLI 검증)

> 목표: 실제 `claude` + `claude login` 환경에서 e2e. **live tier 전용** — `pnpm test:live`(`vitest.live.config.ts`, Phase 26 산출 이미 존재) 에서만. **기본 자동화(`pnpm test`)에서 제외** — CLAUDE.md 유닛 mock-only 원칙 충족 (claude 미설치 시 `describe.skipIf` 로 자동 skip → 회귀 0).

### H1. CREATE `packages/agent/test/providers/claude-cli/runner.live.test.ts`

plan H1 (라인 1647-1706) 그대로. `which claude` 로 `claudeAvailable` 판정 → `describe.skipIf(!claudeAvailable)`:

- 실제 응답("안녕" 포함, sessionId truthy, durationMs > 0), timeout 90s
- multi-turn `--resume`(turn1 sessionId → turn2 cliSessionId 로 이름 기억), timeout 180s
- ANTHROPIC_API_KEY='sk-invalid' 세팅해도 OAuth 로 정상 동작(sanity), timeout 60s

> ⚠ 이 테스트는 **실제 Claude Max 구독 호출** — `pnpm test:live` 수동 실행만. CI/기본 파이프라인 미포함.

### H2. (문서) live 실행 prerequisite — README/docs 또는 plan 환경 prerequisite 참조

본 단계는 코드 변경 없음. plan.md "환경 prerequisite"(:1783-1798) 의 절차(claude 설치 → `claude login` → `pnpm test:live -- providers/claude-cli`) 가 SoT. `vitest.live.config.ts` 가 본 테스트 포함하는지만 확인(glob 패턴 `*.live.test.ts`).

검증 (수동, live 환경에서만): `pnpm test:live -- providers/claude-cli` (3 pass) / claude 미설치 시 `pnpm test:all` 에서 skip 확인

### H3. 밀스톤 H 검증

- claude 미설치 환경: `pnpm test` / `pnpm test:all` 회귀 0 (skipIf 자동 skip)
- (live 환경) live test 3개 통과

---

## 통합 테스트

> plan "통합 테스트"(:1731-1752) 3 시나리오. 시나리오 1·2 의 자동화 가능 부분은 mock e2e, 시나리오 3 auth fallback 은 G5 단위로 커버. 시나리오 1·2 의 실제 CLI 부분은 H(live).

### IT-1. config 한 줄 SDK↔CLI 전환 (mock)

- `provider: 'claude-cli'` config → `createProviderAdapter` 가 `CliProviderAdapter` 반환, 부트 로그 `providerKind: 'claude-cli'` + note 확인 (server boot 테스트 또는 factory 단위로)
- `provider` 미지정/`'anthropic-sdk'` → `AnthropicAdapter` 반환, 회귀 0
- 위치: `packages/server/src/main.test.ts` 확장 또는 신규 `provider-switch.test.ts` (mock provider, 실제 spawn X)

### IT-2. Multi-turn `--resume` (mock, runner 레벨)

- E3 의 `--resume` argv 검증 + F7 의 세션 멤버 갱신으로 커버됨. 추가 통합: adapter 2회 호출 → 2번째 호출 runCliAgent 인자에 1번째 응답 sessionId 전달 확인 (Q1 (A) 전제 — 게이트 후 확정 시 작성)

### IT-3. auth fallback (mock)

- G5 cli-fallback.test 로 커버 (auth → SDK 위임, non-auth → rethrow). Discord 알림은 plan 범위 밖(W4 신규 이벤트 미추가) → 미구현, review.md 에 후속 기록.

---

## 최종 검증

다음을 모두 통과해야 phase 완료 (plan "완료 기준 전체" :1756-1764):

- `pnpm typecheck` 0 에러
- `pnpm lint` 0 위반
- `pnpm test` (mock-only, 유닛) 회귀 0 — 신규 단위 ~30개 통과 (A:7 + B:5 + C:5 + D:5 + E:5 + F:6 + G:2 = 35; plan 추정 ~36)
- `pnpm test:storage` (v10→v11 마이그레이션 simulation + idempotency 통과)
- `pnpm build` 성공 (project references)
- `pnpm format:fix` 적용 후 재-typecheck (oxfmt 키 재정렬 반영, lefthook pre-commit 통과)
- **회귀 0 검증:** SDK 모드(기본값 `provider` 미지정) 시 main.ts 부트 + auto-reply + scheduler 경로 기존 테스트 전부 green
- (live, 수동) `pnpm test:live -- providers/claude-cli` 통과 (claude + login 환경)
- (게이트 전) **Q1 (A/B/C) 확정** — F1/G2/IT-2 의 cliSessionId 경로 코드 최종화

---

## 롤백 절차

각 밀스톤이 독립 커밋이라면 단계적 `git revert`:

- A~E (신규 파일만, 통합 전): revert 시 기존 동작 영향 0
- F: catalog ProviderId 확장 + config 스키마 + main.ts provider 생성 — revert 시 `new AnthropicAdapter(anthropicKey)` 직접 생성으로 복귀
- G: SCHEMA_VERSION 11→10 revert 시 **이미 v11 마이그레이션된 DB 는 cli_session_id 컬럼이 남음** (SQLite ADD COLUMN 비파괴 — 무해, 다음 부트에서 v10 으로 인식되지 않게 주의). 컬럼은 nullable 라 기존 코드 무영향.
- H: live 테스트만 — revert 무위험.

> 기본값 `provider: 'anthropic-sdk'` 유지 시 전체가 dormant — 사실상 런타임 롤백은 config 한 줄 제거로 충분.

---

## 요약

| 밀스톤                      | 신규/수정 파일                                                        | 단위 테스트  | 추정 |
| --------------------------- | --------------------------------------------------------------------- | ------------ | ---- |
| A CLI Backend Config        | types.ts, backends.ts (+test)                                         | 7            | 4h   |
| B Watchdog Ratio            | reliability.ts (+test)                                                | 5            | 2h   |
| C Spawn + Queue             | queue.ts, spawn.ts (+2 test)                                          | 5            | 1d   |
| D Parsers                   | parsers.ts (+test)                                                    | 5            | 3h   |
| E runCliAgent               | errors.ts, runner.ts (+test)                                          | 5            | 1d   |
| F Dual-Path                 | adapter.ts, factory.ts (+test) + catalog/config/types/main/index 수정 | 6            | 1d   |
| G cli_session_id + fallback | database.ts, agent-runs.ts, adapter.ts(G3) 수정 + 2 test              | 2 (+storage) | 4h   |
| H Live e2e                  | runner.live.test.ts                                                   | 3 (live)     | 4h   |
| 통합 + 최종 검증            | —                                                                     | —            | 1d   |

**합계: ~1,045 LOC + ~710 test LOC, ~6.5d (~1주).**
OpenClaw 직접 이식(A~E ~600 LOC) + FinClaw 통합(F~G ~400 LOC).
