// ─── Embedding provider interface & factory ───

export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  embedQuery(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export type EmbeddingMode = 'auto' | 'anthropic' | 'openai';

// NOTE(review-2 I-3): single apiKey — providers fall back to env vars (VOYAGE_API_KEY / OPENAI_API_KEY)
export interface EmbeddingConfig {
  readonly apiKey?: string;
}

/**
 * Create an embedding provider by mode.
 * 'auto' prefers anthropic (voyage-finance-2, 1024D) > openai.
 *
 * NOTE: vec0 DDL declares float[1024]. Only voyage-finance-2 (1024D) fits.
 * OpenAI text-embedding-3-small (1536D) will NOT work with the current schema.
 */
export async function createEmbeddingProvider(
  mode: EmbeddingMode,
  config?: EmbeddingConfig,
): Promise<EmbeddingProvider> {
  if (mode === 'anthropic' || mode === 'auto') {
    try {
      const { AnthropicEmbeddingProvider } = await import('./anthropic.js');
      return new AnthropicEmbeddingProvider(config?.apiKey);
    } catch (err) {
      if (mode === 'anthropic') {
        throw new Error('Failed to create Anthropic embedding provider', { cause: err });
      }
      const msg = err instanceof Error ? err.message : '';
      if (!msg.includes('API_KEY')) {
        throw err;
      }
    }
  }

  if (mode === 'openai' || mode === 'auto') {
    const { OpenAIEmbeddingProvider } = await import('./openai.js');
    return new OpenAIEmbeddingProvider(config?.apiKey);
  }

  throw new Error(`Unknown embedding mode: ${mode as string}`);
}
