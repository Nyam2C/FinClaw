// packages/server/src/auto-reply/execution-adapter.ts
import type { PipelineMsgContext } from './pipeline-context.js';

/**
 * Phase 9 AI 실행 엔진과의 브릿지 인터페이스
 *
 * Phase 8은 "무엇을 실행할지" 결정하고, Phase 9는 "어떻게 실행할지" 담당한다.
 */
export interface ExecutionAdapter {
  execute(ctx: PipelineMsgContext, signal: AbortSignal): Promise<ExecutionResult>;
}

export interface ExecutionResult {
  readonly content: string;
  readonly usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Phase 8 테스트용 Mock 어댑터
 * Phase 9 구현 전까지 사용.
 */
export class MockExecutionAdapter implements ExecutionAdapter {
  constructor(private readonly defaultResponse: string = 'Mock response') {}

  async execute(_ctx: PipelineMsgContext, _signal: AbortSignal): Promise<ExecutionResult> {
    return {
      content: this.defaultResponse,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}
