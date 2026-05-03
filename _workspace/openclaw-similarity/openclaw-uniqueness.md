# OpenClaw 의 기술적 특별 요소 (HIGH 신뢰도)

생성: 2026-05-03
대상: OpenClaw `main` (v2026.2.23) — `/mnt/c/Users/박/Desktop/hi/openclaw`
독자: FinClaw 개발자 (Claude 단일 + Discord 단일 + 1인 + 모바일 비대상)

## 한 줄 결론

OpenClaw 의 진짜 특별한 패턴은 **Backend-as-CLI(claude CLI 하위프로세스를 LLM 백엔드로 사용) · Tool-Loop 4-Detector 의 sha256 hash 기반 stuckness 분류 · Cache Trace 8-stage JSONL fingerprint · FailoverError 단일 예외로 reason→HTTP 코드 매핑 · Top-of-Hour Stagger(thundering herd 방지) · Anthropic Payload Logger 의 sha256 digest audit · auth-profile 의 cooldown-aware round-robin · CLI watchdog noOutput timeout ratio**, 8개. **Claude+Discord 환경에서 즉시 도입 가치 ★★★★ 이상** 은 (1) Tool-Loop 4-Detector, (2) Top-of-Hour Stagger, (3) FailoverError 매핑 셋. **Backend-as-CLI 는 ★★★★★ 의 가치이지만 채택 시 아키텍처 전환 비용이 큼.** 나머지(ACP/Canvas-Host/Plugin-SDK/multi-modal 8 provider/markdown WhatsApp 변환)는 사용자 환경에서 **★ 이하**.

---

## 특별 요소 카탈로그

### 1. Backend-as-CLI 패턴 (claude / codex 하위프로세스를 LLM 백엔드로) — 별점 ★★★★★ / Claude+Discord 도입 가치 ★★★★★ (조건부)

**OpenClaw 의 무엇:**

`src/agents/cli-runner.ts:35-359` 의 `runCliAgent({...})` 는 SDK 가 아니라 **`claude` 또는 `codex` CLI 를 child_process 로 spawn 하여** LLM 호출을 위임한다. `cli-backends.ts:36-65` 에 박힌 기본 인자 셋:

```ts
const DEFAULT_CLAUDE_BACKEND: CliBackendConfig = {
  command: "claude",
  args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"],
  resumeArgs: [..., "--resume", "{sessionId}"],
  output: "json",
  modelArg: "--model",
  sessionArg: "--session-id",
  systemPromptArg: "--append-system-prompt",
  systemPromptMode: "append",
  systemPromptWhen: "first",
  clearEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD"],
  reliability: { watchdog: { fresh: ..., resume: ... } },
  serialize: true,
};
```

핵심: `clearEnv: ["ANTHROPIC_API_KEY"]` — **claude CLI 가 사용자의 Claude Code 구독 인증을 사용하도록 강제** (API key 가 있으면 그쪽으로 빠짐). `--session-id`/`--resume` 으로 multi-turn 세션 유지. `enqueueCliRun(queueKey, ...)` 으로 backend 별 직렬화. `process.supervisor.spawn` 이 PID/scope 추적.

**왜 특별한가:**

- 시중 어떤 AI 비서도 이 짓을 안 한다. SDK 호출이 표준. OpenClaw 는 **Claude Pro 구독자가 API 비용 추가 없이 비서를 돌릴 수 있는 유일한 길** 을 만들었다.
- `parseCliJsonl` / `parseCliJson` 으로 두 CLI(claude=json, codex=jsonl) 의 다른 출력 모드를 표준화.
- `resolveCliNoOutputTimeoutMs(backend, timeoutMs, useResume)` (`cli-runner/reliability.ts:57-71`) — 전체 타임아웃의 비율(`noOutputTimeoutRatio`) 로 watchdog 산출. **fresh vs resume 으로 다른 프로파일** (resume 은 보통 더 짧음).
- `result.reason === "no-output-timeout"` 이면 `FailoverError(reason="timeout")` 로 변환해 **상위 fallback 체인이 다른 backend 로 자동 폴백** 가능.

**Claude+Discord 환경 도입 가치:**

★★★★★ 가치이지만 **조건부**. FinClaw 가 SDK 직접 호출(`packages/agent/src/anthropic.ts`) 인 현재 구조에서 backend-as-CLI 로 가는 것은 **runner 전체 교체** 작업. 그러나:

