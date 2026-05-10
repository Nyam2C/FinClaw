// packages/agent/src/execution/tool-executor.ts
import type { ToolCall } from '@finclaw/types';

/** 도구 핸들러 인터페이스 */
export interface ToolHandler {
  execute(input: unknown, signal?: AbortSignal): Promise<string>;
  /**
   * Phase 30 B6: structured output 강제용 schema (Zod).
   * 정의된 도구는 executor 결과 (JSON string) 가 schema 일치해야 함.
   * 위반 시 isError: true 로 반환 → runner 의 다음 turn 에서 retry.
   */
  readonly outputSchema?: import('zod/v4').ZodType<unknown>;
  /** outputSchema 가 정의되어도 enforce 여부를 토글. */
  readonly enforceStructuredOutput?: boolean;
}

// TODO(L4): ExecutionToolResult와 streaming.ts의 ToolResult가 동일 shape.
//  하나로 통합하여 중복 제거 가능.
/** 도구 실행 결과 */
export interface ExecutionToolResult {
  readonly toolUseId: string;
  readonly content: string;
  readonly isError: boolean;
  /**
   * Phase 30 B6: structured output 위반 표시 (runner 가 1회 retry 결정에 사용).
   */
  readonly structuredOutputViolation?: boolean;
}

/** Phase 30 B6: 1회 retry 후 두 번째 violation 시 발생. */
export class StructuredOutputValidationError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly issues: unknown,
    message?: string,
  ) {
    super(message ?? `Tool '${toolName}' output violated structured output schema`);
    this.name = 'StructuredOutputValidationError';
  }
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

      // Phase 30 B6: outputSchema enforce 시 result(JSON 문자열) 를 검증.
      // 검증 실패 → isError + structuredOutputViolation. runner 가 다음 turn 에 동일 도구를 다시 호출하도록 모델에 안내.
      if (handler.outputSchema && handler.enforceStructuredOutput) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(result);
        } catch {
          parsed = undefined;
        }
        const validation = handler.outputSchema.safeParse(parsed);
        if (!validation.success) {
          return {
            toolUseId: call.id,
            content: `Tool '${call.name}' output schema violation: ${validation.error?.message ?? 'invalid'}`,
            isError: true,
            structuredOutputViolation: true,
          };
        }
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
