# Phase 7 TODO-2: 세션 + 컨텍스트 + 시스템 프롬프트

> Plan Part 3 (세션 관리) + Part 4 (컨텍스트 관리 & 시스템 프롬프트)
>
> 수정 2개 + 소스 7개 + 테스트 3개 = **12 작업**

---

## Part 3: 세션 관리

### - [ ] Step 1: FinClawEventMap에 session:_ + context:_ 이벤트 6종 추가

파일: `packages/infra/src/events.ts`

기존 `FinClawEventMap` 인터페이스에 추가 (todo-1의 tool:\* 이벤트 뒤에):

```typescript
  // ── Phase 7: Session events ──
  'session:lock:acquire': (sessionId: string, pid: number) => void;
  'session:lock:release': (sessionId: string) => void;
  'session:lock:stale': (sessionId: string, stalePid: number) => void;

  // ── Phase 7: Context events ──
  'context:window:status': (status: string, usageRatio: number) => void;
  'context:compact': (strategy: string, beforeTokens: number, afterTokens: number) => void;
  'context:compact:fallback': (fromStrategy: string, toStrategy: string) => void;
```

검증: `pnpm typecheck`

---

### - [ ] Step 2: Write Lock

파일: `packages/agent/src/agents/session/write-lock.ts`

```typescript
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getEventBus, ensureDir } from '@finclaw/infra';

// ── 타입 ──

/** 세션 잠금 결과 */
export interface LockResult {
  readonly acquired: boolean;
  readonly lockPath: string;
  readonly release: () => Promise<void>;
}

/** 세션 잠금 옵션 */
export interface LockOptions {
  readonly sessionDir: string;
  readonly sessionId: string;
  /** 잠금 대기 타임아웃 (기본: 5000ms) */
  readonly timeoutMs?: number;
  /** 오래된 잠금 자동 해제 (기본: 300_000ms = 5분) */
  readonly staleAfterMs?: number;
  /** 폴링 간격 (기본: 100ms) */
  readonly pollIntervalMs?: number;
  /** 재진입 잠금 허용 (기본: false) */
  readonly allowReentrant?: boolean;
}

// ── PID 생존 확인 ──

/** 프로세스가 살아있는지 확인 (gateway-lock.ts 패턴 재사용) */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── 재진입 추적 ──

interface HeldLock {
  lockPath: string;
  pid: number;
  count: number;
}

const heldLocks = new Map<string, HeldLock>();

// ── 메인 함수 ──

/**
 * 파일 기반 배타적 잠금
 *
 * 알고리즘:
 * 1. fs.open(lockPath, 'wx') 로 exclusive 생성 시도
 * 2. 성공 → 잠금 획득, PID + timestamp 기록
 * 3. 실패(EEXIST) → PID 생존 확인 → 죽었으면 stale 처리
 *    → 살아있으면 시간 기반 stale 확인
 *    → stale 아니면 pollIntervalMs 대기 후 재시도
 * 4. 타임아웃 → acquired: false 반환
 * 5. release() → 잠금 파일 삭제 + 시그널 핸들러 해제
 */
export async function acquireWriteLock(options: LockOptions): Promise<LockResult> {
  const {
    sessionDir,
    sessionId,
    timeoutMs = 5_000,
    staleAfterMs = 300_000,
    pollIntervalMs = 100,
    allowReentrant = false,
  } = options;

  await ensureDir(sessionDir);
  const lockPath = path.join(sessionDir, `${sessionId}.lock`);
  const deadline = Date.now() + timeoutMs;
  const bus = getEventBus();

  while (Date.now() < deadline) {
    try {
      // 배타적 생성 시도 (O_CREAT | O_EXCL)
      const fd = await fs.open(lockPath, 'wx');
      const lockData = JSON.stringify({
        pid: process.pid,
        timestamp: new Date().toISOString(),
        sessionId,
      });
      await fd.writeFile(lockData);
      await fd.close();

      // 재진입 추적 등록
      heldLocks.set(lockPath, { lockPath, pid: process.pid, count: 1 });

      // 시그널 핸들러 등록
      const cleanup = async (): Promise<void> => {
        try {
          await fs.unlink(lockPath);
        } catch {
          /* 이미 해제된 경우 무시 */
        }
        heldLocks.delete(lockPath);
      };
      const onSignal = (): void => {
        // 동기적으로 삭제 시도 (best-effort)
        fs.unlink(lockPath).catch(() => {});
        heldLocks.delete(lockPath);
      };

      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);

      bus.emit('session:lock:acquire', sessionId, process.pid);

      return {
        acquired: true,
        lockPath,
        release: async (): Promise<void> => {
          const held = heldLocks.get(lockPath);
          if (held) {
            held.count--;
            if (held.count > 0) return; // 재진입 참조 카운트 남아있음
          }
          process.removeListener('SIGINT', onSignal);
          process.removeListener('SIGTERM', onSignal);
          await cleanup();
          bus.emit('session:lock:release', sessionId);
        },
      };
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;

      // 기존 잠금 확인
      try {
        const raw = await fs.readFile(lockPath, 'utf-8');
        const info = JSON.parse(raw) as { pid: number; timestamp: string; sessionId: string };

        // ① PID 생존 확인 — 죽은 프로세스면 즉시 stale 처리
        if (!isProcessAlive(info.pid)) {
          bus.emit('session:lock:stale', sessionId, info.pid);
          await fs.unlink(lockPath);
          continue;
        }

        // ② 재진입 확인
        if (info.pid === process.pid && allowReentrant) {
          const held = heldLocks.get(lockPath);
          if (held) {
            held.count++;
            return {
              acquired: true,
              lockPath,
              release: async (): Promise<void> => {
                held.count--;
                if (held.count <= 0) {
                  await fs.unlink(lockPath).catch(() => {});
                  heldLocks.delete(lockPath);
                  bus.emit('session:lock:release', sessionId);
                }
              },
            };
          }
        }

        // ③ 시간 기반 stale 확인
        const stat = await fs.stat(lockPath);
        const age = Date.now() - stat.mtimeMs;
        if (age > staleAfterMs) {
          bus.emit('session:lock:stale', sessionId, info.pid);
          await fs.unlink(lockPath);
          continue;
        }
      } catch {
        // readFile/stat 실패 시 재시도 (파일이 사라졌을 수 있음)
        continue;
      }

      // 대기 후 재시도
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  // 타임아웃
  return {
    acquired: false,
    lockPath,
    release: async (): Promise<void> => {},
  };
}

/** 테스트용: 재진입 추적 초기화 */
export function resetHeldLocks(): void {
  heldLocks.clear();
}
```

검증: `pnpm typecheck`

---

### - [ ] Step 3: Transcript Repair

파일: `packages/agent/src/agents/session/transcript-repair.ts`

