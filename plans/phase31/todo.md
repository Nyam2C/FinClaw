# Phase 31 Todo: Runtime Resilience — OpenClaw Adoption (Critical Fix Pack)

> `plans/phase31/plan.md` 의 6 밀스톤 A~F 를 코드 단위로 분해한 구현 가이드.
> OpenClaw 검증 패턴 6건 (Stagger / Backoff / Compaction wiring / Tool-Loop / Tool-Result Guard / Schedule Tool) 을 그대로 이식한다.
> 본 phase 비대상: Backend-as-CLI, FailoverError, Cache Trace, Markdown 메모리 (모두 Phase 32).

---

## 사전 준비

### P-1. `_workspace_prev/` 정리 확인

- `_workspace/phase-execute/31-todo-draft.md` 이전 산출물 없음 (첫 실행)
- 의존성 추가 없음 — `crypto.createHash` 는 Node.js 내장, `@anthropic-ai/sdk` / `zod` 는 기존 dep

### P-2. plan.md 의 사실 검증 결과 (architect 가 코드와 교차 확인)

- `packages/server/src/automation/scheduler.ts:133` 의 `tick()` 메서드 존재 (plan.md 정확)
- `packages/server/src/automation/scheduler.ts:140` `findDueSchedules` 호출 자리 (A2 통합 지점)
- `packages/agent/src/agents/tools/registry.ts:136-142` `LOOP_THRESHOLD`/`isToolLoop` 정의, `:305-306` `console.warn` 위치 (plan.md 의 124-133/295-297 보다 실측이 정확)
- `packages/agent/src/execution/runner.ts:164-172` tool_result `messages.push` (plan.md 정확)
- `packages/server/src/auto-reply/pipeline-context.ts:18` `PipelineMsgContext` 시작 (plan.md 정확)
- `packages/agent/src/agents/context/{compaction.ts,window-guard.ts}` 존재 — Phase 26 산출, server import 0 (dead code)
- `packages/agent/src/agents/session/` 존재 (`index.ts` 있음 → re-export 가능)

### P-3. 테스트 디렉토리 컨벤션 결정

- `packages/server/test/automation/` 신규 생성 (plan.md 명시 위치; 기존은 `src/` co-located 였으나 plan 따름)
- `packages/agent/test/tools/`, `packages/agent/test/agents/session/` 신규 하위 (기존 `test/providers/` 패턴 일치)
- `packages/skills-general/test/` 신규 생성 (스킬 패키지 첫 테스트)

---

## 밀스톤 A — Top-of-Hour Stagger (1h)

### 목표

정각 cron (`"0 * * * *"`, `"0 0 * * *"`) 에 0~5분 jitter 분산 — Anthropic 429 + SQLite WAL 충돌 방지.

### A1. CREATE `packages/server/src/automation/stagger.ts`

OpenClaw `src/cron/stagger.ts:1-47` 이식. `import type { CronSchedule }` 제거 + 인자 타입 단순화.

```ts
// packages/server/src/automation/stagger.ts

export const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000;

function parseCronFields(expr: string): string[] {
  return expr.trim().split(/\s+/).filter(Boolean);
}

export function isRecurringTopOfHourCronExpr(expr: string): boolean {
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
  if (!Number.isFinite(numeric)) return undefined;
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
  if (explicit !== undefined) return explicit;
  return resolveDefaultCronStaggerMs(schedule.cron ?? '') ?? 0;
}
```

검증: `pnpm --filter @finclaw/server build` 통과.

### A2. EDIT `packages/server/src/automation/scheduler.ts` — `tick()` 의 `findDueSchedules` 직후 stagger 적용

기존 (`scheduler.ts:133-150` 부근, `tick()` 메서드 안):

```ts
private async tick(): Promise<void> {
  const now = Date.now();
  let due: Schedule[];
  try {
    due = findDueSchedules(this.deps.db, now);
  } catch (e) {
    this.deps.logger.warn('scheduler.tick_failed', { /* ... */ });
    return;
  }
  // ... 기존 loop ...
}
```

변경 (`findDueSchedules` 결과 loop 진입 직전에 stagger 필터 추가):

```ts
import { resolveCronStaggerMs } from './stagger.js';

// ... tick() 안, due 받은 직후 ...
for (const schedule of due) {
  const staggerMs = resolveCronStaggerMs(schedule);
  if (staggerMs > 0) {
    const jitter = Math.floor(Math.random() * staggerMs);
    if (jitter > 0) {
      // 이번 폴링 skip — 다음 분 폴링이 재평가
      this.deps.logger.debug('schedule.staggered', {
        event: 'schedule.staggered',
        scheduleId: schedule.id,
        cron: schedule.cron,
        jitterMs: jitter,
      });
      continue;
    }
  }
  // 기존 runOne 호출 흐름
  // ... 기존 코드 ...
}
```

주의: `setTimeout(..., jitter)` 대신 "이번 분 skip + 다음 분 재평가" — SQLite 동시 락 안전. OpenClaw 동일 패턴.

검증: `pnpm --filter @finclaw/server typecheck` 0 에러.