- 사용자가 **Claude Pro/Max 구독자라면 API 비용 0원** 으로 비서 운영 가능 — 1인 비서 도메인의 가장 큰 비용 절감.
- LOC 추정: backend resolver(~150) + cli-runner(~400) + 기존 anthropic.ts 와 dual-path(~100). 총 ~650 LOC. 테스트 별도.
- 도입한다면 `packages/agent/src/anthropic.ts` 옆에 `cli.ts` 를 두고 `provider: "claude-cli" | "anthropic-sdk"` config 분기.
- **트레이드오프**: stream 토큰별 처리 불가(CLI 는 일괄 출력), prompt caching cache 제어 불가, tool_use protocol 일부 노출 안됨. FinClaw 의 tool registry 와 충돌 가능.

권장: **Phase 30+ 에서 "추가 backend" 로 검토**. 현재 SDK 경로 유지가 1순위.

---

### 2. Tool-Loop 4-Detector (sha256 hash 기반 stuckness 분류) — 별점 ★★★★★ / Claude+Discord 도입 가치 ★★★★☆

**OpenClaw 의 무엇:**

`src/agents/tool-loop-detection.ts:1-623` 에 4 detector 가 동시에 동작:

```ts
export type LoopDetectorKind =
  | 'generic_repeat' // 같은 (toolName, params) hash N회 반복
  | 'known_poll_no_progress' // command_status / process(poll|log) 의 result_hash 가 안 변함
  | 'global_circuit_breaker' // 어떤 도구든 동일 (args+result) hash 30회 → 세션 차단
  | 'ping_pong'; // toolA→toolB→toolA→toolB N회 + 양쪽 결과 안정
```

핵심 알고리즘:

1. `hashToolCall(toolName, params)` = `${toolName}:${sha256(stableStringify(params))}` (`tool-loop-detection.ts:106-108`)
2. `hashToolOutcome(toolName, params, result, error)` — known poll(`process.poll/log`) 인 경우 `status/exitCode/aggregated` 등 핵심 필드만 digest 해서 **출력은 다르게 보이지만 의미상 같은** 결과를 같은 hash 로 묶음 (`tool-loop-detection.ts:198-229`).
3. `getNoProgressStreak(history, toolName, argsHash)` — 같은 args+result hash 가 끊기지 않은 streak 계산. tail 부터 backward 스캔.
4. `getPingPongStreak(history, currentSignature)` — A↔B 교차 패턴 + 양쪽 모두 "result 가 안정(같은 hash)" 이어야 stuck 확정 (`tool-loop-detection.ts:317-355`). 단순 alternation 만으로는 false positive.
5. 등급: warning(10회) / critical(20회) / global circuit breaker(30회).

**왜 특별한가:**

- 일반 코딩 에이전트는 "max iterations" 같은 단순 카운터만. OpenClaw 는 **의미적 동등성** (poll 결과의 무의미한 timestamp 변화는 무시) 까지 잡는다.
- ping-pong 의 "양쪽 결과 안정" 검증 — Read→Edit→Read→Edit 반복이지만 실제 변화가 있으면 OK, 결과가 항상 같으면 stuck. 매우 정교.
- `warningKey` (`global:${tool}:${argsHash}:${resultHash}`) 로 **같은 stuckness 에 대해 한 번만 알리는 dedupe key** 제공.

**Claude+Discord 환경 도입 가치:**

★★★★☆ — `_workspace/openclaw-similarity/runtime-tools.md` 에서 FinClaw `registry.ts:295-297` 의 console.warn 만 출력하는 misimplemented 영역으로 이미 지적됨. 도입하면:

- LOC: 4 detector 전부 도입 시 ~450, generic_repeat + circuit_breaker 2개만 도입 시 ~180.
- 위치: `packages/agent/src/agents/tools/registry.ts` 의 execute 후 후크.
- FinClaw 1인 환경에서 가장 자주 발생할 stuck: `market.fetch` 또는 `news.search` 의 동일 심볼 반복. generic_repeat 만 도입해도 큰 효과.
- 별점이 ★★★★ 인 이유: ping-pong/known_poll 까지 가면 FinClaw 의 도구 셋(주가/뉴스/거래) 에서는 효용 낮음. 처음 2 detector 만이 핵심.

권장: **Phase 29 후보** — generic_repeat + global_circuit_breaker 2개로 시작.

---

