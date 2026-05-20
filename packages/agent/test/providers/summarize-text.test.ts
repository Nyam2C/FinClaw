import { describe, it, expect, vi } from 'vitest';
import { summarizeText } from '../../src/providers/anthropic.js';

type SummarizeClient = Parameters<typeof summarizeText>[1];

function mockClient(content: unknown): SummarizeClient {
  return {
    messages: { create: vi.fn().mockResolvedValue({ content }) },
  } as unknown as SummarizeClient;
}

describe('summarizeText', () => {
  it('text 블록이 있으면 요약 텍스트를 반환한다', async () => {
    const client = mockClient([{ type: 'text', text: '요약된 내용' }]);
    await expect(summarizeText('긴 대화', client, 'claude-sonnet-4-6')).resolves.toBe(
      '요약된 내용',
    );
  });

  it('빈 text 응답이면 throw 한다 (compactContext 폴백 유도)', async () => {
    const client = mockClient([{ type: 'text', text: '   ' }]);
    await expect(summarizeText('긴 대화', client, 'claude-sonnet-4-6')).rejects.toThrow(
      'empty or non-text',
    );
  });

  it('비-text 블록이면 throw 한다', async () => {
    const client = mockClient([{ type: 'tool_use', id: 'x', name: 'y', input: {} }]);
    await expect(summarizeText('긴 대화', client, 'claude-sonnet-4-6')).rejects.toThrow(
      'empty or non-text',
    );
  });

  it('빈 content 배열이면 throw 한다', async () => {
    const client = mockClient([]);
    await expect(summarizeText('긴 대화', client, 'claude-sonnet-4-6')).rejects.toThrow(
      'empty or non-text',
    );
  });
});
