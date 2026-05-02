// packages/server/src/auto-reply/__tests__/agent-memory-hook.storage.test.ts
import type { FinClawLogger } from '@finclaw/infra';
import {
  addAgentRun,
  getAgentRun,
  openDatabase,
  type Database,
  type EmbeddingProvider,
} from '@finclaw/storage';
import type { AgentId, SessionKey } from '@finclaw/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DefaultAttachMemoryService,
  MIN_MEMORY_OUTPUT_LENGTH,
  type AgentRunMemoryInput,
} from '../agent-memory-hook.js';

const DIMS = 1024;
const AGENT = 'agent-a' as AgentId;
const sessionKey = 'sess-1' as SessionKey;

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

/** 길이 > MIN_MEMORY_OUTPUT_LENGTH 보장하는 더미 본문. */
const LONG_OUTPUT = `AAPL 분석: ${'가'.repeat(120)}`;

function makeRun(database: Database, overrides: Partial<{ output: string; error: string }> = {}) {
  return addAgentRun(database.db, {
    agentId: AGENT,
    prompt: 'AAPL 분석해줘',
    output: overrides.output ?? LONG_OUTPUT,
    error: overrides.error,
  });
}

function inputFor(
  run: { id: string },
  overrides: Partial<AgentRunMemoryInput> = {},
): AgentRunMemoryInput {
  return {
    agentRunId: run.id,
    agentId: AGENT as string,
    prompt: 'AAPL 분석해줘',
    output: LONG_OUTPUT,
    sessionKey,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('DefaultAttachMemoryService — happy path', () => {
  let database: Database;
  let logger: FinClawLogger;

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
    logger = makeLogger();
  });

  afterEach(() => {
    database.close();
  });

  it('attach: output > 100 chars + no error → memoryId returned, agent_runs.memory_id linked, type=financial row exists', async () => {
    const run = makeRun(database);
    const service = new DefaultAttachMemoryService({ db: database.db, logger });

    const result = await service.attach(inputFor(run));

    expect('memoryId' in result).toBe(true);
    if (!('memoryId' in result)) {
      return;
    }
    const memoryId = result.memoryId;

    // agent_runs.memory_id 갱신 확인
    const runAfter = getAgentRun(database.db, run.id);
    expect(runAfter?.memoryId).toBe(memoryId);

    // memories 테이블에 type='financial' 행 존재
    const row = database.db
      .prepare('SELECT id, type, content FROM memories WHERE id = ?')
      .get(memoryId) as { id: string; type: string; content: string } | undefined;
    expect(row?.id).toBe(memoryId);
    expect(row?.type).toBe('financial');
    expect(row?.content).toBe(LONG_OUTPUT);
  });
});

describe('DefaultAttachMemoryService — skip policies', () => {
  let database: Database;
  let logger: FinClawLogger;

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
    logger = makeLogger();
  });

  afterEach(() => {
    database.close();
  });

  it('output too short → skipped: too-short, no memory row created, agent_runs.memory_id stays NULL', async () => {
    const run = makeRun(database, { output: 'OK' });
    const service = new DefaultAttachMemoryService({ db: database.db, logger });

    const result = await service.attach(inputFor(run, { output: 'OK' }));

    expect(result).toEqual({ skipped: 'too-short' });

    const memCount = (
      database.db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }
    ).c;
    expect(memCount).toBe(0);

    const runAfter = getAgentRun(database.db, run.id);
    expect(runAfter?.memoryId).toBeUndefined();
  });

  it('output exactly at MIN_MEMORY_OUTPUT_LENGTH → still skipped (boundary: <=)', async () => {
    const exact = 'a'.repeat(MIN_MEMORY_OUTPUT_LENGTH);
    const run = makeRun(database, { output: exact });
    const service = new DefaultAttachMemoryService({ db: database.db, logger });

    const result = await service.attach(inputFor(run, { output: exact }));
    expect(result).toEqual({ skipped: 'too-short' });
  });

  it('error present → skipped: has-error (even if output is long)', async () => {
    const run = makeRun(database, { error: 'boom' });
    const service = new DefaultAttachMemoryService({ db: database.db, logger });

    const result = await service.attach(inputFor(run, { error: 'boom' }));

    expect(result).toEqual({ skipped: 'has-error' });

    const memCount = (
      database.db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }
    ).c;
    expect(memCount).toBe(0);
  });
});

describe('DefaultAttachMemoryService — embedding fallback', () => {
  let database: Database;
  let logger: FinClawLogger;

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
    logger = makeLogger();
  });

  afterEach(() => {
    database.close();
  });

  it('embedding throws → falls back to addMemory (FTS-only) + warn, memoryId returned', async () => {
    const failingProvider = makeProvider({
      embedBatch: vi.fn().mockRejectedValue(new Error('quota exceeded')),
    });
    const run = makeRun(database);
    const service = new DefaultAttachMemoryService({
      db: database.db,
      embeddingProvider: failingProvider,
      logger,
    });

    const result = await service.attach(inputFor(run));

    expect('memoryId' in result).toBe(true);
    if (!('memoryId' in result)) {
      return;
    }
    // raw row 존재
    const row = database.db.prepare('SELECT id FROM memories WHERE id = ?').get(result.memoryId) as
      | { id: string }
      | undefined;
    expect(row?.id).toBe(result.memoryId);

    // warn 로그 확인
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('embedding failed'),
      expect.objectContaining({ event: 'agent.run.memory.embedding_failed' }),
    );

    // agent_runs.memory_id 링크 확인
    expect(getAgentRun(database.db, run.id)?.memoryId).toBe(result.memoryId);
  });

  it('embeddingProvider undefined → addMemory FTS-only path, memoryId returned', async () => {
    const run = makeRun(database);
    const service = new DefaultAttachMemoryService({ db: database.db, logger });

    const result = await service.attach(inputFor(run));

    expect('memoryId' in result).toBe(true);
    if (!('memoryId' in result)) {
      return;
    }
    const row = database.db.prepare('SELECT id FROM memories WHERE id = ?').get(result.memoryId) as
      | { id: string }
      | undefined;
    expect(row?.id).toBe(result.memoryId);

    expect(getAgentRun(database.db, run.id)?.memoryId).toBe(result.memoryId);
  });
});

describe('agent_runs ↔ memories — ON DELETE SET NULL via hook flow', () => {
  let database: Database;
  let logger: FinClawLogger;

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
    logger = makeLogger();
  });

  afterEach(() => {
    database.close();
  });

  it('attach → DELETE memory → agent_runs.memory_id becomes NULL (FK SET NULL)', async () => {
    const run = makeRun(database);
    const service = new DefaultAttachMemoryService({ db: database.db, logger });

    const result = await service.attach(inputFor(run));
    expect('memoryId' in result).toBe(true);
    if (!('memoryId' in result)) {
      return;
    }
    expect(getAgentRun(database.db, run.id)?.memoryId).toBe(result.memoryId);

    database.db.prepare('DELETE FROM memories WHERE id = ?').run(result.memoryId);

    const after = getAgentRun(database.db, run.id);
    expect(after).not.toBeNull();
    expect(after?.memoryId).toBeUndefined();
  });
});
