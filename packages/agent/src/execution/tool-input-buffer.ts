// packages/agent/src/execution/tool-input-buffer.ts
import type { ToolCall } from '@finclaw/types';
import type { StreamChunk } from '../models/provider-normalize.js';

/** 진행 중인 도구 호출 버퍼 */
interface PendingToolCall {
  readonly id: string;
  readonly name: string;
  inputJson: string;
}

/**
 * tool_use JSON 스트리밍 조합 버퍼
 *
 * Anthropic 스트리밍 API는 도구 입력을
 * tool_use_start → tool_input_delta* → tool_use_end 시퀀스로 전달한다.
 * JSON 조각을 버퍼링하여 완전한 ToolCall을 조립한다.
 */
export class ToolInputBuffer {
  private pending: PendingToolCall | null = null;

  /** StreamChunk를 처리하여 완성된 ToolCall을 반환 (미완성이면 null) */
  feed(chunk: StreamChunk): ToolCall | null {
    switch (chunk.type) {
      case 'tool_use_start':
        this.pending = { id: chunk.id, name: chunk.name, inputJson: '' };
        return null;

      case 'tool_input_delta':
        if (this.pending) {
          this.pending.inputJson += chunk.delta;
        }
        return null;

      case 'tool_use_end': {
        if (!this.pending) {
          return null;
        }
        const call: ToolCall = {
          id: this.pending.id,
          name: this.pending.name,
          input: JSON.parse(this.pending.inputJson || '{}'),
        };
        this.pending = null;
        return call;
      }

      default:
        return null;
    }
  }

  /** 미완성 버퍼 초기화 */
  reset(): void {
    this.pending = null;
  }
}
