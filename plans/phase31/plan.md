# Phase 31 — OpenClaw Adoption (Critical Fix Pack)

## Context

`_workspace/openclaw-similarity/SUMMARY-v2.md` 의 deep-dive 가 OpenClaw (`/mnt/c/Users/박/Desktop/hi/openclaw`, `main` v2026.2.23) 와의 1:1 매핑을 HIGH 신뢰도로 수행한 결과:

- 거시 유사도 ≈ 55% — Critical 알고리즘은 충실히 모방, RAG 주입·11 패키지 분할은 OpenClaw 보다 우월
- 그러나 OpenClaw 의 검증된 작은 패턴 6건이 **그대로 이식 가능**하면서 사용자에게 즉각 효용을 준다는 사실 확인:
  1. **Top-of-Hour Stagger** (cron 정각 thundering herd 방지) — 47 LOC
  2. **Error Backoff** (실패 시 [30s/1m/5m/15m/60m]) — ~20 LOC
  3. **Compaction 배선** (compactContext 호출 1군데 추가) — ~10 LOC
  4. **Tool-Loop 2-Detector** (sha256 hash + circuit breaker) — ~180 LOC
  5. **Session Tool-Result Guard** (oversized text block 자동 truncate) — ~80 LOC
  6. **Schedule Agent Tool** (자연어 자동화 등록) — ~100 LOC

본 Phase 의 목표는 단 하나: **위 6건을 그대로 이식하여 운영 회복력·long-conversation 보호·자동화 사용성을 즉시 끌어올린다.** 큰 아키텍처 변경(Backend-as-CLI 등)은 별도 Phase 32 로 분리.

### 사용자 컨텍스트 (Phase 31 진입 전 확정)

- **LLM provider**: Claude (Anthropic) 단일. multi-provider 비대상.
- **채널**: Discord 단일. multi-channel 비대상.
- **사용자 1인** + 모바일 비대상.
- **구독**: Claude Max (Backend-as-CLI 후속 트랙에서 활용 예정, 본 Phase 무관).
- **원칙 유지**: 감사 가능성 · 환각 방지 · 읽기 전용 (project_use_case.md).

### 사실 검증 (HIGH 신뢰도, deep-dive 산출)

| 항목              | OpenClaw 원본 위치                                              | FinClaw 적용 위치                                                                    | 검증 방식                                |
| ----------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------- |
| Stagger           | `src/cron/stagger.ts:1-47`                                      | `packages/server/src/automation/stagger.ts` (신규) + `scheduler.ts` 통합             | 양쪽 직접 인용                           |
| Backoff           | `src/cron/service/timer.ts:108-119`                             | `packages/server/src/automation/scheduler.ts:280-310` retry 자리                     | 양쪽 직접 인용                           |
| Compaction 배선   | OpenClaw `cli-runner.ts` 의 prompt 빌드 직전 호출 패턴          | `packages/agent/src/execution/runner.ts` 또는 `auto-reply/stages/context.ts`         | grep 으로 server import 0 확인           |
| Tool-Loop         | `src/agents/tool-loop-detection.ts:106-360`                     | `packages/agent/src/agents/tools/registry.ts:295-297` 자리 + 신규 `loop-detector.ts` | `console.warn` only 직접 확인            |
| Tool-Result Guard | `src/agents/pi-embedded-runner/tool-result-truncation.ts:1-140` | `packages/agent/src/agents/session/tool-result-guard.ts` (신규)                      | OpenClaw 자체 디렉토리, 외부 패키지 아님 |
| Schedule Tool     | `src/agents/tools/cron-tool.ts:1-200` (TypeBox)                 | `packages/skills-general/src/schedule-tool.ts` (신규, Zod 변환)                      | 직접 인용                                |

---

## 밀스톤 A — Top-of-Hour Stagger

### 목표

Cron expression 이 정각 패턴(`"0 * * * *"`, `"0 0 * * *"` 등)이면 0~5분 random 분산을 자동 부여하여 동시 실행 thundering herd 방지. Anthropic API 429 + SQLite WAL 충돌 위험 제거.

### 전제

- `packages/server/src/automation/scheduler.ts:78-94` 매분 폴러 + `findDueSchedules` 가 동일 분에 due 인 모든 schedule 을 동시 큐잉.
- 사용자가 12시 보고 + 매시간 알림 + 매일 아침 요약 등 정각 schedule 5개 이상 등록 시 즉시 위험.

### 작업

**파일:**

- `packages/server/src/automation/stagger.ts` (신규, 47 LOC — OpenClaw 원본 그대로 + import 만 조정)
- `packages/server/src/automation/scheduler.ts` (수정, ~5 LOC — `findDueSchedules` 후 stagger 적용)
- `packages/server/test/automation/stagger.test.ts` (신규, ~50 LOC)

#### A1. `stagger.ts` — OpenClaw 원본 그대로 이식

**OpenClaw 원본** (`/mnt/c/Users/박/Desktop/hi/openclaw/src/cron/stagger.ts:1-47`):

```ts
import type { CronSchedule } from './types.js';

export const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000;

function parseCronFields(expr: string) {
  return expr.trim().split(/\s+/).filter(Boolean);
}

export function isRecurringTopOfHourCronExpr(expr: string) {
  const fields = parseCronFields(expr);
  if (fields.length === 5) {
    const [minuteField, hourField] = fields;
    return minuteField === '0' && hourField.includes('*');
  }
  if (fields.length === 6) {
    const [secondField, minuteField, hourField] = fields;
    return secondField === '0' && minuteField === '0' && hourField.includes('*');
  }
  return false;
}

export function normalizeCronStaggerMs(raw: unknown): number | undefined {
  const numeric =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim()
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return Math.max(0, Math.floor(numeric));
}

export function resolveDefaultCronStaggerMs(expr: string): number | undefined {
  return isRecurringTopOfHourCronExpr(expr) ? DEFAULT_TOP_OF_HOUR_STAGGER_MS : undefined;
}

export function resolveCronStaggerMs(schedule: {
  cron?: string;
  staggerMs?: number | string;
}): number {
  const explicit = normalizeCronStaggerMs(schedule.staggerMs);
  if (explicit !== undefined) {
    return explicit;
  }
  return resolveDefaultCronStaggerMs(schedule.cron ?? '') ?? 0;
}
```

