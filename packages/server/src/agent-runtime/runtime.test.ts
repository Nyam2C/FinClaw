// packages/server/src/agent-runtime/runtime.test.ts
// Phase 46 M2: AgentRuntime — 바인딩·resume·회전·recap·1회 재시도·정확히 1 종료·직렬화·상한·감사·oneShot·reset.
import type {
  AgentDriver,
  AgentErrorReason,
  AgentEvent,
  AgentRunRequest,
  DriverRequest,
} from '@finclaw/agent';
import type { FinClawLogger } from '@finclaw/infra';
import { createStorage, getAgentRun, type FinClawStorage } from '@finclaw/storage';
import { createAgentId, createSessionKey } from '@finclaw/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryCaptureService } from '../auto-reply/stages/memory-capture.js';
import type {
  MemoryRetrievalService,
  RetrievalResult,
} from '../auto-reply/stages/memory-retrieval.js';
import { AgentRuntime, type AgentRuntimeDeps } from './runtime.js';

const AGENT = createAgentId('default');
const T0 = Date.UTC(2026, 10, 26, 1, 0, 0);
const HOUR = 60 * 60_000;
const USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
  flush: vi.fn(),
} as unknown as FinClawLogger;

const cliId = (req: DriverRequest): string =>
  req.session.kind === 'none' ? 'ephemeral-session' : req.session.id;

function ok(req: DriverRequest, text = 'ok', middle: AgentEvent[] = []): AgentEvent[] {
  return [
    { type: 'start', runId: req.runId, cliSessionId: cliId(req), model: 'claude-sonnet-4-6' },
    ...middle,
    {
      type: 'done',
      runId: req.runId,
      cliSessionId: cliId(req),
      text,
      usage: USAGE,
      durationMs: 1,
      numTurns: 1,
    },
  ];
}

const err = (req: DriverRequest, reason: AgentErrorReason): AgentEvent[] => [
  { type: 'error', runId: req.runId, reason, message: reason },
];

function scripted(script: (req: DriverRequest, n: number) => AgentEvent[] | Promise<AgentEvent[]>) {
  const calls: DriverRequest[] = [];
  const driver: AgentDriver = async function* (req) {
    calls.push(req);
    for (const ev of await script(req, calls.length)) {
      yield ev;
    }
  };
  return { driver, calls };
}

function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of events) {
    out.push(ev);
  }
  return out;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const terminals = (events: AgentEvent[]) =>
  events.filter((e) => e.type === 'done' || e.type === 'error');
const sessionId = (req: DriverRequest | undefined): string | undefined =>
  req && req.session.kind !== 'none' ? req.session.id : undefined;

function retrievalOf(id: string, content: string): MemoryRetrievalService {
  const result: RetrievalResult = {
    snippets: [
      {
        id,
        content,
        type: 'preference',
        createdAt: T0 - HOUR,
        rawScore: 0.8,
        adjustedScore: 0.8,
        daysOld: 1,
      },
    ],
    transactions: [],
    mode: 'fts-only',
    auditLog: {
      event: 'memory.injected',
      sessionKey: 's1',
      userQuery: 'q',
      memoryIds: [id],
      rawScores: [0.8],
      adjustedScores: [0.8],
      mode: 'fts-only',
      transactionSymbols: [],
      timestamp: T0,
    },
  };
  return { searchRelevant: vi.fn().mockResolvedValue(result) };
}

let storage: FinClawStorage;
let clock: number;

beforeEach(() => {
  storage = createStorage({ dbPath: ':memory:', enableWAL: false });
  clock = T0;
});

afterEach(async () => {
  await storage.close();
});

function makeRuntime(driver: AgentDriver, overrides: Partial<AgentRuntimeDeps> = {}): AgentRuntime {
  return new AgentRuntime({
    driver,
    storage,
    db: storage.db,
    systemPrompt: 'SYS',
    defaultModel: 'claude-sonnet-4-6',
    mcp: { url: 'http://127.0.0.1:0/mcp', mintToken: (sk) => `jwt:${sk}` },
    logger,
    now: () => clock,
    ...overrides,
  });
}

function chat(key: string, input: string, extra: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    sessionKey: createSessionKey(key),
    agentId: AGENT,
    input,
    mode: 'chat',
    signal: new AbortController().signal,
    ...extra,
  };
}

