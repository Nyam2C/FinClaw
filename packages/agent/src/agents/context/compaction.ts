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
  let preservedSystem: TranscriptEntry[];
  if (options.preserveSystemPrompt) {
    const systemEntries = toCompact.filter(
      (e) => e.role === 'system' && !e.content.startsWith('[Previous conversation summary]'),
    );
    const nonSystem = toCompact.filter(
      (e) => !(e.role === 'system' && !e.content.startsWith('[Previous conversation summary]')),
    );
    // system 엔트리는 보존하고 나머지만 압축
    toCompact = nonSystem;
    preservedSystem = systemEntries;
  } else {
    preservedSystem = [];
  }

  // 전략 결정
  let strategy = options.strategy;
  if (strategy === 'hybrid') {
    const excessRatio = excess / totalTokens;
    strategy = excessRatio < 0.2 ? 'truncate-tools' : 'summarize';
  }

  // TODO: targetTokens ≤ ~4916이면 safeTarget이 음수 → summarize 불가, truncate-oldest 폴백.
  // Math.max(0, ...) 클램핑 고려 (review-2 이슈 3)
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
