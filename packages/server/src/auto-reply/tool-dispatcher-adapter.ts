// packages/server/src/auto-reply/tool-dispatcher-adapter.ts
import {
  ExecutionToolDispatcher,
  toApiToolDefinition,
  type ToolExecutionContext,
  type ToolRegistry,
} from '@finclaw/agent';
import type { ToolDefinition } from '@finclaw/types';

export interface DispatcherContextBase {
  readonly sessionId: string;
  readonly userId: string;
  readonly channelId: string;
}

export interface BuiltDispatcher {
  readonly dispatcher: ExecutionToolDispatcher;
  readonly toolDefinitions: readonly ToolDefinition[];
}

/**
 * 현재 요청의 컨텍스트를 캡처한 ExecutionToolDispatcher를 생성한다.
 *
 * Runner는 생성 시점에 dispatcher를 고정하므로, 요청마다 새 dispatcher
 * (+ sessionId/userId가 묶인 ToolExecutionContext)가 필요하다.
 */
export function buildDispatcher(
  registry: ToolRegistry,
  ctx: DispatcherContextBase,
): BuiltDispatcher {
  const dispatcher = new ExecutionToolDispatcher();
  const registered = registry.list();

  for (const tool of registered) {
    const name = tool.definition.name;
    dispatcher.register(name, {
      async execute(input, signal) {
        const effectiveSignal = signal ?? new AbortController().signal;
        const executionCtx: ToolExecutionContext = {
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          channelId: ctx.channelId,
          abortSignal: effectiveSignal,
        };
        const result = await registry.execute(
          name,
          (input as Record<string, unknown> | null) ?? {},
          executionCtx,
        );
        return result.content;
      },
    });
  }

  return {
    dispatcher,
    toolDefinitions: registered.map((t) => toApiToolDefinition(t.definition)),
  };
}
