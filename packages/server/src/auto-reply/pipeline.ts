import type { FinClawLogger } from '@finclaw/infra';
// packages/server/src/auto-reply/pipeline.ts
import type { ChannelPlugin, MsgContext, TraceContext } from '@finclaw/types';
import type { FinclawTracer } from '../observability/tracer.js';
import type { CommandRegistry } from './commands/registry.js';
import type { ExecutionAdapter } from './execution-adapter.js';
import { ackStage, type TypingController } from './stages/ack.js';
import { commandStage } from './stages/command.js';
import { contextStage } from './stages/context.js';
import { deliverResponse } from './stages/deliver.js';
import { executeStage } from './stages/execute.js';
import {
  memoryCaptureStage,
  type MemoryCaptureResult,
  type MemoryCaptureService,
} from './stages/memory-capture.js';
import type { MemoryRetrievalService } from './stages/memory-retrieval.js';
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
  readonly executionAdapter: ExecutionAdapter;
  readonly commandRegistry: CommandRegistry;
  readonly logger: FinClawLogger;
  readonly getChannel: (
    channelId: string,
  ) => Pick<ChannelPlugin, 'send' | 'sendTyping'> | undefined;
  /** Phase 26 B: 명시적 기억 capture (정규식 5종 매칭). 미주입 시 capture 단계 no-op. */
  readonly memoryCaptureService?: MemoryCaptureService;
  /** Phase 26 C: 자동 회상 retrieval (hybrid/FTS). 미주입 시 retrieval 단계 no-op. */
  readonly memoryRetrievalService?: MemoryRetrievalService;
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
 *   -> [execute]   -> ExecuteResult (via ExecutionAdapter)
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
    let rootTraceContext: TraceContext | undefined = tracer?.getCurrentContext();

    // 파이프라인 타임아웃
    const combinedSignal = AbortSignal.timeout(this.config.timeoutMs);

    // tracer 미주입 환경 (test 등) 은 fn 을 그대로 실행 — 의미적 동등.
    const stageSpan = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      if (!tracer) {
        return fn();
      }
      return tracer.withSpan(`stage.${name}`, { sessionKey: ctx.sessionKey }, async (sctx) => {
        rootTraceContext = sctx;
        return fn();
      });
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

      // Stage 2.5: Memory Capture (Phase 26 B)
      // 정규식 5종("기억해/메모/선호/내 원칙/!finclaw remember") 매칭 시 명시적 저장.
      // 비명령 발화에만 동작 (command 단계가 'continue' 인 경우만 도달).
      // 실패해도 파이프라인 진행 (best-effort).
      let capturedMemory: MemoryCaptureResult | null = null;
      if (this.deps.memoryCaptureService) {
        const captureService = this.deps.memoryCaptureService;
        capturedMemory = await stageSpan('memory-capture', async () =>
          memoryCaptureStage(
            normalized.normalizedBody,
            ctx.sessionKey,
            captureService,
            this.deps.logger,
          ),
        );
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
      let enrichedCtx = capturedMemory
        ? {
            ...ctxResult.data,
            capturedMemory: {
              memoryId: capturedMemory.memoryId,
              type: capturedMemory.type,
              content: capturedMemory.content,
              duplicate: capturedMemory.duplicate,
            },
          }
        : ctxResult.data;

      // Stage 4.5: Memory Retrieval (Phase 26 C)
      // Context 직후, Execute 직전에 retrieval 호출.
      // 실패해도 파이프라인 진행 (best-effort) — 빈 retrievalResult 미주입.
      if (this.deps.memoryRetrievalService) {
        const retrievalService = this.deps.memoryRetrievalService;
        try {
          const retrievalResult = await stageSpan('memory-retrieval', async () =>
            retrievalService.searchRelevant({
              userQuery: enrichedCtx.normalizedBody,
              sessionKey: enrichedCtx.sessionKey,
            }),
          );
          enrichedCtx = { ...enrichedCtx, retrievalResult };
          // Phase 30 hotfix P0-3: rerankMeta 를 audit log 로 출력 (agent_runs.rerank_meta 부착은
          // auto-reply 경로에 addAgentRun 자체 호출이 없어 이번 phase 범위 밖).
          if (retrievalResult.rerankMeta) {
            this.deps.logger.info('memory.rerank.observed', {
              event: 'memory.rerank.observed',
              sessionKey: ctx.sessionKey,
              traceId: rootTraceContext?.traceId,
              model: retrievalResult.rerankMeta.model,
              topK: retrievalResult.rerankMeta.scoresAfter.length,
              swaps: retrievalResult.rerankMeta.swaps,
            });
          }
        } catch (err) {
          this.deps.logger.warn('memory retrieval failed (suppressed)', {
            event: 'memory.retrieval.stage_error',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Stage 5: Execute
      if (combinedSignal.aborted) {
        typing?.seal();
        this.logAbort('execute');
        return;
      }
      const execResult = await stageSpan('execute', async () =>
        executeStage(enrichedCtx, this.deps.executionAdapter, combinedSignal),
      );

      if (execResult.action !== 'continue') {
        typing?.seal();
        return;
      }

      // Stage 6: Deliver
      typing?.seal();
      if (combinedSignal.aborted) {
        this.logAbort('deliver');
        return;
      }
      await stageSpan('deliver', async () =>
        deliverResponse(execResult.data, enrichedCtx, channel ?? noopChannel, this.deps.logger),
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
