// packages/agent/src/execution/runner.ts
import type { ConcurrencyLaneManager, LaneId } from '@finclaw/infra';
import type { AgentRunParams, ConversationMessage, TokenUsage } from '@finclaw/types';
import type { ProviderAdapter } from '../providers/adapter.js';
import type { StreamEventListener, ExecutionResult } from './streaming.js';

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
  readonly laneManager: ConcurrencyLaneManager;
  readonly laneId?: LaneId;
  readonly tracer?: RunnerTracerAdapter;
}

/** Runner 생성 팩토리. Phase 39: server execution-adapter 에서 이동 (gateway 가 직접 import). */
export type RunnerFactory = () => Runner;

/**
 * 실행 엔진 메인 러너
 *
 * lane 획득 → provider 1회 호출 → assistant 텍스트 메시지 → lane release.
 * 도구 호출은 claude CLI 내부 루프가 gateway /mcp 로 직접 수행하므로 여기서는 다루지 않는다.
 */
export class Runner {
  private readonly provider: ProviderAdapter;
  private readonly laneManager: ConcurrencyLaneManager;
  private readonly laneId: LaneId;
  private readonly tracer?: RunnerTracerAdapter;

  constructor(options: RunnerOptions) {
    this.provider = options.provider;
    this.laneManager = options.laneManager;
    this.laneId = options.laneId ?? 'main';
    this.tracer = options.tracer;
  }

  async execute(params: AgentRunParams, listener?: StreamEventListener): Promise<ExecutionResult> {
    const startTime = Date.now();
    const handle = await this.laneManager.acquire(this.laneId, params.sessionKey as string);

    try {
      if (params.abortSignal?.aborted) {
        return {
          status: 'aborted',
          messages: params.messages,
          usage: { inputTokens: 0, outputTokens: 0 },
          durationMs: Date.now() - startTime,
        };
      }

      // Phase 30 A7: agent.turn span 아래 provider.stream span.
      const { message, usage } = await this.runWithSpan(
        'agent.turn',
        { turn: 1, agentId: params.agentId },
        () =>
          this.runWithSpan(
            'provider.stream',
            { provider: this.provider.providerId, model: params.model.model, turn: 1 },
            () => this.streamLLMCall(params, listener),
          ),
      );

      return {
        status: 'completed',
        messages: [...params.messages, message],
        usage,
        durationMs: Date.now() - startTime,
      };
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

  /** 단일 LLM 호출 — StreamChunk 를 소비하며 텍스트/사용량을 수집한다. */
  private async streamLLMCall(
    params: AgentRunParams,
    listener?: StreamEventListener,
  ): Promise<{ message: ConversationMessage; usage: TokenUsage }> {
    let text = '';
    const usage = { inputTokens: 0, outputTokens: 0 };

    for await (const chunk of this.provider.streamCompletion({
      model: params.model.model,
      messages: params.messages,
      systemPrompt: params.systemPrompt,
      abortSignal: params.abortSignal,
    })) {
      if (chunk.type === 'text_delta') {
        text += chunk.text;
        listener?.({ type: 'text_delta', delta: chunk.text });
      } else if (chunk.type === 'usage') {
        usage.inputTokens = chunk.usage.inputTokens ?? usage.inputTokens;
        usage.outputTokens = chunk.usage.outputTokens ?? usage.outputTokens;
      }
    }

    return { message: { role: 'assistant', content: text }, usage };
  }
}
