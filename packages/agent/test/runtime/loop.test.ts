// packages/agent/test/runtime/loop.test.ts
// 루프 단위 테스트 — 모델 호출은 정해진 메시지를 차례로 내주는 가짜 (API 호출 없음).
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  checkMessages,
  createLoopDriver,
  settleDanglingToolUses,
  toApiMessages,
  type StreamFn,
  type StreamParams,
} from '../../src/runtime/loop.js';
import type {
  AgentEvent,
  DriverRequest,
  DriverToolResult,
  TranscriptMessage,
} from '../../src/runtime/types.js';

type Block = Anthropic.ContentBlock;
const text = (t: string): Block => ({ type: 'text', text: t, citations: null }) as Block;
const toolUse = (id: string, name: string, input: unknown = {}): Block =>
  ({ type: 'tool_use', id, name, input }) as Block;

function message(
  content: Block[],
  stop: Anthropic.Message['stop_reason'] = 'end_turn',
  usage: Partial<Anthropic.Usage> = {},
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...usage,
    },
  } as Anthropic.Message;
}

type Step =
  | Anthropic.Message
  | Error
  | ((params: StreamParams, signal: AbortSignal) => Promise<Anthropic.Message>);

/**
 * 호출마다 다음 step 을 내준다. text 블록은 delta 로도 흘린다. 요청 스냅샷을 남긴다.
 * API 가 거절할 요청(역할 교대·도구 짝)은 여기서도 거절한다 — 가짜가 무엇이든 받아 주면 테스트가 못 잡는다.
 */
function scripted(steps: Step[]) {
  const requests: StreamParams[] = [];
  const stream: StreamFn = async (params, opts) => {
    requests.push(structuredClone(params));
    const invalid = checkMessages(params.messages);
    if (invalid) {
      throw new Anthropic.BadRequestError(400, undefined, invalid, new Headers());
    }
    const step = steps.shift();
    if (step === undefined) {
      throw new Error('script exhausted');
    }
    if (step instanceof Error) {
      throw step;
    }
    const msg = typeof step === 'function' ? await step(params, opts.signal) : step;
    for (const block of msg.content) {
      if (block.type === 'text') {
        opts.onText(block.text);
      }
    }
    return msg;
  };
  return { stream, requests };
}

const TOOLS = [
  { name: 'get_quote', description: '시세', inputSchema: { type: 'object', properties: {} } },
  { name: 'find_stock', description: '종목 찾기', inputSchema: { type: 'object', properties: {} } },
];

function request(over: Partial<DriverRequest> = {}): DriverRequest {
  return {
    runId: 'run-1',
    systemPrompt: 'SYSTEM',
    messages: [{ role: 'user', content: '삼성전자 얼마야?' }],
    model: 'claude-test',
    tools: TOOLS,
    runTool: async (name) => ({ content: `${name} ok`, isError: false }),
    maxTurns: 10,
    tokenBudget: 1_000_000,
    overallTimeoutMs: 60_000,
    signal: new AbortController().signal,
    ...over,
  };
}

async function collect(stream: StreamFn, req: DriverRequest): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of createLoopDriver({ stream })(req)) {
    events.push(ev);
  }
  return events;
}

const types = (events: AgentEvent[]): string[] => events.map((e) => e.type);
const last = (events: AgentEvent[]): AgentEvent => events.at(-1) as AgentEvent;

