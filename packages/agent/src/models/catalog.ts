// packages/agent/src/models/catalog.ts

/** 모델 제공자 식별자 */
export type ProviderId = 'claude-cli';

/** 모델 가격 정보 (USD per 1M tokens) */
export interface ModelPricing {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly cacheReadPerMillion?: number;
  readonly cacheWritePerMillion?: number;
}

/** 모델 카탈로그 엔트리 */
export interface ModelEntry {
  readonly id: string;
  readonly pricing: ModelPricing;
}

/** 모델 카탈로그 인터페이스 */
export interface ModelCatalog {
  getModel(id: string): ModelEntry | undefined;
}

/** 인메모리 모델 카탈로그 구현 */
export class InMemoryModelCatalog implements ModelCatalog {
  private readonly models = new Map<string, ModelEntry>();

  constructor(initialModels?: readonly ModelEntry[]) {
    if (initialModels) {
      for (const model of initialModels) {
        this.models.set(model.id, model);
      }
    }
  }

  getModel(id: string): ModelEntry | undefined {
    return this.models.get(id);
  }
}