describe('AgentRuntime — CLI 세션 바인딩', () => {
  it('첫 턴: new(선지정 uuid) + 바인딩·원문·응답 저장 + per-run JWT(sessionKey)', async () => {
    const { driver, calls } = scripted((req) => ok(req, '반가워'));
    const events = await collect(makeRuntime(driver).run(chat('s1', '안녕')));
    expect(calls[0]?.session.kind).toBe('new');
    expect(calls[0]?.mcp).toEqual({ url: 'http://127.0.0.1:0/mcp', token: 'jwt:s1' });
    expect(calls[0]).toMatchObject({
      maxTurns: 10,
      autocompact: true,
      idleTimeoutMs: 120_000,
      overallTimeoutMs: 300_000,
    });
    expect(terminals(events)).toEqual([expect.objectContaining({ type: 'done', text: '반가워' })]);
    const rec = await storage.getConversation(createSessionKey('s1'));
    expect(rec?.metadata).toEqual({ cliSessionId: sessionId(calls[0]), lastTurnAt: T0 });
    expect(rec?.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', '안녕'],
      ['assistant', '반가워'],
    ]);
  });

  it('B1 회귀: 2턴째는 같은 세션 resume 이고 prompt 에 <context>·배경지식이 들어간다', async () => {
    const { driver, calls } = scripted((req) => ok(req));
    const rt = makeRuntime(driver, {
      retrieval: retrievalOf('abcdef12-0000-4000-8000-000000000000', '나는 배당주를 선호한다'),
    });
    await collect(rt.run(chat('s1', '첫 질문')));
    clock += HOUR;
    await collect(rt.run(chat('s1', '내 투자 선호 알려줘')));
    expect(calls[1]?.session).toEqual({ kind: 'resume', id: sessionId(calls[0]) });
    expect(calls[1]?.prompt).toContain('<context>');
    expect(calls[1]?.prompt).toContain('## 사용자 배경지식 (자동 주입)');
    expect(calls[1]?.prompt).toContain('[mem:abcdef]');
    expect(calls[1]?.prompt).not.toContain('<recent_conversation>');
    expect(calls[1]?.prompt.endsWith('내 투자 선호 알려줘')).toBe(true);
  });

  it('6h 유휴 → 새 세션 + <recent_conversation> recap', async () => {
    const { driver, calls } = scripted((req, n) => ok(req, n === 1 ? '반가워 자두' : 'ok'));
    const rt = makeRuntime(driver);
    await collect(rt.run(chat('s1', '내 이름은 자두야')));
    clock += 6 * HOUR + 1;
    await collect(rt.run(chat('s1', '내 이름이 뭐지?')));
    expect(calls[1]?.session.kind).toBe('new');
    expect(sessionId(calls[1])).not.toBe(sessionId(calls[0]));
    expect(calls[1]?.prompt).toContain(
      '<recent_conversation>\n사용자: 내 이름은 자두야\nFinClaw: 반가워 자두\n</recent_conversation>',
    );
  });

  it('session_not_found → 새 세션 + recap 으로 1회 재시도, 종료 이벤트 1개, 바인딩 교체', async () => {
    const { driver, calls } = scripted((req, n) =>
      n === 2 ? err(req, 'session_not_found') : ok(req),
    );
    const rt = makeRuntime(driver);
    await collect(rt.run(chat('s1', '첫 질문')));
    const events = await collect(rt.run(chat('s1', '둘째 질문')));
    expect(calls.map((c) => c.session.kind)).toEqual(['new', 'resume', 'new']);
    expect(calls[2]?.prompt).toContain('<recent_conversation>');
    expect(terminals(events)).toEqual([expect.objectContaining({ type: 'done' })]);
    const rec = await storage.getConversation(createSessionKey('s1'));
    expect(rec?.metadata?.cliSessionId).toBe(sessionId(calls[2]));
  });

  it('session_not_found 가 아닌 reason 은 재시도하지 않는다', async () => {
    const { driver, calls } = scripted((req, n) => (n === 2 ? err(req, 'rate_limit') : ok(req)));
    const rt = makeRuntime(driver);
    await collect(rt.run(chat('s1', '첫 질문')));
    const events = await collect(rt.run(chat('s1', '둘째 질문')));
    expect(calls).toHaveLength(2);
    expect(terminals(events)).toEqual([
      expect.objectContaining({ type: 'error', reason: 'rate_limit' }),
    ]);
  });

  it('error 턴: 원문만 남기고, start 가 없었으면 바인딩은 그대로', async () => {
    const { driver, calls } = scripted((req, n) => (n === 2 ? err(req, 'spawn') : ok(req, 'a1')));
    const rt = makeRuntime(driver);
    await collect(rt.run(chat('s1', 'q1')));
    clock += HOUR;
    await collect(rt.run(chat('s1', 'q2')));
    const rec = await storage.getConversation(createSessionKey('s1'));
    expect(rec?.messages.map((m) => m.content)).toEqual(['q1', 'a1', 'q2']);
    expect(rec?.metadata).toEqual({ cliSessionId: sessionId(calls[0]), lastTurnAt: T0 });
  });
});