```typescript
// ── 타입 ──

/** 트랜스크립트 엔트리 */
export interface TranscriptEntry {
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
  readonly timestamp: string;
  readonly toolUseId?: string;
  readonly toolName?: string;
}

/** 트랜스크립트 손상 유형 */
export type CorruptionType =
  | 'truncated-json'
  | 'duplicate-entry'
  | 'orphan-tool-result'
  | 'missing-tool-result'
  | 'invalid-role-sequence';

/** 개별 손상 보고 */
export interface DetectedCorruption {
  readonly type: CorruptionType;
  readonly index: number;
  readonly description: string;
}

/** 손상 보고서 */
export interface CorruptionReport {
  readonly corruptions: readonly DetectedCorruption[];
  readonly isRecoverable: boolean;
}

// ── 손상 감지 ──

/**
 * 트랜스크립트 손상 감지
 *
 * 검사 항목:
 * - duplicate-entry: timestamp + role + content 동일 엔트리 중복
 * - orphan-tool-result: tool_use 없이 tool role 등장
 * - missing-tool-result: assistant의 tool_use 후 tool role 누락
 * - invalid-role-sequence: tool이 assistant 없이 등장
 * - missing-tool-result (empty): 빈 content의 tool 엔트리 (abort 가능성)
 */
export function detectCorruption(entries: readonly TranscriptEntry[]): CorruptionReport {
  const corruptions: DetectedCorruption[] = [];

  // 중복 감지용 set
  const seen = new Set<string>();

  // 이전 assistant의 tool_use 추적
  const pendingToolUseIds = new Set<string>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    // ① 중복 엔트리 감지
    const key = `${entry.timestamp}|${entry.role}|${entry.content}`;
    if (seen.has(key)) {
      corruptions.push({
        type: 'duplicate-entry',
        index: i,
        description: `Duplicate entry at index ${i} (same timestamp, role, content)`,
      });
    }
    seen.add(key);

    // ② orphan tool result 감지
    if (entry.role === 'tool' && entry.toolUseId) {
      if (!pendingToolUseIds.has(entry.toolUseId)) {
        corruptions.push({
          type: 'orphan-tool-result',
          index: i,
          description: `Tool result at index ${i} has no matching tool_use (toolUseId: ${entry.toolUseId})`,
        });
      } else {
        pendingToolUseIds.delete(entry.toolUseId);
      }
    }

    // ③ assistant의 tool_use 추적 (content에서 toolUseId 추출)
    if (entry.role === 'assistant' && entry.toolUseId) {
      pendingToolUseIds.add(entry.toolUseId);
    }

    // ④ invalid role sequence: tool이 이전에 assistant 없이 등장
    if (entry.role === 'tool') {
      const prevNonTool = entries
        .slice(0, i)
        .filter((e) => e.role !== 'tool')
        .at(-1);
      if (prevNonTool && prevNonTool.role !== 'assistant') {
        corruptions.push({
          type: 'invalid-role-sequence',
          index: i,
          description: `Tool result at index ${i} not preceded by assistant message`,
        });
      }
    }

    // ⑤ 빈 tool content (abort 가능성)
    if (entry.role === 'tool' && entry.content === '') {
      corruptions.push({
        type: 'missing-tool-result',
        index: i,
        description: 'Empty tool result (possibly aborted)',
      });
    }
  }

  // ⑥ 매칭되지 않은 tool_use → missing-tool-result
  // pendingToolUseIds에 남아있는 것은 tool_result가 누락된 tool_use
  for (const toolUseId of pendingToolUseIds) {
    // 해당 tool_use의 인덱스 찾기
    const idx = entries.findIndex((e) => e.role === 'assistant' && e.toolUseId === toolUseId);
    if (idx >= 0) {
      corruptions.push({
        type: 'missing-tool-result',
        index: idx,
        description: `Assistant tool_use at index ${idx} has no corresponding tool result (toolUseId: ${toolUseId})`,
      });
    }
  }

  return {
    corruptions,
    isRecoverable: corruptions.every((c) => c.type !== 'truncated-json'),
  };
}

// ── 복구 ──

/**
 * 트랜스크립트 복구
 *
 * 복구 전략:
 * - duplicate-entry: 중복 제거 (첫 번째 유지)
 * - orphan-tool-result: 합성 assistant tool_use 엔트리 삽입
 * - missing-tool-result: 합성 "[Tool result unavailable]" 삽입
 * - invalid-role-sequence: 순서 위반 엔트리 유지 (경고만)
 * - empty tool content: "[Execution aborted]"로 교체
 */
export function repairTranscript(
  entries: readonly TranscriptEntry[],
  report: CorruptionReport,
): TranscriptEntry[] {
  const result = [...entries] as TranscriptEntry[];

  // 삽입/삭제를 위한 인덱스 오프셋 추적
  let offset = 0;

  // 타입별로 분류
  const duplicateIndices = new Set<number>();
  const orphanIndices = new Set<number>();
  const missingToolResultIndices = new Set<number>();
  const emptyToolIndices = new Set<number>();

  for (const corruption of report.corruptions) {
    switch (corruption.type) {
      case 'duplicate-entry':
        duplicateIndices.add(corruption.index);
        break;
      case 'orphan-tool-result':
        orphanIndices.add(corruption.index);
        break;
      case 'missing-tool-result':
        if (
          entries[corruption.index]?.role === 'tool' &&
          entries[corruption.index]?.content === ''
        ) {
          emptyToolIndices.add(corruption.index);
        } else {
          missingToolResultIndices.add(corruption.index);
        }
        break;
      // invalid-role-sequence: 유지 (경고만)
      default:
        break;
    }
  }

  // 1. 중복 제거 (뒤에서부터 제거하여 인덱스 유지)
  const sortedDuplicates = [...duplicateIndices].sort((a, b) => b - a);
  for (const idx of sortedDuplicates) {
    result.splice(idx, 1);
  }

  // offset 조정 (중복 제거로 인한)
  offset = -sortedDuplicates.length;

  // 2. 빈 tool content → "[Execution aborted]"로 교체
  for (const idx of emptyToolIndices) {
    const adjustedIdx = idx + offset;
    if (adjustedIdx >= 0 && adjustedIdx < result.length) {
      result[adjustedIdx] = {
        ...result[adjustedIdx],
        content: '[Execution aborted]',
      };
    }
  }

  // 3. orphan tool result → 합성 assistant tool_use 삽입
  const orphanList = [...orphanIndices].sort((a, b) => a - b);
  let insertOffset = 0;
  for (const idx of orphanList) {
    const adjustedIdx = idx + offset + insertOffset;
    if (adjustedIdx >= 0 && adjustedIdx < result.length) {
      const orphan = result[adjustedIdx];
      const syntheticAssistant: TranscriptEntry = {
        role: 'assistant',
        content: `[Synthetic tool_use for orphan result]`,
        timestamp: orphan.timestamp,
        toolUseId: orphan.toolUseId,
        toolName: orphan.toolName ?? '[unknown-tool]',
      };
      result.splice(adjustedIdx, 0, syntheticAssistant);
      insertOffset++;
    }
  }

  // 4. missing tool result → 합성 tool result 삽입
  const missingList = [...missingToolResultIndices].sort((a, b) => a - b);
  for (const idx of missingList) {
    const adjustedIdx = idx + offset + insertOffset + 1; // assistant 뒤에 삽입
    if (adjustedIdx >= 0 && adjustedIdx <= result.length) {
      const assistant = entries[idx];
      const syntheticTool: TranscriptEntry = {
        role: 'tool',
        content: '[Tool result unavailable]',
        timestamp: assistant.timestamp,
        toolUseId: assistant.toolUseId,
        toolName: assistant.toolName ?? '[unknown-tool]',
      };
      result.splice(adjustedIdx, 0, syntheticTool);
      insertOffset++;
    }
  }

  return result;
}
```

검증: `pnpm typecheck`

---

### - [ ] Step 4: session/index.ts 배럴

파일: `packages/agent/src/agents/session/index.ts`

```typescript
export type { LockResult, LockOptions } from './write-lock.js';
export { acquireWriteLock, resetHeldLocks } from './write-lock.js';

export type {
  TranscriptEntry,
  CorruptionType,
  DetectedCorruption,
  CorruptionReport,
} from './transcript-repair.js';
export { detectCorruption, repairTranscript } from './transcript-repair.js';
```

검증: `pnpm typecheck`

---

## Part 4: 컨텍스트 관리 & 시스템 프롬프트

### - [ ] Step 5: Context Window Guard

파일: `packages/agent/src/agents/context/window-guard.ts`