### A3. CREATE `packages/server/test/automation/stagger.test.ts`

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
  it('honors explicit staggerMs over default', () => {
    expect(resolveCronStaggerMs({ cron: '0 * * * *', staggerMs: 60_000 })).toBe(60_000);
  });
});
```

### A4. 밀스톤 A 검증

다음을 모두 통과해야 다음 밀스톤으로:

- `pnpm test --filter @finclaw/server -- stagger` (4+3 = 7 테스트)
- `pnpm typecheck`
- `grep -n 'resolveCronStaggerMs' packages/server/src/automation/scheduler.ts` 가 1건 이상
- 회귀: 기존 `scheduler.test.ts` 통과

추정: **1h** (이식 30m + 테스트 20m + 통합 검증 10m)

---

## 밀스톤 B — Schedule Error Backoff (30m)

### 목표

연속 실패 시 retry 간격 [30s, 1m, 5m, 15m, 60m] 지수 증가. `* * * * *` retry storm + Claude API 비용 폭발 차단.

### B1. EDIT `packages/server/src/automation/scheduler.ts` — 파일 상단에 backoff 상수 + 함수 추가

OpenClaw `src/cron/service/timer.ts:107-119` 이식. import 직후, class 선언 위에 추가:

```ts
/**
 * Exponential backoff delays (in ms) indexed by consecutive error count.
 * After the last entry the delay stays constant.
 * OpenClaw src/cron/service/timer.ts:107-119 이식.
 */
const ERROR_BACKOFF_SCHEDULE_MS = [
  30_000, // 1st error  →  30 s
  60_000, // 2nd error  →   1 min
  5 * 60_000, // 3rd error  →   5 min
  15 * 60_000, // 4th error  →  15 min
  60 * 60_000, // 5th+ error →  60 min
];

export function errorBackoffMs(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, ERROR_BACKOFF_SCHEDULE_MS.length - 1);
  return ERROR_BACKOFF_SCHEDULE_MS[Math.max(0, idx)];
}
```

`export` 는 테스트가 import 가능하게 하기 위함.

### B2. EDIT `packages/server/src/automation/scheduler.ts` — `markScheduleRun` 직전에 backoff override

위치: `scheduler.ts:289-310` 부근 (retry/markScheduleRun 자리). 인스펙션 단계에서 정확 라인 확인 후 진행:

```ts
// 기존 코드 — nextMs 계산
let nextMs: number | null = null;
try {
  const cron = parseCron(s.cron);
  nextMs = computeNextRunAt(cron, Date.now());
} catch (cronErr) {
  /* ... 기존 ... */
}

// === 추가: 실패 시 backoff override ===
if (error && nextMs !== null) {
  const failures = (fresh?.consecutiveFailures ?? 0) + 1; // 곧 fresh 갱신될 값
  const backoffMs = errorBackoffMs(failures);
  const backoffNextMs = Date.now() + backoffMs;
  // backoff 가 cron 의 다음 발화보다 *나중* 이면 backoff 적용 (cron 이 더 늦으면 그대로 둠)
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

검증: `pnpm --filter @finclaw/server typecheck` 0 에러.

### B3. CREATE `packages/server/test/automation/scheduler.backoff.test.ts`

```ts
import { describe, it, expect } from 'vitest';
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

### B4. 밀스톤 B 검증

- `pnpm test --filter @finclaw/server -- backoff` (7 테스트)
- 기존 `scheduler.test.ts` 회귀 통과 (auto-disable @ 3 failures 패턴 유지)
- `grep -n 'errorBackoffMs\|schedule.backoff_applied' packages/server/src/automation/scheduler.ts` 가 2건 이상

추정: **30m**

---

## 밀스톤 C — Compaction 배선 (1.5h)

### 목표

Phase 26 산출인 `compactContext` / `evaluateContextWindow` (dead code — server import 0) 를 auto-reply context stage 에 연결하여 long-conversation 자동 보호 활성화.

### C1. CREATE `packages/agent/src/execution/token-fn.ts`

`compactContext` 의 `tokenCounter` 인자로 주입되는 함수 시그니처 어댑터. 정밀도 ±5% — 1차는 char/4 근사.

```ts
// packages/agent/src/execution/token-fn.ts
// compactContext 의 tokenCounter 인자로 주입되는 함수 시그니처 어댑터.
// 정밀도 ±5% — Anthropic 의 countTokens API 우선 활용 가능하나 1차는 char/4 근사.

export function approxTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}
```

검증: `pnpm --filter @finclaw/agent build` 통과.

### C2. EDIT `packages/agent/src/providers/anthropic.ts` — `summarizeText` export 추가

파일 끝(또는 기존 export 그룹 인근)에 추가 (~30 LOC):

```ts
// Phase 31 C — compactContext 의 summarizer 인자로 주입.
// Anthropic SDK 1회 호출로 텍스트를 300자 이내 한국어 요약.
export async function summarizeText(
  text: string,
  client: Anthropic,
  model: string,
): Promise<string> {
  const resp = await client.messages.create({
    model,
    max_tokens: 512,
    messages: [{ role: 'user', content: `다음 대화 내용을 300자 이내로 요약:\n\n${text}` }],
  });
  const block = resp.content[0];
  return block?.type === 'text' ? block.text : '';
}
```

주의: `Anthropic` import 가 이미 있는지 확인. 없으면 `import Anthropic from '@anthropic-ai/sdk';` 추가.

### C3. EDIT `packages/agent/src/index.ts` — re-export

신규 export 2개 추가:

```ts
export { summarizeText } from './providers/anthropic.js';
export { approxTokenCount } from './execution/token-fn.js';
```

기존의 `compactContext` / `evaluateContextWindow` export (line 157 부근) 는 그대로 유지.

### C4. EDIT `packages/server/src/auto-reply/pipeline-context.ts:18-56` — `PipelineMsgContext` 인터페이스에 readonly 필드 추가

기존 (`pipeline-context.ts:18`):

```ts
export interface PipelineMsgContext extends MsgContext {
  // ... 기존 필드 (normalizedBody, mentions, urls, channelCapabilities,
  //     userRoles, isAdmin, resolvedModel, marketSession, activeAlerts,
  //     portfolioSnapshot, watchlist, newsContext, capturedMemory,
  //     retrievalResult, traceContext)
  readonly traceContext?: TraceContext;
}
```

변경 — 끝에 readonly 필드 2개 추가:

```ts
export interface PipelineMsgContext extends MsgContext {
  // ... 기존 필드 ...
  readonly traceContext?: TraceContext;
  // === Phase 31 C — compaction wiring ===
  readonly tokenCounter?: (text: string) => number;
  readonly summarizer?: (text: string) => Promise<string>;
}
```

검증: `pnpm --filter @finclaw/server typecheck` 0 에러.

### C5. EDIT `packages/server/src/auto-reply/stages/context.ts` — compaction 호출 1군데

system prompt + transcript 빌드 직후, 다음 stage 로 넘기기 직전:

```ts
import { evaluateContextWindow, compactContext } from '@finclaw/agent';