**FinClaw 측 변경**: `import type { CronSchedule }` 제거, `resolveCronStaggerMs` 의 인자 타입을 FinClaw 의 `Schedule` 형식(`{cron: string, staggerMs?: number}`)으로 단순화.

#### A2. `scheduler.ts` 통합

`packages/server/src/automation/scheduler.ts:134` (`due = findDueSchedules(...)` 직후) 에 추가:

```ts
import { resolveCronStaggerMs } from './stagger.js';

// findDueSchedules 결과에 stagger 적용
for (const schedule of due) {
  const staggerMs = resolveCronStaggerMs(schedule);
  if (staggerMs > 0) {
    const jitter = Math.floor(Math.random() * staggerMs);
    if (jitter > 0) {
      // 이번 폴링에서는 skip, 다음 폴링까지 대기
      this.deps.logger.debug('schedule.staggered', {
        scheduleId: schedule.id,
        cron: schedule.cron,
        jitterMs: jitter,
      });
      continue;
    }
  }
  // 기존 runOne 호출 흐름
}
```

**주의**: 단순 `setTimeout(..., jitter)` 대신 "이번 분 skip + 다음 분 재평가" 패턴이 SQLite 동시 락에 안전. OpenClaw 도 같은 패턴.

#### A3. 테스트 (`stagger.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TOP_OF_HOUR_STAGGER_MS,
  isRecurringTopOfHourCronExpr,
  resolveCronStaggerMs,
} from '../../src/automation/stagger.js';

describe('isRecurringTopOfHourCronExpr', () => {
  it('returns true for "0 * * * *"', () => {
    expect(isRecurringTopOfHourCronExpr('0 * * * *')).toBe(true);
  });
  it('returns false for "*/5 * * * *"', () => {
    expect(isRecurringTopOfHourCronExpr('*/5 * * * *')).toBe(false);
  });
  it('returns true for "0 */2 * * *" (매 2시간 정각)', () => {
    expect(isRecurringTopOfHourCronExpr('0 */2 * * *')).toBe(true);
  });
  it('returns false for "30 * * * *" (정각 아님)', () => {
    expect(isRecurringTopOfHourCronExpr('30 * * * *')).toBe(false);
  });
});

describe('resolveCronStaggerMs', () => {
  it('returns 0 for non-top-of-hour', () => {
    expect(resolveCronStaggerMs({ cron: '*/5 * * * *' })).toBe(0);
  });
  it('returns DEFAULT for top-of-hour', () => {
    expect(resolveCronStaggerMs({ cron: '0 * * * *' })).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });
  it('honors explicit staggerMs', () => {
    expect(resolveCronStaggerMs({ cron: '0 * * * *', staggerMs: 60_000 })).toBe(60_000);
  });
});
```

### 완료 조건

- `pnpm test --filter @finclaw/server -- stagger` 4개 테스트 통과
- `packages/server/src/automation/scheduler.ts:134` 부근에 stagger 호출 정확히 1군데
- 매분 폴러가 정각에 5개 schedule 동시 발화하던 회귀가 5분 분산으로 전환됨 (수동 검증)

### 추정

**1시간** (이식 30분 + 테스트 20분 + 통합 검증 10분)

---

## 밀스톤 B — Schedule Error Backoff

### 목표

연속 실패 시 retry 간격을 [30s, 1m, 5m, 15m, 60m] 로 지수 증가. `* * * * *` schedule 이 매분 실패하던 retry storm + Claude API 비용 폭발 위험 즉시 차단.

### 전제

- `packages/server/src/automation/scheduler.ts:289-310` 가 이미 `consecutiveFailures` 추적 + 3회 시 auto-disable. 그러나 _next_run_at 은 cron 의 다음 발화 그대로_ — backoff 부재가 핵심 갭.
- `markScheduleRun(db, s.id, runId, Date.now(), nextMs)` 가 `nextMs` 를 cron 계산값으로 받는 자리에 backoff override 삽입.

### 작업

**파일:**

- `packages/server/src/automation/scheduler.ts` (수정, ~15 LOC — backoff 함수 + override 자리)
- `packages/server/test/automation/scheduler.backoff.test.ts` (신규, ~40 LOC)

#### B1. Backoff 함수 추가

**OpenClaw 원본** (`src/cron/service/timer.ts:107-119`):

```ts
/**
 * Exponential backoff delays (in ms) indexed by consecutive error count.
 * After the last entry the delay stays constant.
 */
const ERROR_BACKOFF_SCHEDULE_MS = [
  30_000, // 1st error  →  30 s
  60_000, // 2nd error  →   1 min
  5 * 60_000, // 3rd error  →   5 min
  15 * 60_000, // 4th error  →  15 min
  60 * 60_000, // 5th+ error → 60 min
];

function errorBackoffMs(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, ERROR_BACKOFF_SCHEDULE_MS.length - 1);
  return ERROR_BACKOFF_SCHEDULE_MS[Math.max(0, idx)];
}
```

**FinClaw 측 위치**: `packages/server/src/automation/scheduler.ts` 파일 상단의 import 직후, class 선언 위에 그대로 추가.

#### B2. nextMs override 자리

`scheduler.ts:289-310` 의 `markScheduleRun` 직전에:

```ts
// 기존 코드
let nextMs: number | null = null;
try {
  const cron = parseCron(s.cron);
  nextMs = computeNextRunAt(cron, Date.now());
} catch (cronErr) {
  /* ... */
}

// === 추가: 실패 시 backoff override ===
if (error && nextMs !== null) {
  const failures = (fresh?.consecutiveFailures ?? 0) + 1; // 곧 fresh 갱신될 값
  const backoffMs = errorBackoffMs(failures);
  const backoffNextMs = Date.now() + backoffMs;
  // backoff 가 cron 의 다음 발화보다 *나중* 이면 backoff 적용
  if (backoffNextMs > nextMs) {
    nextMs = backoffNextMs;
    this.deps.logger.info('schedule.backoff_applied', {
      event: 'schedule.backoff_applied',
      scheduleId: s.id,
      consecutiveFailures: failures,
      backoffMs,
      nextRunAt: backoffNextMs,
    });
  }
}
// === 추가 끝 ===

