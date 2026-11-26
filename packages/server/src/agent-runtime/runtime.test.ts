// packages/server/src/agent-runtime/runtime.test.ts
// AgentRuntime — 트랜스크립트(append-only)·컨텍스트 창 회전·recap·정확히 1 종료·직렬화·상한·감사·oneShot·reset.
import type {
  AgentDriver,
  AgentErrorReason,
  AgentEvent,
  AgentRunRequest,
  DriverRequest,
  TranscriptMessage,
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

const MODEL = 'claude-opus-5-5';

/** 루프가 내보내는 것과 같은 모양: start → [중간] → assistant 행 → done. */
function ok(req: DriverRequest, text = 'ok', middle: AgentEvent[] = []): AgentEvent[] {
  return [
    { type: 'start', runId: req.runId, model: req.model },
    ...middle,
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    { type: 'done', runId: req.runId, text, usage: USAGE, durationMs: 1, numTurns: 1 },
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
/** 드라이버가 받은 메시지를 [role, 텍스트] 로. */
const sent = (req: DriverRequest | undefined): [string, string][] =>
  (req?.messages ?? []).map((m) => [m.role, rowText(m)]);
const rowText = (m: Pick<TranscriptMessage, 'content'>): string =>
  typeof m.content === 'string'
    ? m.content
    : (m.content as readonly { text?: string }[]).map((b) => b.text ?? '').join('');
const stored = async (key: string): Promise<[string, string][]> =>
  ((await storage.getConversation(createSessionKey(key)))?.messages ?? []).map((m) => [
    m.role,
    rowText(m as TranscriptMessage),
  ]);
const CTX = '<context>\n현재 시각: 2026-11-26T10:00:00+09:00 (Asia/Seoul)\n</context>';

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
    defaultModel: MODEL,
    tools: { list: () => [], execute: vi.fn() },
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

describe('AgentRuntime — 트랜스크립트와 컨텍스트 창', () => {
  it('첫 턴: 컨텍스트·원문을 먼저 저장하고, 드라이버에 메시지·도구·상한을 넘긴다', async () => {
    const execute = vi.fn().mockResolvedValue({ content: '70000', isError: false });
    const tools = {
      list: () => [
        { definition: { name: 'get_quote', description: '시세', inputSchema: { type: 'object' } } },
      ],
      execute,
    } as unknown as AgentRuntimeDeps['tools'];
    let storedAtCall: [string, string][] = [];
    const { driver, calls } = scripted(async (req) => {
      storedAtCall = await stored('s1'); // 모델 호출 시점에 user 턴은 이미 저장돼 있다
      await req.runTool('get_quote', { symbols: ['005930'] }, req.signal);
      return ok(req, '반가워');
    });
    const events = await collect(makeRuntime(driver, { tools }).run(chat('s1', '안녕')));

    expect(storedAtCall).toEqual([
      ['system', CTX],
      ['user', '안녕'],
    ]);
    expect(sent(calls[0])).toEqual(storedAtCall);
    expect(calls[0]).toMatchObject({
      systemPrompt: 'SYS',
      model: MODEL,
      tools: [{ name: 'get_quote', description: '시세', inputSchema: { type: 'object' } }],
      maxTurns: 10,
      tokenBudget: 400_000,
      idleTimeoutMs: 120_000,
      overallTimeoutMs: 300_000,
    });
    expect(execute).toHaveBeenCalledWith(
      'get_quote',
      { symbols: ['005930'] },
      expect.objectContaining({ sessionId: 's1', userId: 'finclaw', channelId: 'agent' }),
    );
    // message 이벤트는 저장만 하고 채널로 내보내지 않는다
    expect(events.map((e) => e.type)).toEqual(['start', 'done']);
    expect(await stored('s1')).toEqual([
      ['system', CTX],
      ['user', '안녕'],
      ['assistant', '반가워'],
    ]);
    const rec = await storage.getConversation(createSessionKey('s1'));
    expect(rec?.metadata).toEqual({
      contextStart: 0,
      lastTurnAt: T0,
      model: MODEL,
      contextTokens: 10,
    });
  });

  it('2턴째는 같은 창을 이어 보내고, 컨텍스트 행에 배경지식이 들어간다 (recap 없음)', async () => {
    const { driver, calls } = scripted((req) => ok(req, 'a'));
    const rt = makeRuntime(driver, {
      retrieval: retrievalOf('abcdef12-0000-4000-8000-000000000000', '나는 배당주를 선호한다'),
    });
    await collect(rt.run(chat('s1', '첫 질문')));
    clock += HOUR;
    await collect(rt.run(chat('s1', '내 투자 선호 알려줘')));

    const second = sent(calls[1]);
    expect(second.map(([role]) => role)).toEqual(['system', 'user', 'assistant', 'system', 'user']);
    expect(second.slice(0, 3)).toEqual(sent(calls[0]).concat([['assistant', 'a']])); // 프리픽스 불변
    const context = second[3][1];
    expect(context).toContain('<context>');
    expect(context).toContain('## 사용자 배경지식 (자동 주입)');
    expect(context).toContain('[mem:abcdef]');
    expect(context).not.toContain('<recent_conversation>');
    expect(second[4]).toEqual(['user', '내 투자 선호 알려줘']);
  });

  it('6h 유휴 → 창을 새로 열고 직전 대화를 recap 으로 싣는다 (원문은 그대로 남는다)', async () => {
    const { driver, calls } = scripted((req, n) => ok(req, n === 1 ? '반가워 자두' : 'ok'));
    const rt = makeRuntime(driver);
    await collect(rt.run(chat('s1', '내 이름은 자두야')));
    clock += 6 * HOUR + 1;
    await collect(rt.run(chat('s1', '내 이름이 뭐지?')));

    const second = sent(calls[1]);
    expect(second.map(([role]) => role)).toEqual(['system', 'user']);
    expect(second[0][1]).toContain(
      '<recent_conversation>\n사용자: 내 이름은 자두야\nFinClaw: 반가워 자두\n</recent_conversation>',
    );
    expect(await stored('s1')).toHaveLength(6); // 1턴 3행 + 2턴 3행
    const rec = await storage.getConversation(createSessionKey('s1'));
    expect(rec?.metadata?.contextStart).toBe(3);
  });

  it('모델이 바뀌면 창을 회전한다 (thinking 블록은 만든 모델에서만 유효)', async () => {
    const { driver, calls } = scripted((req) => ok(req));
    const rt = makeRuntime(driver);
    await collect(rt.run(chat('s1', 'q1')));
    await collect(rt.run(chat('s1', 'q2', { model: 'claude-sonnet-5-5' })));
    expect(sent(calls[1]).map(([role]) => role)).toEqual(['system', 'user']);
    expect(calls[1]?.model).toBe('claude-sonnet-5-5');
  });

  it('직전 run 의 입력이 15만 토큰을 넘었으면 회전한다', async () => {
    const big = { input: 1_000, output: 5, cacheRead: 200_000, cacheWrite: 0 };
    const { driver, calls } = scripted((req, n) =>
      n === 1
        ? [...ok(req).slice(0, -1), { ...(ok(req).at(-1) as AgentEvent), usage: big } as AgentEvent]
        : ok(req),
    );
    const rt = makeRuntime(driver);
    await collect(rt.run(chat('s1', 'q1')));
    await collect(rt.run(chat('s1', 'q2')));
    expect(sent(calls[1]).map(([role]) => role)).toEqual(['system', 'user']);
  });

  it('context_overflow 로 끝난 다음 턴은 회전한다', async () => {
    const { driver, calls } = scripted((req, n) =>
      n === 2 ? err(req, 'context_overflow') : ok(req),
    );
    const rt = makeRuntime(driver);
    await collect(rt.run(chat('s1', 'q1')));
    await collect(rt.run(chat('s1', 'q2')));
    await collect(rt.run(chat('s1', 'q3')));
    expect(sent(calls[2]).map(([role]) => role)).toEqual(['system', 'user']);
  });

  it('예전(CLI 시절) 텍스트 대화는 첫 턴에 회전하고 recap 으로 이어받는다', async () => {
    await storage.appendMessages({
      sessionKey: createSessionKey('s1'),
      agentId: AGENT,
      messages: [
        { role: 'user', content: '예전 질문' },
        { role: 'assistant', content: '예전 답' },
      ],
      at: (T0 - HOUR) as never,
      metadata: { cliSessionId: 'old-cli-session', lastTurnAt: T0 - HOUR },
    });
    const { driver, calls } = scripted((req) => ok(req));
    await collect(makeRuntime(driver).run(chat('s1', '새 질문')));
    const first = sent(calls[0]);
    expect(first.map(([role]) => role)).toEqual(['system', 'user']);
    expect(first[0][1]).toContain('사용자: 예전 질문\nFinClaw: 예전 답');
  });

  it('중단으로 결과 없는 tool_use 가 남았으면 다음 턴에 짝을 닫아 저장하고 보낸다', async () => {
    const toolUse = [{ type: 'tool_use', id: 't1', name: 'get_quote', input: {} }];
    const { driver, calls } = scripted((req, n) =>
      n === 1
        ? [
            { type: 'start', runId: req.runId, model: req.model },
            { type: 'message', message: { role: 'assistant', content: toolUse } },
            { type: 'error', runId: req.runId, reason: 'aborted', message: 'killed' },
          ]
        : ok(req),
    );
    const rt = makeRuntime(driver);
    await collect(rt.run(chat('s1', 'q1')));
    await collect(rt.run(chat('s1', 'q2')));
    expect(calls[1]?.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool', // 합성된 is_error 결과
      'system',
      'user',
    ]);
    expect(calls[1]?.messages[3].content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: 'interrupted before the tool ran',
        is_error: true,
      },
    ]);
    expect((await stored('s1')).map(([role]) => role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'system',
      'user',
      'assistant',
    ]);
  });

  it('error 턴: 원문은 남고 assistant 행은 없다. 창 상태의 시각만 갱신된다', async () => {
    const { driver } = scripted((req, n) => (n === 2 ? err(req, 'rate_limit') : ok(req, 'a1')));
    const rt = makeRuntime(driver);
    await collect(rt.run(chat('s1', 'q1')));
    clock += HOUR;
    const events = await collect(rt.run(chat('s1', 'q2')));
    expect(terminals(events)).toEqual([
      expect.objectContaining({ type: 'error', reason: 'rate_limit' }),
    ]);
    expect((await stored('s1')).filter(([role]) => role !== 'system')).toEqual([
      ['user', 'q1'],
      ['assistant', 'a1'],
      ['user', 'q2'],
    ]);
    const rec = await storage.getConversation(createSessionKey('s1'));
    expect(rec?.metadata).toMatchObject({ contextStart: 0, lastTurnAt: T0 + HOUR });
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
  it('같은 sessionKey 는 직렬화된다 (둘째는 첫째의 트랜스크립트를 이어받는다)', async () => {
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
    expect(sent(calls[1]).map(([role]) => role)).toEqual([
      'system',
      'user',
      'assistant',
      'system',
      'user',
    ]);
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

  it('reset 은 진행 중 run 의 종료 기록 뒤에 실행되어 대화가 되살아나지 않는다', async () => {
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
  it('start.model 이 비어 있으면 model_used 는 요청 모델', async () => {
    const { driver } = scripted((req) => [
      { type: 'start', runId: req.runId, model: '' },
      ...ok(req).slice(1),
    ]);
    await collect(makeRuntime(driver).run(chat('s1', 'q', { runId: 'run-nomodel' })));
    expect(getAgentRun(storage.db, 'run-nomodel')?.modelUsed).toBe(MODEL);
  });

  it('agent_runs 1행(id=runId·tool_calls·used_memory_ids)이 종료 이벤트 yield 전에 존재', async () => {
    const memId = 'abcdef12-0000-4000-8000-000000000000';
    const { driver } = scripted((req) =>
      ok(req, '선호는 배당주 [mem:abcdef]', [
        {
          type: 'tool_use',
          id: 't1',
          name: 'route_task',
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
            name: 'route_task',
            input: { intent: 'price_lookup' },
            isError: false,
          },
        ]);
        expect(row?.usedMemoryIds).toEqual([memId]);
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

  it('oneShot: 대화 조회·저장 0, 컨텍스트는 시각만, 예산 20만', async () => {
    const get = vi.spyOn(storage, 'getConversation');
    const append = vi.spyOn(storage, 'appendMessages');
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
    expect(sent(calls[0])).toEqual([
      ['system', CTX],
      ['user', '오늘 시장 요약'],
    ]);
    expect(calls[0]?.tokenBudget).toBe(200_000);
    expect(get).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(capture.capture).not.toHaveBeenCalled();
    expect(retrieval.searchRelevant).not.toHaveBeenCalled();
  });
});
