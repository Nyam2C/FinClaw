// packages/agent/src/agents/session/tool-result-guard.ts
// OpenClaw src/agents/pi-embedded-runner/tool-result-truncation.ts:43-140 이식.

/**
 * OpenClaw 원본 상수 그대로:
 * - HARD_MAX_TOOL_RESULT_CHARS = 400_000  (~100K tokens; 200K context 의 50%)
 * - MIN_KEEP_CHARS = 2_000  (truncation 시 최소 보존)
 */
export const HARD_MAX_TOOL_RESULT_CHARS = 400_000;
export const MIN_KEEP_CHARS = 2_000;

export const TRUNCATION_SUFFIX =
  "\n\n[Content truncated — original was too large for the model's context window. " +
  'The content above is a partial view. If you need more, request specific sections or use ' +
  'offset/limit parameters to read smaller chunks.]';

/** text content block (Anthropic / FinClaw 공통 부분 형태). */
type TextContentBlock = { type: string; text?: string };

/**
 * tool_result block 의 구조적 최소 형태.
 * FinClaw `ContentBlock` (camelCase toolUseId) 와 Anthropic `ToolResultBlockParam`
 * (snake_case tool_use_id) 모두 만족 — content 만 읽고 나머지는 보존한다.
 */
type ToolResultLike = { content: string | TextContentBlock[] };

/**
 * OpenClaw `truncateToolResultText` 그대로 — 줄바꿈 경계 자르기.
 */
export function truncateToolResultText(
  text: string,
  maxChars: number,
  options: { suffix?: string; minKeepChars?: number } = {},
): string {
  const suffix = options.suffix ?? TRUNCATION_SUFFIX;
  const minKeep = options.minKeepChars ?? MIN_KEEP_CHARS;
  if (text.length <= maxChars) {
    return text;
  }

  const keepChars = Math.max(minKeep, maxChars - suffix.length);
  let cutPoint = keepChars;
  const lastNewline = text.lastIndexOf('\n', keepChars);
  if (lastNewline > keepChars * 0.8) {
    cutPoint = lastNewline;
  }
  return text.slice(0, cutPoint) + suffix;
}

/**
 * Tool result block 의 content 를 truncate.
 * content 가 string 또는 text block 배열인 두 형태 모두 지원.
 */
export function truncateToolResult<T extends ToolResultLike>(
  block: T,
  maxChars: number = HARD_MAX_TOOL_RESULT_CHARS,
): T {
  if (typeof block.content === 'string') {
    return {
      ...block,
      content: truncateToolResultText(block.content, maxChars),
    };
  }
  if (!Array.isArray(block.content)) {
    return block;
  }

  // 전체 text 길이 합산
  const totalChars = block.content.reduce((sum, c) => {
    if (c.type === 'text' && typeof c.text === 'string') {
      return sum + c.text.length;
    }
    return sum;
  }, 0);
  if (totalChars <= maxChars) {
    return block;
  }

  // 비율 기반 분할 truncate
  const newContent = block.content.map((c) => {
    if (c.type !== 'text' || typeof c.text !== 'string') {
      return c;
    }
    const share = c.text.length / totalChars;
    const blockMax = Math.max(MIN_KEEP_CHARS, Math.floor(maxChars * share));
    return { ...c, text: truncateToolResultText(c.text, blockMax) };
  });

  return { ...block, content: newContent };
}

/**
 * 메시지 배열 일괄 처리 — 모든 user 메시지의 tool_result block guard.
 */
export function applyToolResultGuard<T extends { role: string; content: unknown }>(
  messages: T[],
  maxChars: number = HARD_MAX_TOOL_RESULT_CHARS,
): T[] {
  return messages.map((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) {
      return msg;
    }
    const newContent = (msg.content as Array<{ type?: string }>).map((block) => {
      if (block.type === 'tool_result') {
        return truncateToolResult(block as ToolResultLike, maxChars);
      }
      return block;
    });
    return { ...msg, content: newContent };
  });
}