```typescript
import { getEventBus } from '@finclaw/infra';
import type { TranscriptEntry } from '../session/transcript-repair.js';

// ── 타입 ──

/** 토큰 소비량 소스별 분류 */
export interface TokenBreakdown {
  readonly systemPrompt: number;
  readonly toolResults: number;
  readonly conversation: number;
  readonly summary: number;
}

/** 컨텍스트 윈도우 상태 */
export interface ContextWindowState {
  readonly currentTokens: number;
  readonly maxTokens: number;
  readonly usageRatio: number; // 0.0 ~ 1.0
  readonly status: 'safe' | 'warning' | 'critical' | 'exceeded';
  readonly compactionNeeded: boolean;
  readonly breakdown: TokenBreakdown;
}

/** 윈도우 가드 설정 */
export interface WindowGuardConfig {
  readonly warningThreshold: number; // 기본: 0.7 (70%)
  readonly criticalThreshold: number; // 기본: 0.85 (85%)
  readonly reserveTokens: number; // 출력용 예약 토큰 (기본: 4096)
}

/** 절대 최소 임계치 — 이 이하로는 압축하지 않음 */
const ABSOLUTE_MIN_TOKENS = {
  small: 16_384, // 소형 모델 (contextWindow < 32K)
  standard: 32_768, // 표준 모델 (contextWindow >= 32K)
} as const;

// ── 메인 함수 ──

/**
 * 컨텍스트 윈도우 상태 평가
 *
 * @param entries - 현재 트랜스크립트 엔트리
 * @param maxInputTokens - 모델의 최대 입력 토큰 (ModelEntry.maxInputTokens)
 * @param maxOutputTokens - 모델의 최대 출력 토큰 (ModelEntry.maxOutputTokens)
 * @param config - 가드 설정
 * @param tokenCounter - 토큰 카운팅 함수
 */
export function evaluateContextWindow(
  entries: readonly TranscriptEntry[],
  maxInputTokens: number,
  maxOutputTokens: number,
  config: WindowGuardConfig,
  tokenCounter: (text: string) => number,
): ContextWindowState {
  // 소스별 토큰 카운팅
  let systemPrompt = 0;
  let toolResults = 0;
  let conversation = 0;
  let summary = 0;

  for (const entry of entries) {
    const tokens = tokenCounter(entry.content);
    switch (entry.role) {
      case 'system':
        if (entry.content.startsWith('[Previous conversation summary]')) {
          summary += tokens;
        } else {
          systemPrompt += tokens;
        }
        break;
      case 'tool':
        toolResults += tokens;
        break;
      default:
        conversation += tokens;
        break;
    }
  }

  const currentTokens = systemPrompt + toolResults + conversation + summary;
  const effectiveMax = maxInputTokens - config.reserveTokens;
  const usageRatio = effectiveMax > 0 ? currentTokens / effectiveMax : 1;

  // 상태 결정
  let status: ContextWindowState['status'];
  if (usageRatio >= 1) {
    status = 'exceeded';
  } else if (usageRatio >= config.criticalThreshold) {
    status = 'critical';
  } else if (usageRatio >= config.warningThreshold) {
    status = 'warning';
  } else {
    status = 'safe';
  }

  // 절대 최소 임계치 확인
  const minTokens =
    maxInputTokens < 32_768 ? ABSOLUTE_MIN_TOKENS.small : ABSOLUTE_MIN_TOKENS.standard;
  const compactionNeeded = status === 'critical' || status === 'exceeded';

  const bus = getEventBus();
  bus.emit('context:window:status', status, usageRatio);

  return {
    currentTokens,
    maxTokens: effectiveMax,
    usageRatio,
    status,
    compactionNeeded: compactionNeeded && currentTokens > minTokens,
    breakdown: { systemPrompt, toolResults, conversation, summary },
  };
}
```

검증: `pnpm typecheck`

---

### - [ ] Step 6: Compaction

파일: `packages/agent/src/agents/context/compaction.ts`

