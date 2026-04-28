// packages/server/src/auto-reply/__tests__/memory-capture-retrieval.boundary.storage.test.ts
//
// QA 밀스톤 C — 경계면 통합 테스트.
// MemoryCaptureService 로 명시적 선언을 저장한 뒤, 동일 DB 에 대해
// MemoryRetrievalService.searchRelevant 가 그 항목을 회수하고
// formatBackgroundSection 이 비어있지 않은 섹션을 반환하는지 검증한다.
//
// mock-only — embeddingProvider 미주입 → FTS-only 경로로 동작.
import type { FinClawLogger } from '@finclaw/infra';
import type { Database } from '@finclaw/storage';
import { openDatabase } from '@finclaw/storage';
import type { SessionKey } from '@finclaw/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultMemoryCaptureService } from '../stages/memory-capture.js';
import {
  DefaultMemoryRetrievalService,
  formatBackgroundSection,
} from '../stages/memory-retrieval.js';

const sessionKey = 'boundary-session' as SessionKey;

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

describe('boundary: capture then retrieval injects the memory back into system prompt', () => {
  let database: Database;
  let logger: FinClawLogger;

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
    logger = makeLogger();
  });

  afterEach(() => {
    database.close();
  });

  it('captured "!finclaw remember" memory is recalled by the retrieval service (FTS-only path)', async () => {
    // 1. capture — embeddingProvider 미주입 → FTS-only 인덱싱
    // 주의: FTS5 trigram tokenizer 는 3 codepoint 이상의 토큰만 인덱싱한다.
    // 한국어 2글자 단어("분기")는 토큰 미생성 → 회수 불가.
    // 따라서 본 경계면 테스트는 3 char 이상 한글 키워드를 사용한다.
    const capture = new DefaultMemoryCaptureService({ db: database.db, logger });
    const captured = await capture.capture(
      '!finclaw remember 분기별 리밸런싱 전략을 사용한다',
      sessionKey,
    );

    expect(captured).not.toBeNull();
    expect(captured?.duplicate).toBe(false);
    expect(captured?.type).toBe('fact');
    expect(captured?.content).toBe('분기별 리밸런싱 전략을 사용한다');

    // 2. retrieval — 동일 DB, embeddingProvider 미주입 → fts-only 모드
    // 토큰 ['분기별','리밸런싱'] 둘 다 ≥3 codepoint, 둘 다 컨텐츠 substring.
    const retrieval = new DefaultMemoryRetrievalService({ db: database.db, logger });
    const result = await retrieval.searchRelevant({
      userQuery: '분기별 리밸런싱',
      sessionKey,
    });

    expect(result.mode).toBe('fts-only');
    // 회수된 항목 안에 captured.memoryId 가 있어야 한다
    expect(result.snippets.length).toBeGreaterThanOrEqual(1);
    const captureId = captured?.memoryId;
    expect(result.snippets.some((s) => s.id === captureId)).toBe(true);

    // 3. system prompt 섹션이 비어있지 않고 회수된 콘텐츠를 포함
    const section = formatBackgroundSection(result);
    expect(section).not.toBe('');
    expect(section).toContain('## 사용자 배경지식 (자동 주입)');
    expect(section).toContain('분기별 리밸런싱 전략을 사용한다');
    // type 라벨 ('fact' 또는 'preference') 확인
    expect(section).toMatch(/\[(fact|preference)\]/);
  });

  it('unrelated query ("오늘 날씨") yields empty section even when memories exist', async () => {
    const capture = new DefaultMemoryCaptureService({ db: database.db, logger });
    await capture.capture('!finclaw remember 분기별 리밸런싱 전략을 사용한다', sessionKey);

    const retrieval = new DefaultMemoryRetrievalService({ db: database.db, logger });
    const result = await retrieval.searchRelevant({
      userQuery: '오늘 날씨 어떤가요',
      sessionKey,
    });

    // FTS 매칭 0 → snippets 0, transactions 0 (심볼 없음) → 섹션 빈 문자열
    expect(result.snippets).toHaveLength(0);
    expect(result.transactions).toHaveLength(0);
    expect(formatBackgroundSection(result)).toBe('');
  });
});
