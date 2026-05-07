import type { EmbeddingProvider } from './provider.js';

interface OpenAIResponse {
  data: Array<{ embedding: number[] }>;
}

const BATCH_SIZE = 100;
const OPENAI_URL = 'https://api.openai.com/v1/embeddings';

/** Phase 29 C4: OpenAI provider 옵션. 문자열 전달 시 apiKey 로 처리 (구버전 호환). */
export interface OpenAIEmbeddingOptions {
  apiKey?: string;
  /** 출력 차원 truncation (기본 1536, 1024 로 설정 시 vec0 1024D 와 매칭). */
  dimensions?: number;
}

/**
 * OpenAI text-embedding-3-small provider.
 *
 * Phase 29 C: `dimensions` 옵션으로 출력 차원 truncation 지원.
 *   - 기본: 1536D (vec0 1024D 와 mismatch — assertEmbeddingDimension 가 차단)
 *   - `{ dimensions: 1024 }`: API body 의 `dimensions` 필드로 1024D 출력 → vec0 매칭.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai';
  readonly model = 'text-embedding-3-small';
  readonly dimensions: number;

  private readonly apiKey: string;
  private readonly truncationDim: number | undefined;

  constructor(opts?: OpenAIEmbeddingOptions | string) {
    // 기존 호출 호환성: 문자열 전달 시 apiKey 로 처리.
    const config = typeof opts === 'string' ? { apiKey: opts } : (opts ?? {});
    const key = config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error('OPENAI_API_KEY is required');
    }
    this.apiKey = key;
    this.truncationDim = config.dimensions;
    this.dimensions = config.dimensions ?? 1536;
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
        ...(this.truncationDim ? { dimensions: this.truncationDim } : {}),
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
            ...(this.truncationDim ? { dimensions: this.truncationDim } : {}),
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
