// packages/agent/src/runtime/loop.ts
// 자체 에이전트 루프 (plans/agent-core.md §3.1).
//
// 모델이 끝낸다: assistant 메시지에 tool_use 가 없으면 종료. 루프는 저장소·채널·세션을 모르고,
// 트랜스크립트에 덧붙일 행이 생기면 `message` 이벤트로 내보낸다 — 소비자(AgentRuntime)가 그 행을
// 저장한 뒤에야 다음 줄(도구 실행)로 넘어간다 (async generator 는 next() 가 불릴 때까지 멈춘다).
import Anthropic from '@anthropic-ai/sdk';
import type {
  AgentDriver,
  AgentErrorReason,
  AgentEvent,
  DriverRequest,
  DriverToolResult,
  TerminalEvent,
  TranscriptMessage,
} from './types.js';

const MAX_OUTPUT_TOKENS = 16_000;
/** Messages API 의 도구 이름 규칙. 플러그인 도구(`mcp:<id>:<name>`)는 이 규칙에 안 맞아 경계에서 바꿔 보낸다. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export type StreamParams = Anthropic.MessageStreamParams;

/** 모델 호출 1회의 이음매. 실 구현은 SDK 스트림, 테스트는 정해진 메시지를 차례로 내주는 가짜. */
export type StreamFn = (
  params: StreamParams,
  opts: { readonly signal: AbortSignal; readonly onText: (delta: string) => void },
) => Promise<Anthropic.Message>;

/** SDK 스트림 어댑터. 재시도(429·5xx·연결 오류)는 SDK 기본값(2회)에 맡긴다. */
export function createAnthropicStream(client: Anthropic): StreamFn {
  return (params, opts) =>
    client.messages.stream(params, { signal: opts.signal }).on('text', opts.onText).finalMessage();
}

type Block = Anthropic.ContentBlockParam;

/**
 * 트랜스크립트 행 → API 메시지. 결정적이다: 같은 행은 항상 같은 바이트가 된다 (캐시 프리픽스).
 * - `system` 행(턴 컨텍스트)은 바로 뒤 user 행 앞의 text 블록이 된다.
 * - `tool` 행은 user 메시지로 나간다.
 * - 같은 role 이 이어지면 한 메시지로 합친다 (실패한 턴 뒤 재질문, 중단된 도구 결과 뒤 새 질문).
 *   tool_result 는 행 순서상 항상 앞에 온다.
 * - 창이 user 질문으로 시작하지 않으면 앞부분(짝 잃은 assistant·도구 결과)을 버린다.
 */
export function toApiMessages(rows: readonly TranscriptMessage[]): Anthropic.MessageParam[] {
  const out: { role: 'user' | 'assistant'; content: Block[] }[] = [];
  let context: Block[] = [];
  for (const row of rows) {
    if (row.role === 'system') {
      context = blocksOf(row.content);
      continue;
    }
    const role = row.role === 'assistant' ? 'assistant' : 'user';
    const blocks =
      row.role === 'user' ? [...context, ...blocksOf(row.content)] : blocksOf(row.content);
    if (row.role === 'user') {
      context = [];
    }
    if (blocks.length === 0) {
      continue;
    }
    const prev = out.at(-1);
    if (prev?.role === role) {
      prev.content.push(...blocks);
    } else {
      out.push({ role, content: blocks });
    }
  }
  const start = out.findIndex(
    (m) => m.role === 'user' && m.content.every((b) => b.type !== 'tool_result'),
  );
  return start < 0 ? [] : out.slice(start);
}

/**
 * 요청을 보내기 전에 API 가 거절할 모양을 잡는다. 문제가 있으면 사유, 없으면 undefined.
 * 저장된 트랜스크립트가 깨졌을 때 400 을 받기 전에 알고, 런타임이 창을 새로 열어 복구하게 한다.
 */
