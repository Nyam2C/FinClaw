// packages/agent/src/models/alias-index.ts
import { createLogger } from '@finclaw/infra';
import type { ModelCatalog, ModelEntry } from './catalog.js';

const log = createLogger({ name: 'ModelAliasIndex' });

/** 별칭 색인 타입 */
export type AliasIndex = ReadonlyMap<string, ModelEntry>;

/**
 * 별칭 색인 빌드
 *
 * 1. 카탈로그의 모든 모델 순회
 * 2. 모델 ID + aliases 배열을 소문자 정규화 후 Map에 등록
 * 3. 중복 별칭: 먼저 등록된 모델 유지 + 경고 로그
 */
export function buildModelAliasIndex(catalog: ModelCatalog): AliasIndex {
  const index = new Map<string, ModelEntry>();

  for (const model of catalog.listModels()) {
    const keysToRegister = [model.id, ...model.aliases];

    for (const alias of keysToRegister) {
      const normalized = alias.toLowerCase().trim();
      if (index.has(normalized)) {
        const existing = index.get(normalized);
        log.warn(`Duplicate alias "${normalized}": keeping ${existing?.id}, ignoring ${model.id}`);
        continue;
      }
      index.set(normalized, model);
    }
  }

  return index;
}