describe('runLoop', () => {
  it('텍스트만 오면 done — usage·턴 수 포함, 종료 이벤트는 정확히 1개', async () => {
    const { stream, requests } = scripted([message([text('7만원'), text('입니다')])]);
    const events = await collect(stream, request());

    expect(types(events)).toEqual(['start', 'text_delta', 'text_delta', 'message', 'done']);
    expect(last(events)).toMatchObject({
      type: 'done',
      text: '7만원입니다',
      numTurns: 1,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
    // 프리픽스: 시스템 프롬프트에 breakpoint, 도구는 이름순, 자동 캐싱
    expect(requests[0].system).toEqual([
      { type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } },
    ]);
    expect(requests[0].tools?.map((t) => t.name)).toEqual(['find_stock', 'get_quote']);
    expect(requests[0].tool_choice).toEqual({ type: 'auto' });
    expect(requests[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('tool_use 2개는 병렬로 실행하고, 결과는 호출 순서대로 메시지 하나에 담는다', async () => {
    const { stream, requests } = scripted([
      message([toolUse('a', 'get_quote', { s: 1 }), toolUse('b', 'find_stock')], 'tool_use'),
      message([text('끝')]),
    ]);
    let running = 0;
    let peak = 0;
    const runTool = async (name: string): Promise<DriverToolResult> => {
      running += 1;
      peak = Math.max(peak, running);
      // 먼저 부른 도구가 더 늦게 끝나도 결과 순서는 호출 순서다
      await new Promise((r) => setTimeout(r, name === 'get_quote' ? 20 : 1));
      running -= 1;
      return { content: `${name} ok`, isError: false };
    };
    const events = await collect(stream, request({ runTool }));

    expect(peak).toBe(2);
    expect(types(events)).toEqual([
      'start',
      'message', // assistant(tool_use ×2)
      'tool_use',
      'tool_use',
      'tool_result',
      'tool_result',
      'message', // tool 결과 1행
      'text_delta',
      'message',
      'done',
    ]);
    const toolRow = events.filter((e) => e.type === 'message')[1];
    expect(toolRow).toMatchObject({
      message: {
        role: 'tool',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'get_quote ok' },
          { type: 'tool_result', tool_use_id: 'b', content: 'find_stock ok' },
        ],
      },
    });
    // 두 번째 요청에는 assistant 블록 그대로 + 결과가 user 메시지 하나로 들어간다
    expect(requests[1].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(last(events)).toMatchObject({ type: 'done', numTurns: 2, usage: { input: 20 } });
  });

  it('assistant 행은 도구 실행보다 먼저 나온다 (저장이 부수효과보다 먼저)', async () => {
    const { stream } = scripted([
      message([toolUse('a', 'get_quote')], 'tool_use'),
      message([text('ok')]),
    ]);
    const order: string[] = [];
    const driver = createLoopDriver({ stream });
    const req = request({
      runTool: async () => {
        order.push('tool-run');
        return { content: 'ok', isError: false };
      },
    });
    for await (const ev of driver(req)) {
      if (ev.type === 'message') {
        order.push(`persist-${ev.message.role}`);
      }
    }
    expect(order).toEqual(['persist-assistant', 'tool-run', 'persist-tool', 'persist-assistant']);
  });

  it('도구가 실패하거나 throw 해도 is_error 결과로 돌려주고 계속한다', async () => {
    const { stream, requests } = scripted([
      message([toolUse('a', 'get_quote'), toolUse('b', 'find_stock')], 'tool_use'),
      message([text('다시 해볼게요')]),
    ]);
    const runTool = async (name: string): Promise<DriverToolResult> => {
      if (name === 'get_quote') {
        throw new Error('boom');
      }
      return { content: 'Tool not found: find_stock', isError: true };
    };
    const events = await collect(stream, request({ runTool }));

    expect(last(events).type).toBe('done');
    expect(requests[1].messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'a', content: 'tool failed: boom', is_error: true },
      {
        type: 'tool_result',
        tool_use_id: 'b',
        content: 'Tool not found: find_stock',
        is_error: true,
      },
    ]);
    expect(events.filter((e) => e.type === 'tool_result')).toEqual([
      { type: 'tool_result', id: 'a', isError: true },
      { type: 'tool_result', id: 'b', isError: true },
    ]);
  });

  it('max_tokens 로 잘린 tool_use 는 실행하지 않는다', async () => {
    const { stream } = scripted([
      message([toolUse('a', 'get_quote', { partial: true })], 'max_tokens'),
      message([text('도구 없이 답합니다')]),
    ]);
    const runTool = vi.fn(async () => ({ content: 'x', isError: false }));
    const events = await collect(stream, request({ runTool }));

    expect(runTool).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'tool_result')).toEqual({
      type: 'tool_result',
      id: 'a',
      isError: true,
    });
    expect(last(events)).toMatchObject({ type: 'done', text: '도구 없이 답합니다' });
  });

  it('refusal 은 저장하지 않고 error{refusal} 로 끝낸다 (재시도 없음)', async () => {
    const { stream, requests } = scripted([message([toolUse('a', 'get_quote')], 'refusal')]);
    const runTool = vi.fn(async () => ({ content: 'x', isError: false }));
    const events = await collect(stream, request({ runTool }));

    expect(types(events)).toEqual(['start', 'error']);
    expect(last(events)).toMatchObject({ reason: 'refusal', numTurns: 1 });
    expect(runTool).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it('반복 상한을 넘으면 도구 정의는 둔 채 tool_choice none 으로 마무리 호출을 한다', async () => {
    const { stream, requests } = scripted([
      message([toolUse('a', 'get_quote')], 'tool_use'),
      message([toolUse('b', 'get_quote')], 'tool_use'),
      message([text('지금까지로 답합니다')]),
    ]);
    const events = await collect(stream, request({ maxTurns: 2 }));

    expect(requests.map((r) => r.tool_choice)).toEqual([
      { type: 'auto' },
      { type: 'auto' },
      { type: 'none' },
    ]);
    expect(requests[2].tools).toEqual(requests[0].tools); // 캐시 프리픽스 유지
    expect(last(events)).toMatchObject({ type: 'done', text: '지금까지로 답합니다', numTurns: 3 });
  });

  it('토큰 예산을 넘으면 반복 상한과 같이 마무리 호출로 끝낸다 (캐시 읽기는 세지 않는다)', async () => {
    // 14만 토큰짜리 캐시된 컨텍스트로 도구를 두 번 돌려도 예산(1,000)에 걸리지 않는다
    const cached = { input_tokens: 5, output_tokens: 20, cache_read_input_tokens: 140_000 };
    const ok = scripted([
      message([toolUse('a', 'get_quote')], 'tool_use', cached),
      message([toolUse('b', 'get_quote')], 'tool_use', cached),
      message([text('끝')], 'end_turn', cached),
    ]);
    await collect(ok.stream, request({ tokenBudget: 1_000 }));
    expect(ok.requests.map((r) => r.tool_choice)).toEqual([
      { type: 'auto' },
      { type: 'auto' },
      { type: 'auto' },
    ]);

    // 새로 처리한 토큰(입력+캐시 쓰기+출력)이 넘으면 다음 호출은 도구를 막은 마무리 호출이다
    const over = scripted([
      message([toolUse('a', 'get_quote')], 'tool_use', { input_tokens: 900, output_tokens: 200 }),
      message([text('지금까지로 답합니다')]),
    ]);
    const events = await collect(over.stream, request({ tokenBudget: 1_000 }));
    expect(over.requests.map((r) => r.tool_choice)).toEqual([{ type: 'auto' }, { type: 'none' }]);
    expect(last(events)).toMatchObject({ type: 'done', text: '지금까지로 답합니다', numTurns: 2 });
  });

  it('도구 실행 중 abort 되면 tool 행으로 짝을 닫고 error{aborted}', async () => {
    const { stream } = scripted([message([toolUse('a', 'get_quote')], 'tool_use')]);
    const controller = new AbortController();
    const runTool = async (): Promise<DriverToolResult> => {
      controller.abort();
      return { content: 'aborted', isError: true };
    };
    const events = await collect(stream, request({ runTool, signal: controller.signal }));

    expect(types(events).slice(-2)).toEqual(['message', 'error']);
    expect(last(events)).toMatchObject({ reason: 'aborted' });
  });

  it('모델 호출 중 abort 는 aborted, 워치독(overall)은 timeout', async () => {
    const hang = (_p: StreamParams, signal: AbortSignal): Promise<Anthropic.Message> =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()));
      });

    const controller = new AbortController();
    const aborted = collect(scripted([hang]).stream, request({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 5);
    expect(last(await aborted)).toMatchObject({ type: 'error', reason: 'aborted', numTurns: 1 });

    // 시작 전에 이미 중단된 run 은 모델을 부르지 않는다
    const never = scripted([]);
    const pre = await collect(never.stream, request({ signal: AbortSignal.abort() }));
    expect(last(pre)).toMatchObject({ type: 'error', reason: 'aborted', numTurns: 0 });
    expect(never.requests).toHaveLength(0);

    const slow = await collect(scripted([hang]).stream, request({ overallTimeoutMs: 10 }));
    expect(last(slow)).toMatchObject({ type: 'error', reason: 'timeout' });
  });

  it('SDK 오류를 종료 사유로 분류한다', async () => {
    const headers = new Headers();
    const cases: [Error, string][] = [
      [new Anthropic.AuthenticationError(401, undefined, 'bad key', headers), 'auth'],
      [new Anthropic.PermissionDeniedError(403, undefined, 'no', headers), 'auth'],
      [new Anthropic.RateLimitError(429, undefined, 'slow down', headers), 'rate_limit'],
      [new Anthropic.APIConnectionTimeoutError(), 'timeout'],
      [new Anthropic.APIError(402 as never, undefined, 'credit balance too low', headers), 'auth'],
      [new Anthropic.BadRequestError(400, undefined, 'bad', headers), 'invalid_request'],
      [new Anthropic.InternalServerError(500, undefined, 'oops', headers), 'unknown'],
      [new Error('socket hang up'), 'unknown'],
    ];
    for (const [err, reason] of cases) {
      const events = await collect(scripted([err]).stream, request());
      expect(types(events)).toEqual(['start', 'error']);
      expect(last(events)).toMatchObject({ reason });
    }
  });

  it('컨텍스트 초과는 error{context_overflow}', async () => {
    const { stream } = scripted([message([], 'model_context_window_exceeded')]);
    expect(last(await collect(stream, request()))).toMatchObject({ reason: 'context_overflow' });
  });

  it('도구가 없으면 tools·tool_choice·꼬리 캐시를 보내지 않는다 (서브에이전트)', async () => {
    const { stream, requests } = scripted([message([text('분석')])]);
    await collect(stream, request({ tools: [] }));
    expect(requests[0].tools).toBeUndefined();
    expect(requests[0].tool_choice).toBeUndefined();
    expect(requests[0].cache_control).toBeUndefined();
  });

  it('text 없이 끝난 응답(thinking 만 하다 max_tokens)은 저장하지 않고 오류로 끝낸다', async () => {
    const thinking = { type: 'thinking', thinking: '', signature: 's' } as unknown as Block;
    const { stream } = scripted([message([thinking], 'max_tokens')]);
    const events = await collect(stream, request());
    expect(types(events)).toEqual(['start', 'error']);
    expect(last(events)).toMatchObject({ reason: 'unknown' });
  });

  it('끝나지 않는 도구는 기다리지 않는다: abort → 짝을 닫고 aborted, 워치독 → timeout', async () => {
    const never = (): Promise<DriverToolResult> => new Promise(() => {});
    const script = (): Step[] => [message([toolUse('a', 'get_quote')], 'tool_use')];

    const controller = new AbortController();
    const aborted = collect(
      scripted(script()).stream,
      request({ runTool: never, signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 5);
    const events = await aborted;
    expect(types(events).slice(-3)).toEqual(['tool_result', 'message', 'error']);
    expect(events.at(-2)).toMatchObject({
      message: { role: 'tool', content: [{ tool_use_id: 'a', is_error: true }] },
    });
    expect(last(events)).toMatchObject({ reason: 'aborted' });

    const timed = await collect(
      scripted(script()).stream,
      request({ runTool: never, overallTimeoutMs: 10 }),
    );
    expect(last(timed)).toMatchObject({ reason: 'timeout' });
  });

  it('API 규칙에 안 맞는 도구 이름(플러그인 `mcp:id:name`)은 경계에서 바꿔 보내고 되돌린다', async () => {
    const { stream, requests } = scripted([
      message([toolUse('a', 'mcp_fs_read_file')], 'tool_use'),
      message([text('ok')]),
    ]);
    const runTool = vi.fn(async () => ({ content: 'data', isError: false }));
    const events = await collect(
      stream,
      request({
        tools: [{ name: 'mcp:fs:read_file', description: 'd', inputSchema: { type: 'object' } }],
        runTool,
      }),
    );
    expect(requests[0].tools?.map((t) => t.name)).toEqual(['mcp_fs_read_file']);
    expect(runTool).toHaveBeenCalledWith('mcp:fs:read_file', {}, expect.anything());
    expect(events.find((e) => e.type === 'tool_use')).toMatchObject({ name: 'mcp:fs:read_file' });
  });

  it('보낼 수 없는 트랜스크립트는 모델을 부르지 않고 error{invalid_request}', async () => {
    const { stream, requests } = scripted([]);
    const events = await collect(
      stream,
      request({
        messages: [
          { role: 'user', content: 'q' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'a', name: 'get_quote', input: {} }],
          },
          { role: 'system', content: 'ctx' },
          { role: 'user', content: '결과 없이 다음 질문' }, // tool_use 에 답이 없다
        ],
      }),
    );
    expect(types(events)).toEqual(['start', 'error']);
    expect(last(events)).toMatchObject({ reason: 'invalid_request' });
    expect(requests).toHaveLength(0);
  });

  it('종료 이벤트에 마지막 호출의 프롬프트 크기(contextTokens)를 싣는다', async () => {
    const { stream } = scripted([
      message([toolUse('a', 'get_quote')], 'tool_use', {
        input_tokens: 10,
        cache_read_input_tokens: 100,
      }),
      message([text('끝')], 'end_turn', {
        input_tokens: 7,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 50,
      }),
    ]);
    expect(last(await collect(stream, request()))).toMatchObject({ contextTokens: 357 });
  });
});

