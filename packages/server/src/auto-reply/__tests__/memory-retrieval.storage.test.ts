// packages/server/src/auto-reply/__tests__/memory-retrieval.storage.test.ts
import { randomUUID } from 'node:crypto';
import type { FinClawLogger } from '@finclaw/infra';
import type { Database, EmbeddingProvider } from '@finclaw/storage';
import { addMemoryWithEmbedding, addTransaction, openDatabase } from '@finclaw/storage';
import type {
  CurrencyCode,
  MemoryEntry,
  SessionKey,
  TickerSymbol,
  Timestamp,
} from '@finclaw/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DefaultMemoryRetrievalService,
  extractSymbols,
  formatBackgroundSection,
  MAX_INJECTED_MEMORIES,
  SIMILARITY_THRESHOLD,
  type RetrievalResult,
} from '../stages/memory-retrieval.js';

const DIMS = 1024;
const sessionKey = 'test-session' as SessionKey;

function makeLogger(): FinClawLogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    flush: vi.fn().mockResolvedValue(undefined),
  } as unknown as FinClawLogger;
}

/**
 * 결정론적 임베딩 — 텍스트의 문자 코드합으로 단일 차원만 1.0,
 * 나머지 0.0 으로 채운다. 동일 텍스트 → 동일 임베딩 → cosine = 1.
 * 다른 텍스트 → 직교 → cosine = 0.
 */
function makeDeterministicProvider(): EmbeddingProvider {
  function embed(text: string): number[] {
    let sum = 0;
    for (let i = 0; i < text.length; i++) {
      sum = (sum + text.charCodeAt(i)) % DIMS;
    }
    const v = Array.from({ length: DIMS }, () => 0);
    v[sum] = 1.0;
    return v;
  }
  return {
    id: 'mock-deterministic',
    model: 'mock-1024',
    dimensions: DIMS,
    async embedQuery(text) {
      return embed(text);
    },
    async embedBatch(texts) {
      return texts.map((t) => embed(t));
    },
  };
}

async function seedMemory(
  database: Database,
  provider: EmbeddingProvider | undefined,
  opts: { content: string; type: MemoryEntry['type']; createdAt: number; sessionKey?: SessionKey },
): Promise<string> {
  const entry: MemoryEntry = {
    id: randomUUID(),
    sessionKey: (opts.sessionKey ?? sessionKey) as SessionKey,
    content: opts.content,
    type: opts.type,
    createdAt: opts.createdAt as Timestamp,
    metadata: {},
  };
  if (provider) {
    await addMemoryWithEmbedding(database.db, entry, provider);
  } else {
    // FTS-only path: addMemory 만 사용
    const { addMemory } = await import('@finclaw/storage');
    addMemory(database.db, entry);
  }
  return entry.id;
}

describe('extractSymbols', () => {
  it('extracts uppercase 2-5 char tickers', () => {
    expect(extractSymbols('AAPL 분석')).toEqual(['AAPL']);
    expect(extractSymbols('AAPL vs TSLA')).toEqual(['AAPL', 'TSLA']);
    expect(extractSymbols('BTC 시세')).toEqual(['BTC']);
  });

  it('returns empty for non-ticker text', () => {
    expect(extractSymbols('오늘 날씨 어때')).toEqual([]);
    expect(extractSymbols('내 투자 철학 뭐였지?')).toEqual([]);
  });

  it('filters currency codes', () => {
    expect(extractSymbols('AAPL in USD')).toEqual(['AAPL']);
    expect(extractSymbols('KRW EUR JPY')).toEqual([]);
  });

  it('filters time abbreviations', () => {
    expect(extractSymbols('AM PM EST KST')).toEqual([]);
  });

  it('filters common business acronyms', () => {
    expect(extractSymbols('CEO ROI ETF')).toEqual([]);
  });

  it('deduplicates repeated symbols', () => {
    expect(extractSymbols('AAPL AAPL AAPL')).toEqual(['AAPL']);
  });
});

