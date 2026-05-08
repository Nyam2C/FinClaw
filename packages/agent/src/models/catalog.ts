// packages/agent/src/models/catalog.ts

/** 모델 제공자 식별자 */
export type ProviderId = 'anthropic' | 'openai';

/** 모델이 지원하는 기능 */
export interface ModelCapabilities {
  readonly vision: boolean;
  readonly functionCalling: boolean;
  readonly streaming: boolean;
  readonly jsonMode: boolean;
  readonly extendedThinking: boolean;
  /** 금융 특화: 수치 추론 정확도 등급 */
  readonly numericalReasoningTier: 'low' | 'medium' | 'high';
}

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
  readonly provider: ProviderId;
  readonly displayName: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly capabilities: ModelCapabilities;
  readonly pricing: ModelPricing;
  readonly aliases: readonly string[];
  readonly deprecated: boolean;
  readonly releaseDate: string; // ISO 8601
}

/** 모델 카탈로그 인터페이스 */
export interface ModelCatalog {
  listModels(): readonly ModelEntry[];
  getModel(id: string): ModelEntry | undefined;
  getModelsByProvider(provider: ProviderId): readonly ModelEntry[];
  findModels(filter: Partial<ModelCapabilities>): readonly ModelEntry[];
  registerModel(entry: ModelEntry): void;
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

  listModels(): readonly ModelEntry[] {
    return [...this.models.values()];
  }

  getModel(id: string): ModelEntry | undefined {
    return this.models.get(id);
  }

  getModelsByProvider(provider: ProviderId): readonly ModelEntry[] {
    return this.listModels().filter((m) => m.provider === provider);
  }

  findModels(filter: Partial<ModelCapabilities>): readonly ModelEntry[] {
    return this.listModels().filter((model) => {
      for (const [key, value] of Object.entries(filter)) {
        if (model.capabilities[key as keyof ModelCapabilities] !== value) {
          return false;
        }
      }
      return true;
    });
  }

  // TODO(L6): 중복 등록 시 throw. upsert 옵션이나 updateModel() 메서드 추가 고려.
  registerModel(entry: ModelEntry): void {
    if (this.models.has(entry.id)) {
      throw new Error(`Model already registered: ${entry.id}`);
    }
    this.models.set(entry.id, entry);
  }
}
