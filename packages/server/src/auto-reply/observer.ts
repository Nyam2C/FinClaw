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