// ... 기존 transcript 빌드 ...
const transcript = /* 빌드된 메시지 배열 */;

// === Phase 31 C — 컨텍스트 윈도우 평가 + 필요시 compaction ===
let finalTranscript = transcript;
if (ctx.tokenCounter && ctx.summarizer && ctx.resolvedModel) {
  const windowState = evaluateContextWindow(
    transcript,
    ctx.resolvedModel.maxInputTokens,   // 또는 ctx.modelInfo 에 해당하는 필드
    ctx.resolvedModel.maxOutputTokens,
    { warnRatio: 0.7, criticalRatio: 0.85, reserveTokens: 4096 },
    ctx.tokenCounter,
  );

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
      ctx.summarizer,
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
}
// === Phase 31 C 끝 ===

return { ...ctx, transcript: finalTranscript };
```

주의: `ctx.resolvedModel.maxInputTokens` 정확 필드명은 코드 인스펙션에서 확인. 부재 시 `ctx.modelInfo` 또는 `ctx.resolvedModel.id` 로 lookup 하는 helper 추가 (implementer 가 결정).

### C6. EDIT `packages/server/src/main.ts` — pipeline 초기화 시 wiring (~10 LOC)

```ts
import { summarizeText, approxTokenCount } from '@finclaw/agent';

// anthropicClient + modelInfo 가 이미 있다고 가정
const summarizer = (text: string) => summarizeText(text, anthropicClient, modelInfo.id);
const tokenCounter = approxTokenCount;

// pipeline context factory 에 주입
// PipelineMsgContext readonly 필드라 ctx 생성 시 한번에:
const baseCtx: PipelineMsgContext = {
  ...existingCtx,
  tokenCounter,
  summarizer,
};
```

정확한 wiring 위치는 코드 인스펙션 (`main.ts` 의 `buildPipelineContext` 또는 `createMessagePipeline` 호출 자리) 후 결정.

### C7. CREATE `packages/server/test/auto-reply/stages/context.compaction.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import { runContextStage } from '../../../src/auto-reply/stages/context.js';

describe('context stage compaction', () => {
  it('skips compaction when usedTokens < critical (85%)', async () => {
    const summarizer = vi.fn();
    const ctx = makeMockCtx({
      transcript: makeShortTranscript(),
      resolvedModel: { id: 'claude-sonnet-4-5', maxInputTokens: 200_000, maxOutputTokens: 8_000 },
      tokenCounter: (text: string) => Math.ceil(text.length / 4),
      summarizer,
    });
    const result = await runContextStage(ctx);
    expect(summarizer).not.toHaveBeenCalled();
  });

  it('triggers compaction when usedTokens >= critical (85%)', async () => {
    const summarizer = vi.fn().mockResolvedValue('summarized');
    const ctx = makeMockCtx({
      transcript: makeLongTranscript(/* > 85% of 200K tokens */),
      resolvedModel: { id: 'claude-sonnet-4-5', maxInputTokens: 200_000, maxOutputTokens: 8_000 },
      tokenCounter: (text: string) => Math.ceil(text.length / 4),
      summarizer,
    });
    const result = await runContextStage(ctx);
    expect(summarizer).toHaveBeenCalled();
    expect(result.transcript.length).toBeLessThan(ctx.transcript.length);
  });
});

// makeMockCtx / makeShortTranscript / makeLongTranscript 는 test/auto-reply/ 의
// 기존 helper 를 재사용. 없으면 inline 정의 (implementer 가 패턴 따라가기)
```

### C8. 밀스톤 C 검증

- `pnpm test --filter @finclaw/server -- context.compaction` (2 테스트)
- `grep -rn 'compactContext\|evaluateContextWindow' packages/server packages/agent --include='*.ts'` 결과에 **`packages/server/src/auto-reply/stages/context.ts` 포함** (이전: dead code → 본 phase: live)
- `pnpm typecheck` 0 에러
- 회귀: 기존 짧은 대화는 compaction 호출 안 됨

추정: **1.5h** (보강 반영: summarizeText 30 + approxTokenCount 10 + pipeline-context 5 + main.ts 10 + context.ts 15 + test 50 LOC)

---

## 밀스톤 D — Tool-Loop 2-Detector (5h)

### 목표

`registry.ts:305-306` 의 `console.warn`-only loop 검출을 OpenClaw 의 sha256 hash + circuit breaker 로 교체. **generic_repeat + global_circuit_breaker** 2 detector 만 도입 (ping_pong / known_poll 보류).

### D1. CREATE `packages/agent/src/agents/tools/loop-detector.ts`

OpenClaw `src/agents/tool-loop-detection.ts:1-360` 중 generic_repeat + global_circuit_breaker 만 추출 (~180 LOC).

```ts
// packages/agent/src/agents/tools/loop-detector.ts
// OpenClaw src/agents/tool-loop-detection.ts:1-360 중 generic_repeat + global_circuit_breaker 발췌.

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

