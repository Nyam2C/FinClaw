import { describe, it, expect } from 'vitest';
import { BUILT_IN_MODELS } from '../src/models/catalog-data.js';
import { InMemoryModelCatalog } from '../src/models/catalog.js';

describe('InMemoryModelCatalog', () => {
  const catalog = new InMemoryModelCatalog(BUILT_IN_MODELS);

  it('ID로 모델 가격을 조회한다', () => {
    expect(catalog.getModel('claude-opus-4-7')?.pricing.inputPerMillion).toBe(15);
  });

  it('존재하지 않는 ID → undefined', () => {
    expect(catalog.getModel('nonexistent')).toBeUndefined();
  });
});