markScheduleRun(this.deps.db, s.id, runId, Date.now(), nextMs);
```

#### B3. 테스트 (`scheduler.backoff.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
// errorBackoffMs 를 export 해서 테스트 가능하게 한다
import { errorBackoffMs } from '../../src/automation/scheduler.js';

describe('errorBackoffMs', () => {
  it('returns 30s for 1st error', () => {
    expect(errorBackoffMs(1)).toBe(30_000);
  });
  it('returns 60s for 2nd error', () => {
    expect(errorBackoffMs(2)).toBe(60_000);
  });
  it('returns 5m for 3rd error', () => {
    expect(errorBackoffMs(3)).toBe(5 * 60_000);
  });
  it('returns 15m for 4th error', () => {
    expect(errorBackoffMs(4)).toBe(15 * 60_000);
  });
  it('returns 60m for 5th error', () => {
    expect(errorBackoffMs(5)).toBe(60 * 60_000);
  });
  it('caps at 60m for 10th error', () => {
    expect(errorBackoffMs(10)).toBe(60 * 60_000);
  });
  it('returns 30s for 0 (defensive)', () => {
    expect(errorBackoffMs(0)).toBe(30_000);
  });
});
```

추가 통합 테스트 (선택):

- `* * * * *` schedule 이 3회 연속 실패 시 next_run_at 이 5분 후로 미뤄지는지 검증.

### 완료 조건

- `errorBackoffMs` 7개 단위 테스트 통과
- 통합 테스트 1개 (3회 실패 시 nextMs 가 5분 후 ± 1초)
- 기존 `auto-disable @ 3 failures` 회귀 테스트 통과

### 추정

**30분**

---

## 밀스톤 C — Compaction 배선 (dead code → live)

### 목표

이미 구현된 `compactContext` / `evaluateContextWindow` (Phase 26 산출) 를 agent loop 또는 auto-reply context stage 에 연결하여 long-conversation 자동 보호 활성화.

### 전제

- 검증 결과 (`grep -rn 'compactContext\|evaluateContextWindow' packages/server packages/agent --include='*.ts'`):
  - `packages/agent/src/index.ts:157` export 만
  - `packages/agent/src/agents/context/window-guard.ts:48` 정의
  - `packages/agent/src/agents/context/compaction.ts:126` 정의
  - **server/auto-reply 어디서도 import 안 함** → dead code
- OpenClaw 는 `cli-runner.ts` 의 prompt 빌드 직전에 호출. FinClaw 는 SDK 직호출이라 `runner.ts` 또는 `context.ts` stage 가 자연스러운 자리.

### 작업

**옵션 1 (권장)**: `packages/agent/src/execution/runner.ts` 의 turn loop 진입 직전.

**옵션 2**: `packages/server/src/auto-reply/stages/context.ts` 에서 system prompt 빌드 직후, execute stage 직전.

본 plan 은 **옵션 2** 채택 — 옵션 1 은 agent 패키지가 storage 에 의존하지 않아 summarizer 주입이 어렵다. context stage 는 이미 storage·agent 양쪽에 접근.

**파일:**

- `packages/server/src/auto-reply/stages/context.ts` (수정, ~15 LOC)
- `packages/server/test/auto-reply/stages/context.compaction.test.ts` (신규, ~50 LOC)

#### C1. context stage 통합

`packages/server/src/auto-reply/stages/context.ts` 의 system prompt + transcript 빌드가 끝나고 다음 stage 로 넘기기 직전:

```ts
import { evaluateContextWindow, compactContext } from '@finclaw/agent';
// ↑ index.ts:157 export 된 함수 사용

// ... 기존 transcript 빌드 ...
const transcript = /* 빌드된 메시지 배열 */;

// === 추가: 컨텍스트 윈도우 평가 + 필요시 compaction ===
const windowState = evaluateContextWindow(
  transcript,
  ctx.modelInfo.maxInputTokens,
  ctx.modelInfo.maxOutputTokens,
  { warnRatio: 0.7, criticalRatio: 0.85, reserveTokens: 4096 },
  ctx.tokenCounter,  // 이미 ctx 에 주입돼 있어야 함
);

let finalTranscript = transcript;
if (windowState.status === 'critical' || windowState.status === 'exceeded') {
  ctx.logger.warn('context.compaction_triggered', {
    event: 'context.compaction_triggered',
    status: windowState.status,
    usedTokens: windowState.usedTokens,
    maxTokens: windowState.effectiveMax,
  });
  const result = await compactContext(
    transcript,
    { targetRatio: 0.5 },
    ctx.summarizer,    // anthropic adapter 가 제공
    ctx.tokenCounter,
  );
  finalTranscript = result.entries;
  ctx.logger.info('context.compacted', {
    event: 'context.compacted',
    strategy: result.strategy,
    beforeTokens: windowState.usedTokens,
    afterTokens: result.tokenCount,
  });
}
// === 추가 끝 ===

return { ...ctx, transcript: finalTranscript };
```

#### C2. 의존성 주입

`pipeline-context.ts` (또는 상응) 에 `tokenCounter` + `summarizer` 추가:

```ts
export interface PipelineContext {
  // ... 기존
  tokenCounter: (text: string) => number;
  summarizer: (text: string) => Promise<string>;
}
```

`main.ts` 에서 pipeline 초기화 시 anthropic adapter 의 token counter + summarize 함수 주입.

#### C3. 테스트

```ts
import { describe, it, expect, vi } from 'vitest';
import { runContextStage } from '../../../src/auto-reply/stages/context.js';

