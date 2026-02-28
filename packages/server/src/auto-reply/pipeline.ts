import type { FinClawLogger } from '@finclaw/infra';
// packages/server/src/auto-reply/pipeline.ts
import type { MsgContext, OutboundMessage, ChannelPlugin } from '@finclaw/types';
import type { BindingMatch } from '../process/binding-matcher.js';
import type { CommandRegistry } from './commands/registry.js';
import type { ExecutionAdapter } from './execution-adapter.js';
import type { PipelineObserver } from './observer.js';
import type { FinanceContextProvider } from './pipeline-context.js';
import { ackStage, type TypingController } from './stages/ack.js';
import { commandStage } from './stages/command.js';
import { contextStage } from './stages/context.js';
import { deliverResponse } from './stages/deliver.js';
import { executeStage } from './stages/execute.js';
import { normalizeMessage } from './stages/normalize.js';

// ── Stage Result types ──

/** 단계 실행 결과 */
export type StageResult<T> =
  | { readonly action: 'continue'; readonly data: T }
  | { readonly action: 'skip'; readonly reason: string }
  | { readonly action: 'abort'; readonly reason: string; readonly error?: Error };

/** 파이프라인 실행 결과 */
export interface PipelineResult {
  readonly success: boolean;
  readonly stagesExecuted: readonly string[];
  readonly abortedAt?: string;
  readonly abortReason?: string;
  readonly durationMs: number;
  readonly response?: OutboundMessage;
}

/** 파이프라인 설정 */
export interface PipelineConfig {
  readonly enableAck: boolean;
  readonly commandPrefix: string;
  readonly maxResponseLength: number;
  readonly timeoutMs: number;
  readonly respectMarketHours: boolean;
}

/** 파이프라인 의존성 주입 */
export interface PipelineDependencies {
  readonly executionAdapter: ExecutionAdapter;
  readonly financeContextProvider: FinanceContextProvider;
  readonly commandRegistry: CommandRegistry;
  readonly logger: FinClawLogger;
  readonly observer?: PipelineObserver;
  readonly getChannel: (
    channelId: string,
  ) => Pick<ChannelPlugin, 'send' | 'addReaction' | 'sendTyping'> | undefined;
}

/**
 * 파이프라인 오케스트레이터
 *
 * 진입점: MessageRouter의 onProcess 콜백
 *
 * 데이터 흐름:
 * MsgContext + BindingMatch + AbortSignal
 *   -> [normalize] -> NormalizedMessage
 *   -> [command]   -> CommandResult | PassthroughMessage (또는 skip)
 *   -> [ack]       -> AckedMessage
 *   -> [context]   -> PipelineMsgContext
 *   -> [execute]   -> ExecuteResult (via ExecutionAdapter)
 *   -> [deliver]   -> PipelineResult
 */
export class AutoReplyPipeline {
  constructor(
    private readonly config: PipelineConfig,
    private readonly deps: PipelineDependencies,
  ) {}

  /** MessageRouter.onProcess 콜백으로 등록할 진입점 */
  async process(ctx: MsgContext, match: BindingMatch, signal: AbortSignal): Promise<void> {
    const startTime = performance.now();
    const stagesExecuted: string[] = [];

    // AbortSignal.any: 외부 취소 + 파이프라인 타임아웃 결합
    const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);

    this.deps.observer?.onPipelineStart?.(ctx);

    let typing: TypingController | undefined;

