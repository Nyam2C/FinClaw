// packages/agent/src/execution/tool-executor.ts
import type { ToolCall } from '@finclaw/types';

/** 도구 핸들러 인터페이스 */
export interface ToolHandler {
  execute(input: unknown, signal?: AbortSignal): Promise<string>;
}

// TODO(L4): ExecutionToolResult와 streaming.ts의 ToolResult가 동일 shape.
//  하나로 통합하여 중복 제거 가능.
/** 도구 실행 결과 */
export interface ExecutionToolResult {
  readonly toolUseId: string;
  readonly content: string;
  readonly isError: boolean;
}

const MAX_RESULT_CHARS = 10_000;

/**
 * 도구 디스패치 및 병렬 실행
 *
 * - 등록된 ToolHandler에 도구 호출을 디스패치
 * - 미등록 도구는 isError: true로 반환
 * - 결과 크기 제한 (MAX_RESULT_CHARS: 10,000자)
 * - 병렬 실행 (Promise.all)
 */
export class ExecutionToolDispatcher {
  private readonly handlers = new Map<string, ToolHandler>();

  register(name: string, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }

  unregister(name: string): boolean {
    return this.handlers.delete(name);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  async executeAll(
    toolCalls: readonly ToolCall[],
    signal?: AbortSignal,
  ): Promise<readonly ExecutionToolResult[]> {
    return Promise.all(toolCalls.map((call) => this.executeSingle(call, signal)));
  }

  private async executeSingle(call: ToolCall, signal?: AbortSignal): Promise<ExecutionToolResult> {
    const handler = this.handlers.get(call.name);
    if (!handler) {
      return { toolUseId: call.id, content: `Unknown tool: ${call.name}`, isError: true };
    }

    try {
      let result = await handler.execute(call.input, signal);
      if (result.length > MAX_RESULT_CHARS) {
        result = result.slice(0, MAX_RESULT_CHARS) + '\n... [truncated]';
      }
      return { toolUseId: call.id, content: result, isError: false };
    } catch (error) {
      return {
        toolUseId: call.id,
        content: `Tool execution error: ${(error as Error).message}`,
        isError: true,
      };
    }
  }
}