```typescript
import { getEventBus } from '@finclaw/infra';
import type { TranscriptEntry } from '../session/transcript-repair.js';

// ── 타입 ──

/** 압축 전략 */
export type CompactionStrategy =
  | 'summarize' // AI 요약 (가장 정확, 비용 발생)
  | 'truncate-oldest' // 가장 오래된 메시지 제거
  | 'truncate-tools' // 도구 결과만 축소
  | 'hybrid'; // summarize + truncate-tools 자동 선택

/** 압축 옵션 */
export interface CompactionOptions {
  readonly strategy: CompactionStrategy;
  readonly targetTokens: number;
  readonly preserveRecentMessages: number; // 최근 N개 메시지 보존
  readonly preserveSystemPrompt: boolean;
}

/** 압축 결과 */
export interface CompactionResult {
  readonly compactedEntries: TranscriptEntry[];
  readonly summary?: string;
  readonly removedCount: number;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly strategy: CompactionStrategy;
}

// ── 안전 상수 ──

/** 토큰 카운터 오차 보정 (1.2 = 20% 마진) */
const SAFETY_MARGIN = 1.2;
/** 요약 생성 시 소비되는 추가 토큰 (요약 프롬프트 + 출력) */
const SUMMARIZATION_OVERHEAD_TOKENS = 4096;

// ── 3단계 폴백 요약 ──

async function compactWithFallback(
  toCompact: readonly TranscriptEntry[],
  safeTarget: number,
  summarizer: (text: string) => Promise<string>,
  tokenCounter: (text: string) => number,
): Promise<{ entries: TranscriptEntry[]; summary?: string; strategy: CompactionStrategy }> {
  const bus = getEventBus();

  // 1단계: Full summarize — 전체를 한 번에 요약
  try {
    const text = toCompact.map((e) => `[${e.role}]: ${e.content}`).join('\n');
    const summary = await summarizer(text);
    if (tokenCounter(summary) <= safeTarget) {
      return {
        entries: [
          {
            role: 'system' as const,
            content: `[Previous conversation summary]\n${summary}`,
            timestamp: new Date().toISOString(),
          },
        ],
        summary,
        strategy: 'summarize',
      };
    }
    bus.emit('context:compact:fallback', 'summarize-full', 'summarize-partial');
  } catch {
    bus.emit('context:compact:fallback', 'summarize-full', 'summarize-partial');
  }

  // 2단계: Partial — 청크 분할 후 개별 요약
  const totalTokens = toCompact.reduce((sum, e) => sum + tokenCounter(e.content), 0);
  const chunkCount = Math.max(2, Math.ceil(totalTokens / safeTarget));
  try {
    const chunkSize = Math.ceil(toCompact.length / chunkCount);
    const summaries: string[] = [];
    for (let i = 0; i < toCompact.length; i += chunkSize) {
      const chunk = toCompact.slice(i, i + chunkSize);
      const text = chunk.map((e) => `[${e.role}]: ${e.content}`).join('\n');
      summaries.push(await summarizer(text));
    }
    const combined = summaries.join('\n---\n');
    if (tokenCounter(combined) <= safeTarget) {
      return {
        entries: [
          {
            role: 'system' as const,
            content: `[Previous conversation summary]\n${combined}`,
            timestamp: new Date().toISOString(),
          },
        ],
        summary: combined,
        strategy: 'summarize',
      };
    }
    bus.emit('context:compact:fallback', 'summarize-partial', 'truncate-oldest');
  } catch {
    bus.emit('context:compact:fallback', 'summarize-partial', 'truncate-oldest');
  }

  // 3단계: Fallback — truncate-oldest (AI 호출 없이 안전하게 후퇴)
  const targetRemove = totalTokens - safeTarget;
  let removedTokens = 0;
  const kept: TranscriptEntry[] = [];
  for (let i = 0; i < toCompact.length; i++) {
    if (removedTokens >= targetRemove) {
      kept.push(toCompact[i]);
    } else {
      removedTokens += tokenCounter(toCompact[i].content);
    }
  }
  return { entries: kept, strategy: 'truncate-oldest' };
}

// ── 메인 함수 ──

/**
 * 적응형 컨텍스트 압축
 *
 * 1. 현재 토큰 수와 목표 토큰 수의 차이 계산
 * 2. preserveRecentMessages만큼 최근 메시지는 압축 대상에서 제외
 * 3. systemPrompt는 preserveSystemPrompt=true면 보존
 * 4. 전략에 따라 압축 실행
 * 5. hybrid 모드: 차이 < 20%면 truncate-tools, >= 20%면 summarize
 * 6. summarize 실패 시 3단계 폴백
 */
export async function compactContext(
  entries: readonly TranscriptEntry[],
  options: CompactionOptions,
  summarizer: (text: string) => Promise<string>,
  tokenCounter: (text: string) => number,
): Promise<CompactionResult> {
  const totalTokens = entries.reduce((sum, e) => sum + tokenCounter(e.content), 0);
  const excess = totalTokens - options.targetTokens;

  // 압축 불필요
  if (excess <= 0) {
    return {
      compactedEntries: [...entries],
      removedCount: 0,
      beforeTokens: totalTokens,
      afterTokens: totalTokens,
      strategy: options.strategy,
    };
  }

  const bus = getEventBus();

  // 보존 대상과 압축 대상 분리
  const preserveCount = Math.min(options.preserveRecentMessages, entries.length);
  const toPreserve = entries.slice(-preserveCount);
  let toCompact = entries.slice(0, entries.length - preserveCount);

  // system prompt 보존
  if (options.preserveSystemPrompt) {
    const systemEntries = toCompact.filter(
      (e) => e.role === 'system' && !e.content.startsWith('[Previous conversation summary]'),
    );
    const nonSystem = toCompact.filter(
      (e) => !(e.role === 'system' && !e.content.startsWith('[Previous conversation summary]')),
    );
    // system 엔트리는 보존하고 나머지만 압축
    toCompact = nonSystem;
    // system 엔트리는 결과에 prepend
    var preservedSystem = systemEntries;
  } else {
    var preservedSystem: TranscriptEntry[] = [];
  }

  // 전략 결정
  let strategy = options.strategy;
  if (strategy === 'hybrid') {
    const excessRatio = excess / totalTokens;
    strategy = excessRatio < 0.2 ? 'truncate-tools' : 'summarize';
  }

  const safeTarget =
    Math.floor(options.targetTokens / SAFETY_MARGIN) - SUMMARIZATION_OVERHEAD_TOKENS;

  let compacted: TranscriptEntry[];
  let summary: string | undefined;

  switch (strategy) {
    case 'truncate-tools': {
      compacted = toCompact.map((entry) =>
        entry.role === 'tool'
          ? { ...entry, content: '[Result truncated for context management]' }
          : entry,
      );
      break;
    }

    case 'truncate-oldest': {
      let removedTokens = 0;
      compacted = [];
      for (let i = 0; i < toCompact.length; i++) {
        if (removedTokens >= excess) {
          compacted.push(toCompact[i]);
        } else {
          removedTokens += tokenCounter(toCompact[i].content);
        }
      }
      break;
    }

    case 'summarize': {
      const fallbackResult = await compactWithFallback(
        toCompact,
        safeTarget,
        summarizer,
        tokenCounter,
      );
      compacted = fallbackResult.entries;
      summary = fallbackResult.summary;
      strategy = fallbackResult.strategy; // 폴백으로 변경되었을 수 있음
      break;
    }

    default:
      compacted = [...toCompact];
  }

  const result = [...preservedSystem, ...compacted, ...toPreserve];
  const afterTokens = result.reduce((sum, e) => sum + tokenCounter(e.content), 0);

  bus.emit('context:compact', strategy, totalTokens, afterTokens);

  return {
    compactedEntries: result,
    summary,
    removedCount: entries.length - result.length,
    beforeTokens: totalTokens,
    afterTokens,
    strategy,
  };
}
```

검증: `pnpm typecheck`

---

### - [ ] Step 7: context/index.ts 배럴

파일: `packages/agent/src/agents/context/index.ts`

```typescript
export type { TokenBreakdown, ContextWindowState, WindowGuardConfig } from './window-guard.js';
export { evaluateContextWindow } from './window-guard.js';

export type { CompactionStrategy, CompactionOptions, CompactionResult } from './compaction.js';
export { compactContext } from './compaction.js';
```

검증: `pnpm typecheck`

---

### - [ ] Step 8: System Prompt Builder

파일: `packages/agent/src/agents/system-prompt.ts`

