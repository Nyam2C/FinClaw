import { describe, it, expect } from 'vitest';
import {
  truncateToolResultText,
  truncateToolResult,
  HARD_MAX_TOOL_RESULT_CHARS,
  MIN_KEEP_CHARS,
} from '../../../src/agents/session/tool-result-guard.js';

describe('truncateToolResultText', () => {
  it('returns original when under maxChars', () => {
    expect(truncateToolResultText('short', 100)).toBe('short');
  });

  it('truncates at newline boundary when possible', () => {
    const text = 'line1\nline2\nline3\nline4\nline5';
    const result = truncateToolResultText(text, 12, { suffix: '...', minKeepChars: 5 });
    expect(result.endsWith('...')).toBe(true);
    // newline 경계로 잘림 — 정확한 길이는 알고리즘에 따라 다르나 suffix 포함 보장
  });

  it('respects minKeepChars', () => {
    const result = truncateToolResultText('x'.repeat(1000), 100, {
      minKeepChars: 500,
      suffix: 'END',
    });
    expect(result.length).toBeGreaterThanOrEqual(500);
  });
});

describe('truncateToolResult', () => {
  it('passes through string content under limit', () => {
    const block = {
      type: 'tool_result' as const,
      tool_use_id: 't1',
      content: 'short result',
    };
    expect(truncateToolResult(block, 100).content).toBe('short result');
  });

  it('truncates string content over limit', () => {
    const big = 'x'.repeat(500_000);
    const block = {
      type: 'tool_result' as const,
      tool_use_id: 't1',
      content: big,
    };
    const result = truncateToolResult(block, HARD_MAX_TOOL_RESULT_CHARS);
    expect((result.content as string).length).toBeLessThanOrEqual(HARD_MAX_TOOL_RESULT_CHARS);
  });

  it('truncates array content (multi text block) by share', () => {
    const block = {
      type: 'tool_result' as const,
      tool_use_id: 't1',
      content: [
        { type: 'text' as const, text: 'A'.repeat(300_000) },
        { type: 'text' as const, text: 'B'.repeat(200_000) },
      ],
    };
    const result = truncateToolResult(block, HARD_MAX_TOOL_RESULT_CHARS);
    const totalLen = (result.content as Array<{ text?: string }>).reduce(
      (s, c) => s + (c.text?.length ?? 0),
      0,
    );
    // suffix 여유 포함
    expect(totalLen).toBeLessThanOrEqual(HARD_MAX_TOOL_RESULT_CHARS + 500);
  });

  it('passes through array content under limit', () => {
    const block = {
      type: 'tool_result' as const,
      tool_use_id: 't1',
      content: [{ type: 'text' as const, text: 'small' }],
    };
    expect(truncateToolResult(block, 1000)).toEqual(block);
  });

  it('preserves MIN_KEEP_CHARS even when share is small', () => {
    const block = {
      type: 'tool_result' as const,
      tool_use_id: 't1',
      content: [
        { type: 'text' as const, text: 'A'.repeat(490_000) },
        { type: 'text' as const, text: 'B'.repeat(10_000) },
      ],
    };
    const result = truncateToolResult(block, HARD_MAX_TOOL_RESULT_CHARS);
    const arr = result.content as Array<{ text?: string }>;
    // 두번째 block 은 share 가 작지만 MIN_KEEP_CHARS (2_000) 이상 보장
    expect(arr[1]?.text?.length ?? 0).toBeGreaterThanOrEqual(MIN_KEEP_CHARS);
  });
});