export function checkMessages(messages: readonly Anthropic.MessageParam[]): string | undefined {
  if (messages.length === 0 || messages[0].role !== 'user') {
    return 'first message must be a user message';
  }
  let pending = new Set<string>(); // 직전 assistant 의 tool_use 중 아직 답 없는 것
  for (const [i, m] of messages.entries()) {
    if (i > 0 && messages[i - 1].role === m.role) {
      return `messages[${i}] repeats role ${m.role}`;
    }
    const blocks = typeof m.content === 'string' ? [] : m.content;
    if (typeof m.content === 'string' ? m.content.length === 0 : blocks.length === 0) {
      return `messages[${i}] is empty`;
    }
    if (m.role === 'user') {
      const answered = new Set(
        blocks.flatMap((b) => (b.type === 'tool_result' ? [b.tool_use_id] : [])),
      );
      if (answered.size !== pending.size || [...pending].some((id) => !answered.has(id))) {
        return `messages[${i}] does not answer the tool calls before it`;
      }
      pending = new Set();
    } else {
      pending = new Set(blocks.flatMap((b) => (b.type === 'tool_use' ? [b.id] : [])));
    }
  }
  return messages.at(-1)?.role === 'user' ? undefined : 'last message must be a user message';
}

/**
 * 마지막 assistant 행에 결과 없는 tool_use 가 남았으면(중단·크래시) is_error 결과 행을 만들어 준다.
 * 닫을 것이 없으면 undefined.
 */
export function settleDanglingToolUses(
  rows: readonly TranscriptMessage[],
): TranscriptMessage | undefined {
  const lastAssistant = rows.findLastIndex((r) => r.role === 'assistant');
  if (lastAssistant < 0 || rows.slice(lastAssistant + 1).some((r) => r.role === 'tool')) {
    return undefined;
  }
  const calls = toolUses(rows[lastAssistant].content);
  return calls.length === 0
    ? undefined
    : {
        role: 'tool',
        content: calls.map((c) => toolResult(c.id, 'interrupted before the tool ran', true)),
      };
}

/**
 * 실 드라이버. 키가 없으면 SDK 를 만들지 않고 모든 run 을 `error{auth}` 로 끝낸다 —
 * 서버는 키 없이도 부팅한다 (알림·조회 RPC 는 모델 없이 동작).
 */
export function createAnthropicDriver(opts: { readonly apiKey: string | undefined }): AgentDriver {
  if (!opts.apiKey) {
    return async function* missingKey(req) {
      yield {
        type: 'error',
        runId: req.runId,
        reason: 'auth',
        message: 'ANTHROPIC_API_KEY is not set',
      };
    };
  }
  return createLoopDriver({
    stream: createAnthropicStream(new Anthropic({ apiKey: opts.apiKey })),
  });
}

