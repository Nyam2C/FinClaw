import { resetEventBus } from '@finclaw/infra';
import { describe, it, expect, afterEach } from 'vitest';
import type { CompactionOptions } from '../src/agents/context/compaction.js';
import type { TranscriptEntry } from '../src/agents/session/transcript-repair.js';
import { compactContext } from '../src/agents/context/compaction.js';

// ── 헬퍼 ──

/** 간이 토큰 카운터: 문자 4개 = 1토큰 */
function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 간이 요약기 */
async function mockSummarizer(text: string): Promise<string> {
  return `[Summary of ${text.length} chars]`;
}

/** 실패하는 요약기 */
async function failingSummarizer(_text: string): Promise<string> {
  throw new Error('Summarizer unavailable');
}

function makeEntry(role: TranscriptEntry['role'], content: string, idx: number): TranscriptEntry {
  return {
    role,
    content,
    timestamp: `2024-01-01T00:00:${String(idx).padStart(2, '0')}Z`,
  };
}

function makeOptions(overrides?: Partial<CompactionOptions>): CompactionOptions {
  return {
    strategy: 'hybrid',
    targetTokens: 100,
    preserveRecentMessages: 2,
    preserveSystemPrompt: true,
    ...overrides,
  };
}

describe('compactContext', () => {
  afterEach(() => {
    resetEventBus();
  });

  it('목표 토큰 이하이면 압축하지 않는다', async () => {
    const entries: TranscriptEntry[] = [
      makeEntry('user', 'hi', 0),
      makeEntry('assistant', 'hello', 1),
    ];
    const result = await compactContext(
      entries,
      makeOptions({ targetTokens: 10000 }),
      mockSummarizer,
      countTokens,
    );

    expect(result.removedCount).toBe(0);
    expect(result.compactedEntries).toHaveLength(2);
    expect(result.beforeTokens).toBe(result.afterTokens);
  });

  it('truncate-tools 전략은 tool 결과를 축소한다', async () => {
    const entries: TranscriptEntry[] = [
      makeEntry('user', 'query', 0),
      makeEntry('assistant', 'calling tool', 1),
      makeEntry('tool', 'A'.repeat(400), 2), // 큰 tool 결과
      makeEntry('user', 'thanks', 3),
      makeEntry('assistant', 'done', 4),
    ];
    const result = await compactContext(
      entries,
      makeOptions({ strategy: 'truncate-tools', targetTokens: 50 }),
      mockSummarizer,
      countTokens,
    );

    const toolEntry = result.compactedEntries.find((e) => e.role === 'tool');
    expect(toolEntry?.content).toContain('[Result truncated');
    expect(result.strategy).toBe('truncate-tools');
  });

  it('truncate-oldest 전략은 오래된 메시지를 제거한다', async () => {
    const entries: TranscriptEntry[] = [
      makeEntry('user', 'A'.repeat(200), 0),
      makeEntry('assistant', 'B'.repeat(200), 1),
      makeEntry('user', 'C'.repeat(200), 2),
      makeEntry('assistant', 'D'.repeat(100), 3),
      makeEntry('user', 'recent1', 4),
      makeEntry('assistant', 'recent2', 5),
    ];
    const result = await compactContext(
      entries,
      makeOptions({ strategy: 'truncate-oldest', targetTokens: 100 }),
      mockSummarizer,
      countTokens,
    );

    expect(result.removedCount).toBeGreaterThan(0);
    // 최근 2개 메시지는 보존
    const lastTwo = result.compactedEntries.slice(-2);
    expect(lastTwo[0].content).toBe('recent1');
    expect(lastTwo[1].content).toBe('recent2');
  });

  it('summarize 전략은 AI 요약을 생성한다', async () => {
    const entries: TranscriptEntry[] = [
      makeEntry('user', 'A'.repeat(40000), 0),
      makeEntry('assistant', 'B'.repeat(40000), 1),
      makeEntry('user', 'recent', 2),
      makeEntry('assistant', 'reply', 3),
    ];
    // safeTarget = floor(6000/1.2) - 4096 = 904 → mockSummarizer의 짧은 요약이 통과
    const result = await compactContext(
      entries,
      makeOptions({ strategy: 'summarize', targetTokens: 6000 }),
      mockSummarizer,
      countTokens,
    );

    expect(result.summary).toBeDefined();
    const summaryEntry = result.compactedEntries.find((e) =>
      e.content.includes('[Previous conversation summary]'),
    );
    expect(summaryEntry).toBeDefined();
  });

  it('hybrid 전략은 초과량에 따라 자동 선택한다', async () => {
    const entries: TranscriptEntry[] = [
      makeEntry('user', 'A'.repeat(200), 0),
      makeEntry('assistant', 'B'.repeat(200), 1),
      makeEntry('user', 'recent', 2),
      makeEntry('assistant', 'reply', 3),
    ];
    const result = await compactContext(
      entries,
      makeOptions({ strategy: 'hybrid', targetTokens: 50 }),
      mockSummarizer,
      countTokens,
    );

    // 초과량이 크므로 summarize가 선택될 것
    expect(result.strategy).not.toBe('hybrid');
  });

  it('preserveRecentMessages만큼 최근 메시지를 보존한다', async () => {
    const entries: TranscriptEntry[] = [
      makeEntry('user', 'old1', 0),
      makeEntry('assistant', 'old2', 1),
      makeEntry('user', 'keep1', 2),
      makeEntry('assistant', 'keep2', 3),
    ];
    const result = await compactContext(
      entries,
      makeOptions({ strategy: 'truncate-oldest', targetTokens: 10, preserveRecentMessages: 2 }),
      mockSummarizer,
      countTokens,
    );

    const lastTwo = result.compactedEntries.slice(-2);
    expect(lastTwo[0].content).toBe('keep1');
    expect(lastTwo[1].content).toBe('keep2');
  });

  it('summarizer 실패 시 truncate-oldest로 폴백한다', async () => {
    const entries: TranscriptEntry[] = [
      makeEntry('user', 'A'.repeat(200), 0),
      makeEntry('assistant', 'B'.repeat(200), 1),
      makeEntry('user', 'recent', 2),
      makeEntry('assistant', 'reply', 3),
    ];
    const result = await compactContext(
      entries,
      makeOptions({ strategy: 'summarize', targetTokens: 50 }),
      failingSummarizer,
      countTokens,
    );

    // 요약 실패 → truncate-oldest 폴백
    expect(result.strategy).toBe('truncate-oldest');
    expect(result.summary).toBeUndefined();
  });
});