describe('context stage compaction', () => {
  it('skips compaction when usedTokens < critical', async () => {
    const summarizer = vi.fn();
    const ctx = makeMockCtx({
      transcript: makeShortTranscript(),
      modelInfo: { maxInputTokens: 200_000, maxOutputTokens: 8_000 },
      summarizer,
    });
    const result = await runContextStage(ctx);
    expect(summarizer).not.toHaveBeenCalled();
  });

  it('triggers compaction when usedTokens >= critical (85%)', async () => {
    const summarizer = vi.fn().mockResolvedValue('summarized');
    const ctx = makeMockCtx({
      transcript: makeLongTranscript(/* > 85% of 200K */),
      modelInfo: { maxInputTokens: 200_000, maxOutputTokens: 8_000 },
      summarizer,
    });
    const result = await runContextStage(ctx);
    expect(summarizer).toHaveBeenCalled();
    expect(result.transcript.length).toBeLessThan(ctx.transcript.length);
  });
});
```

### 완료 조건

- `compactContext` 호출 grep 결과가 `agent/src/index.ts:157` (export) + `auto-reply/stages/context.ts` (1군데 호출) 두 곳에서 발견
- 단위 테스트 2개 통과
- 회귀 0 — 기존 짧은 대화는 compaction 호출되지 않음

### 추정

**30분**

---

## 밀스톤 D — Tool-Loop 2-Detector

### 목표

`packages/agent/src/agents/tools/registry.ts:295-297` 의 `console.warn` only 패턴을 OpenClaw 의 sha256 hash 기반 detection 으로 교체. **generic_repeat + global_circuit_breaker** 2 detector 만 도입 (ping-pong / known-poll 은 FinClaw 도구 셋에서 효용 낮아 보류).

### 전제

- `registry.ts:124-133` 의 `isToolLoop` (5 calls / 10s window) + `:295-297` 의 console.warn 코멘트만 — verdict 변경 없음 (검증 완료).
- OpenClaw 의 detection 은 _result hash_ 까지 봐서 "결과가 안 변하면" stuck 판정 — 의미적 동등성. FinClaw 도 도입 시 동일 효용.

### 작업

**파일:**

- `packages/agent/src/agents/tools/loop-detector.ts` (신규, ~180 LOC)
- `packages/agent/src/agents/tools/registry.ts` (수정, ~30 LOC — 기존 isToolLoop 제거 + loop-detector 호출)
- `packages/agent/test/tools/loop-detector.test.ts` (신규, ~120 LOC)

#### D1. `loop-detector.ts` — OpenClaw 발췌 + 단순화

OpenClaw 원본 (`src/agents/tool-loop-detection.ts:1-360`) 중 _generic_repeat + circuit_breaker_ 만 추출. ping_pong / known_poll 부분은 제거.

핵심 발췌 (그대로 이식):

```ts
// packages/agent/src/agents/tools/loop-detector.ts

import { createHash } from 'node:crypto';

export const TOOL_CALL_HISTORY_SIZE = 30;
export const WARNING_THRESHOLD = 10;
export const CRITICAL_THRESHOLD = 20;
export const GLOBAL_CIRCUIT_BREAKER_THRESHOLD = 30;

export type LoopDetectorKind = 'generic_repeat' | 'global_circuit_breaker';

export type LoopDetectionResult =
  | { stuck: false }
  | {
      stuck: true;
      level: 'warning' | 'critical';
      detector: LoopDetectorKind;
      count: number;
      message: string;
      warningKey?: string;
    };

export interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  resultHash?: string;
}

// === stableStringify + digestStable: OpenClaw 원본 그대로 (tool-loop-detection.ts:113-148) ===

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).toSorted();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function digestStable(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${digestStable(params)}`;
}

export function hashToolResult(result: unknown, error: unknown): string | undefined {
  if (error !== undefined) {
    return `error:${digestStable(error instanceof Error ? error.message : String(error))}`;
  }
  if (result === undefined || result === null) {
    return undefined;
  }
  return digestStable(result);
}

// === getNoProgressStreak: OpenClaw 원본 (tool-loop-detection.ts:235-263) ===

function getNoProgressStreak(
  history: ToolCallRecord[],
  toolName: string,
  argsHash: string,
): { count: number; latestResultHash?: string } {
  let streak = 0;
  let latestResultHash: string | undefined;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const record = history[i];
    if (!record || record.toolName !== toolName || record.argsHash !== argsHash) continue;
    if (typeof record.resultHash !== 'string' || !record.resultHash) continue;
    if (!latestResultHash) {
      latestResultHash = record.resultHash;
      streak = 1;
      continue;
    }
    if (record.resultHash !== latestResultHash) break;
    streak += 1;
  }
  return { count: streak, latestResultHash };
}

// === detectToolCallLoop: 2 detector 단순화 ===

export function detectToolCallLoop(
  history: ToolCallRecord[],
  toolName: string,
  params: unknown,
): LoopDetectionResult {
  const argsHash = hashToolCall(toolName, params);
  const noProgress = getNoProgressStreak(history, toolName, argsHash);

  if (noProgress.count >= GLOBAL_CIRCUIT_BREAKER_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'global_circuit_breaker',
      count: noProgress.count,
      message: `CRITICAL: ${toolName} repeated ${noProgress.count} times with no progress. Session blocked.`,
      warningKey: `global:${toolName}:${argsHash}:${noProgress.latestResultHash ?? 'none'}`,
    };
  }

  if (noProgress.count >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'generic_repeat',
      count: noProgress.count,
      message: `Tool "${toolName}" called ${noProgress.count} times with identical args+result. Possible infinite loop.`,
      warningKey: `repeat:${toolName}:${argsHash}`,
    };
  }

  if (noProgress.count >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'generic_repeat',
      count: noProgress.count,
      message: `Tool "${toolName}" called ${noProgress.count} times with no progress.`,
      warningKey: `repeat:${toolName}:${argsHash}`,
    };
  }

  return { stuck: false };
}

export function appendHistory(
  history: ToolCallRecord[],
  record: ToolCallRecord,
  maxSize = TOOL_CALL_HISTORY_SIZE,
): ToolCallRecord[] {
  const next = [...history, record];
  return next.length > maxSize ? next.slice(-maxSize) : next;
}
```

#### D2. `registry.ts` 통합

기존 (`registry.ts:124-133, 295-297`):

```ts
// 제거 대상
const LOOP_THRESHOLD = 5;
const LOOP_WINDOW_MS = 10_000;
function isToolLoop(timestamps: number[]): boolean {
  /* ... */
}

// :295-297 제거 대상
if (isToolLoop(timestamps)) {
  console.warn(`[ToolRegistry] Tool loop detected for "${name}", forcing require-approval`);
}
```

신규:

```ts
import {
  detectToolCallLoop,
  hashToolCall,
  hashToolResult,
  appendHistory,
  type ToolCallRecord,
} from './loop-detector.js';

class InMemoryToolRegistry {
  private callHistory: ToolCallRecord[] = [];
  private warningKeysSeen = new Set<string>();

  async execute(name: string, params: unknown): Promise<ToolResult> {
    // ... 기존 9-stage policy 통과 후

    // === 추가: 루프 감지 (verdict 변경 가능) ===
    const loopResult = detectToolCallLoop(this.callHistory, name, params);
    if (loopResult.stuck) {
      const dedupeKey = loopResult.warningKey ?? '';
      if (!this.warningKeysSeen.has(dedupeKey)) {
        this.warningKeysSeen.add(dedupeKey);
        this.logger.warn('tool.loop_detected', {
          event: 'tool.loop_detected',
          tool: name,
          detector: loopResult.detector,
          level: loopResult.level,
          count: loopResult.count,
          message: loopResult.message,
        });
      }
      if (loopResult.level === 'critical') {
        // global_circuit_breaker — 차단
        return {
          ok: false,
          error: { code: 'tool.loop_blocked', message: loopResult.message },
        };
      }
      // warning — verdict 를 require-approval 로 강제 (실제 차단)
      // policyResult.finalVerdict = 'require-approval';  ← 9-stage 정책 결과 override
    }
    // === 추가 끝 ===

    // ... 기존 hooks + 실행 ...
    const result = /* tool 실제 실행 */;
    const error = /* 발생 에러 */;

    // === 추가: history 기록 ===
    this.callHistory = appendHistory(this.callHistory, {
      toolName: name,
      argsHash: hashToolCall(name, params),
      resultHash: hashToolResult(result, error),
    });
    // === 추가 끝 ===

    return result;
  }
}
```

#### D3. 테스트 (`loop-detector.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import {
  detectToolCallLoop,
  hashToolCall,
  hashToolResult,
  appendHistory,
  WARNING_THRESHOLD,
  CRITICAL_THRESHOLD,
  GLOBAL_CIRCUIT_BREAKER_THRESHOLD,
} from '../../src/agents/tools/loop-detector.js';

