// packages/server/src/auto-reply/__tests__/trace.e2e.storage.test.ts
// Phase 30 A15: pipeline 한 번 실행 → spans 테이블 다수 기록 + agent_runs 와의 traceId 매칭.

import type { FinClawLogger } from '@finclaw/infra';
import { openDatabase } from '@finclaw/storage';
import {
  createAgentId,
  createChannelId,
  createSessionKey,
  createTimestamp,
  type ChannelPlugin,
  type MsgContext,
} from '@finclaw/types';
import { describe, expect, it, vi } from 'vitest';
import { createTracer } from '../../observability/tracer.js';
import type { BindingMatch } from '../../process/binding-matcher.js';
import { InMemoryCommandRegistry } from '../commands/registry.js';
import { MockExecutionAdapter } from '../execution-adapter.js';
import type { FinanceContextProvider } from '../pipeline-context.js';
import { AutoReplyPipeline } from '../pipeline.js';

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

function makeProvider(): FinanceContextProvider {
  return {
    getActiveAlerts: vi.fn().mockResolvedValue([]),
    getPortfolio: vi.fn().mockResolvedValue(null),
    getRecentNews: vi.fn().mockResolvedValue([]),
    getMarketSession: vi.fn().mockReturnValue({
      isOpen: true,
      market: 'NYSE',
      nextOpenAt: null,
      timezone: 'America/New_York',
    }),
    getWatchlist: vi.fn().mockResolvedValue([]),
  };
}

function makeChannel(): Pick<ChannelPlugin, 'send' | 'addReaction' | 'sendTyping'> {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
  };
}

function makeCtx(): MsgContext {
  return {
    body: 'hello',
    bodyForAgent: 'hello',
    rawBody: 'hello',
    from: 'user1',
    senderId: 'user1',
    senderName: 'User',
    provider: 'discord',
    channelId: createChannelId('discord'),
    chatType: 'direct',
    sessionKey: createSessionKey('test-session'),
    accountId: 'user1',
    timestamp: createTimestamp(Date.now()),
  };
}

function makeMatch(): BindingMatch {
  return {
    agentId: createAgentId('default'),
    rule: { agentId: createAgentId('default'), priority: 0 },
    matchTier: 'default',
  };
}

describe('Phase 30 A15 — pipeline produces span tree', () => {
  it('records >=6 spans (root + 6 stage spans) for a normal Discord message', async () => {
    const db = openDatabase({ path: ':memory:', enableWAL: false });
    const tracer = createTracer({ db: db.db });

    const channel = makeChannel();
    const pipeline = new AutoReplyPipeline(
      {
        enableAck: true,
        commandPrefix: '/',
        maxResponseLength: 2000,
        timeoutMs: 10_000,
        respectMarketHours: false,
      },
      {
        executionAdapter: new MockExecutionAdapter('AI response'),
        financeContextProvider: makeProvider(),
        commandRegistry: new InMemoryCommandRegistry(),
        logger: makeLogger(),
        getChannel: () => channel,
        tracer,
      },
    );

    await pipeline.process(makeCtx(), makeMatch(), AbortSignal.timeout(10_000));

    const rows = db.db.prepare('SELECT trace_id, name FROM spans').all() as Array<{
      trace_id: string;
      name: string;
    }>;
    expect(rows.length).toBeGreaterThanOrEqual(7); // root + 6 stage spans (no memory-capture/retrieval)
    const allSameTrace = rows.every((r) => r.trace_id === rows[0]?.trace_id);
    expect(allSameTrace).toBe(true);
    const names = rows.map((r) => r.name);
    expect(names).toContain('pipeline.process');
    expect(names).toContain('stage.normalize');
    expect(names).toContain('stage.command');
    expect(names).toContain('stage.ack');
    expect(names).toContain('stage.context');
    expect(names).toContain('stage.execute');
    expect(names).toContain('stage.deliver');
  });
});
