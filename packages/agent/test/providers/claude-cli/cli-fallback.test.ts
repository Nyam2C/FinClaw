import { describe, it, expect, vi } from 'vitest';
import type { StreamChunk } from '../../../src/models/provider-normalize.js';
import type { ProviderAdapter, ProviderRequestParams } from '../../../src/providers/adapter.js';
import { CliProviderAdapter } from '../../../src/providers/claude-cli/adapter.js';
import { CliFailoverError } from '../../../src/providers/claude-cli/errors.js';
import * as runnerMod from '../../../src/providers/claude-cli/runner.js';

const params = (): ProviderRequestParams => ({
  model: 'sonnet',
  messages: [{ role: 'user', content: 'hi' }],
});

async function drain(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of iter) {
    out.push(c);
  }
  return out;
}

describe('CliProviderAdapter auth fallback (W2)', () => {
  it('delegates to sdkFallback when CLI throws auth error', async () => {
    vi.spyOn(runnerMod, 'runCliAgent').mockRejectedValue(
      new CliFailoverError('Please log in', {
        reason: 'auth',
        provider: 'claude-cli',
        model: 'sonnet',
      }),
    );
    const streamFn = vi.fn(async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'text_delta', text: 'sdk' };
      yield { type: 'done' };
    });
    const sdk: ProviderAdapter = {
      providerId: 'anthropic',
      chatCompletion: vi.fn(),
      streamCompletion: streamFn,
    };
    const a = new CliProviderAdapter({ sdkFallback: sdk });
    const chunks = await drain(a.streamCompletion(params()));
    expect(chunks).toContainEqual({ type: 'text_delta', text: 'sdk' });
    expect(streamFn).toHaveBeenCalled();
  });

  it('rethrows (no fallback delegation) when CLI fails with non-auth reason', async () => {
    vi.spyOn(runnerMod, 'runCliAgent').mockRejectedValue(
      new CliFailoverError('timeout', {
        reason: 'timeout',
        provider: 'claude-cli',
        model: 'sonnet',
      }),
    );
    const streamFn = vi.fn();
    const sdk: ProviderAdapter = {
      providerId: 'anthropic',
      chatCompletion: vi.fn(),
      streamCompletion: streamFn,
    };
    const a = new CliProviderAdapter({ sdkFallback: sdk });
    await expect(drain(a.streamCompletion(params()))).rejects.toMatchObject({ reason: 'timeout' });
    expect(streamFn).not.toHaveBeenCalled();
  });
});
