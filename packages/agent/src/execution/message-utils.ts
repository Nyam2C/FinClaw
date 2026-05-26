// packages/agent/src/execution/message-utils.ts
import type { ContentBlock, ConversationMessage } from '@finclaw/types';

/** Phase 22: 도구 호출 감사용 메타데이터 — DeliverStage 출처 footer·DB 병렬 저장에서 소비 */
export interface ToolCallRecord {
  readonly name: string;
  readonly input: unknown;
  readonly output: string;
  readonly source?: string;
  readonly timestamp: number;
  readonly durationMs?: number;
  readonly isError?: boolean;
}

export function extractAssistantText(messages: readonly ConversationMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== 'assistant') {
      continue;
    }
    if (typeof msg.content === 'string') {
      return msg.content;
    }
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('');
    }
  }
  return '';
}

/** assistant tool_use 블록과 뒤따르는 tool tool_result 블록을 페어링해 감사 레코드 생성 */
export function collectToolCalls(
  messages: readonly ConversationMessage[],
  fallbackTimestamp: number,
): ToolCallRecord[] {
  const records: ToolCallRecord[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) {
      continue;
    }
    for (const block of msg.content) {
      if (block.type !== 'tool_use') {
        continue;
      }
      const resultMsg = messages.slice(i + 1).find((r) => r?.role === 'tool');
      const resultBlock =
        resultMsg && Array.isArray(resultMsg.content)
          ? resultMsg.content.find((b) => b.type === 'tool_result' && b.toolUseId === block.id)
          : undefined;
      records.push({
        name: block.name,
        input: block.input,
        output: resultBlock?.type === 'tool_result' ? resultBlock.content : '',
        timestamp: fallbackTimestamp,
        isError: resultBlock?.type === 'tool_result' ? resultBlock.isError : undefined,
      });
    }
  }
  return records;
}