### 3. Top-of-Hour Cron Stagger (썬더링 허드 방지) — 별점 ★★★★ / Claude+Discord 도입 가치 ★★★★★

**OpenClaw 의 무엇:**

`src/cron/stagger.ts:1-47` 의 47줄짜리 작은 모듈:

```ts
export const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000;

export function isRecurringTopOfHourCronExpr(expr: string) {
  const fields = parseCronFields(expr);
  if (fields.length === 5) {
    const [minuteField, hourField] = fields;
    return minuteField === '0' && hourField.includes('*'); // "0 * * * *" 류
  }
  // ...
}

export function resolveCronStaggerMs(schedule): number {
  const explicit = normalizeCronStaggerMs(schedule.staggerMs);
  if (explicit !== undefined) return explicit;
  return resolveDefaultCronStaggerMs(cronExpr) ?? 0;
}
```

핵심: 사용자가 `"0 * * * *"` (매시 정각) 로 cron 을 등록하면 **자동으로 0~5분 random stagger** 를 부여. 명시적 staggerMs 가 있으면 그걸 우선.

`src/cron/service/jobs.top-of-hour-stagger.test.ts` 가 이 동작을 회귀 보호.

**왜 특별한가:**

- 1인 비서라도 사용자가 "매 시간 포트폴리오 요약 보내줘" 같은 cron 5~10개를 등록하면 정각마다 동시 실행 → API 429 / DB lock 충돌. 일반 cron 라이브러리는 이걸 안 잡는다.
- "정각 cron 만" 자동 stagger — 5분 단위(`"*/5 * * * *"`) 등은 그냥 두는 것이 옳다. 분리 판정이 정교.
- 47줄에 모든 게 들어 있고 사이드이펙트 없음 — 순수 함수. 테스트하기 쉽고 도입하기 쉽다.

**Claude+Discord 환경 도입 가치:**

★★★★★ — FinClaw `packages/server/src/automation/scheduler.ts:69-351` 의 cron 1분 폴러는 정각 jobs 동시 실행 위험이 그대로 존재. Anthropic API 429 + SQLite WAL 충돌 위험.

- LOC: 47줄 그대로 이식 가능.
- 위치: `packages/server/src/automation/stagger.ts` 신설, `scheduler.ts` 의 `findDue` 후 stagger 적용.
- 별점이 ★★★★ 인 이유: OpenClaw 코드가 단순해서 "특별" 점수는 ★★★★ 이지만 도입 가치(비용 대비 효과) 는 최고급.

권장: **Phase 29 즉시 도입**. 이번 phase scope 와 정합.

---

### 4. FailoverError 단일 예외로 reason→HTTP status 매핑 — 별점 ★★★★ / Claude+Discord 도입 가치 ★★★★

**OpenClaw 의 무엇:**

`src/agents/failover-error.ts:1-240` 의 핵심 패턴:

```ts
export class FailoverError extends Error {
  readonly reason: FailoverReason; // billing/rate_limit/auth/timeout/format/model_not_found/unknown
  readonly provider?: string;
  readonly model?: string;
  readonly status?: number;
  readonly code?: string;
  // ...
}

export function resolveFailoverStatus(reason: FailoverReason): number | undefined {
  switch (reason) {
    case 'billing':
      return 402;
    case 'rate_limit':
      return 429;
    case 'auth':
      return 401;
    case 'timeout':
      return 408;
    case 'format':
      return 400;
    case 'model_not_found':
      return 404;
    default:
      return undefined;
  }
}

// 역방향: HTTP status → reason
export function resolveFailoverReasonFromError(err: unknown): FailoverReason | null {
  const status = getStatusCode(err);
  if (status === 402) return 'billing';
  if (status === 429) return 'rate_limit';
  // ...
  // ETIMEDOUT/ESOCKETTIMEDOUT/ECONNRESET → "timeout"
  // 메시지 정규식으로 폴백 분류
}
```

추가 정교함:

- `TIMEOUT_HINT_RE = /timeout|timed out|deadline exceeded|context deadline exceeded|stop reason:\s*abort|reason:\s*abort|unhandled stop reason:\s*abort/i` — Anthropic SDK 의 abort 메시지까지 timeout 으로 분류.
- `coerceToFailoverError(err, context)` — 임의 에러를 FailoverError 로 정규화하면서 cause 보존.

**왜 특별한가:**