describe('hashToolCall', () => {
  it('returns same hash for same params (key order independent)', () => {
    const a = hashToolCall('market.fetch', { symbol: 'AAPL', limit: 10 });
    const b = hashToolCall('market.fetch', { limit: 10, symbol: 'AAPL' });
    expect(a).toBe(b);
  });
  it('returns different hash for different tool', () => {
    expect(hashToolCall('a', {})).not.toBe(hashToolCall('b', {}));
  });
});

describe('detectToolCallLoop', () => {
  const sameArgs = { symbol: 'AAPL' };
  const sameResult = { price: 180 };

  function buildHistory(count: number) {
    let h: any[] = [];
    for (let i = 0; i < count; i++) {
      h = appendHistory(h, {
        toolName: 'market.fetch',
        argsHash: hashToolCall('market.fetch', sameArgs),
        resultHash: hashToolResult(sameResult, undefined),
      });
    }
    return h;
  }

  it('returns stuck:false under warning threshold', () => {
    const h = buildHistory(9);
    const r = detectToolCallLoop(h, 'market.fetch', sameArgs);
    expect(r.stuck).toBe(false);
  });

  it('returns warning at threshold (10)', () => {
    const h = buildHistory(WARNING_THRESHOLD - 1);
    // 10번째 detect 호출
    const r = detectToolCallLoop(h, 'market.fetch', sameArgs);
    expect(r.stuck).toBe(true);
    if (r.stuck) {
      expect(r.level).toBe('warning');
      expect(r.detector).toBe('generic_repeat');
    }
  });

  it('returns critical at threshold (20)', () => {
    const h = buildHistory(CRITICAL_THRESHOLD - 1);
    const r = detectToolCallLoop(h, 'market.fetch', sameArgs);
    expect(r.stuck && r.level).toBe('critical');
  });

  it('returns global_circuit_breaker at threshold (30)', () => {
    const h = buildHistory(GLOBAL_CIRCUIT_BREAKER_THRESHOLD - 1);
    const r = detectToolCallLoop(h, 'market.fetch', sameArgs);
    expect(r.stuck && r.detector).toBe('global_circuit_breaker');
  });

  it('breaks streak when result changes', () => {
    let h = buildHistory(15);
    // 다른 result 1번 끼움
    h = appendHistory(h, {
      toolName: 'market.fetch',
      argsHash: hashToolCall('market.fetch', sameArgs),
      resultHash: hashToolResult({ price: 200 }, undefined),
    });
    // 이후 같은 args + 같은 result 5번 더
    for (let i = 0; i < 5; i++) {
      h = appendHistory(h, {
        toolName: 'market.fetch',
        argsHash: hashToolCall('market.fetch', sameArgs),
        resultHash: hashToolResult({ price: 200 }, undefined),
      });
    }
    const r = detectToolCallLoop(h, 'market.fetch', sameArgs);
    // streak 가 5 (새 result 시작 후) 라 warning 미달
    expect(r.stuck).toBe(false);
  });
});
```

### 완료 조건

- 단위 테스트 6개 모두 통과
- `registry.ts:295-297` 의 `console.warn` 코드 제거 확인
- 통합 테스트: `market.fetch({symbol:'AAPL'})` 를 동일 결과로 30회 호출 시 31회째 `tool.loop_blocked` 에러 반환

### 추정

**반나절** (이식 1.5h + registry 통합 1.5h + 테스트 1h)

---

## 밀스톤 E — Session Tool-Result Guard

### 목표

거대한 tool result (시세 일봉 365일치 / 뉴스 수십 건 raw 응답 등) 를 transcript persist 직전에 자동 truncate. 토큰 폭발 + Claude 400 (oversize) 차단.

### 전제

- 사용자 도메인이 시세/뉴스/거래 → tool result 가 큰 JSON 일 가능성 매우 높음 (예: yahoo-finance 일봉 365건 ~50KB).
- OpenClaw `pi-embedded-runner/tool-result-truncation.ts` 가 _OpenClaw 자체_ 디렉토리 — 외부 패키지 아님 (사실 정정).
- FinClaw 의 transcript 메시지 형식은 Anthropic SDK 의 `MessageParam` (content blocks 배열).

### 작업

**파일:**

- `packages/agent/src/agents/session/tool-result-guard.ts` (신규, ~80 LOC)
- `packages/agent/src/agents/session/index.ts` (수정, re-export)
- `packages/agent/test/agents/session/tool-result-guard.test.ts` (신규, ~80 LOC)
- transcript builder 통합 (위치는 코드 인스펙션 후 결정 — 후보: `agent/src/execution/runner.ts` 의 message append 직전, 또는 `auto-reply/stages/execute.ts`)

#### E1. `tool-result-guard.ts` — OpenClaw 발췌 + 타입 매핑

OpenClaw 원본 (`src/agents/pi-embedded-runner/tool-result-truncation.ts:43-140`) 의 `truncateToolResultText` + `truncateToolResultMessage` 를 FinClaw 메시지 타입에 맞게 재작성:

```ts
// packages/agent/src/agents/session/tool-result-guard.ts