describe('toApiMessages', () => {
  const T = (t: string) => ({ type: 'text', text: t });

  it('system 행은 바로 뒤 user 앞의 text 블록이 되고, tool 행은 user 로 나간다', () => {
    const rows: TranscriptMessage[] = [
      { role: 'user', content: '예전 텍스트 행' },
      { role: 'assistant', content: '예전 답' },
      { role: 'system', content: '<context>시각</context>' },
      { role: 'user', content: '삼성전자?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'get_quote', input: {} }] },
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'a', content: '70000' }] },
    ];
    expect(toApiMessages(rows)).toEqual([
      { role: 'user', content: [T('예전 텍스트 행')] },
      { role: 'assistant', content: [T('예전 답')] },
      { role: 'user', content: [T('<context>시각</context>'), T('삼성전자?')] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'get_quote', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '70000' }] },
    ]);
  });

  it('같은 role 이 이어지면 한 메시지로 합친다 (도구 결과 → 새 질문, 실패한 턴 → 재질문)', () => {
    const rows: TranscriptMessage[] = [
      { role: 'system', content: 'c1' },
      { role: 'user', content: 'q1' }, // 이 턴은 실패해 assistant 행이 없다
      { role: 'system', content: 'c2' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'get_quote', input: {} }] },
      {
        role: 'tool',
        content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x', is_error: true }],
      },
      { role: 'system', content: 'c3' },
      { role: 'user', content: 'q3' },
    ];
    const out = toApiMessages(rows);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(out[0].content).toEqual([T('c1'), T('q1'), T('c2'), T('q2')]);
    expect(out[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'a', content: 'x', is_error: true }, // 결과가 먼저
      T('c3'),
      T('q3'),
    ]);
    expect(checkMessages(out)).toBeUndefined();
  });

  it('창이 user 질문으로 시작하지 않으면 앞부분을 버린다', () => {
    const rows: TranscriptMessage[] = [
      { role: 'assistant', content: '짝 잃은 답' },
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'x' }] },
      { role: 'assistant', content: '또 다른 답' },
      { role: 'user', content: 'q' },
    ];
    expect(toApiMessages(rows)).toEqual([{ role: 'user', content: [T('q')] }]);
    expect(toApiMessages([{ role: 'assistant', content: 'a' }])).toEqual([]);
  });

  it('행을 덧붙여도 앞 메시지는 바이트 단위로 그대로다 (캐시 프리픽스)', () => {
    const rows: TranscriptMessage[] = [
      { role: 'system', content: 'ctx' },
      { role: 'user', content: 'q1' },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '', signature: 'sig' }, T('a1')],
      },
    ];
    const more: TranscriptMessage[] = [
      ...rows,
      { role: 'system', content: 'ctx2' },
      { role: 'user', content: 'q2' },
    ];
    const before = toApiMessages(rows);
    const after = toApiMessages(more);
    expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
  });
});