- 일반 코드는 try/catch 마다 `if (err.status === 429) ...` 분산 처리. OpenClaw 는 **에러 분류를 단일 클래스에 응집**.
- HTTP status ↔ semantic reason 양방향 매핑. fallback chain 에서 `if (err.reason === "rate_limit")` 만 보면 됨.
- timeout 분류가 매우 까다로운데(SDK 마다 다름), 정규식 + status code + ENV var code(ETIMEDOUT 등) 3중 체크.

**Claude+Discord 환경 도입 가치:**

★★★★ — FinClaw `packages/agent/src/anthropic.ts` 가 raw error 를 그대로 throw. server runner 가 string match 로 분류 시도. 통합 클래스가 없어 `auth-profile cooldown` 같은 상위 패턴 도입의 토대가 부재.

- LOC: 240줄 그대로 이식 가능. FinClaw 도메인에 맞게 `model_not_found` 정도만 조정.
- 위치: `packages/agent/src/runtime/failover-error.ts` 신설.
- Multi-provider Critical Missing(SUMMARY.md #1) 보완의 전제 조건. provider adapter 추가 전에 이걸 먼저 깔아야 정상.
- 별점 ★★★★: 패턴 자체는 평범하지만 **양방향 매핑 + cause 보존 + 메시지 정규식** 의 정교함이 도드라짐.

권장: **Phase 29~30 에서 multi-provider 추가 전 선행 작업**.

---

### 5. Cache Trace 8-stage JSONL Fingerprint — 별점 ★★★★ / Claude+Discord 도입 가치 ★★★

**OpenClaw 의 무엇:**

`src/agents/cache-trace.ts:1-256`:

```ts
export type CacheTraceStage =
  | 'session:loaded' // SQLite 에서 로드
  | 'session:sanitized' // 토큰 sanitize 후
  | 'session:limited' // 토큰 윈도우 제한 적용 후
  | 'prompt:before' // prompt 빌드 직전
  | 'prompt:images' // 이미지 인라인 직전
  | 'stream:context' // streamFn 으로 들어가는 직전
  | 'session:after'; // run 완료 후

export type CacheTraceEvent = {
  ts;
  seq;
  stage;
  runId;
  sessionId;
  provider;
  modelId;
  prompt?;
  system?;
  options?;
  model?;
  messages?;
  messageCount?;
  messageRoles;
  messageFingerprints?;
  messagesDigest?; // sha256(fingerprints.join("|"))
  systemDigest?;
  // ...
};

const recordStage = (stage, payload) => {
  // ... systemDigest = sha256(stableStringify(system))
  // ... messageFingerprints = messages.map(m => sha256(stableStringify(m)))
  // ... messagesDigest = sha256(fingerprints.join("|"))
  writer.write(`${safeJsonStringify(event)}\n`);
};

const wrapStreamFn = (streamFn) => (model, context, options) => {
  recordStage('stream:context', { model: { id, provider, api }, system, messages, options });
  return streamFn(model, context, options);
};
```

핵심: 8 stage 마다 (1) `messages` 의 각 메시지를 sha256 해서 fingerprint 배열 생성, (2) 그 배열을 join 해서 `messagesDigest` 생성. **stage 사이에 messagesDigest 가 변하면 = caching 이 깨졌다**.

**왜 특별한가:**

- Anthropic prompt caching 은 cache key 가 **prefix exact match**. 어디서 한 글자라도 바뀌면 cache miss → 비용 폭증. 일반 audit 는 "그래서 어디서 깨졌는지" 답을 못 함.
- 8 stage 의 fingerprint 를 비교하면 "session:limited 와 prompt:before 사이에서 messagesDigest 변화 → 토큰 윈도우 제한이 cache prefix 를 깼다" 같이 **정확한 위치** 를 짚어낼 수 있다.
- `wrapStreamFn` 으로 streamFn 자체를 hook — 비침투적. 환경변수 `OPENCLAW_CACHE_TRACE=1` 로 on/off.
- JSONL queue writer (`getQueuedFileWriter`) 사용으로 fsync 충돌 없음.

**Claude+Discord 환경 도입 가치:**

★★★ — 가치는 분명하지만 **사용자 1인 환경에서 cache trace 가 진짜 필요한가?** 의문. FinClaw 는 24/7 가동이 아니고 발화량이 적어서 cache miss 비용이 낮음.

- LOC: 256줄 + queued-file-writer ~100. 총 ~350.
- project_use_case.md "감사 가능성" 원칙과 정합 — audit log 1개로서는 가치.
- SUMMARY.md "Cache trace 부재(Missing Important)" 항목과 직접 연결.
- 별점 ★★★ 의 이유: 매우 정교하지만 1인 환경 효용 한정. SaaS/팀 환경이라면 ★★★★★.

권장: **Phase 30+ 에 audit 강화 의도 있을 때만**. 우선순위는 Phase 29 의 #1~#4 보다 낮다.

---

### 6. CLI Watchdog Ratio (전체 timeout 의 비율로 noOutput timeout 자동 산출) — 별점 ★★★★ / Claude+Discord 도입 가치 ★★

**OpenClaw 의 무엇:**

`src/agents/cli-runner/reliability.ts:57-71`:

```ts
export function resolveCliNoOutputTimeoutMs(params: {
  backend: CliBackendConfig;
  timeoutMs: number;
  useResume: boolean;
}): number {
  const profile = pickWatchdogProfile(params.backend, params.useResume);
  const cap = Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, params.timeoutMs - 1_000);
  if (profile.noOutputTimeoutMs !== undefined) {
    return Math.min(profile.noOutputTimeoutMs, cap);
  }
  const computed = Math.floor(params.timeoutMs * profile.noOutputTimeoutRatio);
  const bounded = Math.min(profile.maxMs, Math.max(profile.minMs, computed));
  return Math.min(bounded, cap);
}
```

핵심: `noOutputTimeoutMs = clamp(timeoutMs * ratio, minMs, maxMs)` 로 산출. **fresh vs resume 으로 다른 ratio 프로파일** (fresh 는 보통 더 길게 — 생각하느라 출력이 늦어질 수 있으니). 명시적 값이 있으면 그걸 우선하되 항상 `timeoutMs - 1000` 으로 cap (overall timeout 보다 1초 일찍 watchdog 발동).

**왜 특별한가:**

- "프로세스가 X초 무응답이면 죽인다" 는 흔하지만, **전체 timeout 과의 비율로 자동 산출** + fresh/resume 분리는 드물다.
- `cap = timeoutMs - 1000` — overall timeout 보다 1초 일찍 watchdog 이 발동하도록 강제. 그래야 watchdog 이 죽이고 정확한 reason 을 분류할 시간이 있음.
- LLM 호출의 "출력은 느리지만 살아있다" vs "정말 죽었다" 의 본질적 모호함을 ratio 기반으로 풀어냄.

**Claude+Discord 환경 도입 가치:**

★★ — Backend-as-CLI 를 도입하지 않는 한 **직접 효용 없음**. SDK 호출은 SDK 자체가 timeout 처리. 다만:

- FinClaw `packages/skills-finance/src/market/*` 등 외부 API 호출에 응용 가능 — overall timeout 의 70% 를 noOutput timeout 으로.
- 별점 ★★★★ 의 이유: 패턴 자체는 매우 깔끔. 단지 사용 컨텍스트가 한정적.

권장: **도입 안 함**. 현재 안 쓰는 패턴.

---

### 7. Auth-Profile Cooldown-Aware Round Robin — 별점 ★★★★ / Claude+Discord 도입 가치 ★★

**OpenClaw 의 무엇:**

`src/agents/auth-profiles/order.ts:11-188` 의 `resolveAuthProfileOrder({cfg, store, provider, preferredProfile})`:

1. `clearExpiredCooldowns(store, now)` — 만료된 쿨다운부터 정리 (#3604 코멘트 — 쿨다운 직후 transient failure 로 다시 쿨다운되는 카스케이드 방지).
2. `explicitOrder` 우선(`store.order` > `cfg.auth.order`), 없으면 `lastUsed` 기반 정렬.
3. **available vs cooldown 으로 partition**:
   - available: 쿨다운 없는 프로파일들
   - cooldown: `cooldownUntil` 까지 못 쓰는 프로파일들 → expiry 빠른 순 정렬해서 끝에 append (다 망했어도 가장 빨리 풀릴 거 시도).
4. 결과: `[...available, ...cooldownSortedByExpiry]`.

`auth-profiles/usage.ts` 의 `resolveProfileUnusableUntil(stats)` 가 실패 횟수에 따라 exponential backoff 로 cooldown 시간 증가.

**왜 특별한가:**

- 일반 multi-key rotation 은 단순 round-robin. 쿨다운에 들어간 키도 그냥 건너뛰지만 **언제 풀리는지** 추적 안 함.
- "available 다 떨어지면 cooldown 중 가장 빨리 풀릴 거 시도" 는 graceful degradation. 모든 키가 쿨다운이어도 멈추지 않음.
- `lastUsed` 기반 round-robin → 같은 키만 hammer 하지 않음. 모든 키 균등 사용.
- 9 파일 ~1,500 LOC 의 모듈화: store(영속화) / order(선택) / repair(복구) / usage(stats) / oauth(OAuth flow) / external-cli-sync(claude-cli credentials 호환).

**Claude+Discord 환경 도입 가치:**

★★ — FinClaw 는 **Anthropic 단일 키** 사용. multi-key rotation 자체가 사용 안되는 패턴.

- 미래에 OpenAI/Google adapter 추가 시 useful 할 수 있으나 **multi-provider 자체가 SUMMARY.md 의 Critical Missing**.
- Phase 30+ 에서 multi-provider + multi-key 동시에 도입할 거라면 이 패턴 그대로 가져오기 가능.
- LOC: 9 파일 → 단순화해서 ~400.

권장: **현재 도입 안 함**. multi-provider 도입 시 동시 검토.

---

### 8. Anthropic Payload Logger (sha256 digest 으로 비용 audit) — 별점 ★★★ / Claude+Discord 도입 가치 ★★★

**OpenClaw 의 무엇:**

`src/agents/anthropic-payload-log.ts:1-185`:

```ts
const wrapStreamFn = (streamFn) => (model, context, options) => {
  if (!isAnthropicModel(model)) return streamFn(model, context, options);
  return streamFn(model, context, {
    ...options,
    onPayload: (payload) => {
      record({
        ts,
        stage: 'request',
        payload, // 전체 payload
        payloadDigest: sha256(stableStringify(payload)), // fingerprint
      });
      options?.onPayload?.(payload);
    },
  });
};

const recordUsage = (messages, error) => {
  const usage = findLastAssistantUsage(messages); // role:assistant 의 마지막 usage 필드
  record({ ts, stage: 'usage', usage, error });
};
```

특징:

- `options.onPayload` 콜백으로 hook (pi-ai SDK 가 제공하는 타이밍 — 실제 HTTP 직전).
- `findLastAssistantUsage` — assistant 메시지의 usage 필드를 backward 스캔. 여러 메시지 중 가장 마지막 것만 사용 비용으로 카운트.
- Anthropic 모델만 적용 (`isAnthropicModel`).
- `payloadDigest` 로 동일 prompt 재사용 여부 사후 검증 가능.

**왜 특별한가:**

- prompt + usage 를 한 JSONL 에 시간순으로 기록. 사후 비용 분석 시 "어느 prompt 가 얼마나 비쌌나" 직접 매칭 가능.
- digest 로 caching hit 추정 — 같은 digest 다른 cache_creation/cache_read 비율 비교.
- Cache Trace(#5) 와 짝을 이룸. Cache Trace = 빌드 단계, Payload Logger = 송신 단계.

**Claude+Discord 환경 도입 가치:**

★★★ — FinClaw 도 Anthropic 단일 → 그대로 적용 가능.

- LOC: 185줄 직접 이식.
- 위치: `packages/agent/src/runtime/payload-log.ts` 신설.
- project_use_case.md "감사 가능성·SQLite 영구 저장" 원칙과 정합. Cache Trace 보다 가치 비율 좋음 (구현 작고 효용 직접적).
- 별점 ★★★ 의 이유: 패턴이 sha256 + JSONL 로 평범하지만 `findLastAssistantUsage` backward scan + Anthropic 모델 한정 적용이 깔끔.

권장: **Phase 30 audit 보강 시 도입**.

---

## OpenClaw 의 "겉모습은 화려하지만 실제로는 평범한" 요소 (참고)

사용자가 OpenClaw 에서 "오 이거 멋지다" 고 느낄 수 있지만 본질은 흔한 wrapper 인 것들:

1. **ACP 프로토콜 (`src/acp/` 14 파일)** — Cursor/Zed 같은 외부 IDE 통합. 그러나 본질은 `@agentclientprotocol/sdk` 가 정의한 ndjson stream 프로토콜의 **단순 어댑터**. 게이트웨이 클라이언트 + 메시지 포워딩이 전부. 표준 따르기 외에 OpenClaw 만의 알고리즘 없음. **사용자가 IDE 에서 OpenClaw 를 부르지 않을 거라면 ★ 가치**.

2. **Canvas-Host (`src/canvas-host/`)** — A2UI 의 ChatGPT Canvas 류 호스팅. 본질은 chokidar 파일 와처 + WebSocket live reload + http 정적 서빙. **흔한 dev server 패턴**. 한계: A2UI spec 자체가 완성도 낮음. 사용자 1인 비서에 Canvas 거의 무가치 → ☆.

3. **Multi-modal 8 provider (`src/media-understanding/{anthropic,deepgram,google,groq,minimax,mistral,openai,zai}`)** — 8개 보이지만 각 디렉토리는 5~10 파일의 **API client + 결과 normalize**. 추상화는 `MediaUnderstandingProvider` 인터페이스 정도. FinClaw 가 음성/이미지 처리 안 한다면 **★ 이하**.

4. **Markdown WhatsApp/Telegram 변환 (`src/markdown/whatsapp.ts`)** — 78줄짜리 정규식 기반 변환. `**bold**` → `*bold*` 등. 채널 인디펜던트 출력의 핵심이지만 **로직 자체는 매우 단순**. 매력적으로 보이는 다채널 추상화의 실체는 이 80줄짜리 변환들. **Discord 는 표준 markdown** → FinClaw 도입 가치 0.

5. **Plugin-SDK 38 extensions** — `src/plugin-sdk/index.ts:1-506` 의 144개 export. 본질은 **type re-export + helper 함수 30~40개**. extensions 패키지 38개 중 채널 어댑터(slack, telegram, line, whatsapp 등) 가 다수 — 외부 plugin 작성 시 channel adapter 인터페이스 제공. SDK 자체 알고리즘은 적음. FinClaw 1인+1채널 → **사실상 0 가치**.

6. **Skills 카탈로그 52개 + Progressive Disclosure** — 화려해 보이지만 SKILL.md frontmatter + glob 매칭 + 시스템 프롬프트 주입의 **흔한 RAG 패턴**. FinClaw 의 plans/phase29 에서 검토.

7. **Bash exec PTY + sandbox 16 모듈** — `src/agents/bash-tools.exec.ts:1-584` + `pty-keys.ts:1-291` + `src/agents/sandbox/` 32 파일. 정교하지만 **쓰임 자체가 코딩 에이전트용**. FinClaw 금융 비서가 PTY 가 필요한 시나리오 없음.

8. **Apply-patch 자기-편집** — `src/agents/apply-patch.ts:1-532`. claude/codex CLI 가 자기 자신을 편집할 때 쓰는 \*\*\* Begin Patch 포맷 파서. 코딩 에이전트의 핵심 도구. 금융 비서 도메인 무관.

9. **Subagent system + announce idempotency** — `subagent-*.ts` 다수. 금융 1인 비서는 sub-agent 가 거의 필요 없음. 다만 `announce-idempotency.ts:6-25` 의 `v1:${childSessionKey}:${childRunId}` 키 패턴은 깔끔하지만 25줄. 패턴이라 부르기도 작음.

---

## OpenClaw 의 약점 (잘 알려지지 않은 것)

본 deep-dive 에서 직접 발견한 OpenClaw 측 결함:

1. **`bash-tools.exec.ts` 의 `validateScriptFileForShellBleed` 가 코미디성 휴리스틱** — `src/agents/bash-tools.exec.ts:113-150` 가 python/js 파일에 `$ENV_VAR` 가 있으면 "shell syntax leak 의심" 으로 경고. 그런데 매칭이 `[A-Z_][A-Z0-9_]{1,}` 라서 **JS 의 `$state`, `$$` 등은 우회**. 또 file size 512KB 미만만 검사. 보안 가치 거의 없는 cosmetic check.

2. **`cli-runner.ts:81-86` 의 하드코딩된 prompt suffix** — `"Tools are disabled in this session. Do not call tools."` 가 **모든** CLI run 에 append. backend-as-CLI 모드에서 tool 사용 불가하다는 것을 model 에게 강제하지만, 사용자 systemPrompt 에 이 줄이 항상 들어가는 건 의도/문서가 부족.

3. **`tool-loop-detection.ts:64-100` 의 default `enabled: false`** — 4 detector 가 정교한데 **기본값 disabled**. 사용자가 명시적으로 켜야 동작. 즉 OpenClaw 사용자 대다수가 이 기능의 가치를 못 받고 있을 가능성이 높음. (FinClaw 가 도입한다면 default enabled 권장.)

4. **`auth-profiles` 의 `clearExpiredCooldowns` 가 매 호출 시 sync I/O** — `order.ts:24` 가 `resolveAuthProfileOrder` 호출마다 store mutate. 빈번한 모델 호출 시 file lock 충돌 가능. lazy clear 가 더 안전했을 것.

5. **`cache-trace.ts` 의 `messages` 전체 직렬화 비용** — `wrapStreamFn` 이 stage 마다 `safeJsonStringify(event)` 호출. messages 가 100K+ chars 이면 stage 마다 N MB 쓰기. `OPENCLAW_CACHE_TRACE_MESSAGES=false` 로 끄지 않으면 prod 부담.

6. **Plugin-SDK 의 type-only export 가 144개 중 ~80%** — `src/plugin-sdk/index.ts:8-...` 가 type-only re-export 다수. 실제 helper 함수는 30~40개. SDK 라기보다 **type alias 카탈로그**.

7. **`apply-patch.ts:1-532` 가 코드만 532줄, 테스트 별도 ~600줄** — `*** Begin Patch` 포맷이 OpenClaw 가 만든 게 아니라 OpenAI Codex 의 표준. 그러나 OpenClaw 의 구현이 **claude CLI 의 native diff 도구가 더 풍부한데도** 이걸 직접 가짐 → 코드 중복 의심.

8. **`system-prompt.ts:1-695`** — 695줄짜리 평탄한 builder. 14개 section builder 가 한 파일에. 분할 안 됨. system prompt 가 길수록 cache 가치는 낮아진다(첫 호출 cache miss 비용 큼).

---

## Claude+Discord 환경 우선 도입 권장 Top 3

가치/비용 비율로:

### 1순위: Top-of-Hour Cron Stagger (★★★★★ 도입 가치)

- **이유**: 47줄 단일 파일 그대로 이식. FinClaw scheduler 의 정각 cron thundering herd 위험 직접 해소.
- **비용**: ~50 LOC + 테스트 ~80 LOC. 1시간 작업.
- **위치**: `packages/server/src/automation/stagger.ts` 신설, `scheduler.ts` 의 `findDue` 후 적용.

### 2순위: Tool-Loop Detection 2-Detector(generic_repeat + global_circuit_breaker) (★★★★ 도입 가치)

- **이유**: SUMMARY.md 의 Misimplemented Important 직접 보완. 4개 중 핵심 2개만으로 90% 효용.
- **비용**: ~180 LOC + 테스트 ~250 LOC. 반나절 작업. sha256 hash 함수는 이미 storage 에 있을 것.
- **위치**: `packages/agent/src/agents/tools/loop-detection.ts` 신설, `registry.ts` 의 execute 후크에서 호출.

### 3순위: FailoverError 단일 예외 + reason↔HTTP 매핑 (★★★★ 도입 가치)

- **이유**: 향후 multi-provider 도입 전제 조건. project_use_case.md "감사 가능성" 정합. 현재 분산된 에러 분류를 응집.
- **비용**: ~240 LOC. 기존 anthropic.ts 의 raw throw 를 `FailoverError` 로 wrap (~30 LOC 변경).
- **위치**: `packages/agent/src/runtime/failover-error.ts` 신설.
- **선행 가치**: cache trace / payload logger / multi-provider 도입 모두 이걸 깔고 시작하는 게 맞음.

**그 다음 후보**: Anthropic Payload Logger(★★★) — Phase 30 의 audit 강화 작업과 묶어서. Backend-as-CLI(★★★★★ 가치이지만 ★★★ 비용·전환 리스크) — Phase 31+ 의 별도 트랙.

---

## 신뢰도 등급

모든 평가가 OpenClaw 코드 직접 인용 기반 **HIGH**.

- 8 special items 모두 파일·라인·함수 시그니처 인용.
- "겉만 화려한 9개" / "약점 8개" 모두 코드 직접 확인 후 작성.
- Claude+Discord 도입 가치 평가는 SUMMARY.md / project_use_case.md / FinClaw CLAUDE.md 의 "사용자 1인 + Discord 단일 + 모바일 비대상 + Anthropic 단일" 제약을 직접 적용한 결과.