import type { Anthropic } from '@anthropic-ai/sdk';

type ToolResultBlock = Anthropic.ToolResultBlockParam;
type Message = Anthropic.MessageParam;

/**
 * OpenClaw 원본 상수 그대로:
 * - HARD_MAX_TOOL_RESULT_CHARS = 400_000  (~100K tokens; 2M context window 의 30%)
 * - MIN_KEEP_CHARS = 2_000  (truncation 시 최소 보존)
 */
export const HARD_MAX_TOOL_RESULT_CHARS = 400_000;
export const MIN_KEEP_CHARS = 2_000;

export const TRUNCATION_SUFFIX =
  "\n\n⚠️ [Content truncated — original was too large for the model's context window. " +
  'The content above is a partial view. If you need more, request specific sections or use ' +
  'offset/limit parameters to read smaller chunks.]';

/**
 * OpenClaw `truncateToolResultText` 그대로 — 줄바꿈 경계로 자르기.
 */
export function truncateToolResultText(
  text: string,
  maxChars: number,
  options: { suffix?: string; minKeepChars?: number } = {},
): string {
  const suffix = options.suffix ?? TRUNCATION_SUFFIX;
  const minKeep = options.minKeepChars ?? MIN_KEEP_CHARS;
  if (text.length <= maxChars) return text;

  const keepChars = Math.max(minKeep, maxChars - suffix.length);
  let cutPoint = keepChars;
  const lastNewline = text.lastIndexOf('\n', keepChars);
  if (lastNewline > keepChars * 0.8) {
    cutPoint = lastNewline;
  }
  return text.slice(0, cutPoint) + suffix;
}

/**
 * Tool result 메시지의 text content block 들을 truncate.
 * Anthropic SDK 의 ToolResultBlockParam 형식에 맞춰 재작성.
 */
export function truncateToolResult(
  block: ToolResultBlock,
  maxChars: number = HARD_MAX_TOOL_RESULT_CHARS,
): ToolResultBlock {
  if (typeof block.content === 'string') {
    return {
      ...block,
      content: truncateToolResultText(block.content, maxChars),
    };
  }
  if (!Array.isArray(block.content)) return block;

  // 전체 길이 체크
  const totalChars = block.content.reduce((sum, c) => {
    if (c.type === 'text' && typeof c.text === 'string') return sum + c.text.length;
    return sum;
  }, 0);
  if (totalChars <= maxChars) return block;

  // 비율 기반으로 각 text block 분할
  const newContent = block.content.map((c) => {
    if (c.type !== 'text' || typeof c.text !== 'string') return c;
    const share = c.text.length / totalChars;
    const blockMax = Math.max(MIN_KEEP_CHARS, Math.floor(maxChars * share));
    return { ...c, text: truncateToolResultText(c.text, blockMax) };
  });

  return { ...block, content: newContent };
}

/**
 * 메시지 배열에서 모든 tool_result block 을 guard.
 */
export function applyToolResultGuard(
  messages: Message[],
  maxChars: number = HARD_MAX_TOOL_RESULT_CHARS,
): Message[] {
  return messages.map((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
    const newContent = msg.content.map((block) => {
      if (block.type === 'tool_result') {
        return truncateToolResult(block, maxChars);
      }
      return block;
    });
    return { ...msg, content: newContent };
  });
}
```

#### E2. 통합 위치

**옵션 1**: `packages/agent/src/execution/runner.ts` 의 turn loop 에서 tool_result 를 messages 에 append 하기 직전.

**옵션 2**: transcript persistence 직전 (storage 측).

본 plan **옵션 1** 채택 — Anthropic API 호출 직전 guard 가 명확.

`runner.ts` 의 tool_result append 자리:

```ts
import { truncateToolResult, HARD_MAX_TOOL_RESULT_CHARS } from '../agents/session/tool-result-guard.js';

// 기존:
const toolResultBlock: Anthropic.ToolResultBlockParam = {
  type: 'tool_result',
  tool_use_id: callId,
  content: rawContent,
};

// 변경:
const guardedBlock = truncateToolResult({
  type: 'tool_result',
  tool_use_id: callId,
  content: rawContent,
}, HARD_MAX_TOOL_RESULT_CHARS);

if (guardedBlock !== /* ... */) {
  this.logger.warn('tool_result.truncated', {
    event: 'tool_result.truncated',
    callId,
    originalChars: /* 측정 */,
    truncatedChars: HARD_MAX_TOOL_RESULT_CHARS,
  });
}
```

#### E3. 테스트

```ts
import { describe, it, expect } from 'vitest';
import {
  truncateToolResultText,
  truncateToolResult,
  HARD_MAX_TOOL_RESULT_CHARS,
  MIN_KEEP_CHARS,
} from '../../../src/agents/session/tool-result-guard.js';