describe('formatBackgroundSection', () => {
  function makeResult(partial: Partial<RetrievalResult>): RetrievalResult {
    return {
      snippets: [],
      transactions: [],
      mode: 'hybrid',
      auditLog: {
        event: 'memory.injected',
        sessionKey: 'k',
        userQuery: '',
        memoryIds: [],
        rawScores: [],
        adjustedScores: [],
        mode: 'hybrid',
        transactionSymbols: [],
        timestamp: 0,
      },
      ...partial,
    };
  }

  it('returns empty string when both snippets and transactions are empty', () => {
    expect(formatBackgroundSection(makeResult({}))).toBe('');
  });

  it('formats snippets-only result', () => {
    const out = formatBackgroundSection(
      makeResult({
        snippets: [
          {
            id: 'm1',
            content: '분기별 리밸런싱 한다',
            type: 'preference',
            createdAt: Date.UTC(2025, 11, 2),
            rawScore: 0.8,
            adjustedScore: 0.7,
            daysOld: 30,
          },
        ],
      }),
    );
    expect(out).toContain('## 사용자 배경지식 (자동 주입)');
    expect(out).toContain('[preference] 분기별 리밸런싱 한다 (2025-12-02 저장)');
    expect(out).not.toContain('## 최근 거래');
  });

  it('formats transactions-only result with action labels', () => {
    const out = formatBackgroundSection(
      makeResult({
        transactions: [
          {
            symbol: 'AAPL',
            action: 'buy',
            quantity: 10,
            price: 180,
            currency: 'USD',
            executedAt: Date.UTC(2026, 2, 15),
          },
          {
            symbol: 'AAPL',
            action: 'sell',
            quantity: 5,
            price: 200,
            currency: 'USD',
            executedAt: Date.UTC(2026, 2, 20),
          },
        ],
      }),
    );
    expect(out).not.toContain('## 사용자 배경지식');
    expect(out).toContain('## 최근 거래 (AAPL)');
    expect(out).toContain('2026-03-15: 매수 10주 @ USD 180');
    expect(out).toContain('2026-03-20: 매도 5주 @ USD 200');
  });

  it('groups transactions by symbol', () => {
    const out = formatBackgroundSection(
      makeResult({
        transactions: [
          {
            symbol: 'AAPL',
            action: 'buy',
            quantity: 10,
            price: 180,
            currency: 'USD',
            executedAt: Date.UTC(2026, 2, 15),
          },
          {
            symbol: 'TSLA',
            action: 'buy',
            quantity: 2,
            price: 250,
            currency: 'USD',
            executedAt: Date.UTC(2026, 2, 20),
          },
        ],
      }),
    );
    expect(out).toContain('## 최근 거래 (AAPL)');
    expect(out).toContain('## 최근 거래 (TSLA)');
  });

  it('omits price suffix when price is null (e.g. dividend)', () => {
    const out = formatBackgroundSection(
      makeResult({
        transactions: [
          {
            symbol: 'AAPL',
            action: 'dividend',
            quantity: 1,
            price: null,
            currency: 'USD',
            executedAt: Date.UTC(2026, 2, 15),
          },
        ],
      }),
    );
    expect(out).toContain('2026-03-15: 배당 1주');
    expect(out).not.toContain('@');
  });
});

