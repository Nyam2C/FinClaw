import { describe, it, expect, vi } from 'vitest';
import type { ProviderRequestParams } from '../../../src/providers/adapter.js';
import { CliProviderAdapter } from '../../../src/providers/claude-cli/adapter.js';
import * as runnerMod from '../../../src/providers/claude-cli/runner.js';
import { createProviderAdapter } from '../../../src/providers/factory.js';

const params = (): ProviderRequestParams => ({
  model: 'sonnet',
  messages: [{ role: 'user', content: '안녕' }],
});

describe('CliProviderAdapter', () => {
  it('reports providerId claude-cli', () => {
    expect(new CliProviderAdapter().providerId).toBe('claude-cli');
  });

  it('streamCompletion yields text_delta → usage → done', async () => {
    vi.spyOn(runnerMod, 'runCliAgent').mockResolvedValue({
      text: '응답',
      sessionId: 'sess1',
      usage: { input: 10, output: 5 },
      durationMs: 100,
    });
    const a = new CliProviderAdapter();
    const chunks = [];
    for await (const c of a.streamCompletion(params())) {
      chunks.push(c);
    }
    expect(chunks).toEqual([
      { type: 'text_delta', text: '응답' },
      {
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimatedCostUsd: 0,
        },
      },
      { type: 'done' },
    ]);
  });

  it('surfaces CLI total_cost_usd as estimatedCostUsd in the usage chunk', async () => {
    vi.spyOn(runnerMod, 'runCliAgent').mockResolvedValue({
      text: 'x',
      usage: { input: 4, output: 270, costUsd: 0.0789 },
      durationMs: 1,
    });
    const a = new CliProviderAdapter();
    let cost: number | undefined;
    for await (const c of a.streamCompletion(params())) {
      if (c.type === 'usage') {
        cost = c.usage.estimatedCostUsd;
      }
    }
    expect(cost).toBe(0.0789);
  });

  it('serializes messages into prompt + passes model', async () => {
    const spy = vi.spyOn(runnerMod, 'runCliAgent').mockResolvedValue({ text: 'x', durationMs: 1 });
    const a = new CliProviderAdapter();
    for await (const _ of a.streamCompletion(params())) {
      /* drain */
    }
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('안녕'), modelId: 'sonnet' }),
    );
  });
});

describe('createProviderAdapter factory', () => {
  it('creates claude-cli adapter', () => {
    expect(createProviderAdapter({ kind: 'claude-cli' }).providerId).toBe('claude-cli');
  });
});
