// packages/server/src/auto-reply/stages/memory-retrieval.ts
import type { DatabaseSync } from 'node:sqlite';
import type { FinClawLogger } from '@finclaw/infra';
import type { ChunkSearchResult, EmbeddingProvider, Transaction } from '@finclaw/storage';
import {
  getMemory,
  listTransactions,
  mergeHybridResults,
  searchFts,
  searchVector,
} from '@finclaw/storage';
import type { MemoryEntry, SessionKey, TickerSymbol } from '@finclaw/types';

// ─── Constants (single source of truth) ───

/** raw 점수 컷오프. 무관 발화에 무관 기억이 끼지 않게 하는 마지노선. */
export const SIMILARITY_THRESHOLD = 0.65;

/** 신선도 반감기. exp(-daysOld / 90). 3개월 지나면 가중치 ≈ 37%. */
export const FRESHNESS_HALF_LIFE_DAYS = 90;

/** system prompt 에 주입하는 기억의 상한. 비용 통제. */
export const MAX_INJECTED_MEMORIES = 3;

/** 임계값 컷 후도 상한 3개를 채울 여유분. */
export const TOP_K_FETCH = 5;

/** 발화 심볼당 거래 이력 주입 건수. */
export const SYMBOL_TX_LIMIT = 3;

/** 검색 대상 메모리 타입. summary 는 자동 회상에서 제외. */
const SEARCHABLE_TYPES: ReadonlySet<MemoryEntry['type']> = new Set([
  'fact',
  'preference',
  'financial',
]);

/** 심볼 false-positive 제외 리스트 (통화·시간대·관용어). */
const SYMBOL_BLOCKLIST: ReadonlySet<string> = new Set([
  // 통화
  'USD',
  'KRW',
  'EUR',
  'JPY',
  'GBP',
  'CNY',
  'HKD',
  'CHF',
  'CAD',
  'AUD',
  // 시간/시간대
  'AM',
  'PM',
  'EST',
  'PST',
  'KST',
  'UTC',
  'GMT',
  // 관용 약어
  'IPO',
  'ETF',
  'CEO',
  'CFO',
  'CTO',
  'GDP',
  'FED',
  'SEC',
  'IRS',
  'ROI',
  'EPS',
  'PER',
  'PBR',
]);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Public types ───

export interface MemorySnippet {
  readonly id: string;
  readonly content: string;
  readonly type: MemoryEntry['type'];
  readonly createdAt: number;
  readonly rawScore: number;
  readonly adjustedScore: number;
  readonly daysOld: number;
}

export interface InjectedTransaction {
  readonly symbol: string;
  readonly action: Transaction['action'];
  readonly quantity: number;
  readonly price: number | null;
  readonly currency: string;
  readonly executedAt: number;
}

export interface AuditLog {
  readonly event: 'memory.injected';
  readonly sessionKey: string;
  readonly userQuery: string;
  readonly memoryIds: readonly string[];
  readonly rawScores: readonly number[];
  readonly adjustedScores: readonly number[];
  readonly mode: 'hybrid' | 'fts-only';
  readonly transactionSymbols: readonly string[];
  readonly timestamp: number;
}

export interface RetrievalResult {
  readonly snippets: readonly MemorySnippet[];
  readonly transactions: readonly InjectedTransaction[];
  readonly mode: 'hybrid' | 'fts-only';
  readonly auditLog: AuditLog;
}

export interface MemoryRetrievalService {
  searchRelevant(input: { userQuery: string; sessionKey: SessionKey }): Promise<RetrievalResult>;
}

export interface MemoryRetrievalServiceDeps {
  readonly db: DatabaseSync;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly logger: FinClawLogger;
}

// ─── Symbol extraction ───

/**
 * 발화에서 가능한 티커 심볼을 추출한다.
 * 단순 정규식: 대문자 2-5자. 통화/시간/관용 약어는 블록리스트로 제거.
 * 한국어 종목명·6자리 코드는 본 단계 범위 외.
 */
export function extractSymbols(text: string): string[] {
  const matches = text.match(/\b[A-Z]{2,5}\b/g) ?? [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of matches) {
    if (SYMBOL_BLOCKLIST.has(m)) {
      continue;
    }
    if (seen.has(m)) {
      continue;
    }
    seen.add(m);
    result.push(m);
  }
  return result;
}

// ─── Format builder ───

const ACTION_LABEL: Record<Transaction['action'], string> = {
  buy: '매수',
  sell: '매도',
  dividend: '배당',
  fee: '수수료',
  split: '분할',
};

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * system prompt 에 삽입할 "사용자 배경지식" 섹션을 빌드한다.
 *
 * snippets·transactions 모두 비어있으면 빈 문자열 반환 → caller 가 섹션 자체 생략.
 * 거래는 심볼별로 그룹화. 심볼이 여러 개면 각 심볼마다 블록 별도.
 */
export function formatBackgroundSection(result: RetrievalResult): string {
  const lines: string[] = [];

  if (result.snippets.length > 0) {
    lines.push('## 사용자 배경지식 (자동 주입)');
    for (const s of result.snippets) {
      lines.push(`- [${s.type}] ${s.content} (${isoDate(s.createdAt)} 저장)`);
    }
  }

  if (result.transactions.length > 0) {
    // 심볼별 그룹화 (입력 순서 유지)
    const bySymbol = new Map<string, InjectedTransaction[]>();
    for (const tx of result.transactions) {
      const list = bySymbol.get(tx.symbol);
      if (list) {
        list.push(tx);
      } else {
        bySymbol.set(tx.symbol, [tx]);
      }
    }

    for (const [symbol, txs] of bySymbol) {
      if (lines.length > 0) {
        lines.push(''); // 섹션 간 빈 줄
      }
      lines.push(`## 최근 거래 (${symbol})`);
      for (const tx of txs) {
        const label = ACTION_LABEL[tx.action];
        const priceStr = tx.price !== null ? `@ ${tx.currency} ${tx.price}`.trim() : '';
        lines.push(`- ${isoDate(tx.executedAt)}: ${label} ${tx.quantity}주 ${priceStr}`.trimEnd());
      }
    }
  }

  return lines.join('\n');
}

