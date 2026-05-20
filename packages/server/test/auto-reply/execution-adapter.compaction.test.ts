import type { ConversationMessage, ModelRef } from '@finclaw/types';
import { describe, it, expect, vi } from 'vitest';
import { maybeCompactMessages } from '../../src/auto-reply/execution-adapter.js';

const MODEL: ModelRef = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
};

const tokenCounter = (text: string) => Math.ceil(text.length / 4);

function makeMessages(totalChars: number): ConversationMessage[] {
  // user/assistant 교대로 채워 totalChars 근사.
  const per = 2_000;
  const count = Math.ceil(totalChars / per);
  const msgs: ConversationMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'x'.repeat(per) });
  }
  return msgs;
}

describe('maybeCompactMessages', () => {
  it('returns original when tokenCounter/summarizer not injected', async () => {
    const messages = makeMessages(10_000);
    const result = await maybeCompactMessages(messages, MODEL, {});
    expect(result).toEqual(messages);
  });

  it('skips compaction when usedTokens < critical (85%)', async () => {
    const summarizer = vi.fn();
    // 200K contextWindow, effectiveMax ~196K tokens. 짧은 대화 → safe.
    const messages = makeMessages(40_000); // ~10K tokens << critical
    const result = await maybeCompactMessages(messages, MODEL, { tokenCounter, summarizer });
    expect(summarizer).not.toHaveBeenCalled();
    expect(result.length).toBe(messages.length);
  });

  it('triggers compaction when usedTokens >= critical (85%)', async () => {
    const summarizer = vi.fn().mockResolvedValue('요약된 대화');
    // effectiveMax = 200_000 - 4096 = 195_904 tokens. critical(85%) ~= 166_518 tokens
    // tokenCounter=char/4 → ~670K chars 이상이면 critical.
    const messages = makeMessages(800_000); // ~200K tokens >= critical
    const result = await maybeCompactMessages(messages, MODEL, { tokenCounter, summarizer });
    expect(summarizer).toHaveBeenCalled();
    expect(result.length).toBeLessThan(messages.length);
  });
});
