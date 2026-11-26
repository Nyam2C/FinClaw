// packages/server/src/agent-runtime/prepare-turn.ts
// 턴별 가변 컨텍스트(시각·회상·거래·recap)를 user 메시지 앞 블록으로 조립 — 시스템 프롬프트는 정적 (캐시 프리픽스).
import type { FinClawLogger } from '@finclaw/infra';
import type { SessionKey } from '@finclaw/types';
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
 * 턴 컨텍스트 조립: [<recent_conversation>] + <context>. 트랜스크립트에는 `system` 행으로 저장되고,
 * API 로는 바로 뒤 user 메시지의 첫 블록으로 나간다. recap 은 컨텍스트를 회전한 턴에만 넘긴다.
 * recap 은 user 원문과 assistant text 만 쓴다 → 컨텍스트·도구 결과 재주입 순환 없음.
 */
export function composeContext(context: string, recap: readonly RecapMessage[]): string {
  const lines = recap
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, text: messageText(m.content) }))
    .filter((m) => m.text.length > 0) // tool_use 만 있는 assistant 행 제외
    .slice(-RECAP_MESSAGES)
    .map(
      (m) => `${m.role === 'user' ? '사용자' : 'FinClaw'}: ${m.text.slice(0, RECAP_MESSAGE_CHARS)}`,
    );
  // ponytail: 합계 상한 초과 시 recap 을 오래된 것부터 버린다 — 배경지식은 상류에서 이미 상한(3건·거래 3건).
  while (lines.length > 0 && recapBlock(lines).length + context.length > BLOCK_BUDGET_CHARS) {
    lines.shift();
  }
  return lines.length > 0 ? `${recapBlock(lines)}\n\n${context}` : context;
}

interface RecapMessage {
  readonly role: string;
  readonly content: string | readonly unknown[];
}

function messageText(content: RecapMessage['content']): string {
  return typeof content === 'string'
    ? content
    : (content as readonly { type?: string; text?: string }[])
        .flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
        .join('');
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
