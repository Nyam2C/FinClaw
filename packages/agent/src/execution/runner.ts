// packages/agent/src/execution/runner.ts
import type { AgentRunParams, ConversationMessage, ToolCall, TokenUsage } from '@finclaw/types';
import { retry, type RetryOptions, ConcurrencyLaneManager, type LaneId } from '@finclaw/infra';
import type { ProviderAdapter, ProviderRequestParams } from '../providers/adapter.js';
import type { StreamEventListener, ExecutionResult } from './streaming.js';
import { classifyFallbackError } from '../errors.js';
import { StreamStateMachine } from './streaming.js';
import { TokenCounter } from './tokens.js';
import { ExecutionToolDispatcher } from './tool-executor.js';
import { ToolInputBuffer } from './tool-input-buffer.js';

export interface RunnerOptions {
  readonly provider: ProviderAdapter;
  readonly toolExecutor: ExecutionToolDispatcher;
  readonly laneManager: ConcurrencyLaneManager;
  readonly laneId?: LaneId;
  readonly maxTurns?: number;
  readonly retryOptions?: RetryOptions;
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

  constructor(options: RunnerOptions) {
    this.provider = options.provider;
    this.toolExecutor = options.toolExecutor;
    this.laneManager = options.laneManager;
    this.laneId = options.laneId ?? 'main';
    this.maxTurns = options.maxTurns ?? 10;
    this.retryOptions = options.retryOptions ?? {};
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
    const messages = [...params.messages];

    const handle = await this.laneManager.acquire(this.laneId, params.sessionKey as string);

    try {
      let turns = 0;

      while (turns < this.maxTurns) {
        if (params.abortSignal?.aborted) {
          return buildResult('aborted', messages, tokenCounter, startTime, turns);
        }

        turns++;

        const response = await retry(() => this.streamLLMCall(params, messages, listener), {
          ...this.retryOptions,
          shouldRetry: (error) => {
            const reason = classifyFallbackError(error as Error);
            return reason === 'rate-limit' || reason === 'server-error' || reason === 'timeout';
          },
          signal: params.abortSignal,
        });

        tokenCounter.add(response.usage);
        messages.push(response.message);

        tokenCounter.checkThresholds(listener);

        if (!response.toolCalls.length) {
          return buildResult('completed', messages, tokenCounter, startTime, turns);
        }

        const results = await this.toolExecutor.executeAll(response.toolCalls, params.abortSignal);

        messages.push({
          role: 'tool',
          content: results.map((r) => ({
            type: 'tool_result' as const,
            toolUseId: r.toolUseId,
            content: r.content,
            isError: r.isError,
          })),
        });
      }

      return buildResult('max_turns', messages, tokenCounter, startTime, turns);
    } finally {
      handle.release();
    }
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
  ): Promise<LLMCallResult> {
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
      temperature: params.temperature,
      maxTokens: params.maxTokens ?? params.model.maxOutputTokens,
      abortSignal: params.abortSignal,
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