// === stableStringify + digestStable — OpenClaw tool-loop-detection.ts:113-148 그대로 ===

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

// === getNoProgressStreak — OpenClaw tool-loop-detection.ts:235-263 ===

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

// === detectToolCallLoop — 2 detector 단순화 ===

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

검증: `pnpm --filter @finclaw/agent build` 통과.

### D2. EDIT `packages/agent/src/agents/tools/registry.ts` — 기존 `LOOP_THRESHOLD` / `isToolLoop` 제거 + loop-detector 호출

기존 (`registry.ts:136-142`):

```ts
const LOOP_THRESHOLD = 5;
const LOOP_WINDOW_MS = 10_000;
function isToolLoop(timestamps: number[]): boolean {
  // ...
  return recent.length >= LOOP_THRESHOLD;
}
```

→ **삭제** (전체 제거).

기존 (`registry.ts:298-306`):

```ts
console.warn(`[ToolRegistry] Tool "${name}" requires approval (auto-approved)`);
// ...
this.callTimestamps.set(name, timestamps.slice(-LOOP_THRESHOLD));
if (isToolLoop(timestamps)) {
  console.warn(`[ToolRegistry] Tool loop detected for "${name}", forcing require-approval`);
}
```

→ **삭제** + loop-detector 호출로 교체.

신규 (class 본문 + execute 메서드):

```ts
import {
  detectToolCallLoop,
  hashToolCall,
  hashToolResult,
  appendHistory,
  type ToolCallRecord,
} from './loop-detector.js';

class InMemoryToolRegistry {
  // ... 기존 필드 ...
  private callHistory: ToolCallRecord[] = [];
  private warningKeysSeen = new Set<string>();

  async execute(name: string, params: unknown): Promise<ToolResult> {
    // === 9-stage policy 평가 (기존 :275 부근) ===
    let policyResult = evaluateToolPolicy({ /* ... */ }, this.policyRules);

    // === Phase 31 D — 루프 감지 (verdict override 가능, bus.emit 직전이어야 함) ===
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
        // global_circuit_breaker — 차단. bus.emit 도 'deny' 강제.
        bus.emit('tool:policy:verdict', name, 'deny', /* decidingStage */ 99);
        return {
          ok: false,
          error: { code: 'tool.loop_blocked', message: loopResult.message },
        };
      }
      // warning — 9-stage 결과를 require-approval 로 override (immutable shape 패턴)
      policyResult = {
        ...policyResult,
        finalVerdict: 'require-approval',
        decidingStage: 99,
        reason: loopResult.message,
      };
    }
    // === Phase 31 D 끝 ===

    bus.emit('tool:policy:verdict', name, policyResult.finalVerdict, policyResult.decidingStage);

    // ... 기존 deny / require-approval 처리 (단, console.warn 제거됨) ...
    // ... 기존 hooks + 실행 ...
    const result = /* tool 실제 실행 */;
    const error = /* 발생 에러 */;

    // === Phase 31 D — history 기록 ===
    this.callHistory = appendHistory(this.callHistory, {
      toolName: name,
      argsHash: hashToolCall(name, params),
      resultHash: hashToolResult(result, error),
    });
    // === 끝 ===

    return result;
  }
}
```

주의:

- `this.callTimestamps` 도 사용 중인 다른 곳 없으면 함께 제거. 그 외 cooldown 등에 쓰이면 그대로 둠 (코드 인스펙션 후 결정).
- `bus.emit('tool:policy:verdict', ...)` 가 loop override **이후** 에 발생해야 다운스트림(auto-reply observer / agent_runs) 이 최종 verdict 를 정확히 관찰.

검증: `pnpm --filter @finclaw/agent typecheck` 0 에러.