    try {
      // Stage 1: Normalize
      if (combinedSignal.aborted) {
        this.emitAbort(ctx, stagesExecuted, 'normalize', startTime);
        return;
      }
      this.deps.observer?.onStageStart?.('normalize', ctx);
      const normalizeResult = normalizeMessage(ctx);
      stagesExecuted.push('normalize');
      this.deps.observer?.onStageComplete?.('normalize', normalizeResult);

      if (normalizeResult.action !== 'continue') {
        this.emitComplete(ctx, stagesExecuted, startTime);
        return;
      }
      const normalized = normalizeResult.data;

      // Stage 2: Command
      if (combinedSignal.aborted) {
        this.emitAbort(ctx, stagesExecuted, 'command', startTime);
        return;
      }
      this.deps.observer?.onStageStart?.('command', ctx);
      const cmdResult = await commandStage(
        normalized.normalizedBody,
        this.deps.commandRegistry,
        this.config.commandPrefix,
        ctx,
      );
      stagesExecuted.push('command');
      this.deps.observer?.onStageComplete?.('command', cmdResult);

      if (cmdResult.action !== 'continue') {
        this.emitComplete(ctx, stagesExecuted, startTime);
        return;
      }

      // Stage 3: ACK
      if (combinedSignal.aborted) {
        this.emitAbort(ctx, stagesExecuted, 'ack', startTime);
        return;
      }
      this.deps.observer?.onStageStart?.('ack', ctx);
      const channel = this.deps.getChannel(ctx.channelId as string);
      const noopChannel = { send: undefined, addReaction: undefined, sendTyping: undefined };
      const ackResult = await ackStage(
        channel ?? noopChannel,
        '', // messageId — MsgContext에 없으므로 빈 문자열. MsgContext 확장 시 messageId 필드 추가 필요.
        ctx.channelId as string,
        ctx.senderId,
        this.config.enableAck,
        this.deps.logger,
      );
      stagesExecuted.push('ack');
      this.deps.observer?.onStageComplete?.('ack', ackResult);

      if (ackResult.action === 'continue') {
        typing = ackResult.data.typing;
      }

      // Stage 4: Context
      if (combinedSignal.aborted) {
        typing?.seal();
        this.emitAbort(ctx, stagesExecuted, 'context', startTime);
        return;
      }
      this.deps.observer?.onStageStart?.('context', ctx);
      const channelCaps = channel
        ? {
            supportsMarkdown: true,
            supportsImages: true,
            supportsAudio: false,
            supportsVideo: false,
            supportsButtons: false,
            supportsThreads: true,
            supportsReactions: true,
            supportsEditing: true,
            maxMessageLength: 2000,
          }
        : {
            supportsMarkdown: false,
            supportsImages: false,
            supportsAudio: false,
            supportsVideo: false,
            supportsButtons: false,
            supportsThreads: false,
            supportsReactions: false,
            supportsEditing: false,
            maxMessageLength: 2000,
          };

      const ctxResult = await contextStage(
        ctx,
        normalized,
        {
          financeContextProvider: this.deps.financeContextProvider,
          channelCapabilities: channelCaps,
        },
        combinedSignal,
      );
      stagesExecuted.push('context');
      this.deps.observer?.onStageComplete?.('context', ctxResult);

      if (ctxResult.action !== 'continue') {
        typing?.seal();
        if (ctxResult.action === 'abort') {
          this.emitAbort(ctx, stagesExecuted, 'context', startTime);
        } else {
          this.emitComplete(ctx, stagesExecuted, startTime);
        }
        return;
      }
      const enrichedCtx = ctxResult.data;

      // Stage 5: Execute
      if (combinedSignal.aborted) {
        typing?.seal();
        this.emitAbort(ctx, stagesExecuted, 'execute', startTime);
        return;
      }
      this.deps.observer?.onStageStart?.('execute', ctx);
      const execResult = await executeStage(
        enrichedCtx,
        this.deps.executionAdapter,
        combinedSignal,
      );
      stagesExecuted.push('execute');
      this.deps.observer?.onStageComplete?.('execute', execResult);

      if (execResult.action !== 'continue') {
        typing?.seal();
        this.emitComplete(ctx, stagesExecuted, startTime);
        return;
      }

      // Stage 6: Deliver
      typing?.seal();
      if (combinedSignal.aborted) {
        this.emitAbort(ctx, stagesExecuted, 'deliver', startTime);
        return;
      }
      this.deps.observer?.onStageStart?.('deliver', ctx);
      const deliverResult = await deliverResponse(
        execResult.data,
        enrichedCtx,
        channel ?? noopChannel,
        this.deps.logger,
      );
      stagesExecuted.push('deliver');
      this.deps.observer?.onStageComplete?.('deliver', deliverResult);

      const response = deliverResult.action === 'continue' ? deliverResult.data : undefined;
      this.deps.observer?.onPipelineComplete?.(ctx, {
        success: true,
        stagesExecuted,
        durationMs: performance.now() - startTime,
        response,
      });
    } catch (error) {
      typing?.seal();
      this.deps.observer?.onPipelineError?.(ctx, error as Error);
      throw error;
    }
  }

  private emitAbort(
    ctx: MsgContext,
    stagesExecuted: string[],
    stage: string,
    startTime: number,
  ): void {
    this.deps.logger.warn('Pipeline aborted', { stage });
    this.deps.observer?.onPipelineComplete?.(ctx, {
      success: false,
      stagesExecuted,
      abortedAt: stage,
      abortReason: 'Signal aborted',
      durationMs: performance.now() - startTime,
    });
  }

  private emitComplete(ctx: MsgContext, stagesExecuted: string[], startTime: number): void {
    this.deps.observer?.onPipelineComplete?.(ctx, {
      success: true,
      stagesExecuted,
      durationMs: performance.now() - startTime,
    });
  }
}
