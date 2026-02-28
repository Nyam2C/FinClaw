import type { FinClawLogger, TypedEmitter, FinClawEventMap } from '@finclaw/infra';
// packages/server/src/auto-reply/observer.ts
import type { MsgContext } from '@finclaw/types';
import type { PipelineResult, StageResult } from './pipeline.js';

/**
 * 파이프라인 관측성 인터페이스
 *
 * 선택적(optional) DI — deps.observer? 로 주입.
 * 구현하지 않으면 관측 이벤트가 무시된다.
 */
export interface PipelineObserver {
  onPipelineStart?(ctx: MsgContext): void;
  onPipelineComplete?(ctx: MsgContext, result: PipelineResult): void;
  onPipelineError?(ctx: MsgContext, error: Error): void;
  onStageStart?(stageName: string, ctx: MsgContext): void;
  onStageComplete?(stageName: string, result: StageResult<unknown>): void;
}

/**
 * 기본 PipelineObserver 구현
 *
 * FinClawLogger를 활용하여 스테이지별 로깅 + EventBus 이벤트 발행.
 */
export class DefaultPipelineObserver implements PipelineObserver {
  constructor(
    private readonly logger: FinClawLogger,
    private readonly eventBus?: TypedEmitter<FinClawEventMap>,
  ) {}

  onPipelineStart(ctx: MsgContext): void {
    this.logger.debug('Pipeline started', { sessionKey: ctx.sessionKey });
    this.eventBus?.emit('pipeline:start', { sessionKey: ctx.sessionKey });
  }

  onPipelineComplete(ctx: MsgContext, result: PipelineResult): void {
    this.logger.info('Pipeline completed', {
      sessionKey: ctx.sessionKey,
      success: result.success,
      durationMs: result.durationMs,
      stages: result.stagesExecuted,
    });
    this.eventBus?.emit('pipeline:complete', {
      sessionKey: ctx.sessionKey,
      success: result.success,
      durationMs: result.durationMs,
      stagesExecuted: result.stagesExecuted,
      abortedAt: result.abortedAt,
      abortReason: result.abortReason,
    });
  }

  onPipelineError(ctx: MsgContext, error: Error): void {
    this.logger.error('Pipeline error', { sessionKey: ctx.sessionKey, error });
    this.eventBus?.emit('pipeline:error', { sessionKey: ctx.sessionKey, error });
  }

  onStageStart(stageName: string, ctx: MsgContext): void {
    this.logger.debug(`Stage ${stageName} started`, { sessionKey: ctx.sessionKey });
  }

  onStageComplete(stageName: string, result: StageResult<unknown>): void {
    this.logger.debug(`Stage ${stageName} completed`, { action: result.action });
  }
}
