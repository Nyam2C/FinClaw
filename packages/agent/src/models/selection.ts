// packages/agent/src/models/selection.ts
import { getEventBus } from '@finclaw/infra';
import type { AliasIndex } from './alias-index.js';
import type { ModelCatalog, ModelEntry, ProviderId } from './catalog.js';

/** 해석 전 사용자 입력 (별칭 또는 모델 ID 문자열) */
export interface UnresolvedModelRef {
  readonly raw: string;
}

/** 해석 완료된 모델 참조 */
export interface ResolvedModel {
  readonly entry: ModelEntry;
  readonly provider: ProviderId;
  readonly modelId: string;
  readonly resolvedFrom: 'id' | 'alias' | 'default';
}

/**
 * 모델 참조 해석
 *
 * 해석 순서:
 * 1. 정확한 ID 매칭 (catalog.getModel)
 * 2. 별칭 매칭 (aliasIndex.get, 소문자 정규화)
 * 3. 기본 모델 (defaultModelId가 제공된 경우)
 * 4. 에러 throw
 */
export function resolveModel(
  ref: UnresolvedModelRef,
  catalog: ModelCatalog,
  aliasIndex: AliasIndex,
  defaultModelId?: string,
): ResolvedModel {
  const bus = getEventBus();
  const raw = ref.raw.trim();

  // 1. 정확한 ID 매칭
  const byId = catalog.getModel(raw);
  if (byId) {
    bus.emit('model:resolve', raw, byId.id);
    return { entry: byId, provider: byId.provider, modelId: byId.id, resolvedFrom: 'id' };
  }

  // 2. 별칭 매칭
  const byAlias = aliasIndex.get(raw.toLowerCase());
  if (byAlias) {
    bus.emit('model:resolve', raw, byAlias.id);
    return {
      entry: byAlias,
      provider: byAlias.provider,
      modelId: byAlias.id,
      resolvedFrom: 'alias',
    };
  }

  // 3. 기본 모델
  if (defaultModelId) {
    const defaultEntry =
      catalog.getModel(defaultModelId) ?? aliasIndex.get(defaultModelId.toLowerCase());
    if (defaultEntry) {
      bus.emit('model:resolve', raw, defaultEntry.id);
      return {
        entry: defaultEntry,
        provider: defaultEntry.provider,
        modelId: defaultEntry.id,
        resolvedFrom: 'default',
      };
    }
  }

  // 4. 에러
  throw new Error(
    `Model not found: "${raw}". Available models: ${catalog
      .listModels()
      .map((m) => m.id)
      .join(', ')}`,
  );
}