// ─── Service ───

/**
 * 기본 구현.
 *
 * 흐름:
 * 1. extractSymbols(userQuery) — 거래 동시 주입 대상 심볼 추출
 * 2. embeddingProvider 있으면 hybrid (vector + FTS), 없거나 throw 면 fts-only
 * 3. mergeHybridResults → memoryId 별 dedup → getMemory 로 메타 조회
 * 4. raw score < SIMILARITY_THRESHOLD 컷, 신선도 곱셈, 정렬, 상한 3개
 * 5. listTransactions(symbol, limit=3) — 추출된 심볼별
 * 6. 감사 로그 emit (logger.info)
 */
export class DefaultMemoryRetrievalService implements MemoryRetrievalService {
  constructor(private readonly deps: MemoryRetrievalServiceDeps) {}

  async searchRelevant(input: {
    userQuery: string;
    sessionKey: SessionKey;
  }): Promise<RetrievalResult> {
    const { db, embeddingProvider, logger } = this.deps;
    const userQuery = input.userQuery;

    // 1. hybrid vs fts-only 결정 + 검색
    let mode: 'hybrid' | 'fts-only' = embeddingProvider ? 'hybrid' : 'fts-only';
    let merged: ChunkSearchResult[] = [];

    if (mode === 'hybrid' && embeddingProvider) {
      try {
        // TOP_K_FETCH * 2 — chunk 단위 결과를 memoryId dedup 후 충분히 남기기 위함
        const [vec, fts] = await Promise.all([
          searchVector(db, userQuery, embeddingProvider, TOP_K_FETCH * 2),
          Promise.resolve(searchFts(db, userQuery, TOP_K_FETCH * 2)),
        ]);
        merged = mergeHybridResults(vec, fts, { limit: TOP_K_FETCH * 2, minScore: 0 });
      } catch (err) {
        // 임베딩 프로바이더 장애 → FTS 단독 fallback
        logger.warn('Memory retrieval: embedding failed, falling back to FTS-only', {
          event: 'memory.retrieval.embedding_failed',
          error: err instanceof Error ? err.message : String(err),
        });
        mode = 'fts-only';
        merged = searchFts(db, userQuery, TOP_K_FETCH * 2);
      }
    } else {
      merged = searchFts(db, userQuery, TOP_K_FETCH * 2);
    }

    // 2. memoryId 별 dedup — 가장 높은 chunk score 만 유지
    const bestByMemory = new Map<string, ChunkSearchResult>();
    for (const r of merged) {
      const prev = bestByMemory.get(r.memoryId);
      if (!prev || r.score > prev.score) {
        bestByMemory.set(r.memoryId, r);
      }
    }

    // 3. memory 메타 로드 + 임계값/신선도 적용
    const now = Date.now();
    const candidates: MemorySnippet[] = [];
    for (const r of bestByMemory.values()) {
      const rawScore = r.score;
      if (rawScore < SIMILARITY_THRESHOLD) {
        continue;
      }
      const entry = getMemory(db, r.memoryId);
      if (!entry) {
        continue; // 인덱스/테이블 불일치 — 조용히 skip
      }
      if (!SEARCHABLE_TYPES.has(entry.type)) {
        continue;
      }
      const createdAt = entry.createdAt as number;
      // 시계 오차로 days < 0 가능 → 1로 clamp (신선도 가중치는 어제 수준)
      const daysOld = Math.max(1, (now - createdAt) / MS_PER_DAY);
      const adjustedScore = rawScore * Math.exp(-daysOld / FRESHNESS_HALF_LIFE_DAYS);
      candidates.push({
        id: entry.id,
        content: entry.content,
        type: entry.type,
        createdAt,
        rawScore,
        adjustedScore,
        daysOld,
      });
    }

    // 4. 정렬 + 상한
    candidates.sort((a, b) => b.adjustedScore - a.adjustedScore);
    const snippets = candidates.slice(0, MAX_INJECTED_MEMORIES);

    // 5. 거래 동시 주입
    const symbols = extractSymbols(userQuery);
    const transactions: InjectedTransaction[] = [];
    for (const symbol of symbols) {
      const txs = listTransactions(db, {
        symbol: symbol as TickerSymbol,
        limit: SYMBOL_TX_LIMIT,
      });
      for (const tx of txs) {
        transactions.push({
          symbol: tx.symbol as string,
          action: tx.action,
          quantity: tx.quantity,
          price: tx.price ?? null,
          currency: tx.currency as string,
          executedAt: tx.executedAt as number,
        });
      }
    }

    // 6. 감사 로그
    const auditLog: AuditLog = {
      event: 'memory.injected',
      sessionKey: input.sessionKey as string,
      userQuery,
      memoryIds: snippets.map((s) => s.id),
      rawScores: snippets.map((s) => s.rawScore),
      adjustedScores: snippets.map((s) => s.adjustedScore),
      mode,
      transactionSymbols: symbols,
      timestamp: now,
    };
    logger.info('memory.injected', auditLog as unknown as Record<string, unknown>);

    return { snippets, transactions, mode, auditLog };
  }
}