describe('AgentRuntime — 정확히 1 종료 (I11)', () => {
  it('드라이버 throw → error{unknown} 1개', async () => {
    const { driver } = scripted(() => {
      throw new Error('boom');
    });
    const events = await collect(makeRuntime(driver).run(chat('s1', 'q')));
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', reason: 'unknown', message: 'boom' }),
    ]);
  });

  it('이미 abort 된 signal → error{aborted}, 드라이버 호출 0', async () => {
    const { driver, calls } = scripted((req) => ok(req));
    const ac = new AbortController();
    ac.abort();
    const events = await collect(makeRuntime(driver).run(chat('s1', 'q', { signal: ac.signal })));
    expect(events).toEqual([expect.objectContaining({ type: 'error', reason: 'aborted' })]);
    expect(calls).toHaveLength(0);
  });

  it('전역 lane 대기 타임아웃 → error{timeout} 1개', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const g = gate();
    const { driver, calls } = scripted(async (req) => {
      await g.opened;
      return ok(req);
    });
    const rt = makeRuntime(driver);
    const a = collect(rt.run(chat('a', 'q')));
    const b = collect(rt.run(chat('b', 'q')));
    await settle();
    expect(calls).toHaveLength(2);
    const c = collect(rt.run(chat('c', 'q')));
    await settle();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(terminals(await c)).toEqual([
      expect.objectContaining({ type: 'error', reason: 'timeout' }),
    ]);
    g.open();
    await Promise.all([a, b]);
  });

  it('abortAll() → 진행 중 run 의 드라이버 signal 이 abort 된다', async () => {
    const { driver } = scripted(async (req) => {
      await new Promise((resolve) => req.signal.addEventListener('abort', resolve, { once: true }));
      return err(req, 'aborted');
    });
    const rt = makeRuntime(driver);
    const pending = collect(rt.run(chat('s1', 'q')));
    await settle();
    void rt.abortAll();
    expect(terminals(await pending)).toEqual([expect.objectContaining({ reason: 'aborted' })]);
  });

  it('abortAll() 은 진행 중 run 의 agent_runs 기록까지 기다린다 (종료 시 감사 행 보존)', async () => {
    const { driver } = scripted(async (req) => {
      await new Promise((resolve) => req.signal.addEventListener('abort', resolve, { once: true }));
      return err(req, 'aborted');
    });
    const rt = makeRuntime(driver);
    const pending = collect(rt.run(chat('s1', 'q', { runId: 'run-shutdown' })));
    await settle();
    await rt.abortAll();
    expect(getAgentRun(storage.db, 'run-shutdown')).toMatchObject({ error: 'aborted: aborted' });
    await pending;
  });
});

describe('AgentRuntime — 동시성 (D6)', () => {
  it('같은 sessionKey 는 직렬화된다 (둘째는 첫째의 바인딩으로 resume)', async () => {
    const g = gate();
    const { driver, calls } = scripted(async (req) => {
      await g.opened;
      return ok(req);
    });
    const rt = makeRuntime(driver);
    const first = collect(rt.run(chat('s1', 'q1')));
    const second = collect(rt.run(chat('s1', 'q2')));
    await settle();
    expect(calls).toHaveLength(1);
    g.open();
    await Promise.all([first, second]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.session).toEqual({ kind: 'resume', id: sessionId(calls[0]) });
  });

  it('전역 상한 2 — 3번째는 앞 run 이 끝날 때까지 대기', async () => {
    const g = gate();
    const { driver, calls } = scripted(async (req) => {
      await g.opened;
      return ok(req);
    });
    const rt = makeRuntime(driver);
    const runs = ['a', 'b', 'c'].map((k) => collect(rt.run(chat(k, 'q'))));
    await settle();
    expect(calls).toHaveLength(2);
    g.open();
    await Promise.all(runs);
    expect(calls).toHaveLength(3);
  });

  it('Q14: reset 은 진행 중 run 의 종료 기록 뒤에 실행되어 바인딩이 되살아나지 않는다', async () => {
    const g = gate();
    const { driver } = scripted(async (req) => {
      await g.opened;
      return ok(req);
    });
    const rt = makeRuntime(driver);
    const run = collect(rt.run(chat('s1', 'q')));
    await settle();
    const reset = rt.reset(createSessionKey('s1'));
    await settle();
    g.open();
    await run;
    expect(await reset).toBe(true); // run 이 만든 행을 지웠다 = run 뒤에 실행됨
    expect(await storage.getConversation(createSessionKey('s1'))).toBeNull();
  });
});

