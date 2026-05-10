import { retry, type RetryOptions, ConcurrencyLaneManager, type LaneId } from '@finclaw/infra';
// packages/agent/src/execution/runner.ts
import type { AgentRunParams, ConversationMessage, ToolCall, TokenUsage } from '@finclaw/types';
import { classifyFallbackError } from '../errors.js';
import type { ProviderAdapter, ProviderRequestParams } from '../providers/adapter.js';
import type { StreamEventListener, ExecutionResult } from './streaming.js';
import { StreamStateMachine } from './streaming.js';
import { TokenCounter } from './tokens.js';
import { ExecutionToolDispatcher, StructuredOutputValidationError } from './tool-executor.js';
import { ToolInputBuffer } from './tool-input-buffer.js';

/**
 * Phase 30 A7: 옵셔널 tracer adapter — agent 패키지가 server 의 tracer 에 직접 의존하지
 * 않도록 최소 인터페이스만 받음. 상위 (server main.ts) 가 server 의 FinclawTracer
 * 를 어댑팅하여 주입.
 */
export interface RunnerTracerAdapter {
  withSpan<T>(
    name: string,
    attrs: Readonly<Record<string, unknown>>,
    fn: () => Promise<T>,
  ): Promise<T>;
}

export interface RunnerOptions {
  readonly provider: ProviderAdapter;
  readonly toolExecutor: ExecutionToolDispatcher;
  readonly laneManager: ConcurrencyLaneManager;
  readonly laneId?: LaneId;
  readonly maxTurns?: number;
  readonly retryOptions?: RetryOptions;
  readonly tracer?: RunnerTracerAdapter;
}

/** streamLLMCall 내부 반환값 */
interface LLMCallResult {
  readonly message: ConversationMessage;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: TokenUsage;
}

/**
 * 실행 엔진 메인 러너
 *
 * 사용자 메시지를 받아 LLM 호출 → tool_use 감지 → 도구 실행 → 후속 LLM 호출을
 * 반복하는 오케스트레이션 루프.
 *
 * 통합 모듈:
 * - retry() + classifyFallbackError(): 재시도 로직
 * - ConcurrencyLaneManager: 동시성 제어
 * - StreamStateMachine: 상태 전이 관리
 * - ToolInputBuffer: tool_use JSON 조합
 * - ExecutionToolDispatcher: 도구 실행
 * - TokenCounter: 토큰 카운팅 + 임계값 경고
 */
export class Runner {
  private readonly provider: ProviderAdapter;
  private readonly toolExecutor: ExecutionToolDispatcher;
  private readonly laneManager: ConcurrencyLaneManager;
  private readonly laneId: LaneId;
  private readonly maxTurns: number;
  private readonly retryOptions: RetryOptions;
  private readonly tracer?: RunnerTracerAdapter;

  constructor(options: RunnerOptions) {
    this.provider = options.provider;
    this.toolExecutor = options.toolExecutor;
    this.laneManager = options.laneManager;
    this.laneId = options.laneId ?? 'main';
    this.maxTurns = options.maxTurns ?? 10;
    this.retryOptions = options.retryOptions ?? {};
    this.tracer = options.tracer;
  }

