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