```typescript
import type { ToolDefinition } from '@finclaw/types/agent.js';
import type { ChatType } from '@finclaw/types/message.js';

// ── 타입 ──

/** 시스템 프롬프트 섹션 */
export interface PromptSection {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly priority: number; // 높을수록 먼저 배치
  readonly required: boolean;
  readonly tokenEstimate: number;
}

/** 금융 투자 성향 */
export interface InvestmentProfile {
  readonly riskTolerance: 'conservative' | 'moderate' | 'aggressive';
  readonly preferredMarkets: readonly string[];
  readonly complianceLevel: 'retail' | 'professional' | 'institutional';
}

/** 모델 능력 정보 (Phase 6의 ModelCapabilities 참조) */
export interface PromptModelCapabilities {
  readonly supportsTools: boolean;
  readonly supportsVision: boolean;
  readonly supportsStreaming: boolean;
}

/** 시스템 프롬프트 빌더 컨텍스트 */
export interface PromptBuildContext {
  readonly userId: string;
  readonly channelId: string;
  readonly chatType: ChatType;
  readonly availableTools: readonly ToolDefinition[];
  readonly modelCapabilities: PromptModelCapabilities;
  readonly customInstructions?: string;
  /** 금융 특화: 사용자의 투자 성향 */
  readonly investmentProfile?: InvestmentProfile;
}

/** 프롬프트 빌드 모드 */
export type PromptBuildMode = 'full' | 'minimal' | 'none';

// ── 섹션 빌더 ──

export function buildIdentitySection(): PromptSection {
  return {
    id: 'identity',
    title: 'Identity',
    content: [
      'You are FinClaw, an AI financial assistant.',
      'You provide accurate financial information, analysis, and guidance.',
      'You are professional, knowledgeable, and helpful.',
    ].join('\n'),
    priority: 100,
    required: true,
    tokenEstimate: 30,
  };
}

function buildCapabilitiesSection(ctx: PromptBuildContext): PromptSection {
  const capabilities: string[] = ['Financial data analysis', 'Market information retrieval'];
  if (ctx.modelCapabilities.supportsTools) capabilities.push('Tool execution');
  if (ctx.modelCapabilities.supportsVision) capabilities.push('Image analysis');

  return {
    id: 'capabilities',
    title: 'Capabilities',
    content: `Your capabilities:\n${capabilities.map((c) => `- ${c}`).join('\n')}`,
    priority: 95,
    required: true,
    tokenEstimate: 20 + capabilities.length * 5,
  };
}

export function buildToolsSection(tools: readonly ToolDefinition[]): PromptSection {
  if (tools.length === 0) {
    return {
      id: 'tools',
      title: 'Tools',
      content: 'No tools are currently available.',
      priority: 90,
      required: false,
      tokenEstimate: 10,
    };
  }

  const toolDescriptions = tools.map((t) => `- **${t.name}**: ${t.description}`).join('\n');

  return {
    id: 'tools',
    title: 'Available Tools',
    content: `You have access to the following tools:\n${toolDescriptions}`,
    priority: 90,
    required: true,
    tokenEstimate: tools.length * 20,
  };
}

export function buildFinanceContextSection(): PromptSection {
  return {
    id: 'finance-context',
    title: 'Financial Context',
    content: [
      'You operate in the financial domain.',
      'Always provide accurate, up-to-date financial information.',
      'When discussing investments, include relevant risk factors.',
      'Use standard financial terminology and formats.',
    ].join('\n'),
    priority: 85,
    required: true,
    tokenEstimate: 40,
  };
}

export function buildComplianceSection(level: string): PromptSection {
  const rules: string[] = [
    'Never provide personalized investment advice without proper disclaimers.',
    'Always disclose that you are an AI, not a licensed financial advisor.',
    'Do not guarantee investment returns or outcomes.',
  ];

  if (level === 'institutional') {
    rules.push('Follow institutional compliance standards and audit requirements.');
    rules.push('Flag potential regulatory issues proactively.');
  }

  return {
    id: 'compliance',
    title: 'Compliance Guidelines',
    content: `Financial compliance rules:\n${rules.map((r) => `- ${r}`).join('\n')}`,
    priority: 80,
    required: true,
    tokenEstimate: 30 + rules.length * 10,
  };
}

export function buildRiskDisclaimerSection(): PromptSection {
  return {
    id: 'risk-disclaimer',
    title: 'Risk Disclaimer',
    content: [
      'IMPORTANT: Include the following disclaimer when providing investment-related information:',
      '"This information is for educational purposes only and should not be considered financial advice.',
      'Past performance does not guarantee future results. Investing involves risk, including possible loss of principal."',
    ].join('\n'),
    priority: 75,
    required: true,
    tokenEstimate: 50,
  };
}

function buildUserContextSection(ctx: PromptBuildContext): PromptSection {
  const lines: string[] = [`User ID: ${ctx.userId}`];
  if (ctx.investmentProfile) {
    lines.push(`Risk tolerance: ${ctx.investmentProfile.riskTolerance}`);
    if (ctx.investmentProfile.preferredMarkets.length > 0) {
      lines.push(`Preferred markets: ${ctx.investmentProfile.preferredMarkets.join(', ')}`);
    }
    lines.push(`Compliance level: ${ctx.investmentProfile.complianceLevel}`);
  }

  return {
    id: 'user-context',
    title: 'User Context',
    content: lines.join('\n'),
    priority: 70,
    required: false,
    tokenEstimate: lines.length * 10,
  };
}

function buildChannelContextSection(ctx: PromptBuildContext): PromptSection {
  const rules: Record<ChatType, string> = {
    direct: 'This is a direct message. Be personal and detailed in responses.',
    group: 'This is a group chat. Be concise and address the specific user.',
    channel: 'This is a broadcast channel. Keep responses professional and general.',
  };

  return {
    id: 'channel-context',
    title: 'Channel Context',
    content: rules[ctx.chatType],
    priority: 65,
    required: false,
    tokenEstimate: 20,
  };
}

function buildFormattingSection(): PromptSection {
  return {
    id: 'formatting',
    title: 'Response Formatting',
    content: [
      'Format guidelines:',
      '- Use tables for comparative data',
      '- Use bullet points for lists',
      '- Format numbers with appropriate precision (currency: 2 decimals, percentages: 2 decimals)',
      '- Use markdown for emphasis when needed',
    ].join('\n'),
    priority: 60,
    required: false,
    tokenEstimate: 40,
  };
}

function buildLanguageSection(): PromptSection {
  return {
    id: 'language',
    title: 'Language & Tone',
    content: [
      'Respond in the same language as the user message.',
      'Maintain a professional yet approachable tone.',
      'Avoid jargon when simpler terms suffice.',
    ].join('\n'),
    priority: 55,
    required: false,
    tokenEstimate: 25,
  };
}

function buildConstraintsSection(): PromptSection {
  return {
    id: 'constraints',
    title: 'Constraints',
    content: [
      'Constraints:',
      '- Do not fabricate financial data or statistics',
      '- Do not provide specific buy/sell recommendations',
      '- Do not access or share user personal financial data without explicit request',
      '- If uncertain about information accuracy, state so clearly',
    ].join('\n'),
    priority: 50,
    required: true,
    tokenEstimate: 40,
  };
}

function buildExamplesSection(): PromptSection {
  return {
    id: 'examples',
    title: 'Response Examples',
    content: '',
    priority: 45,
    required: false,
    tokenEstimate: 0,
  };
}

function buildCurrentStateSection(): PromptSection {
  const now = new Date();
  return {
    id: 'current-state',
    title: 'Current State',
    content: `Current date/time: ${now.toISOString()}`,
    priority: 40,
    required: false,
    tokenEstimate: 15,
  };
}

function buildMemorySection(): PromptSection {
  return {
    id: 'memory',
    title: 'Conversation Memory',
    content: '',
    priority: 35,
    required: false,
    tokenEstimate: 0,
  };
}

function buildCustomSection(instructions: string): PromptSection {
  return {
    id: 'custom',
    title: 'Custom Instructions',
    content: instructions,
    priority: 30,
    required: false,
    tokenEstimate: Math.ceil(instructions.length / 4), // 대략 4 chars per token
  };
}

// ── 메인 함수 ──

/**
 * 15+ 섹션 동적 시스템 프롬프트 빌더
 *
 * 섹션은 priority 내림차순으로 정렬되어 조립된다.
 * 빈 content 섹션은 건너뛴다.
 * mode='minimal'이면 identity + tools + constraints만 포함.
 * mode='none'이면 빈 문자열 반환.
 */
export function buildSystemPrompt(ctx: PromptBuildContext, mode: PromptBuildMode = 'full'): string {
  if (mode === 'none') return '';

  const complianceLevel = ctx.investmentProfile?.complianceLevel ?? 'retail';

  // 모든 섹션 생성
  const allSections: PromptSection[] = [
    buildIdentitySection(),
    buildCapabilitiesSection(ctx),
    buildToolsSection(ctx.availableTools),
    buildFinanceContextSection(),
    buildComplianceSection(complianceLevel),
    buildRiskDisclaimerSection(),
    buildUserContextSection(ctx),
    buildChannelContextSection(ctx),
    buildFormattingSection(),
    buildLanguageSection(),
    buildConstraintsSection(),
    buildExamplesSection(),
    buildCurrentStateSection(),
    buildMemorySection(),
  ];

  // custom instructions
  if (ctx.customInstructions) {
    allSections.push(buildCustomSection(ctx.customInstructions));
  }

  // mode 필터링
  let sections: PromptSection[];
  if (mode === 'minimal') {
    const minimalIds = new Set(['identity', 'tools', 'constraints']);
    sections = allSections.filter((s) => minimalIds.has(s.id));
  } else {
    sections = allSections;
  }

  // priority 내림차순 정렬
  sections.sort((a, b) => b.priority - a.priority);

  // 빈 content 섹션 제거
  sections = sections.filter((s) => s.content.length > 0);

  // 조립
  return sections.map((s) => `## ${s.title}\n\n${s.content}`).join('\n\n---\n\n');
}
```

검증: `pnpm typecheck`

---

### - [ ] Step 9: Skills Manager (스텁)

파일: `packages/agent/src/agents/skills/manager.ts`

```typescript
/**
 * 스킬 로딩/관리 — 기본 수준 스텁 구현
 *
 * Phase 7에서는 스킬 정의 인터페이스와 기본 로딩만 구현.
 * 핫 리로드, 의존성 해결 등은 후속 Phase에서 확장.
 */

import type { ToolDefinition } from '@finclaw/types/agent.js';

