// packages/server/src/auto-reply/pipeline.ts
import type { AgentRunPort } from '@finclaw/agent';
import type { FinClawLogger } from '@finclaw/infra';
import type { ChannelPlugin, MsgContext } from '@finclaw/types';
import type { FinclawTracer } from '../observability/tracer.js';
import type { CommandRegistry } from './commands/registry.js';
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

/** 파이프라인 설정 */
export interface PipelineConfig {
  readonly commandPrefix: string;
  readonly timeoutMs: number;
}

/** 파이프라인 의존성 주입 */
export interface PipelineDependencies {
  /** Phase 46: 실행은 AgentRuntime (capture·retrieval 은 runtime.prepareTurn 소유 — D4). */
  readonly runtime: AgentRunPort;
  readonly commandRegistry: CommandRegistry;
  readonly logger: FinClawLogger;
  readonly getChannel: (
    channelId: string,
  ) => Pick<ChannelPlugin, 'send' | 'sendTyping'> | undefined;
  /** Phase 30 A6: 옵셔널 OTel tracer — 주입 시 각 stage 가 span 으로 묶임. */
  readonly tracer?: FinclawTracer;
}

/**
 * 파이프라인 오케스트레이터
 *
 * 진입점: MessageRouter의 onProcess 콜백
 *
 * 데이터 흐름:
 * MsgContext
 *   -> [normalize] -> NormalizedMessage
 *   -> [command]   -> CommandResult | PassthroughMessage (또는 skip)
 *   -> [ack]       -> AckedMessage
 *   -> [context]   -> PipelineMsgContext
 *   -> [execute]   -> ExecuteResult (via AgentRuntime)
 *   -> [deliver]   -> OutboundMessage
 */
export class AutoReplyPipeline {
  constructor(
    private readonly config: PipelineConfig,
    private readonly deps: PipelineDependencies,
  ) {}

  /** MessageRouter.onProcess 콜백으로 등록할 진입점 */
  async process(ctx: MsgContext): Promise<void> {
    const tracer = this.deps.tracer;
    if (tracer) {
      await tracer.withSpan(
        'pipeline.process',
        { sessionKey: ctx.sessionKey, channelId: ctx.channelId },
        async () => this.runPipeline(ctx),
      );
      return;
    }
    await this.runPipeline(ctx);
  }

  private async runPipeline(ctx: MsgContext): Promise<void> {
    const tracer = this.deps.tracer;

    // 파이프라인 타임아웃
    const combinedSignal = AbortSignal.timeout(this.config.timeoutMs);

    // tracer 미주입 환경 (test 등) 은 fn 을 그대로 실행 — 의미적 동등.
    const stageSpan = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      if (!tracer) {
        return fn();
      }
      return tracer.withSpan(`stage.${name}`, { sessionKey: ctx.sessionKey }, async () => fn());
    };

    let typing: TypingController | undefined;

    try {
      // Stage 1: Normalize
      if (combinedSignal.aborted) {
        this.logAbort('normalize');
        return;
      }
      const normalizeResult = await stageSpan('normalize', async () => normalizeMessage(ctx));

      if (normalizeResult.action !== 'continue') {
        return;
      }
      const normalized = normalizeResult.data;

      // Stage 2: Command
      if (combinedSignal.aborted) {
        this.logAbort('command');
        return;
      }
      const cmdResult = await stageSpan('command', async () =>
        commandStage(
          normalized.normalizedBody,
          this.deps.commandRegistry,
          this.config.commandPrefix,
          ctx,
        ),
      );

      if (cmdResult.action !== 'continue') {
        return;
      }

      // Stage 3: ACK
      if (combinedSignal.aborted) {
        this.logAbort('ack');
        return;
      }
      const channel = this.deps.getChannel(ctx.channelId as string);
      const noopChannel = { send: undefined, sendTyping: undefined };
      const ackResult = await stageSpan('ack', async () =>
        ackStage(channel ?? noopChannel, ctx.channelId as string, ctx.chatId ?? ctx.senderId),
      );

      if (ackResult.action === 'continue') {
        typing = ackResult.data.typing;
      }

      // Stage 4: Context
      if (combinedSignal.aborted) {
        typing?.seal();
        this.logAbort('context');
        return;
      }
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

      const ctxResult = await stageSpan('context', async () =>
        contextStage(ctx, normalized, channelCaps),
      );

      if (ctxResult.action !== 'continue') {
        typing?.seal();
        if (ctxResult.action === 'abort') {
          this.logAbort('context');
        }
        return;
      }
      const enrichedCtx = ctxResult.data;

      // Stage 5: Execute
      if (combinedSignal.aborted) {
        typing?.seal();
        this.logAbort('execute');
        return;
      }
      const execResult = await stageSpan('execute', async () =>
        executeStage(enrichedCtx, this.deps.runtime, combinedSignal),
      );

      if (execResult.action !== 'continue') {
        typing?.seal();
        return;
      }

      // Stage 6: Deliver — capture 꼬리표는 done.captured 로 돌아온다 (D4)
      typing?.seal();
      if (combinedSignal.aborted) {
        this.logAbort('deliver');
        return;
      }
      const deliverCtx = execResult.data.captured
        ? { ...enrichedCtx, capturedMemory: execResult.data.captured }
        : enrichedCtx;
      await stageSpan('deliver', async () =>
        deliverResponse(execResult.data, deliverCtx, channel ?? noopChannel, this.deps.logger),
      );
    } catch (error) {
      typing?.seal();
      throw error;
    }
  }

  private logAbort(stage: string): void {
    this.deps.logger.warn('Pipeline aborted', { stage });
  }
}