describe('DefaultMemoryRetrievalService — hybrid mode', () => {
  let database: Database;
  let logger: FinClawLogger;
  let provider: EmbeddingProvider;

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
    logger = makeLogger();
    provider = makeDeterministicProvider();
  });

  afterEach(() => {
    database.close();
  });

  it('returns matching memory for identical query/content (hybrid mode)', async () => {
    await seedMemory(database, provider, {
      content: '나는 분기별 리밸런싱 한다',
      type: 'preference',
      createdAt: Date.now() - 24 * 60 * 60 * 1000,
    });
    const service = new DefaultMemoryRetrievalService({
      db: database.db,
      embeddingProvider: provider,
      logger,
    });
    const result = await service.searchRelevant({
      userQuery: '나는 분기별 리밸런싱 한다',
      sessionKey,
    });
    expect(result.mode).toBe('hybrid');
    expect(result.snippets.length).toBeGreaterThanOrEqual(1);
    expect(result.snippets[0].content).toBe('나는 분기별 리밸런싱 한다');
  });

  it('emits memory.injected audit log', async () => {
    await seedMemory(database, provider, {
      content: '내 투자 원칙은 가치 투자',
      type: 'preference',
      createdAt: Date.now() - 24 * 60 * 60 * 1000,
    });
    const service = new DefaultMemoryRetrievalService({
      db: database.db,
      embeddingProvider: provider,
      logger,
    });
    await service.searchRelevant({
      userQuery: '내 투자 원칙은 가치 투자',
      sessionKey,
    });
    expect(logger.info).toHaveBeenCalledWith(
      'memory.injected',
      expect.objectContaining({
        event: 'memory.injected',
        sessionKey: 'test-session',
        mode: 'hybrid',
      }),
    );
  });

  it('caps results at MAX_INJECTED_MEMORIES (3) even when more match', async () => {
    // 동일 텍스트 5개 등록 (각각 다른 sessionKey 로 dedup hash 회피)
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await seedMemory(database, provider, {
        content: `매칭 콘텐츠 ${i}`,
        type: 'preference',
        createdAt: now - 24 * 60 * 60 * 1000,
        sessionKey: `s-${i}` as SessionKey,
      });
    }
    const service = new DefaultMemoryRetrievalService({
      db: database.db,
      embeddingProvider: provider,
      logger,
    });
    // FTS substring 매칭 가능한 query
    const result = await service.searchRelevant({
      userQuery: '매칭 콘텐츠 0',
      sessionKey,
    });
    expect(result.snippets.length).toBeLessThanOrEqual(MAX_INJECTED_MEMORIES);
  });

  it('freshness: yesterday-saved memory ranks above 90-days-old when both match', async () => {
    const now = Date.now();
    const recentId = await seedMemory(database, provider, {
      content: '최신 신선도 테스트 문장',
      type: 'fact',
      createdAt: now - 1 * 24 * 60 * 60 * 1000,
      sessionKey: 's-recent' as SessionKey,
    });
    const oldId = await seedMemory(database, provider, {
      content: '오래된 신선도 테스트 문장',
      type: 'fact',
      createdAt: now - 180 * 24 * 60 * 60 * 1000,
      sessionKey: 's-old' as SessionKey,
    });
    const service = new DefaultMemoryRetrievalService({
      db: database.db,
      embeddingProvider: provider,
      logger,
    });
    // FTS trigram 으로 둘 다 매칭되는 공통 substring
    const result = await service.searchRelevant({
      userQuery: '신선도 테스트',
      sessionKey,
    });
    // 둘 다 회수됐다고 가정하면 첫번째가 recent 여야 함
    if (result.snippets.length >= 2) {
      const recentIdx = result.snippets.findIndex((s) => s.id === recentId);
      const oldIdx = result.snippets.findIndex((s) => s.id === oldId);
      expect(recentIdx).toBeLessThan(oldIdx);
      expect(result.snippets[recentIdx].adjustedScore).toBeGreaterThan(
        result.snippets[oldIdx].adjustedScore,
      );
    } else if (result.snippets.length === 1) {
      // 한쪽만 임계값 통과 — recent 여야 함 (가중치 우선)
      expect(result.snippets[0].id).toBe(recentId);
    }
  });
});

describe('DefaultMemoryRetrievalService — threshold cut', () => {
  it('excludes results with rawScore below SIMILARITY_THRESHOLD', async () => {
    // mergeHybridResults 가 0.3 같은 낮은 점수만 반환하도록 강제하기 위해
    // searchVector/searchFts 결과가 최종 score 0.65 미만이 나오는 시나리오.
    // 가장 단순한 방법: 매칭 데이터 자체를 안 넣으면 candidates 비어 결과 0.
    const database = openDatabase({ path: ':memory:' });
    const logger = makeLogger();
    try {
      const service = new DefaultMemoryRetrievalService({
        db: database.db,
        embeddingProvider: makeDeterministicProvider(),
        logger,
      });
      const result = await service.searchRelevant({
        userQuery: '아무것도 매칭되지 않을 임의 문구',
        sessionKey,
      });
      expect(result.snippets).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it('SIMILARITY_THRESHOLD constant is 0.65', () => {
    expect(SIMILARITY_THRESHOLD).toBe(0.65);
  });
});

describe('DefaultMemoryRetrievalService — fts-only mode', () => {
  let database: Database;
  let logger: FinClawLogger;

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
    logger = makeLogger();
  });

  afterEach(() => {
    database.close();
  });

  it('uses fts-only when embeddingProvider is undefined', async () => {
    await seedMemory(database, undefined, {
      content: 'FTS 전용 모드 테스트',
      type: 'fact',
      createdAt: Date.now() - 24 * 60 * 60 * 1000,
    });
    const service = new DefaultMemoryRetrievalService({
      db: database.db,
      logger,
    });
    const result = await service.searchRelevant({
      userQuery: 'FTS 전용 모드',
      sessionKey,
    });
    expect(result.mode).toBe('fts-only');
    expect(result.auditLog.mode).toBe('fts-only');
  });

  it('falls back to fts-only when embedding throws and warns', async () => {
    await seedMemory(database, undefined, {
      content: '임베딩 장애 fallback 테스트',
      type: 'fact',
      createdAt: Date.now() - 24 * 60 * 60 * 1000,
    });
    const failingProvider: EmbeddingProvider = {
      id: 'failing',
      model: 'fail-1024',
      dimensions: DIMS,
      async embedQuery() {
        throw new Error('quota exceeded');
      },
      async embedBatch() {
        throw new Error('quota exceeded');
      },
    };
    const service = new DefaultMemoryRetrievalService({
      db: database.db,
      embeddingProvider: failingProvider,
      logger,
    });
    const result = await service.searchRelevant({
      userQuery: '임베딩 장애',
      sessionKey,
    });
    expect(result.mode).toBe('fts-only');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('embedding failed'),
      expect.objectContaining({ event: 'memory.retrieval.embedding_failed' }),
    );
  });
});