/** 스킬 정의 */
export interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly tools: readonly ToolDefinition[];
}

/** 스킬 매니저 인터페이스 */
export interface SkillManager {
  load(skill: SkillDefinition): void;
  unload(name: string): boolean;
  get(name: string): SkillDefinition | undefined;
  list(): readonly SkillDefinition[];
  getTools(): readonly ToolDefinition[];
}

/** 인메모리 스킬 매니저 */
export class InMemorySkillManager implements SkillManager {
  private readonly skills = new Map<string, SkillDefinition>();

  load(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
  }

  unload(name: string): boolean {
    return this.skills.delete(name);
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  list(): readonly SkillDefinition[] {
    return [...this.skills.values()];
  }

  /** 모든 스킬의 도구를 합쳐 반환 */
  getTools(): readonly ToolDefinition[] {
    return [...this.skills.values()].flatMap((s) => s.tools);
  }
}
```

검증: `pnpm typecheck`

---

### - [ ] Step 10: agent/index.ts 배럴 업데이트

파일: `packages/agent/src/index.ts`

기존 export 뒤에 Phase 7 모듈 추가:

```typescript
// ── Phase 7: Tools ──
export type {
  ToolGroupId,
  ToolGroup,
  ToolInputSchema,
  ToolPropertySchema,
  RegisteredToolDefinition,
  ToolExecutor,
  ToolExecutionContext,
  ToolResult,
  RegisteredTool,
  ToolRegistry,
  BeforeToolExecutePayload,
  AfterToolExecutePayload,
  ToolRegistryHooks,
  PolicyVerdict,
  PolicyRule,
  PolicyContext,
  PolicyStage,
  PolicyStageResult,
  PolicyEvaluationResult,
  GuardedToolResult,
  ResultGuardOptions,
} from './agents/tools/index.js';
export {
  BUILT_IN_GROUPS,
  toApiToolDefinition,
  InMemoryToolRegistry,
  evaluateToolPolicy,
  matchToolPattern,
  guardToolResult,
  FINANCIAL_REDACT_PATTERNS,
} from './agents/tools/index.js';

// ── Phase 7: Session ──
export type {
  LockResult,
  LockOptions,
  TranscriptEntry,
  CorruptionType,
  DetectedCorruption,
  CorruptionReport,
} from './agents/session/index.js';
export {
  acquireWriteLock,
  resetHeldLocks,
  detectCorruption,
  repairTranscript,
} from './agents/session/index.js';

// ── Phase 7: Context ──
export type {
  TokenBreakdown,
  ContextWindowState,
  WindowGuardConfig,
  CompactionStrategy,
  CompactionOptions,
  CompactionResult,
} from './agents/context/index.js';
export { evaluateContextWindow, compactContext } from './agents/context/index.js';

// ── Phase 7: System Prompt ──
export type {
  PromptSection,
  InvestmentProfile,
  PromptModelCapabilities,
  PromptBuildContext,
  PromptBuildMode,
} from './agents/system-prompt.js';
export {
  buildSystemPrompt,
  buildIdentitySection,
  buildToolsSection,
  buildFinanceContextSection,
  buildComplianceSection,
  buildRiskDisclaimerSection,
} from './agents/system-prompt.js';

// ── Phase 7: Skills ──
export type { SkillDefinition, SkillManager } from './agents/skills/manager.js';
export { InMemorySkillManager } from './agents/skills/manager.js';
```

검증: `pnpm typecheck`

---

## 테스트

### - [ ] Step 11: write-lock.test.ts

파일: `packages/agent/test/write-lock.test.ts`

```typescript
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { resetEventBus } from '@finclaw/infra';
import { describe, it, expect, afterEach } from 'vitest';

import { acquireWriteLock, resetHeldLocks } from '../src/agents/session/write-lock.js';

// ── 헬퍼 ──

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finclaw-wl-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('acquireWriteLock', () => {
  afterEach(() => {
    resetHeldLocks();
    resetEventBus();
  });

  it('잠금을 성공적으로 획득한다', async () => {
    await withTempDir(async (dir) => {
      const result = await acquireWriteLock({ sessionDir: dir, sessionId: 'sess-1' });

      expect(result.acquired).toBe(true);
      expect(result.lockPath).toContain('sess-1.lock');

      // 잠금 파일이 존재하는지 확인
      const stat = await fs.stat(result.lockPath);
      expect(stat.isFile()).toBe(true);

      // 잠금 파일 내용 확인
      const content = JSON.parse(await fs.readFile(result.lockPath, 'utf-8'));
      expect(content.pid).toBe(process.pid);
      expect(content.sessionId).toBe('sess-1');

      await result.release();
    });
  });

  it('이중 잠금을 방지한다 (타임아웃)', async () => {
    await withTempDir(async (dir) => {
      const lock1 = await acquireWriteLock({ sessionDir: dir, sessionId: 'sess-1' });
      expect(lock1.acquired).toBe(true);

      // 두 번째 잠금 시도 — 짧은 타임아웃
      const lock2 = await acquireWriteLock({
        sessionDir: dir,
        sessionId: 'sess-1',
        timeoutMs: 200,
        pollIntervalMs: 50,
      });
      expect(lock2.acquired).toBe(false);

      await lock1.release();
    });
  });

  it('release() 후 잠금 파일이 삭제된다', async () => {
    await withTempDir(async (dir) => {
      const result = await acquireWriteLock({ sessionDir: dir, sessionId: 'sess-1' });
      expect(result.acquired).toBe(true);

      await result.release();

      await expect(fs.stat(result.lockPath)).rejects.toThrow();
    });
  });

  it('release() 후 다시 잠금을 획득할 수 있다', async () => {
    await withTempDir(async (dir) => {
      const lock1 = await acquireWriteLock({ sessionDir: dir, sessionId: 'sess-1' });
      await lock1.release();

      const lock2 = await acquireWriteLock({ sessionDir: dir, sessionId: 'sess-1' });
      expect(lock2.acquired).toBe(true);

      await lock2.release();
    });
  });

  it('stale 잠금을 시간 기반으로 감지하고 강제 해제한다', async () => {
    await withTempDir(async (dir) => {
      const lockPath = path.join(dir, 'sess-stale.lock');

      // 수동으로 오래된 잠금 파일 생성
      const lockData = JSON.stringify({
        pid: process.pid,
        timestamp: new Date(Date.now() - 600_000).toISOString(),
        sessionId: 'sess-stale',
      });
      await fs.writeFile(lockPath, lockData);

      // mtime을 과거로 설정
      const past = new Date(Date.now() - 600_000);
      await fs.utimes(lockPath, past, past);

      // staleAfterMs=1000으로 설정하면 즉시 stale 처리
      const result = await acquireWriteLock({
        sessionDir: dir,
        sessionId: 'sess-stale',
        staleAfterMs: 1_000,
      });
      expect(result.acquired).toBe(true);

      await result.release();
    });
  });

  it('죽은 프로세스의 잠금을 PID 확인으로 즉시 해제한다', async () => {
    await withTempDir(async (dir) => {
      const lockPath = path.join(dir, 'sess-dead.lock');

      // 존재하지 않는 PID로 잠금 파일 생성
      const lockData = JSON.stringify({
        pid: 999999,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-dead',
      });
      await fs.writeFile(lockPath, lockData);

      const result = await acquireWriteLock({
        sessionDir: dir,
        sessionId: 'sess-dead',
      });
      expect(result.acquired).toBe(true);

      await result.release();
    });
  });

  it('재진입 잠금을 허용한다 (allowReentrant)', async () => {
    await withTempDir(async (dir) => {
      const lock1 = await acquireWriteLock({
        sessionDir: dir,
        sessionId: 'sess-reentrant',
        allowReentrant: true,
      });
      expect(lock1.acquired).toBe(true);

      const lock2 = await acquireWriteLock({
        sessionDir: dir,
        sessionId: 'sess-reentrant',
        allowReentrant: true,
      });
      expect(lock2.acquired).toBe(true);

      // 첫 번째 release — 파일은 아직 존재해야 함
      await lock2.release();
      const stat = await fs.stat(lock1.lockPath).catch(() => null);
      expect(stat).not.toBeNull();

      // 두 번째 release — 파일 삭제
      await lock1.release();
    });
  });
});
```

검증: `pnpm test -- packages/agent/test/write-lock.test.ts`

---

### - [ ] Step 12: transcript-repair.test.ts

파일: `packages/agent/test/transcript-repair.test.ts`

```typescript
import { describe, it, expect } from 'vitest';

import type { TranscriptEntry } from '../src/agents/session/transcript-repair.js';
import { detectCorruption, repairTranscript } from '../src/agents/session/transcript-repair.js';

// ── 헬퍼 ──

function makeEntry(overrides?: Partial<TranscriptEntry>): TranscriptEntry {
  return {
    role: 'user',
    content: 'hello',
    timestamp: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('detectCorruption', () => {
  it('정상 트랜스크립트는 손상 없음', () => {
    const entries: TranscriptEntry[] = [
      makeEntry({ role: 'user', content: 'hi', timestamp: 't1' }),
      makeEntry({ role: 'assistant', content: 'hello', timestamp: 't2' }),
    ];
    const report = detectCorruption(entries);

    expect(report.corruptions).toHaveLength(0);
    expect(report.isRecoverable).toBe(true);
  });

  it('중복 엔트리를 감지한다', () => {
    const entries: TranscriptEntry[] = [
      makeEntry({ role: 'user', content: 'hi', timestamp: 't1' }),
      makeEntry({ role: 'user', content: 'hi', timestamp: 't1' }),
    ];
    const report = detectCorruption(entries);

    expect(report.corruptions).toHaveLength(1);
    expect(report.corruptions[0].type).toBe('duplicate-entry');
  });

  it('orphan tool result를 감지한다', () => {
    const entries: TranscriptEntry[] = [
      makeEntry({ role: 'user', content: 'hi', timestamp: 't1' }),
      makeEntry({
        role: 'tool',
        content: 'result',
        timestamp: 't2',
        toolUseId: 'tu-1',
        toolName: 'test-tool',
      }),
    ];
    const report = detectCorruption(entries);

    const orphan = report.corruptions.find((c) => c.type === 'orphan-tool-result');
    expect(orphan).toBeDefined();
  });

  it('missing tool result를 감지한다', () => {
    const entries: TranscriptEntry[] = [
      makeEntry({ role: 'user', content: 'hi', timestamp: 't1' }),
      makeEntry({
        role: 'assistant',
        content: 'using tool',
        timestamp: 't2',
        toolUseId: 'tu-1',
      }),
      // tool result 누락
      makeEntry({ role: 'user', content: 'next', timestamp: 't3' }),
    ];
    const report = detectCorruption(entries);

    const missing = report.corruptions.find((c) => c.type === 'missing-tool-result');
    expect(missing).toBeDefined();
  });

  it('빈 tool content (abort)를 감지한다', () => {
    const entries: TranscriptEntry[] = [
      makeEntry({ role: 'assistant', content: 'call', timestamp: 't1', toolUseId: 'tu-1' }),
      makeEntry({ role: 'tool', content: '', timestamp: 't2', toolUseId: 'tu-1' }),
    ];
    const report = detectCorruption(entries);

    const empty = report.corruptions.find(
      (c) => c.type === 'missing-tool-result' && c.description.includes('Empty'),
    );
    expect(empty).toBeDefined();
  });

  it('invalid role sequence를 감지한다', () => {
    const entries: TranscriptEntry[] = [
      makeEntry({ role: 'user', content: 'hi', timestamp: 't1' }),
      makeEntry({ role: 'tool', content: 'result', timestamp: 't2' }),
    ];
    const report = detectCorruption(entries);

    const invalid = report.corruptions.find((c) => c.type === 'invalid-role-sequence');
    expect(invalid).toBeDefined();
  });
});

describe('repairTranscript', () => {
  it('중복 엔트리를 제거한다', () => {
    const entries: TranscriptEntry[] = [
      makeEntry({ role: 'user', content: 'hi', timestamp: 't1' }),
      makeEntry({ role: 'user', content: 'hi', timestamp: 't1' }),
      makeEntry({ role: 'assistant', content: 'hello', timestamp: 't2' }),
    ];
    const report = detectCorruption(entries);
    const repaired = repairTranscript(entries, report);

    expect(repaired).toHaveLength(2);
    expect(repaired[0].content).toBe('hi');
    expect(repaired[1].content).toBe('hello');
  });

  it('orphan tool result에 합성 assistant를 삽입한다', () => {
    const entries: TranscriptEntry[] = [
      makeEntry({ role: 'user', content: 'hi', timestamp: 't1' }),
      makeEntry({
        role: 'tool',
        content: 'result',
        timestamp: 't2',
        toolUseId: 'tu-1',
        toolName: 'test-tool',
      }),
    ];
    const report = detectCorruption(entries);
    const repaired = repairTranscript(entries, report);

    // orphan 앞에 합성 assistant가 삽입되어야 함
    const syntheticAssistant = repaired.find(
      (e) => e.role === 'assistant' && e.content.includes('Synthetic'),
    );
    expect(syntheticAssistant).toBeDefined();
  });

  it('missing tool result에 합성 tool result를 삽입한다', () => {
    const entries: TranscriptEntry[] = [
      makeEntry({ role: 'user', content: 'hi', timestamp: 't1' }),
      makeEntry({
        role: 'assistant',
        content: 'using tool',
        timestamp: 't2',
        toolUseId: 'tu-1',
      }),
      makeEntry({ role: 'user', content: 'next', timestamp: 't3' }),
    ];
    const report = detectCorruption(entries);
    const repaired = repairTranscript(entries, report);

    const syntheticTool = repaired.find(
      (e) => e.role === 'tool' && e.content.includes('unavailable'),
    );
    expect(syntheticTool).toBeDefined();
  });

  it('빈 tool content를 "[Execution aborted]"로 교체한다', () => {
    const entries: TranscriptEntry[] = [
      makeEntry({ role: 'assistant', content: 'call', timestamp: 't1', toolUseId: 'tu-1' }),
      makeEntry({ role: 'tool', content: '', timestamp: 't2', toolUseId: 'tu-1' }),
    ];
    const report = detectCorruption(entries);
    const repaired = repairTranscript(entries, report);

    const aborted = repaired.find((e) => e.content === '[Execution aborted]');
    expect(aborted).toBeDefined();
  });
});
```

검증: `pnpm test -- packages/agent/test/transcript-repair.test.ts`

---

### - [ ] Step 13: compaction.test.ts

파일: `packages/agent/test/compaction.test.ts`

```typescript
import { resetEventBus } from '@finclaw/infra';
import { describe, it, expect, afterEach } from 'vitest';

import type { TranscriptEntry } from '../src/agents/session/transcript-repair.js';
import type { CompactionOptions } from '../src/agents/context/compaction.js';
import { compactContext } from '../src/agents/context/compaction.js';

// ── 헬퍼 ──

/** 간이 토큰 카운터: 문자 4개 = 1토큰 */
function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 간이 요약기 */
async function mockSummarizer(text: string): Promise<string> {
  return `[Summary of ${text.length} chars]`;
}

/** 실패하는 요약기 */
async function failingSummarizer(_text: string): Promise<string> {
  throw new Error('Summarizer unavailable');
}

function makeEntry(role: TranscriptEntry['role'], content: string, idx: number): TranscriptEntry {
  return {
    role,
    content,
    timestamp: `2024-01-01T00:00:${String(idx).padStart(2, '0')}Z`,
  };
}

function makeOptions(overrides?: Partial<CompactionOptions>): CompactionOptions {
  return {
    strategy: 'hybrid',
    targetTokens: 100,
    preserveRecentMessages: 2,
    preserveSystemPrompt: true,
    ...overrides,
  };
}

describe('compactContext', () => {
  afterEach(() => {
    resetEventBus();
  });

  it('목표 토큰 이하이면 압축하지 않는다', async () => {
    const entries: TranscriptEntry[] = [
      makeEntry('user', 'hi', 0),
      makeEntry('assistant', 'hello', 1),
    ];
    const result = await compactContext(
      entries,
      makeOptions({ targetTokens: 10000 }),
      mockSummarizer,
      countTokens,
    );

    expect(result.removedCount).toBe(0);
    expect(result.compactedEntries).toHaveLength(2);
    expect(result.beforeTokens).toBe(result.afterTokens);
  });

  it('truncate-tools 전략은 tool 결과를 축소한다', async () => {
    const entries: TranscriptEntry[] = [
      makeEntry('user', 'query', 0),
      makeEntry('assistant', 'calling tool', 1),
      makeEntry('tool', 'A'.repeat(400), 2), // 큰 tool 결과
      makeEntry('user', 'thanks', 3),
      makeEntry('assistant', 'done', 4),
    ];
    const result = await compactContext(
      entries,
      makeOptions({ strategy: 'truncate-tools', targetTokens: 50 }),
      mockSummarizer,
      countTokens,
    );

    const toolEntry = result.compactedEntries.find((e) => e.role === 'tool');
    expect(toolEntry?.content).toContain('[Result truncated');
    expect(result.strategy).toBe('truncate-tools');
  });

  it('truncate-oldest 전략은 오래된 메시지를 제거한다', async () => {
    const entries: TranscriptEntry[] = [
      makeEntry('user', 'A'.repeat(200), 0),
      makeEntry('assistant', 'B'.repeat(200), 1),
      makeEntry('user', 'C'.repeat(200), 2),
      makeEntry('assistant', 'D'.repeat(100), 3),
      makeEntry('user', 'recent1', 4),
      makeEntry('assistant', 'recent2', 5),
    ];
    const result = await compactContext(
      entries,
      makeOptions({ strategy: 'truncate-oldest', targetTokens: 100 }),
      mockSummarizer,
      countTokens,
    );

    expect(result.removedCount).toBeGreaterThan(0);
    // 최근 2개 메시지는 보존
    const lastTwo = result.compactedEntries.slice(-2);
    expect(lastTwo[0].content).toBe('recent1');
    expect(lastTwo[1].content).toBe('recent2');
  });

  it('summarize 전략은 AI 요약을 생성한다', async () => {
    const entries: TranscriptEntry[] = [
      makeEntry('user', 'A'.repeat(200), 0),
      makeEntry('assistant', 'B'.repeat(200), 1),
      makeEntry('user', 'recent', 2),
      makeEntry('assistant', 'reply', 3),
    ];
    const result = await compactContext(
      entries,
      makeOptions({ strategy: 'summarize', targetTokens: 50 }),
      mockSummarizer,
      countTokens,
    );

    expect(result.summary).toBeDefined();
    const summaryEntry = result.compactedEntries.find((e) =>
      e.content.includes('[Previous conversation summary]'),
    );
    expect(summaryEntry).toBeDefined();
  });

  it('hybrid 전략은 초과량에 따라 자동 선택한다', async () => {
    const entries: TranscriptEntry[] = [
      makeEntry('user', 'A'.repeat(200), 0),
      makeEntry('assistant', 'B'.repeat(200), 1),
      makeEntry('user', 'recent', 2),
      makeEntry('assistant', 'reply', 3),
    ];
    const result = await compactContext(
      entries,
      makeOptions({ strategy: 'hybrid', targetTokens: 50 }),
      mockSummarizer,
      countTokens,
    );

    // 초과량이 크므로 summarize가 선택될 것
    expect(result.strategy).not.toBe('hybrid');
  });

  it('preserveRecentMessages만큼 최근 메시지를 보존한다', async () => {
    const entries: TranscriptEntry[] = [
      makeEntry('user', 'old1', 0),
      makeEntry('assistant', 'old2', 1),
      makeEntry('user', 'keep1', 2),
      makeEntry('assistant', 'keep2', 3),
    ];
    const result = await compactContext(
      entries,
      makeOptions({ strategy: 'truncate-oldest', targetTokens: 10, preserveRecentMessages: 2 }),
      mockSummarizer,
      countTokens,
    );

    const lastTwo = result.compactedEntries.slice(-2);
    expect(lastTwo[0].content).toBe('keep1');
    expect(lastTwo[1].content).toBe('keep2');
  });

  it('summarizer 실패 시 truncate-oldest로 폴백한다', async () => {
    const entries: TranscriptEntry[] = [
      makeEntry('user', 'A'.repeat(200), 0),
      makeEntry('assistant', 'B'.repeat(200), 1),
      makeEntry('user', 'recent', 2),
      makeEntry('assistant', 'reply', 3),
    ];
    const result = await compactContext(
      entries,
      makeOptions({ strategy: 'summarize', targetTokens: 50 }),
      failingSummarizer,
      countTokens,
    );

    // 요약 실패 → truncate-oldest 폴백
    expect(result.strategy).toBe('truncate-oldest');
    expect(result.summary).toBeUndefined();
  });
});
```

검증: `pnpm test -- packages/agent/test/compaction.test.ts`

---

## 최종 검증

```bash
# 전체 타입 체크
pnpm typecheck

# todo-2 테스트 실행
pnpm test -- packages/agent/test/write-lock.test.ts packages/agent/test/transcript-repair.test.ts packages/agent/test/compaction.test.ts

# 전체 Phase 7 테스트
pnpm test -- packages/agent/test/tool-groups.test.ts packages/agent/test/tool-registry.test.ts packages/agent/test/tool-policy.test.ts packages/agent/test/result-guard.test.ts packages/agent/test/write-lock.test.ts packages/agent/test/transcript-repair.test.ts packages/agent/test/compaction.test.ts

# 린트 (선택)
pnpm lint
```

### 체크리스트 요약

| #   | 파일                                                     | 유형              |
| --- | -------------------------------------------------------- | ----------------- |
| 1   | `packages/infra/src/events.ts`                           | 수정 (이벤트 6종) |
| 2   | `packages/agent/src/agents/session/write-lock.ts`        | 생성              |
| 3   | `packages/agent/src/agents/session/transcript-repair.ts` | 생성              |
| 4   | `packages/agent/src/agents/session/index.ts`             | 생성              |
| 5   | `packages/agent/src/agents/context/window-guard.ts`      | 생성              |
| 6   | `packages/agent/src/agents/context/compaction.ts`        | 생성              |
| 7   | `packages/agent/src/agents/context/index.ts`             | 생성              |
| 8   | `packages/agent/src/agents/system-prompt.ts`             | 생성              |
| 9   | `packages/agent/src/agents/skills/manager.ts`            | 생성              |
| 10  | `packages/agent/src/index.ts`                            | 수정 (배럴 추가)  |
| 11  | `packages/agent/test/write-lock.test.ts`                 | 생성              |
| 12  | `packages/agent/test/transcript-repair.test.ts`          | 생성              |
| 13  | `packages/agent/test/compaction.test.ts`                 | 생성              |
