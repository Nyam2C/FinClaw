// packages/server/src/auto-reply/__tests__/memory-capture.storage.test.ts
import type { FinClawLogger } from '@finclaw/infra';
import type { Database, EmbeddingProvider } from '@finclaw/storage';
import { openDatabase } from '@finclaw/storage';
import type { SessionKey } from '@finclaw/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DefaultMemoryCaptureService,
  memoryCaptureStage,
  type MemoryCaptureService,
} from '../stages/memory-capture.js';

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

function makeProvider(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    id: 'mock',
    model: 'mock-1024',
    dimensions: DIMS,
    async embedQuery() {
      return Array.from({ length: DIMS }, () => 0.01);
    },
    async embedBatch(texts) {
      return texts.map(() => Array.from({ length: DIMS }, () => 0.01));
    },
    ...overrides,
  };
}

describe('DefaultMemoryCaptureService — pattern matching', () => {
  let database: Database;
  let logger: FinClawLogger;

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
    logger = makeLogger();
  });

  afterEach(() => {
    database.close();
  });

  it.each<[string, 'fact' | 'preference', string]>([
    ['기억해: 분기별 리밸런싱한다', 'fact', '분기별 리밸런싱한다'],
    ['메모: 12월 세금 손실 매도', 'fact', '12월 세금 손실 매도'],
    ['선호: 장기 보유 중심', 'preference', '장기 보유 중심'],
    ['내 투자 원칙은 배당주 중심', 'preference', '배당주 중심'],
    ['내 기준은 PER 15 이하만 매수', 'preference', 'PER 15 이하만 매수'],
    ['!finclaw remember 1년 한 번 점검한다', 'fact', '1년 한 번 점검한다'],
  ])('captures "%s" as %s', async (text, expectedType, expectedContent) => {
    const service = new DefaultMemoryCaptureService({ db: database.db, logger });
    const result = await service.capture(text, sessionKey);
    expect(result).not.toBeNull();
    expect(result?.type).toBe(expectedType);
    expect(result?.content).toBe(expectedContent);
    expect(result?.duplicate).toBe(false);
  });

  it('returns null for non-matching text', async () => {
    const service = new DefaultMemoryCaptureService({ db: database.db, logger });
    const result = await service.capture('오늘 점심 뭐 먹지', sessionKey);
    expect(result).toBeNull();
  });

  it('returns null when content is too short (< 3 chars)', async () => {
    const service = new DefaultMemoryCaptureService({ db: database.db, logger });
    const result = await service.capture('기억해: a', sessionKey);
    expect(result).toBeNull();
  });

  it('returns null when no patterns match an empty memo', async () => {
    const service = new DefaultMemoryCaptureService({ db: database.db, logger });
    const result = await service.capture('', sessionKey);
    expect(result).toBeNull();
  });

  it('uses first matching pattern only (priority order)', async () => {
    // "기억해: 내 원칙은 X" — "기억해" 패턴이 먼저 매칭, type=fact
    const service = new DefaultMemoryCaptureService({ db: database.db, logger });
    const result = await service.capture('기억해: 내 원칙은 가치 투자', sessionKey);
    expect(result?.type).toBe('fact');
    expect(result?.content).toBe('내 원칙은 가치 투자');
  });
});

describe('DefaultMemoryCaptureService — dedup', () => {
  let database: Database;
  let logger: FinClawLogger;

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
    logger = makeLogger();
  });

  afterEach(() => {
    database.close();
  });

  it('returns existing memoryId on duplicate hash and marks duplicate=true', async () => {
    const service = new DefaultMemoryCaptureService({ db: database.db, logger });
    const first = await service.capture('기억해: 분기별 리밸런싱한다', sessionKey);
    const second = await service.capture('기억해: 분기별 리밸런싱한다', sessionKey);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second?.memoryId).toBe(first?.memoryId);
    expect(second?.duplicate).toBe(true);
    expect(first?.duplicate).toBe(false);
  });

  it('different content → different memoryIds', async () => {
    const service = new DefaultMemoryCaptureService({ db: database.db, logger });
    const a = await service.capture('기억해: 첫번째 메모', sessionKey);
    const b = await service.capture('기억해: 두번째 메모', sessionKey);
    expect(a?.memoryId).not.toBe(b?.memoryId);
    expect(a?.duplicate).toBe(false);
    expect(b?.duplicate).toBe(false);
  });
});

describe('DefaultMemoryCaptureService — embedding fallback', () => {
  let database: Database;
  let logger: FinClawLogger;

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
    logger = makeLogger();
  });

  afterEach(() => {
    database.close();
  });

  it('without embeddingProvider — saves via FTS-only addMemory path', async () => {
    const service = new DefaultMemoryCaptureService({ db: database.db, logger });
    const result = await service.capture('기억해: FTS 전용 저장', sessionKey);
    expect(result).not.toBeNull();
    if (!result) {
      return;
    }
    expect(result.duplicate).toBe(false);
    // memory row must exist
    const row = database.db.prepare('SELECT id FROM memories WHERE id = ?').get(result.memoryId) as
      | { id: string }
      | undefined;
    expect(row?.id).toBe(result.memoryId);
  });

  it('embedding throws — falls back to addMemory with warn log', async () => {
    const failingProvider = makeProvider({
      embedBatch: vi.fn().mockRejectedValue(new Error('quota exceeded')),
    });
    const service = new DefaultMemoryCaptureService({
      db: database.db,
      embeddingProvider: failingProvider,
      logger,
    });
    const result = await service.capture('기억해: 임베딩 실패해도 저장', sessionKey);
    expect(result).not.toBeNull();
    if (!result) {
      return;
    }
    expect(result.duplicate).toBe(false);
    // raw row must still exist
    const row = database.db.prepare('SELECT id FROM memories WHERE id = ?').get(result.memoryId) as
      | { id: string }
      | undefined;
    expect(row?.id).toBe(result.memoryId);
    // warn must have been called
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('embedding failed'),
      expect.objectContaining({ event: 'memory.capture.embedding_failed' }),
    );
  });

  it('with valid embeddingProvider — calls embedBatch', async () => {
    const provider = makeProvider();
    const embedSpy = vi.spyOn(provider, 'embedBatch');
    const service = new DefaultMemoryCaptureService({
      db: database.db,
      embeddingProvider: provider,
      logger,
    });
    const result = await service.capture('기억해: 임베딩 정상 동작', sessionKey);
    expect(result).not.toBeNull();
    expect(embedSpy).toHaveBeenCalledTimes(1);
  });
});

describe('memoryCaptureStage — wrapper', () => {
  it('returns null when service is undefined (no-op)', async () => {
    const logger = makeLogger();
    const result = await memoryCaptureStage('기억해: x', sessionKey, undefined, logger);
    expect(result).toBeNull();
  });

  it('suppresses errors thrown by service.capture', async () => {
    const logger = makeLogger();
    const failing: MemoryCaptureService = {
      capture: vi.fn().mockRejectedValue(new Error('unexpected')),
    };
    const result = await memoryCaptureStage('기억해: 무엇이든', sessionKey, failing, logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('memoryCaptureStage error'),
      expect.objectContaining({ event: 'memory.capture.stage_error' }),
    );
  });

  it('returns service result on success', async () => {
    const logger = makeLogger();
    const service: MemoryCaptureService = {
      capture: vi.fn().mockResolvedValue({
        memoryId: 'abc-123',
        type: 'fact',
        content: 'x',
        duplicate: false,
      }),
    };
    const result = await memoryCaptureStage('기억해: x', sessionKey, service, logger);
    expect(result?.memoryId).toBe('abc-123');
  });
});
