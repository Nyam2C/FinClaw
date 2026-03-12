import type { EmbeddingProvider } from './provider.js';

interface VoyageResponse {
  data: Array<{ embedding: number[] }>;
}

const BATCH_SIZE = 50;
const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';

export class AnthropicEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'anthropic';
  readonly model = 'voyage-finance-2';
  readonly dimensions = 1024;

  private readonly apiKey: string;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.VOYAGE_API_KEY;
    if (!key) {
      throw new Error('VOYAGE_API_KEY is required');
    }
    this.apiKey = key;
  }

  async embedQuery(text: string): Promise<number[]> {
    const res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: [text],
        input_type: 'query',
      }),
    });

    if (!res.ok) {
      throw new Error(`Voyage API error: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as VoyageResponse;
    return data.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      try {
        const res = await fetch(VOYAGE_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            input: batch,
            input_type: 'document',
          }),
        });

        if (!res.ok) {
          throw new Error(`Voyage API error: ${res.status}`);
        }

        const data = (await res.json()) as VoyageResponse;
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
