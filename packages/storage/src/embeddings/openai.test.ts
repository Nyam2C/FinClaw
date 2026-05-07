// Phase 29 C: OpenAIEmbeddingProvider dimensions option + assertEmbeddingDimension.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIEmbeddingProvider } from './openai.js';
import { assertEmbeddingDimension, EmbeddingDimensionMismatchError } from './registry.js';

describe('OpenAIEmbeddingProvider dimensions option', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: Array(1024).fill(0.01) }] }),
      text: async () => '',
    } as Response);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('default dimensions is 1536 (no truncation in API body)', async () => {
    const p = new OpenAIEmbeddingProvider({ apiKey: 'k' });
    expect(p.dimensions).toBe(1536);
    await p.embedQuery('hi');
    const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty('dimensions');
  });

  it('dimensions=1024 → API body includes dimensions:1024', async () => {
    const p = new OpenAIEmbeddingProvider({ apiKey: 'k', dimensions: 1024 });
    expect(p.dimensions).toBe(1024);
    await p.embedQuery('hi');
    const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      dimensions?: number;
    };
    expect(body.dimensions).toBe(1024);
  });

  it('legacy string apiKey constructor still works', () => {
    const p = new OpenAIEmbeddingProvider('legacy-key');
    expect(p.dimensions).toBe(1536);
  });

  it('assertEmbeddingDimension throws on mismatch', () => {
    const p = new OpenAIEmbeddingProvider({ apiKey: 'k' }); // 1536
    expect(() => assertEmbeddingDimension(p, 1024)).toThrow(EmbeddingDimensionMismatchError);
  });

  it('assertEmbeddingDimension passes on match', () => {
    const p = new OpenAIEmbeddingProvider({ apiKey: 'k', dimensions: 1024 });
    expect(() => assertEmbeddingDimension(p, 1024)).not.toThrow();
  });
});