### D3. CREATE `packages/agent/test/tools/loop-detector.test.ts`

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
  type ToolCallRecord,
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

  function buildHistory(count: number): ToolCallRecord[] {
    let h: ToolCallRecord[] = [];
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
    const h = buildHistory(WARNING_THRESHOLD - 2);
    const r = detectToolCallLoop(h, 'market.fetch', sameArgs);
    expect(r.stuck).toBe(false);
  });

  it('returns warning at threshold (10)', () => {
    const h = buildHistory(WARNING_THRESHOLD);
    const r = detectToolCallLoop(h, 'market.fetch', sameArgs);
    expect(r.stuck).toBe(true);
    if (r.stuck) {
      expect(r.level).toBe('warning');
      expect(r.detector).toBe('generic_repeat');
    }
  });

  it('returns critical at threshold (20)', () => {
    const h = buildHistory(CRITICAL_THRESHOLD);
    const r = detectToolCallLoop(h, 'market.fetch', sameArgs);
    expect(r.stuck).toBe(true);
    if (r.stuck) expect(r.level).toBe('critical');
  });

  it('returns global_circuit_breaker at threshold (30)', () => {
    const h = buildHistory(GLOBAL_CIRCUIT_BREAKER_THRESHOLD);
    const r = detectToolCallLoop(h, 'market.fetch', sameArgs);
    expect(r.stuck).toBe(true);
    if (r.stuck) expect(r.detector).toBe('global_circuit_breaker');
  });

  it('breaks streak when result changes', () => {
    let h = buildHistory(15);
    // 다른 result 1번 끼움 → streak 깨짐
    h = appendHistory(h, {
      toolName: 'market.fetch',
      argsHash: hashToolCall('market.fetch', sameArgs),
      resultHash: hashToolResult({ price: 200 }, undefined),
    });
    // 새 result 로 5번 더 — 새 streak 5 (< warning 10)
    for (let i = 0; i < 5; i++) {
      h = appendHistory(h, {
        toolName: 'market.fetch',
        argsHash: hashToolCall('market.fetch', sameArgs),
        resultHash: hashToolResult({ price: 200 }, undefined),
      });
    }
    const r = detectToolCallLoop(h, 'market.fetch', sameArgs);
    expect(r.stuck).toBe(false);
  });

  it('appendHistory caps at TOOL_CALL_HISTORY_SIZE (30)', () => {
    const h = buildHistory(50);
    expect(h.length).toBe(30);
  });
});
```

### D4. 밀스톤 D 검증

- `pnpm test --filter @finclaw/agent -- loop-detector` (8 테스트)
- `grep -n 'isToolLoop\|LOOP_THRESHOLD' packages/agent/src/agents/tools/registry.ts` → **0**
- `grep -n 'console.warn.*loop' packages/agent/src/agents/tools/registry.ts` → **0**
- 통합 회귀: `pnpm test --filter @finclaw/agent` 전체 통과 (특히 `tool-registry.test.ts`, `tool-policy.test.ts`)
- 9-stage 호환성: `bus.emit('tool:policy:verdict', ...)` 의 최종 verdict 가 loop override 후 값 전달 (deny / require-approval 정확 반영)

추정: **5h** (이식 1.5h + registry 통합 1.5h + 9-stage 호환성 검증 30m + 테스트 1h + 회귀 0.5h)

---

## 밀스톤 E — Session Tool-Result Guard (1h)

### 목표

거대 tool result (시세 일봉 365일 / 뉴스 raw 응답 등) 를 messages 배열 push 직전 자동 truncate. 토큰 폭발 + Claude 400 (oversize) 차단.

### E1. CREATE `packages/agent/src/agents/session/tool-result-guard.ts`

OpenClaw `src/agents/pi-embedded-runner/tool-result-truncation.ts:43-140` 이식. Anthropic SDK 타입에 맞춰 작성 (FinClaw 의 자체 `ToolResultBlock` 은 camelCase `toolUseId` — 호출부에서 변환).

```ts
// packages/agent/src/agents/session/tool-result-guard.ts
// OpenClaw src/agents/pi-embedded-runner/tool-result-truncation.ts:43-140 이식.

import type { Anthropic } from '@anthropic-ai/sdk';

type ToolResultBlock = Anthropic.ToolResultBlockParam;
type Message = Anthropic.MessageParam;

/**
 * OpenClaw 원본 상수 그대로:
 * - HARD_MAX_TOOL_RESULT_CHARS = 400_000  (~100K tokens; 200K context 의 50%)
 * - MIN_KEEP_CHARS = 2_000  (truncation 시 최소 보존)
 */
export const HARD_MAX_TOOL_RESULT_CHARS = 400_000;
export const MIN_KEEP_CHARS = 2_000;

export const TRUNCATION_SUFFIX =
  "\n\n[Content truncated — original was too large for the model's context window. " +
  'The content above is a partial view. If you need more, request specific sections or use ' +
  'offset/limit parameters to read smaller chunks.]';

