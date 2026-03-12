import type { EmbeddingProvider } from './provider.js';

interface OpenAIResponse {
  data: Array<{ embedding: number[] }>;
}

const BATCH_SIZE = 100;
const OPENAI_URL = 'https://api.openai.com/v1/embeddings';

/**
 * OpenAI text-embedding-3-small provider (1536D).
 *
 * WARNING: vec0 DDL declares float[1024]. This provider's 1536D output
 * will NOT fit the current schema. Use voyage-finance-2 (1024D) instead.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai';
  readonly model = 'text-embedding-3-small';
  readonly dimensions = 1536;

  private readonly apiKey: string;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error('OPENAI_API_KEY is required');
    }
    this.apiKey = key;
  }

  async embedQuery(text: string): Promise<number[]> {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as OpenAIResponse;
    return data.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      try {
        const res = await fetch(OPENAI_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            input: batch,
          }),
        });

        if (!res.ok) {
          throw new Error(`OpenAI API error: ${res.status}`);
        }

        const data = (await res.json()) as OpenAIResponse;
        results.push(...data.data.map((d) => d.embedding));
      } catch {
        // Fallback: embed individually
        for (const text of batch) {
          results.push(await this.embedQuery(text));
        }
      }
    }

    return results;
  }
}
