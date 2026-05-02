// packages/server/src/auto-reply/__tests__/agent-run-to-retrieval.boundary.storage.test.ts
//
// QA Phase 26 통합 검증 — e2e 시나리오 5: agent.run output → 다음 retrieval 에서 매칭.
//
// 흐름:
//   1) agent_runs 에 row 추가 (output: AAPL 분석 결과, 100자 초과)
//   2) DefaultAttachMemoryService.attach 호출 → memoryId 반환,
//      memories 에 type='financial' 로 저장 + agent_runs.memory_id 링크
//   3) AAPL 거래 fixture 1건 추가 (symbol 기반 거래 동시 주입 검증)
//   4) DefaultMemoryRetrievalService.searchRelevant({"AAPL ..."}) 호출
//   5) snippets 에 attached memory 포함 + transactions 에 fixture 거래 포함 검증
//   6) formatBackgroundSection 이 양쪽 모두 system prompt 에 합성하는지 검증
//
// mock-only — embeddingProvider 미주입 → fts-only 경로.
import type { FinClawLogger } from '@finclaw/infra';
import {
  addAgentRun,
  addTransaction,
  getAgentRun,
  getMemory,
  openDatabase,
  type Database,
} from '@finclaw/storage';
import type { AgentId, CurrencyCode, SessionKey, TickerSymbol, Timestamp } from '@finclaw/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultAttachMemoryService } from '../agent-memory-hook.js';
import {
  DefaultMemoryRetrievalService,
  formatBackgroundSection,
} from '../stages/memory-retrieval.js';

const sessionKey = 'integration-session' as SessionKey;
const PORTFOLIO_ID = 'pf-int';

// FTS5 trigram tokenizer 가 인덱싱하려면 토큰 ≥3 codepoint.
// 한글 2글자 단어는 토큰 미생성 → 회수 불가. 따라서 충분히 긴 키워드 사용.
// 100자 초과 (MIN_MEMORY_OUTPUT_LENGTH=100) 보장.
const ANALYSIS_OUTPUT =
  'AAPL 분석 결과 정리: 현재 주가는 상승 여력이 있으나 PER 30 부담이 존재한다. ' +
  '분기별 실적 발표 후 재평가가 권장되며, 배당주 중심의 장기보유 전략과는 일부 상충된다. ' +
  '리밸런싱 시점에 비중 축소 후보로 고려할 것.';

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

function seedPortfolio(database: Database): void {
  database.db
    .prepare(
      "INSERT INTO portfolios (id, name, currency, updated_at) VALUES (?, 'Test', 'USD', 1700000000000)",
    )
    .run(PORTFOLIO_ID);
}

describe('boundary: agent.run output → attach → retrieval recall (e2e scenario 5)', () => {
  let database: Database;
  let logger: FinClawLogger;

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
    logger = makeLogger();
    seedPortfolio(database);
  });

  afterEach(() => {
    database.close();
  });

  it('attached agent.run memory + symbol-matched transaction are both injected into background section', async () => {
    // 1) agent.run row 영속화
    const run = addAgentRun(database.db, {
      agentId: 'analyst' as AgentId,
      prompt: 'AAPL 분석',
      output: ANALYSIS_OUTPUT,
      durationMs: 12_345,
      modelUsed: 'claude-opus-4-7',
    });

    expect(run.id).toBeTruthy();
    expect(run.memoryId).toBeUndefined(); // 아직 attach 전

    // 2) attach — embeddingProvider 미주입 → FTS-only 경로
    const attach = new DefaultAttachMemoryService({ db: database.db, logger });
    const result = await attach.attach({
      agentRunId: run.id,
      agentId: 'analyst',
      prompt: 'AAPL 분석',
      output: ANALYSIS_OUTPUT,
      sessionKey,
      createdAt: Date.now(),
    });

    // attach 결과 검증
    if ('skipped' in result) {
      throw new Error(`attach skipped unexpectedly: ${result.skipped}`);
    }
    expect(result.memoryId).toBeTruthy();

    // 2-a) memories 행 type='financial' 보존
    const mem = getMemory(database.db, result.memoryId);
    if (mem === null) {
      throw new Error('memories row missing after attach');
    }
    expect(mem.type).toBe('financial');
    expect(mem.content).toBe(ANALYSIS_OUTPUT);

    // 2-b) agent_runs.memory_id 링크
    const linkedRun = getAgentRun(database.db, run.id);
    if (linkedRun === null) {
      throw new Error('agent_runs row missing after attach');
    }
    expect(linkedRun.memoryId).toBe(result.memoryId);

    // 3) AAPL 거래 fixture — symbol 기반 거래 동시 주입 검증용
    const tx = addTransaction(database.db, {
      portfolioId: PORTFOLIO_ID,
      symbol: 'AAPL' as TickerSymbol,
      action: 'buy',
      quantity: 10,
      price: 180,
      fee: 0,
      currency: 'USD' as CurrencyCode,
      executedAt: 1_710_000_000_000 as Timestamp,
      source: 'manual',
    });
    expect(tx.id).toBeTruthy();

    // 4) retrieval — 동일 DB, embeddingProvider 미주입 → fts-only
    // FTS buildFtsQuery 는 공백 분리한 모든 토큰을 AND 매칭한다.
    // 따라서 query 의 모든 토큰이 본문에 등장해야 매칭 + score = 1/(1+|BM25rank|)
    // 가 SIMILARITY_THRESHOLD(0.65) 를 넘는다.
    // userQuery 에 'AAPL' (대문자) 포함 → extractSymbols ['AAPL'] → listTransactions 동시 주입.
    // 본문에 '분기별' '리밸런싱' (≥3 codepoint) 포함 → FTS trigram 매칭 성공.
    const retrieval = new DefaultMemoryRetrievalService({ db: database.db, logger });
    const ret = await retrieval.searchRelevant({
      userQuery: 'AAPL 분기별 리밸런싱',
      sessionKey,
    });

    expect(ret.mode).toBe('fts-only');

    // 5-a) snippets 에 attached memory 포함 — 핵심 회수 검증
    expect(ret.snippets.length).toBeGreaterThanOrEqual(1);
    const attachedId = result.memoryId;
    expect(ret.snippets.some((s) => s.id === attachedId)).toBe(true);
    const matched = ret.snippets.find((s) => s.id === attachedId);
    expect(matched?.type).toBe('financial');

    // 5-b) transactions 에 AAPL fixture 거래 포함 — 심볼 기반 동시 주입 검증
    expect(ret.transactions.length).toBeGreaterThanOrEqual(1);
    const aaplTx = ret.transactions.find((t) => t.symbol === 'AAPL');
    expect(aaplTx).toBeDefined();
    expect(aaplTx?.action).toBe('buy');
    expect(aaplTx?.quantity).toBe(10);
    expect(aaplTx?.price).toBe(180);

    // 5-c) auditLog 에 memoryIds + transactionSymbols 모두 기록
    expect(ret.auditLog.event).toBe('memory.injected');
    expect(ret.auditLog.memoryIds).toContain(attachedId);
    expect(ret.auditLog.transactionSymbols).toContain('AAPL');

    // 6) system prompt 섹션 합성 — 양쪽 모두 포함
    const section = formatBackgroundSection(ret);
    expect(section).toContain('## 사용자 배경지식 (자동 주입)');
    expect(section).toContain('[financial]');
    expect(section).toContain('## 최근 거래 (AAPL)');
    expect(section).toContain('매수 10주');
  });
});
