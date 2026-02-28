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
  _maxOutputTokens: number,
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
