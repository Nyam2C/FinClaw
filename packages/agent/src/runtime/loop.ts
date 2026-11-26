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

export type StreamParams = Anthropic.MessageStreamParams;

/**
 * 모델 호출 1회의 이음매. 실 구현은 SDK 스트림, 테스트는 정해진 메시지를 차례로 내주는 가짜.
 * `onActivity` 는 스트림 이벤트마다(thinking 포함), `onText` 는 text delta 마다 부른다.
 */
export type StreamFn = (
  params: StreamParams,
  opts: {
    readonly signal: AbortSignal;
    readonly onText: (delta: string) => void;
    readonly onActivity: () => void;
  },
) => Promise<Anthropic.Message>;

/** SDK 스트림 어댑터. 재시도(429·5xx·연결 오류)는 SDK 기본값(2회)에 맡긴다. */
export function createAnthropicStream(client: Anthropic): StreamFn {
  return (params, opts) =>
    client.messages
      .stream(params, { signal: opts.signal })
      .on('streamEvent', opts.onActivity)
      .on('text', opts.onText)
      .finalMessage();
}

/**
 * 트랜스크립트 행 → API 메시지. 결정적이다: 같은 행은 항상 같은 바이트가 된다 (캐시 프리픽스).
 * `system` 행(턴 컨텍스트)은 바로 뒤 user 메시지의 첫 text 블록으로 합친다.
 */
export function toApiMessages(rows: readonly TranscriptMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  let context: string | undefined;
  for (const row of rows) {
    if (row.role === 'system') {
      context = textOf(row.content);
    } else if (row.role === 'user') {
      const input = textOf(row.content);
      out.push({
        role: 'user',
        content:
          context === undefined
            ? input
            : [
                { type: 'text', text: context },
                { type: 'text', text: input },
              ],
      });
      context = undefined;
    } else {
      out.push({
        role: row.role === 'tool' ? 'user' : 'assistant',
        content: row.content as Anthropic.MessageParam['content'],
      });
    }
  }
  return out;
}

/**
 * 마지막 assistant 행에 결과 없는 tool_use 가 남았으면(중단·크래시) is_error 결과 행을 만들어 준다.
 * 안 닫으면 다음 요청이 API 에서 거절된다. 닫을 것이 없으면 undefined.
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
    const done = (text: string): TerminalEvent => ({
      type: 'done',
      runId: req.runId,
      text,
      usage: { ...usage },
      durationMs: now() - startedAt,
      numTurns,
    });
    const fail = (reason: AgentErrorReason, message: string): TerminalEvent => ({
      type: 'error',
      runId: req.runId,
      reason,
      message,
      usage: { ...usage },
      numTurns,
    });

    // 워치독: overall 은 고정 타이머, idle 은 스트림 활동마다 되감는다. 둘 다 같은 signal 로 스트림·도구를 끊는다.
    const watchdog = new AbortController();
    const signal = AbortSignal.any([req.signal, watchdog.signal]);
    const overallTimer = setTimeout(() => watchdog.abort(), req.overallTimeoutMs);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const touch = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => watchdog.abort(), req.idleTimeoutMs);
    };
    const stopReason = (): AgentErrorReason => (req.signal.aborted ? 'aborted' : 'timeout');

    const messages = toApiMessages(req.messages);
    // 이름순 고정 — 도구 목록이 바이트 단위로 같아야 캐시가 맞는다.
    const tools: Anthropic.Tool[] = req.tools
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      }));

    yield { type: 'start', runId: req.runId, model: req.model };
    try {
      for (;;) {
        if (signal.aborted) {
          yield fail(stopReason(), 'run stopped before model call');
          return;
        }
        numTurns += 1;
        const wrapUp = numTurns > req.maxTurns; // 상한 도달: 도구 정의는 그대로 두고(캐시 유지) 호출만 막는다
        const params: StreamParams = {
          model: req.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: [{ type: 'text', text: req.systemPrompt, cache_control: { type: 'ephemeral' } }],
          cache_control: { type: 'ephemeral' }, // 대화 꼬리 자동 캐싱
          messages,
          ...(tools.length > 0
            ? { tools, tool_choice: { type: wrapUp ? 'none' : 'auto' } as const }
            : {}),
        };

        // ── 모델 호출 1회: text delta 를 오는 대로 흘린다 ──
        const deltas: string[] = [];
        const model: { result?: { message: Anthropic.Message } | { error: unknown } } = {};
        let wake: (() => void) | undefined;
        touch();
        void opts
          .stream(params, {
            signal,
            onActivity: touch,
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
        clearTimeout(idleTimer);
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

        yield { type: 'message', message: { role: 'assistant', content: msg.content } };
        messages.push({ role: 'assistant', content: msg.content });

        const calls = toolUses(msg.content);
        if (calls.length === 0) {
          if (msg.stop_reason === 'pause_turn' && !wrapUp) {
            continue; // 서버 측 일시정지 — 같은 히스토리로 다시 요청
          }
          yield done(text); // 유일한 정상 종료 (max_tokens 로 잘린 텍스트도 여기로 온다)
          return;
        }

        for (const call of calls) {
          yield { type: 'tool_use', id: call.id, name: call.name, input: call.input };
        }
        let results: Anthropic.ToolResultBlockParam[];
        if (msg.stop_reason === 'max_tokens' || wrapUp) {
          // 잘린 tool_use 는 입력이 온전하지 않다. 마무리 호출에서 나온 tool_use 도 실행하지 않는다.
          results = calls.map((c) =>
            toolResult(c.id, 'tool call was cut off or not allowed here; answer without it', true),
          );
        } else {
          // 전부 조회 도구라 병렬. 결과는 호출 순서대로.
          const settled = await Promise.all(calls.map((c) => runTool(req, c, signal)));
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
        if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite > req.tokenBudget) {
          yield fail('budget', `token budget ${req.tokenBudget} exceeded`);
          return;
        }
      }
    } finally {
      clearTimeout(overallTimer);
      clearTimeout(idleTimer);
    }
  };
}

async function runTool(
  req: DriverRequest,
  call: Anthropic.ToolUseBlock,
  signal: AbortSignal,
): Promise<DriverToolResult> {
  try {
    return await req.runTool(call.name, call.input, signal);
  } catch (err) {
    // 도구 실패는 예외가 아니라 모델이 읽는 결과다.
    return {
      content: `tool failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

function classify(
  err: unknown,
  fail: (reason: AgentErrorReason, message: string) => TerminalEvent,
): TerminalEvent {
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  ) {
    return fail('auth', 'Anthropic API rejected the key');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return fail('rate_limit', 'Anthropic API rate limit');
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return fail('timeout', 'Anthropic API request timed out');
  }
  if (err instanceof Anthropic.APIError) {
    return fail('unknown', `Anthropic API error ${err.status ?? ''}: ${err.message}`.slice(0, 300));
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

function textOf(content: TranscriptMessage['content']): string {
  return typeof content === 'string'
    ? content
    : (content as readonly { type?: string; text?: string }[])
        .flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
        .join('\n');
}