describe('truncateToolResultText', () => {
  it('returns original when under maxChars', () => {
    expect(truncateToolResultText('short', 100)).toBe('short');
  });
  it('truncates at newline boundary', () => {
    const text = 'a\nb\nc\nd\ne';
    const result = truncateToolResultText(text, 5, { suffix: '...', minKeepChars: 3 });
    expect(result.endsWith('...')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(8);
  });
  it('respects minKeepChars', () => {
    const result = truncateToolResultText('x'.repeat(1000), 100, {
      minKeepChars: 500,
      suffix: 'END',
    });
    expect(result.length).toBeGreaterThanOrEqual(500);
  });
});

describe('truncateToolResult', () => {
  it('passes through string content under limit', () => {
    const block = {
      type: 'tool_result' as const,
      tool_use_id: 't1',
      content: 'short result',
    };
    expect(truncateToolResult(block, 100).content).toBe('short result');
  });

  it('truncates string content over limit', () => {
    const big = 'x'.repeat(500_000);
    const block = {
      type: 'tool_result' as const,
      tool_use_id: 't1',
      content: big,
    };
    const result = truncateToolResult(block, HARD_MAX_TOOL_RESULT_CHARS);
    expect((result.content as string).length).toBeLessThanOrEqual(HARD_MAX_TOOL_RESULT_CHARS);
  });

  it('truncates array content (multi text block) by share', () => {
    const block = {
      type: 'tool_result' as const,
      tool_use_id: 't1',
      content: [
        { type: 'text' as const, text: 'A'.repeat(300_000) },
        { type: 'text' as const, text: 'B'.repeat(200_000) },
      ],
    };
    const result = truncateToolResult(block, HARD_MAX_TOOL_RESULT_CHARS);
    const totalLen = (result.content as any[]).reduce((s, c) => s + (c.text?.length ?? 0), 0);
    expect(totalLen).toBeLessThanOrEqual(HARD_MAX_TOOL_RESULT_CHARS + 200); // suffix 여유
  });
});
```

### 완료 조건

- 단위 테스트 6개 통과
- 시세 365일 일봉 mock fetch 후 tool_result 가 `tool_result.truncated` 로그 생성 + size <= 400KB
- Anthropic API 400 oversize 회귀 0

### 추정

**1시간**

---

## 밀스톤 F — Schedule Agent Tool (자연어 자동화 등록)

### 목표

사용자가 Discord 에서 "매일 오후 12시에 포트폴리오 보고해줘" 라고 발화하면 agent 가 `schedule.create` 를 호출해 등록할 수 있게 한다. 시나리오 B (이전 deep-dive) 해결.

### 전제

- `packages/server/src/gateway/rpc/methods/schedule.ts` 가 이미 9개 RPC 메서드 (create/list/update/delete/runNow/history/disable/enable/testCron) 노출 — Phase 28 산출.
- FinClaw 의 도구는 **Zod v4** schema (OpenClaw 의 TypeBox 와 다름).
- agent 가 RPC 를 호출하는 패턴은 `packages/skills-finance/src/*` 가 표준 — 그 패턴 따라간다.

### 작업

**파일:**

- `packages/skills-general/src/schedule-tool.ts` (신규, ~100 LOC — Zod schema + 도구 정의)
- `packages/skills-general/src/index.ts` (수정, re-export + register)
- `packages/skills-general/test/schedule-tool.test.ts` (신규, ~60 LOC — mock RPC)

#### F1. 도구 정의 (Zod, FinClaw 표준)

OpenClaw 의 cron-tool 은 `status/list/add/update/remove/run/runs/wake` 8 action. 본 plan 은 **3 action** 으로 단순화 — Discord 1인 환경에 wake/runs 같은 운영 action 불요. agent 가 자주 호출할 패턴만:

```ts
// packages/skills-general/src/schedule-tool.ts

import { z } from 'zod';
import type { ToolDefinition } from '@finclaw/agent';
import type { ScheduleRpc } from '@finclaw/types'; // RPC 클라이언트 인터페이스

const ScheduleToolInput = z.object({
  action: z.enum(['create', 'list', 'delete']),

  // create 인자
  name: z.string().min(1).max(80).optional(),
  cron: z
    .string()
    .min(1)
    .optional()
    .describe('Cron expression. 예: "0 12 * * *" (매일 12시), "0 9 * * 1" (매주 월요일 9시)'),
  prompt: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe('Schedule 발동 시 agent 에 보낼 명령. 예: "현재 포트폴리오 요약해줘"'),

  // delete 인자
  scheduleId: z.string().optional(),
});

export function createScheduleTool(rpc: ScheduleRpc): ToolDefinition {
  return {
    name: 'schedule.manage',
    description: [
      '사용자의 자동화 schedule 을 등록/조회/삭제한다.',
      '사용자가 "매일 X시에 Y해줘", "매주 월요일에 Z 보내줘" 같이 요청하면 action="create" 호출.',
      'cron 표현은 표준 5-field (분 시 일 월 요일). timezone 은 UTC 기준.',
      '한국 시간 12시 = UTC 03:00 → cron "0 3 * * *".',
    ].join(' '),
    input_schema: ScheduleToolInput,

    async execute(input) {
      switch (input.action) {
        case 'create': {
          if (!input.name || !input.cron || !input.prompt) {
            return { ok: false, error: 'name, cron, prompt are all required for create' };
          }
          // cron 사전 검증
          try {
            await rpc.testCron({ cron: input.cron });
          } catch (e) {
            return { ok: false, error: `Invalid cron: ${(e as Error).message}` };
          }
          const result = await rpc.create({
            name: input.name,
            cron: input.cron,
            prompt: input.prompt,
            enabled: true,
          });
          return { ok: true, data: { scheduleId: result.id, nextRunAt: result.nextRunAt } };
        }
        case 'list': {
          const result = await rpc.list({ limit: 20 });
          return {
            ok: true,
            data: result.schedules.map((s) => ({
              id: s.id,
              name: s.name,
              cron: s.cron,
              enabled: s.enabled,
              status: s.status,
              consecutiveFailures: s.consecutiveFailures,
              nextRunAt: s.nextRunAt,
            })),
          };
        }
        case 'delete': {
          if (!input.scheduleId) {
            return { ok: false, error: 'scheduleId required for delete' };
          }
          await rpc.delete({ scheduleId: input.scheduleId });
          return { ok: true, data: { deleted: input.scheduleId } };
        }
      }
    },
  };
}
```

#### F2. 등록

`packages/skills-general/src/index.ts`:

```ts
export { createScheduleTool } from './schedule-tool.js';

export function registerGeneralTools(deps: { rpc: ScheduleRpc /* ... */ }) {
  return [
    createScheduleTool(deps.rpc),
    // ... 기존 도구
  ];
}
```

`packages/server/src/main.ts` (또는 skills 등록 위치) 에서 `rpc` 를 생성해 주입.

#### F3. 테스트

```ts
import { describe, it, expect, vi } from 'vitest';
import { createScheduleTool } from '../src/schedule-tool.js';