export function createLoopDriver(opts: {
  readonly stream: StreamFn;
  readonly now?: () => number;
}): AgentDriver {
  const now = opts.now ?? Date.now;
  return async function* loop(req: DriverRequest): AsyncGenerator<AgentEvent> {
    const startedAt = now();
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let numTurns = 0;
    let contextTokens = 0; // 마지막 호출의 프롬프트 크기 (입력+캐시) — 런타임의 회전 판정용
    const done = (text: string): TerminalEvent => ({
      type: 'done',
      runId: req.runId,
      text,
      usage: { ...usage },
      contextTokens,
      durationMs: now() - startedAt,
      numTurns,
    });
    const fail = (reason: AgentErrorReason, message: string): TerminalEvent => ({
      type: 'error',
      runId: req.runId,
      reason,
      message,
      usage: { ...usage },
      contextTokens,
      numTurns,
    });

    // 워치독: overall 타이머 하나. 같은 signal 로 스트림과 도구를 끊는다.
    const watchdog = new AbortController();
    const signal = AbortSignal.any([req.signal, watchdog.signal]);
    const overallTimer = setTimeout(() => watchdog.abort(), req.overallTimeoutMs);
    const stopReason = (): AgentErrorReason => (req.signal.aborted ? 'aborted' : 'timeout');

    const messages = toApiMessages(req.messages);
    // 이름순 고정 — 도구 목록이 바이트 단위로 같아야 캐시가 맞는다. API 이름 ↔ 레지스트리 이름.
    const names = new Map<string, string>();
    const tools: Anthropic.Tool[] = req.tools
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((t) => {
        const apiName = TOOL_NAME.test(t.name)
          ? t.name
          : t.name.replaceAll(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        names.set(apiName, t.name);
        return {
          name: apiName,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        };
      });

    yield { type: 'start', runId: req.runId, model: req.model };
    try {
      const invalid = checkMessages(messages);
      if (invalid) {
        yield fail('invalid_request', invalid);
        return;
      }
      for (;;) {
        if (signal.aborted) {
          yield fail(stopReason(), 'run stopped before model call');
          return;
        }
        numTurns += 1;
        // 상한(반복·예산)에 닿으면 도구 호출만 막고 지금까지로 답하게 한다. 도구 정의는 그대로 둔다
        // (tools·system 캐시 유지 — tool_choice 가 바뀌면 messages 캐시는 다시 쓴다).
        const fresh = usage.input + usage.cacheWrite + usage.output; // 캐시 읽기는 뺀다 (훨씬 싸다)
        const wrapUp = numTurns > req.maxTurns || fresh > req.tokenBudget;
        const params: StreamParams = {
          model: req.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: [{ type: 'text', text: req.systemPrompt, cache_control: { type: 'ephemeral' } }],
          messages,
          ...(tools.length > 0
            ? {
                tools,
                tool_choice: { type: wrapUp ? 'none' : 'auto' } as const,
                // 대화 꼬리 자동 캐싱 — 도구 루프의 다음 호출이 읽는다. 도구 없는 1회 호출에는 할증만 된다.
                cache_control: { type: 'ephemeral' } as const,
              }
            : {}),
        };

        // ── 모델 호출 1회: text delta 를 오는 대로 흘린다 ──
        const deltas: string[] = [];
        const model: { result?: { message: Anthropic.Message } | { error: unknown } } = {};
        let wake: (() => void) | undefined;
        void opts
          .stream(params, {
            signal,
            onText: (delta) => {
              deltas.push(delta);
              wake?.();
            },
          })
          .then(
            (message) => {
              model.result = { message };
            },
            (error: unknown) => {
              model.result = { error };
            },
          )
          .finally(() => wake?.());
        for (;;) {
          const delta = deltas.shift();
          if (delta !== undefined) {
            yield { type: 'text_delta', text: delta };
          } else if (model.result) {
            break;
          } else {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        }
        const outcome = model.result;
        if ('error' in outcome) {
          yield signal.aborted
            ? fail(stopReason(), 'run stopped during model call')
            : classify(outcome.error, fail);
          return;
        }

        const msg = outcome.message;
        usage.input += msg.usage.input_tokens;
        usage.output += msg.usage.output_tokens;
        usage.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
        usage.cacheWrite += msg.usage.cache_creation_input_tokens ?? 0;
        contextTokens =
          msg.usage.input_tokens +
          (msg.usage.cache_read_input_tokens ?? 0) +
          (msg.usage.cache_creation_input_tokens ?? 0);
        const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');

        if (msg.stop_reason === 'refusal') {
          // 거절은 tool_use 를 중간에 끊을 수 있다 — 그 메시지는 저장도 실행도 하지 않는다.
          yield fail('refusal', 'model refused the request');
          return;
        }
        if (msg.stop_reason === 'model_context_window_exceeded') {
          yield fail('context_overflow', 'context window exceeded');
          return;
        }
        const calls = toolUses(msg.content);
        if (calls.length === 0 && text.length === 0) {
          // thinking 만 하다 max_tokens 에 걸린 경우 등 — 빈 답을 저장하거나 채널에 보내지 않는다.
          yield fail(
            'unknown',
            `model returned no text (stop_reason ${msg.stop_reason ?? 'none'})`,
          );
          return;
        }

        yield { type: 'message', message: { role: 'assistant', content: msg.content } };
        messages.push({ role: 'assistant', content: msg.content });

        if (calls.length === 0) {
          yield done(text); // 유일한 정상 종료 (max_tokens 로 잘린 텍스트도 여기로 온다)
          return;
        }

        for (const call of calls) {
          yield {
            type: 'tool_use',
            id: call.id,
            name: names.get(call.name) ?? call.name,
            input: call.input,
          };
        }
        let results: Anthropic.ToolResultBlockParam[];
        if (msg.stop_reason === 'max_tokens' || wrapUp) {
          // 잘린 tool_use 는 입력이 온전하지 않다. 마무리 호출에서 나온 tool_use 도 실행하지 않는다.
          results = calls.map((c) =>
            toolResult(c.id, 'tool call was cut off or not allowed here; answer without it', true),
          );
        } else {
          // 전부 조회 도구라 병렬. 결과는 호출 순서대로.
          const settled = await Promise.all(
            calls.map((c) => runTool(req, names.get(c.name) ?? c.name, c.input, signal)),
          );
          results = calls.map((c, i) => toolResult(c.id, settled[i].content, settled[i].isError));
        }
        for (const r of results) {
          yield { type: 'tool_result', id: r.tool_use_id, isError: r.is_error === true };
        }
        // 한 턴의 결과는 메시지 하나에 — 중단됐어도 짝은 닫고 끝낸다.
        yield { type: 'message', message: { role: 'tool', content: results } };
        messages.push({ role: 'user', content: results });

        if (signal.aborted) {
          yield fail(stopReason(), 'run stopped during tool execution');
          return;
        }
        if (wrapUp) {
          yield done(text);
          return;
        }
      }
    } finally {
      clearTimeout(overallTimer);
    }
  };
}

/** 도구 1건. 실패·throw 는 모델이 읽는 결과로 바꾸고, 중단 신호를 무시하는 도구는 기다리지 않는다. */
async function runTool(
  req: DriverRequest,
  name: string,
  input: unknown,
  signal: AbortSignal,
): Promise<DriverToolResult> {
  const interrupted: DriverToolResult = {
    content: 'interrupted before the tool finished',
    isError: true,
  };
  if (signal.aborted) {
    return interrupted;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<DriverToolResult>((resolve) => {
    onAbort = () => resolve(interrupted);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([req.runTool(name, input, signal), aborted]);
  } catch (err) {
    return {
      content: `tool failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

function classify(
  err: unknown,
  fail: (reason: AgentErrorReason, message: string) => TerminalEvent,
): TerminalEvent {
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return fail('timeout', 'Anthropic API request timed out');
  }
  if (err instanceof Anthropic.APIError) {
    const detail = `Anthropic API ${err.status ?? ''}: ${err.message}`.slice(0, 300);
    if (err.status === 401 || err.status === 402 || err.status === 403) {
      return fail('auth', detail); // 키가 틀렸거나 크레딧이 없다
    }
    if (err.status === 429) {
      return fail('rate_limit', detail);
    }
    if (err.status === 400) {
      return fail('invalid_request', detail); // 런타임이 컨텍스트 창을 새로 열고 1회 재시도한다
    }
    return fail('unknown', detail);
  }
  return fail('unknown', (err instanceof Error ? err.message : String(err)).slice(0, 300));
}

function toolUses(content: TranscriptMessage['content']): Anthropic.ToolUseBlock[] {
  return typeof content === 'string'
    ? []
    : (content as readonly Anthropic.ContentBlock[]).filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
}

function toolResult(id: string, content: string, isError: boolean): Anthropic.ToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) };
}

/** 저장된 content → 블록 배열. 문자열은 text 블록 하나(빈 문자열이면 없음), 배열은 받은 그대로. */
function blocksOf(content: TranscriptMessage['content']): Block[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : [];
  }
  return [...(content as readonly Block[])];
}