describe('AgentRuntime — 감사 · oneShot', () => {
  it('init 에 model 이 없으면(start.model 빈 문자열) model_used 는 기본 모델', async () => {
    const { driver } = scripted((req) => [
      { type: 'start', runId: req.runId, cliSessionId: cliId(req), model: '' },
      ...ok(req).slice(1),
    ]);
    await collect(makeRuntime(driver).run(chat('s1', 'q', { runId: 'run-nomodel' })));
    expect(getAgentRun(storage.db, 'run-nomodel')?.modelUsed).toBe('claude-sonnet-4-6');
  });

  it('agent_runs 1행(id=runId·tool_calls·used_memory_ids·cli_session_id)이 종료 이벤트 yield 전에 존재', async () => {
    const memId = 'abcdef12-0000-4000-8000-000000000000';
    const { driver, calls } = scripted((req) =>
      ok(req, '선호는 배당주 [mem:abcdef]', [
        {
          type: 'tool_use',
          id: 't1',
          name: 'mcp__finclaw__route_task',
          input: { intent: 'price_lookup' },
        },
        { type: 'tool_result', id: 't1', isError: false },
      ]),
    );
    const rt = makeRuntime(driver, { retrieval: retrievalOf(memId, '나는 배당주를 선호한다') });
    let checked = false;
    for await (const ev of rt.run(chat('s1', 'q', { runId: 'run-xyz' }))) {
      if (ev.type === 'done') {
        const row = getAgentRun(storage.db, 'run-xyz');
        expect(row).not.toBeNull();
        expect(JSON.parse(row?.toolCalls ?? '[]')).toEqual([
          {
            id: 't1',
            name: 'mcp__finclaw__route_task',
            input: { intent: 'price_lookup' },
            isError: false,
          },
        ]);
        expect(row?.usedMemoryIds).toEqual([memId]);
        expect(row?.cliSessionId).toBe(sessionId(calls[0]));
        expect(row?.tokensInput).toBe(10);
        expect(ev.usedMemoryIds).toEqual([memId]);
        checked = true;
      }
    }
    expect(checked).toBe(true);
    const count = storage.db.prepare('SELECT COUNT(*) AS c FROM agent_runs').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('capture 결과가 done.captured 로 붙는다', async () => {
    const captured = {
      memoryId: 'm-1',
      type: 'preference' as const,
      content: '배당주',
      duplicate: false,
    };
    const capture: MemoryCaptureService = { capture: vi.fn().mockResolvedValue(captured) };
    const { driver } = scripted((req) => ok(req));
    const events = await collect(makeRuntime(driver, { capture }).run(chat('s1', '선호: 배당주')));
    expect(events.at(-1)).toMatchObject({ type: 'done', captured });
  });

  it('oneShot: 대화 조회·저장 0, session none, <context> 시각만, autocompact 없음, MCP 는 붙음', async () => {
    const get = vi.spyOn(storage, 'getConversation');
    const upsert = vi.spyOn(storage, 'upsertConversation');
    const capture: MemoryCaptureService = { capture: vi.fn() };
    const retrieval = retrievalOf('abcdef12-0000-4000-8000-000000000000', 'x');
    const { driver, calls } = scripted((req) => ok(req, '리포트'));
    const events = await collect(
      makeRuntime(driver, { capture, retrieval }).run({
        sessionKey: createSessionKey('schedule-1-abc'),
        agentId: AGENT,
        input: '오늘 시장 요약',
        mode: 'oneShot',
        signal: new AbortController().signal,
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: 'done', text: '리포트' });
    expect(calls[0]?.session).toEqual({ kind: 'none' });
    expect(calls[0]?.prompt).toBe(
      '<context>\n현재 시각: 2026-11-26T10:00:00+09:00 (Asia/Seoul)\n</context>\n\n오늘 시장 요약',
    );
    expect(calls[0]?.autocompact).toBe(false);
    expect(calls[0]?.mcp?.token).toBe('jwt:schedule-1-abc');
    expect(get).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(capture.capture).not.toHaveBeenCalled();
    expect(retrieval.searchRelevant).not.toHaveBeenCalled();
  });
});