describe('schedule.manage tool', () => {
  function makeMockRpc() {
    return {
      create: vi.fn().mockResolvedValue({ id: 'sch_1', nextRunAt: 1234567890 }),
      list: vi.fn().mockResolvedValue({ schedules: [] }),
      delete: vi.fn().mockResolvedValue({}),
      testCron: vi.fn().mockResolvedValue({ valid: true }),
    };
  }

  it('creates schedule from natural language intent', async () => {
    const rpc = makeMockRpc();
    const tool = createScheduleTool(rpc);
    const result = await tool.execute({
      action: 'create',
      name: '매일 12시 포트폴리오 보고',
      cron: '0 3 * * *', // KST 12시 = UTC 03:00
      prompt: '현재 포트폴리오 요약해줘',
    });
    expect(result.ok).toBe(true);
    expect(rpc.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '매일 12시 포트폴리오 보고',
        cron: '0 3 * * *',
        enabled: true,
      }),
    );
  });

  it('rejects create with missing fields', async () => {
    const rpc = makeMockRpc();
    const tool = createScheduleTool(rpc);
    const result = await tool.execute({
      action: 'create',
      name: 'test',
    } as any);
    expect(result.ok).toBe(false);
  });

  it('rejects invalid cron via testCron', async () => {
    const rpc = makeMockRpc();
    rpc.testCron.mockRejectedValue(new Error('Invalid cron syntax'));
    const tool = createScheduleTool(rpc);
    const result = await tool.execute({
      action: 'create',
      name: 'bad',
      cron: 'not a cron',
      prompt: 'x',
    });
    expect(result.ok).toBe(false);
    expect(rpc.create).not.toHaveBeenCalled();
  });

  it('lists schedules', async () => {
    const rpc = makeMockRpc();
    rpc.list.mockResolvedValue({
      schedules: [
        {
          id: 'sch_1',
          name: '12시 보고',
          cron: '0 3 * * *',
          enabled: true,
          status: 'active',
          consecutiveFailures: 0,
          nextRunAt: 0,
        },
      ],
    });
    const tool = createScheduleTool(rpc);
    const result = await tool.execute({ action: 'list' });
    expect(result.ok).toBe(true);
    expect((result.data as any[]).length).toBe(1);
  });
});
```

### 완료 조건

- 단위 테스트 4개 통과
- e2e: Discord 에서 "매일 오전 9시에 한국 주가 알려줘" 발화 → schedule 1개 생성 + `agent_runs` 에 schedule_id 연결됨
- 사용자가 "내 자동화 목록 보여줘" 발화 시 list 정상 응답

### 추정

**반나절** (도구 1.5h + 등록·통합 1.5h + 테스트 1h)

---

## 통합 테스트

### 시나리오 1 — 12시 정기 보고 (Stagger + Backoff + Compaction 통합)

1. 사용자: Discord 에서 "매일 12시에 포트폴리오 요약 보내줘" (밀스톤 F)
2. agent 가 `schedule.manage(action: 'create', cron: '0 3 * * *', ...)` 호출
3. 매분 폴러가 12:00 UTC 03:00 도달 시 due 로 판정
4. 다른 정각 schedule 4개 동시 due → stagger 적용으로 0~5분 분산 (밀스톤 A)
5. 첫 schedule 실행 — agent.run → 포트폴리오 RAG 주입 → Discord delivery
6. 만약 실패 시 다음 retry 가 backoff 적용 (밀스톤 B)
7. 토큰이 critical 임계 도달 시 compaction 발동 (밀스톤 C)

### 시나리오 2 — 도구 무한 호출 차단 (Tool-Loop)

1. 사용자: "AAPL 주가 계속 보여줘"
2. agent 가 `market.fetch({symbol:'AAPL'})` 호출 → 동일 결과 30회 반복
3. 31회째 호출 시 `tool.loop_blocked` 차단 (밀스톤 D)
4. agent 가 사용자에게 "동일한 조회 반복 감지. 다른 질문이 있으신가요?" 응답

### 시나리오 3 — 거대 tool result 자동 truncate

1. 사용자: "AAPL 5년치 일봉 다 보여줘"
2. agent 가 `market.history({symbol:'AAPL', range:'5y'})` 호출 → ~500KB JSON
3. tool_result_guard 가 400KB 로 truncate + 로그 (밀스톤 E)
4. Anthropic API 400 (oversize) 회피 — 응답 정상 생성

---

## 완료 기준 (전체)

- [ ] 6 밀스톤 모두 단위 테스트 통과 (총 ~33 테스트)
- [ ] 통합 시나리오 3 모두 e2e 통과
- [ ] 회귀 0 — 기존 vitest 모두 통과 (`pnpm test`)
- [ ] `pnpm typecheck` 0 에러
- [ ] `pnpm lint` 0 경고
- [ ] CLAUDE.md 의 Phase 31 변경 이력 추가 (선택)

## 추정 합계

| 밀스톤                  | LOC (이식 + 통합)                   | 시간             |
| ----------------------- | ----------------------------------- | ---------------- |
| A. Stagger              | 47 + 5 + 50(test)                   | 1h               |
| B. Backoff              | 12 + 15 + 40(test)                  | 30m              |
| C. Compaction 배선      | 0 + 15 + 50(test)                   | 30m              |
| D. Tool-Loop 2-Detector | 180 + 30 + 120(test)                | 4h               |
| E. Tool-Result Guard    | 80 + 10 + 80(test)                  | 1h               |
| F. Schedule Tool        | 100 + 20 + 60(test)                 | 4h               |
| 통합 검증               | —                                   | 1h               |
| **합계**                | **419 + 95 + 400(test) = ~914 LOC** | **~12h (1.5일)** |

OpenClaw 직접 이식 ~240 LOC + FinClaw 통합 ~95 LOC + 테스트 ~400 LOC.

## 후속 (Phase 32 별도 트랙)

본 Phase 의 6 밀스톤이 완료된 후:

- **Backend-as-CLI** — Claude Max 구독 활용. ~730 LOC, 1주. `plans/phase32/plan.md` 별도 작성.
- **FailoverError 양방향 매핑** (선택) — multi-provider 도입 의도가 생기면.
- **Cache Trace 8-stage** (선택) — audit 강화 의도가 생기면.
- **Markdown 1차 source 메모리** (선택) — 메모리 git 추적 원할 때.