describe('checkMessages', () => {
  const use = { type: 'tool_use', id: 'a', name: 't', input: {} } as const;
  const result = { type: 'tool_result', tool_use_id: 'a', content: 'x' } as const;

  it('정상 대화는 통과', () => {
    expect(
      checkMessages([
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [use] },
        { role: 'user', content: [result] },
      ]),
    ).toBeUndefined();
  });

  it.each([
    ['빈 배열', []],
    ['assistant 로 시작', [{ role: 'assistant', content: 'a' }]],
    [
      '같은 role 반복',
      [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ],
    ],
    ['빈 메시지', [{ role: 'user', content: '' }]],
    [
      '답 없는 tool_use',
      [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [use] },
        { role: 'user', content: 'next' },
      ],
    ],
    [
      '짝 없는 tool_result',
      [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: [result] },
      ],
    ],
    [
      'assistant 로 끝남',
      [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ],
    ],
  ] as [string, Anthropic.MessageParam[]][])('거절: %s', (_name, messages) => {
    expect(checkMessages(messages)).toEqual(expect.any(String));
  });
});

describe('settleDanglingToolUses', () => {
  const assistant: TranscriptMessage = {
    role: 'assistant',
    content: [
      { type: 'text', text: '조회할게요' },
      { type: 'tool_use', id: 'a', name: 'get_quote', input: {} },
      { type: 'tool_use', id: 'b', name: 'find_stock', input: {} },
    ],
  };

  it('결과 없는 tool_use 마다 is_error 결과를 만든다', () => {
    expect(settleDanglingToolUses([{ role: 'user', content: 'q' }, assistant])).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'a',
          content: 'interrupted before the tool ran',
          is_error: true,
        },
        {
          type: 'tool_result',
          tool_use_id: 'b',
          content: 'interrupted before the tool ran',
          is_error: true,
        },
      ],
    });
  });

  it('이미 닫혔거나 tool_use 가 없으면 아무것도 만들지 않는다', () => {
    expect(settleDanglingToolUses([assistant, { role: 'tool', content: [] }])).toBeUndefined();
    expect(settleDanglingToolUses([{ role: 'assistant', content: '텍스트만' }])).toBeUndefined();
    expect(settleDanglingToolUses([{ role: 'user', content: 'q' }])).toBeUndefined();
  });
});