  /**
   * 실행 루프 메인 엔트리포인트
   *
   * 1. Lane 핸들 획득
   * 2. Turn 루프:
   *    a. LLM 스트리밍 호출 (retry + classifyFallbackError 통합)
   *    b. tool_use 감지 시 도구 실행
   *    c. 도구 결과를 메시지에 추가
   *    d. maxTurns 도달 또는 tool_use 없으면 종료
   * 3. Lane 핸들 release
   */
  async execute(params: AgentRunParams, listener?: StreamEventListener): Promise<ExecutionResult> {
    const tokenCounter = new TokenCounter(params.model.contextWindow);
    const startTime = Date.now();
    const messages: ConversationMessage[] = [...params.messages];

    const handle = await this.laneManager.acquire(this.laneId, params.sessionKey as string);

    try {
      let turns = 0;
      // Phase 30 B6: structured output retry 추적 (도구 이름별 violation 횟수).
      const violationCount = new Map<string, number>();
      // 다음 turn 에 강제할 도구 이름 (직전 turn 의 violation 결과 reaction).
      let nextForceToolName: string | undefined;

      while (turns < this.maxTurns) {
        if (params.abortSignal?.aborted) {
          return buildResult('aborted', messages, tokenCounter, startTime, turns);
        }

        turns++;

        // Phase 30 A7: turn 단위 span — provider.stream + tool.execute 가 자식 span.
        const turnIdx = turns;
        const forceToolName = nextForceToolName;
        nextForceToolName = undefined;
        const turnRun = async (): Promise<{
          continueLoop: boolean;
          abortReturn?: ExecutionResult;
        }> => {
          const response = await this.runWithSpan(
            'provider.stream',
            { provider: this.provider.providerId, model: params.model.model, turn: turnIdx },
            () =>
              retry(() => this.streamLLMCall(params, messages, listener, forceToolName), {
                ...this.retryOptions,
                shouldRetry: (error) => {
                  const reason = classifyFallbackError(error as Error);
                  return (
                    reason === 'rate-limit' || reason === 'server-error' || reason === 'timeout'
                  );
                },
                signal: params.abortSignal,
              }),
          );

          tokenCounter.add(response.usage);
          messages.push(response.message);

          tokenCounter.checkThresholds(listener);

          if (!response.toolCalls.length) {
            return { continueLoop: false };
          }

          const results = await this.runWithSpan(
            'tool.execute',
            { count: response.toolCalls.length, turn: turnIdx },
            () => this.toolExecutor.executeAll(response.toolCalls, params.abortSignal),
          );

          // Phase 30 B6: structured output violation 처리. 도구별 1회 retry 후 두 번째 위반 시 throw.
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const call = response.toolCalls[i];
            if (r?.structuredOutputViolation && call) {
              const prev = violationCount.get(call.name) ?? 0;
              if (prev >= 1) {
                throw new StructuredOutputValidationError(
                  call.name,
                  r.content,
                  `Tool '${call.name}' violated structured output schema after retry`,
                );
              }
              violationCount.set(call.name, prev + 1);
              nextForceToolName = call.name;
            }
          }

          messages.push({
            role: 'tool',
            content: results.map((r) => ({
              type: 'tool_result' as const,
              toolUseId: r.toolUseId,
              content: r.content,
              isError: r.isError,
            })),
          });
          return { continueLoop: true };
        };

        const turnResult = await this.runWithSpan(
          'agent.turn',
          { turn: turnIdx, agentId: params.agentId },
          turnRun,
        );
        if (!turnResult.continueLoop) {
          return buildResult('completed', messages, tokenCounter, startTime, turns);
        }
      }

      return buildResult('max_turns', messages, tokenCounter, startTime, turns);
    } finally {
      handle.release();
    }
  }

  /** Phase 30 A7: tracer 미주입 시 fn 그대로 실행 (의미적 동등). */
  private async runWithSpan<T>(
    name: string,
    attrs: Readonly<Record<string, unknown>>,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.tracer) {
      return fn();
    }
    return this.tracer.withSpan(name, attrs, fn);
  }

  /**
   * 단일 LLM 스트리밍 호출
   *
   * provider.streamCompletion()으로 스트림을 열고,
   * StreamChunk를 소비하면서 텍스트/도구호출/사용량을 수집한다.
   */
  private async streamLLMCall(
    params: AgentRunParams,
    messages: ConversationMessage[],
    listener?: StreamEventListener,
    forceToolName?: string,
  ): Promise<LLMCallResult> {
    // TODO(L4): FSM이 LLM 호출마다 새로 생성되어 실행 루프 전체의 상태를 추적하지 않음.
    //  현재 동작 문제 없으나, 루프 전체 상태 추적이 필요하면 execute() 레벨로 승격 필요.
    const sm = new StreamStateMachine();
    if (listener) {
      sm.on(listener);
    }

    sm.transition('streaming');

    const buffer = new ToolInputBuffer();
    const toolCalls: ToolCall[] = [];
    let text = '';
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    const requestParams: ProviderRequestParams = {
      model: params.model.model,
      messages,
      tools: params.tools,
      systemPrompt: params.systemPrompt,
      temperature: params.temperature,
      maxTokens: params.maxTokens ?? params.model.maxOutputTokens,
      abortSignal: params.abortSignal,
      ...(forceToolName ? { forceToolChoice: { name: forceToolName } } : {}),
    };

    for await (const chunk of this.provider.streamCompletion(requestParams)) {
      switch (chunk.type) {
        case 'text_delta':
          text += chunk.text;
          listener?.({ type: 'text_delta', delta: chunk.text });
          break;

        case 'tool_use_start':
        case 'tool_input_delta':
        case 'tool_use_end': {
          const completed = buffer.feed(chunk);
          if (chunk.type === 'tool_use_start' && sm.currentState === 'streaming') {
            sm.transition('tool_use');
          }
          if (completed) {
            toolCalls.push(completed);
            listener?.({ type: 'tool_use_start', toolCall: completed });
          }
          break;
        }

        case 'usage':
          if (chunk.usage.inputTokens !== undefined) {
            Object.assign(usage, { inputTokens: chunk.usage.inputTokens });
          }
          if (chunk.usage.outputTokens !== undefined) {
            Object.assign(usage, { outputTokens: chunk.usage.outputTokens });
          }
          break;

        case 'done':
          break;
      }
    }

    const contentBlocks = [];
    if (text) {
      contentBlocks.push({ type: 'text' as const, text });
    }
    for (const tc of toolCalls) {
      contentBlocks.push({
        type: 'tool_use' as const,
        id: tc.id,
        name: tc.name,
        input: tc.input,
      });
    }

    const message: ConversationMessage = {
      role: 'assistant',
      content:
        contentBlocks.length === 1 && contentBlocks[0]?.type === 'text' ? text : contentBlocks,
    };

    // 상태 전이: streaming/tool_use → done
    if (sm.currentState === 'tool_use') {
      sm.transition('executing');
      sm.transition('done');
    } else if (sm.currentState === 'streaming') {
      sm.transition('done');
    }

    return { message, toolCalls, usage };
  }
}

function buildResult(
  status: ExecutionResult['status'],
  messages: ConversationMessage[],
  tokenCounter: TokenCounter,
  startTime: number,
  turns: number,
): ExecutionResult {
  return {
    status,
    messages,
    usage: tokenCounter.current,
    turns,
    durationMs: Date.now() - startTime,
  };
}
