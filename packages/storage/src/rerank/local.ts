// packages/storage/src/rerank/local.ts
// Phase 30 D2: 로컬 cross-encoder ONNX (HuggingFace transformers.js).
//
// pipeline('text-classification', model_id) 가 `{ text, text_pair }` 입력을 받아
// query-document 관련도 점수를 반환. 외부 API 키 없이 동작 (모델 1회 다운로드 필요).
// 모델 미존재 / 로드 실패는 mock fallback 으로 처리 (createRerankerWithFallback).

import type { Reranker } from './index.js';

export interface LocalRerankerOptions {
  /** HF Hub 모델 ID. 기본 'Xenova/bge-reranker-v2-m3'. */
  readonly modelId?: string;
  readonly cacheDir?: string;
}

export class LocalReranker implements Reranker {
  readonly id: string;
  private pipelinePromise: Promise<unknown> | null = null;

  constructor(private readonly options: LocalRerankerOptions = {}) {
    this.id = options.modelId ?? 'Xenova/bge-reranker-v2-m3';
  }

  async rerank(query: string, candidates: readonly string[]): Promise<number[]> {
    if (!this.pipelinePromise) {
      const transformers = (await import('@huggingface/transformers')) as {
        pipeline: (
          task: string,
          model: string,
          options: { cache_dir?: string },
        ) => Promise<unknown>;
      };
      this.pipelinePromise = transformers.pipeline('text-classification', this.id, {
        cache_dir: this.options.cacheDir,
      });
    }
    const pipe = (await this.pipelinePromise) as (
      input: ReadonlyArray<{ text: string; text_pair: string }>,
    ) => Promise<Array<{ score: number }>>;
    const inputs = candidates.map((c) => ({ text: query, text_pair: c }));
    const results = await pipe(inputs);
    return results.map((r) => r.score);
  }
}