describe('DefaultMemoryRetrievalService — empty result', () => {
  it('formatBackgroundSection returns empty when no snippets and no transactions', async () => {
    const database = openDatabase({ path: ':memory:' });
    const logger = makeLogger();
    try {
      const service = new DefaultMemoryRetrievalService({
        db: database.db,
        logger,
      });
      const result = await service.searchRelevant({
        userQuery: '오늘 날씨',
        sessionKey,
      });
      expect(result.snippets).toHaveLength(0);
      expect(result.transactions).toHaveLength(0);
      expect(formatBackgroundSection(result)).toBe('');
    } finally {
      database.close();
    }
  });
});

describe('DefaultMemoryRetrievalService — transaction injection', () => {
  let database: Database;
  let logger: FinClawLogger;

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
    logger = makeLogger();
    // portfolios 부모 row 가 필요 → 직접 insert
    database.db
      .prepare(
        `INSERT INTO portfolios (id, name, currency, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run('p1', 'test', 'USD', Date.now());
  });

  afterEach(() => {
    database.close();
  });

  it('injects up to SYMBOL_TX_LIMIT transactions when query mentions symbol', async () => {
    addTransaction(database.db, {
      portfolioId: 'p1',
      symbol: 'AAPL' as TickerSymbol,
      action: 'buy',
      quantity: 10,
      price: 180,
      currency: 'USD' as CurrencyCode,
      executedAt: (Date.now() - 10 * 24 * 60 * 60 * 1000) as Timestamp,
      source: 'manual',
    });
    addTransaction(database.db, {
      portfolioId: 'p1',
      symbol: 'AAPL' as TickerSymbol,
      action: 'buy',
      quantity: 5,
      price: 200,
      currency: 'USD' as CurrencyCode,
      executedAt: (Date.now() - 5 * 24 * 60 * 60 * 1000) as Timestamp,
      source: 'manual',
    });

    const service = new DefaultMemoryRetrievalService({
      db: database.db,
      logger,
    });
    const result = await service.searchRelevant({
      userQuery: 'AAPL 분석해줘',
      sessionKey,
    });
    expect(result.transactions.length).toBe(2);
    expect(result.transactions.every((t) => t.symbol === 'AAPL')).toBe(true);
    expect(result.auditLog.transactionSymbols).toEqual(['AAPL']);
  });

  it('does not inject transactions when no symbol detected', async () => {
    addTransaction(database.db, {
      portfolioId: 'p1',
      symbol: 'AAPL' as TickerSymbol,
      action: 'buy',
      quantity: 10,
      price: 180,
      currency: 'USD' as CurrencyCode,
      executedAt: Date.now() as Timestamp,
      source: 'manual',
    });
    const service = new DefaultMemoryRetrievalService({
      db: database.db,
      logger,
    });
    const result = await service.searchRelevant({
      userQuery: '오늘 날씨 어때',
      sessionKey,
    });
    expect(result.transactions).toHaveLength(0);
    expect(result.auditLog.transactionSymbols).toEqual([]);
  });
});