/**
 * OpenClaw `truncateToolResultText` 그대로 — 줄바꿈 경계 자르기.
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
 * Tool result block 의 content 를 truncate.
 * Anthropic SDK 의 ToolResultBlockParam 형식 (string 또는 content blocks 배열) 둘 다 지원.
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

  // 전체 text 길이 합산
  const totalChars = block.content.reduce((sum, c) => {
    if (c.type === 'text' && typeof c.text === 'string') return sum + c.text.length;
    return sum;
  }, 0);
  if (totalChars <= maxChars) return block;

  // 비율 기반 분할 truncate
  const newContent = block.content.map((c) => {
    if (c.type !== 'text' || typeof c.text !== 'string') return c;
    const share = c.text.length / totalChars;
    const blockMax = Math.max(MIN_KEEP_CHARS, Math.floor(maxChars * share));
    return { ...c, text: truncateToolResultText(c.text, blockMax) };
  });

  return { ...block, content: newContent };
}

/**
 * 메시지 배열 일괄 처리 — 모든 user 메시지의 tool_result block guard.
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

검증: `pnpm --filter @finclaw/agent build` 통과.

### E2. EDIT `packages/agent/src/agents/session/index.ts` — re-export

```ts
export {
  truncateToolResult,
  truncateToolResultText,
  applyToolResultGuard,
  HARD_MAX_TOOL_RESULT_CHARS,
  MIN_KEEP_CHARS,
  TRUNCATION_SUFFIX,
} from './tool-result-guard.js';
```

### E3. EDIT `packages/agent/src/execution/runner.ts:164-172` — messages.push 직전 truncate

기존 (`runner.ts:164-172`):

```ts
messages.push({
  role: 'tool',
  content: results.map((r) => ({
    type: 'tool_result' as const,
    toolUseId: r.toolUseId,
    content: r.content,
    isError: r.isError,
  })),
});
```

변경:

```ts
import {
  truncateToolResult,
  HARD_MAX_TOOL_RESULT_CHARS,
} from '../agents/session/tool-result-guard.js';

// ... runner 내부 ...
const guardedBlocks = results.map((r) => {
  const block = {
    type: 'tool_result' as const,
    toolUseId: r.toolUseId,
    content: r.content,
    isError: r.isError,
  };
  const guarded = truncateToolResult(block, HARD_MAX_TOOL_RESULT_CHARS);
  // 실제 truncate 발생 여부 비교 (로그용)
  const originalChars =
    typeof r.content === 'string'
      ? r.content.length
      : Array.isArray(r.content)
        ? r.content.reduce(
            (s, c) =>
              s +
              (typeof (c as { text?: string })?.text === 'string'
                ? (c as { text: string }).text.length
                : 0),
            0,
          )
        : 0;
  if (originalChars > HARD_MAX_TOOL_RESULT_CHARS) {
    this.logger.warn('tool_result.truncated', {
      event: 'tool_result.truncated',
      callId: r.toolUseId,
      originalChars,
      truncatedChars: HARD_MAX_TOOL_RESULT_CHARS,
    });
  }
  return guarded;
});
messages.push({ role: 'tool', content: guardedBlocks });
```

주의: FinClaw `ConversationMessage` 의 `toolUseId` (camelCase) 와 Anthropic SDK `tool_use_id` (snake_case) 매핑은 Anthropic 호출 직전 변환 단계가 별도 처리. 본 guard 는 camelCase 유지.

검증: `pnpm --filter @finclaw/agent typecheck` 0 에러.

### E4. CREATE `packages/agent/test/agents/session/tool-result-guard.test.ts`

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

  it('truncates at newline boundary when possible', () => {
    const text = 'line1\nline2\nline3\nline4\nline5';
    const result = truncateToolResultText(text, 12, { suffix: '...', minKeepChars: 5 });
    expect(result.endsWith('...')).toBe(true);
    // newline 경계로 잘림 — 정확한 길이는 알고리즘에 따라 다르나 suffix 포함 보장
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
    const totalLen = (result.content as Array<{ text?: string }>).reduce(
      (s, c) => s + (c.text?.length ?? 0),
      0,
    );
    // suffix 여유 포함
    expect(totalLen).toBeLessThanOrEqual(HARD_MAX_TOOL_RESULT_CHARS + 500);
  });

  it('passes through array content under limit', () => {
    const block = {
      type: 'tool_result' as const,
      tool_use_id: 't1',
      content: [{ type: 'text' as const, text: 'small' }],
    };
    expect(truncateToolResult(block, 1000)).toEqual(block);
  });

  it('preserves MIN_KEEP_CHARS even when share is small', () => {
    const block = {
      type: 'tool_result' as const,
      tool_use_id: 't1',
      content: [
        { type: 'text' as const, text: 'A'.repeat(490_000) },
        { type: 'text' as const, text: 'B'.repeat(10_000) },
      ],
    };
    const result = truncateToolResult(block, HARD_MAX_TOOL_RESULT_CHARS);
    const arr = result.content as Array<{ text?: string }>;
    // 두번째 block 은 share 가 작지만 MIN_KEEP_CHARS (2_000) 이상 보장
    expect(arr[1].text!.length).toBeGreaterThanOrEqual(MIN_KEEP_CHARS);
  });
});
```

### E5. 밀스톤 E 검증

- `pnpm test --filter @finclaw/agent -- tool-result-guard` (6+ 테스트)
- `pnpm typecheck` 0 에러
- 통합: 시세 365일 mock fetch (~500KB) 후 `tool_result.truncated` 로그 + 결과 size ≤ 400KB
- 회귀: `pnpm test --filter @finclaw/agent` (특히 `runner.test.ts`) 통과

추정: **1h** (이식 30m + runner 통합 15m + 테스트 15m)

---

## 밀스톤 F — Schedule Agent Tool (5h)

### 목표

사용자가 Discord 에서 "매일 오후 12시에 포트폴리오 보고해줘" 발화 → agent 가 `schedule.manage(action:'create', ...)` 호출로 자동 등록.

### F1. CREATE `packages/types/src/schedule-rpc.ts`

`ScheduleRpc` 인터페이스 + 요청·응답 타입 8개 (~40 LOC).

```ts
// packages/types/src/schedule-rpc.ts
// Phase 31 F — agent 도구가 호출할 ScheduleRpc 클라이언트 인터페이스.
// server 측 packages/server/src/gateway/rpc/methods/schedule.ts 의 Zod schema 와 호환.

import type { Schedule } from './automation.js';

export interface ScheduleCreateRequest {
  name: string;
  cron: string;
  prompt: string;
  enabled?: boolean;
}

export interface ScheduleCreateResponse {
  id: string;
  nextRunAt: number;
}

export interface ScheduleListRequest {
  limit?: number;
}

export interface ScheduleListResponse {
  schedules: ReadonlyArray<
    Pick<
      Schedule,
      'id' | 'name' | 'cron' | 'enabled' | 'status' | 'consecutiveFailures' | 'nextRunAt'
    >
  >;
}

export interface ScheduleDeleteRequest {
  scheduleId: string;
}

export interface TestCronRequest {
  cron: string;
}

export interface TestCronResponse {
  valid: boolean;
  nextRunAt?: number;
  reason?: string;
}

export interface ScheduleRpc {
  create(req: ScheduleCreateRequest): Promise<ScheduleCreateResponse>;
  list(req: ScheduleListRequest): Promise<ScheduleListResponse>;
  delete(req: ScheduleDeleteRequest): Promise<void>;
  testCron(req: TestCronRequest): Promise<TestCronResponse>;
}
```

### F2. EDIT `packages/types/src/index.ts` — re-export

```ts
export type {
  ScheduleRpc,
  ScheduleCreateRequest,
  ScheduleCreateResponse,
  ScheduleListRequest,
  ScheduleListResponse,
  ScheduleDeleteRequest,
  TestCronRequest,
  TestCronResponse,
} from './schedule-rpc.js';
```

검증: `pnpm --filter @finclaw/types build` 통과.

### F3. CREATE `packages/skills-general/src/schedule-tool.ts`

OpenClaw `src/agents/tools/cron-tool.ts:1-200` 의 TypeBox → Zod 변환 + 8 action → 3 action 단순화 (~100 LOC).

```ts
// packages/skills-general/src/schedule-tool.ts
// OpenClaw cron-tool.ts (TypeBox 8 action) → FinClaw Zod 3 action 단순화.
// Discord 1인 환경에서 wake/runs 같은 운영 action 불요. agent 가 자주 호출할 패턴만 유지.

import { z } from 'zod';
import type { ToolDefinition } from '@finclaw/agent';
import type { ScheduleRpc } from '@finclaw/types';

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
            const validation = await rpc.testCron({ cron: input.cron });
            if (!validation.valid) {
              return { ok: false, error: `Invalid cron: ${validation.reason ?? 'unknown'}` };
            }
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

주의: `ToolDefinition` 의 정확 시그니처는 `@finclaw/agent` export 확인 후 일치시킴 — 기존 `packages/skills-general/src/{datetime,file-read,web-fetch}.ts` 패턴 따라가기.

### F4. EDIT `packages/skills-general/src/index.ts` — `registerGeneralTools` 에 `createScheduleTool` 추가

기존 `registerGeneralTools(deps)` 시그니처에 `rpc: ScheduleRpc` 의존 추가:

```ts
import type { ScheduleRpc } from '@finclaw/types';
import { createScheduleTool } from './schedule-tool.js';

export { createScheduleTool };

export interface GeneralToolDeps {
  rpc: ScheduleRpc;
  // ... 기존 deps ...
}

export function registerGeneralTools(deps: GeneralToolDeps): ToolDefinition[] {
  return [
    createScheduleTool(deps.rpc),
    // ... 기존 도구 (datetime, file-read, web-fetch) ...
  ];
}
```

기존 `registerGeneralTools` 호출부는 `main.ts` 한 곳 — F5 에서 함께 갱신.

### F5. EDIT `packages/server/src/main.ts` — ScheduleRpc 인스턴스 생성 + skills-general 등록

```ts
import type { ScheduleRpc } from '@finclaw/types';
import {
  handleScheduleCreate,
  handleScheduleList,
  handleScheduleDelete,
  handleTestCron,
} from './gateway/rpc/methods/schedule.js';

// gateway/rpc/methods/schedule.ts 의 핸들러를 ScheduleRpc 형태로 wrap
const scheduleRpc: ScheduleRpc = {
  create: (req) => handleScheduleCreate(deps, req),
  list: (req) => handleScheduleList(deps, req),
  delete: (req) => handleScheduleDelete(deps, req),
  testCron: (req) => handleTestCron(deps, req),
};

const generalTools = registerGeneralTools({
  rpc: scheduleRpc,
  // ... 기존 deps ...
});
```

주의: `handleScheduleCreate` 등의 정확한 함수명·시그니처는 `gateway/rpc/methods/schedule.ts` 인스펙션 후 정렬. 시그니처가 `(deps, params) => Promise<{ result?, error? }>` 형태면 한 단계 unwrap 필요.

검증: `pnpm --filter @finclaw/server typecheck` 0 에러.

### F6. CREATE `packages/skills-general/test/schedule-tool.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import { createScheduleTool } from '../src/schedule-tool.js';
import type { ScheduleRpc } from '@finclaw/types';

function makeMockRpc(): ScheduleRpc & {
  create: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  testCron: ReturnType<typeof vi.fn>;
} {
  return {
    create: vi.fn().mockResolvedValue({ id: 'sch_1', nextRunAt: 1234567890 }),
    list: vi.fn().mockResolvedValue({ schedules: [] }),
    delete: vi.fn().mockResolvedValue(undefined),
    testCron: vi.fn().mockResolvedValue({ valid: true }),
  };
}

describe('schedule.manage tool', () => {
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
    } as never);
    expect(result.ok).toBe(false);
    expect(rpc.create).not.toHaveBeenCalled();
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
    expect((result.data as unknown[]).length).toBe(1);
  });
});
```

### F7. 밀스톤 F 검증

- `pnpm test --filter @finclaw/skills-general -- schedule-tool` (4 테스트)
- `pnpm typecheck` 0 에러
- `pnpm lint` 0 경고
- e2e: 로컬 server 기동 후 Discord (또는 mock channel) 에서 "매일 오전 9시에 한국 주가 알려줘" 발화 → `schedule.list` RPC 호출 시 1건 보임 + `agent_runs` 의 `toolCallsJson` 에 `schedule.manage` 호출 기록

추정: **5h** (types 추출 1h + 도구 작성 1.5h + main.ts wiring 1h + 테스트 1h + e2e 30m)

---

## 통합 테스트

### IT-1. 시나리오 1 — 12시 보고 (Stagger + Backoff + Compaction 통합)

1. 사용자: Discord 에서 "매일 12시에 포트폴리오 요약 보내줘" (밀스톤 F)
2. agent 가 `schedule.manage(action:'create', cron:'0 3 * * *', ...)` 호출
3. 매분 폴러가 UTC 03:00 도달 시 due 판정
4. 다른 정각 schedule 4개 동시 due → stagger 0~5분 분산 (밀스톤 A)
5. 첫 schedule 실행 — agent.run → 포트폴리오 RAG 주입 → Discord delivery
6. 만약 실패 시 다음 retry backoff 적용 (밀스톤 B)
7. 토큰 critical 임계 도달 시 compaction 발동 (밀스톤 C)

수동 검증 단계 (자동화 어려운 경우 implementer 가 mock 으로):

- `schedule.staggered` 로그 다중 발생 확인
- 강제 실패 주입 시 `schedule.backoff_applied` 로그 + next_run_at 갱신 확인
- 긴 transcript 주입 시 `context.compaction_triggered` 로그 확인

### IT-2. 시나리오 2 — 도구 무한 호출 차단 (Tool-Loop)

1. agent 가 `market.fetch({symbol:'AAPL'})` 동일 결과 30회 반복 (mock fixture)
2. 31회째 호출 시 `tool.loop_blocked` 에러 반환 (밀스톤 D)
3. `bus.emit('tool:policy:verdict', 'market.fetch', 'deny', 99)` 발화 확인
4. agent 가 "동일한 조회 반복 감지 — 다른 질문이 있으신가요?" 응답 (선택, agent prompt 의 에러 핸들링)

### IT-3. 시나리오 3 — 거대 tool result 자동 truncate

1. `market.history({symbol:'AAPL', range:'5y'})` mock 으로 ~500KB JSON 반환
2. `tool_result.truncated` 로그 발생 + result content size ≤ 400KB (밀스톤 E)
3. Anthropic API 400 (oversize) 회피 — 응답 정상 생성

---

## 최종 검증

다음을 모두 통과해야 phase 31 완료:

- `pnpm test` 전체 통과 (회귀 0, 신규 ~33 테스트 추가)
- `pnpm typecheck` 0 에러
- `pnpm lint` 0 경고
- `pnpm build` 통과
- `pnpm format:fix` 후 git diff 검토 — 변경 외 무관 라인 없음 (CLAUDE.md §3 외과적 변경)
- `grep -rn 'compactContext\|evaluateContextWindow' packages/server --include='*.ts'` → `auto-reply/stages/context.ts` 포함
- `grep -n 'isToolLoop\|LOOP_THRESHOLD\|console.warn.*loop' packages/agent/src/agents/tools/registry.ts` → 0
- 통합 시나리오 IT-1 / IT-2 / IT-3 모두 통과

선택:

- CLAUDE.md 변경 이력 추가
- PHASE31_DONE.md 작성

---

## 롤백 절차

각 밀스톤이 독립 커밋이라면 다음 순서로 단계적 롤백:

- F → E → D → C → B → A (의존 역순)
- `git revert {밀스톤 커밋}` — 단, F (ScheduleRpc 추출) revert 시 types/index.ts re-export 도 함께 회수됨
- D (Tool-Loop) revert 는 `isToolLoop` 복원 필요 — 가능하면 새 fix-forward 커밋으로 대응

---

## 메모 / 리스크

### 모호점 (architect 가 plan.md 와 코드를 교차 확인하여 해소)

- **C5 `ctx.resolvedModel.maxInputTokens` 정확 필드명** — `MsgContext` 의 model 정보 구조 인스펙션 후 결정. 부재 시 `ctx.resolvedModel.id` 로부터 model registry lookup helper 추가.
- **C6 `main.ts` pipeline 초기화 위치** — `buildPipelineContext` 또는 `createMessagePipeline` 호출 자리. implementer 가 인스펙션 후 정확 위치 결정.
- **D2 `this.callTimestamps` 잔존 여부** — cooldown 등 다른 곳에서 쓰이면 유지, 아니면 함께 삭제.
- **F5 `handleScheduleCreate` 등 핸들러 시그니처** — `gateway/rpc/methods/schedule.ts` 인스펙션 후 wrap 형태 결정 (`(deps, params)` → `(params)` unwrap 가능성).

### OpenClaw 출처 (참조용)

- Stagger: `/mnt/c/Users/박/Desktop/hi/openclaw/src/cron/stagger.ts:1-47`
- Backoff: `/mnt/c/Users/박/Desktop/hi/openclaw/src/cron/service/timer.ts:107-119`
- Tool-Loop: `/mnt/c/Users/박/Desktop/hi/openclaw/src/agents/tool-loop-detection.ts:1-360` (generic_repeat + circuit_breaker 만 추출, ping_pong / known_poll 제외)
- Tool-Result Guard: `/mnt/c/Users/박/Desktop/hi/openclaw/src/agents/pi-embedded-runner/tool-result-truncation.ts:43-140`
- Schedule Tool: `/mnt/c/Users/박/Desktop/hi/openclaw/src/agents/tools/cron-tool.ts:1-200` (TypeBox → Zod, 8 action → 3 action)

### 본 Phase 비대상 (Phase 32 별도 트랙)

- Backend-as-CLI (Claude Max 활용, ~730 LOC, 1주)
- FailoverError 양방향 매핑
- Cache Trace 8-stage
- Markdown 1차 source 메모리
- Phase 30 잔여 (rerank_meta wire-up, depth≥3 통합 테스트, P0-4 db 의존 일원화, P1 cleanup 6건)

### 사용자 컨텍스트

- LLM provider: Claude (Anthropic) 단일 — multi-provider 비대상
- 채널: Discord 단일 — multi-channel 비대상
- 사용자 1인 — F 의 prompt injection 위험 낮음, 별도 sanitization X (cron 검증만)
- 구독: Claude Max (Phase 32 에서 활용)
- 원칙 유지: 감사 가능성 · 환각 방지 · 읽기 전용
