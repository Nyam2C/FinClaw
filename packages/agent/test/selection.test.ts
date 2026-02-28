import { resetEventBus } from '@finclaw/infra';
import { describe, it, expect, afterEach } from 'vitest';
import { buildModelAliasIndex } from '../src/models/alias-index.js';
import { BUILT_IN_MODELS } from '../src/models/catalog-data.js';
import { InMemoryModelCatalog } from '../src/models/catalog.js';
import { resolveModel } from '../src/models/selection.js';

describe('buildModelAliasIndex', () => {
  const catalog = new InMemoryModelCatalog(BUILT_IN_MODELS);

  it('모든 모델 ID와 별칭을 색인한다', () => {
    const index = buildModelAliasIndex(catalog);
    // 6 모델 ID + 각 모델의 aliases 합계
    expect(index.size).toBeGreaterThan(6);
  });

  it('대소문자 무시하여 조회', () => {
    const index = buildModelAliasIndex(catalog);
    expect(index.get('opus')).toBeDefined();
    expect(index.get('OPUS')).toBeUndefined(); // key는 소문자로 저장됨
    // resolveModel에서 .toLowerCase() 처리하므로 alias-index 자체는 소문자 키만 저장
  });

  it('중복 별칭 시 먼저 등록된 모델 유지', () => {
    const models = [
      { ...BUILT_IN_MODELS[0], id: 'model-a', aliases: ['shared'] },
      { ...BUILT_IN_MODELS[1], id: 'model-b', aliases: ['shared'] },
    ];
    const cat = new InMemoryModelCatalog(models);
    const index = buildModelAliasIndex(cat);
    expect(index.get('shared')?.id).toBe('model-a');
  });
});

describe('resolveModel', () => {
  const catalog = new InMemoryModelCatalog(BUILT_IN_MODELS);
  const aliasIndex = buildModelAliasIndex(catalog);

  afterEach(() => {
    resetEventBus();
  });

  it('정확한 ID로 해석', () => {
    const result = resolveModel({ raw: 'claude-opus-4-6' }, catalog, aliasIndex);
    expect(result.modelId).toBe('claude-opus-4-6');
    expect(result.resolvedFrom).toBe('id');
    expect(result.provider).toBe('anthropic');
  });

  it('별칭으로 해석', () => {
    const result = resolveModel({ raw: 'opus' }, catalog, aliasIndex);
    expect(result.modelId).toBe('claude-opus-4-6');
    expect(result.resolvedFrom).toBe('alias');
  });

  it('대소문자 무관하게 별칭 해석', () => {
    const result = resolveModel({ raw: 'SONNET' }, catalog, aliasIndex);
    expect(result.modelId).toBe('claude-sonnet-4-6');
    expect(result.resolvedFrom).toBe('alias');
  });

  it('기본 모델로 폴백', () => {
    const result = resolveModel({ raw: 'nonexistent' }, catalog, aliasIndex, 'claude-sonnet-4-6');
    expect(result.modelId).toBe('claude-sonnet-4-6');
    expect(result.resolvedFrom).toBe('default');
  });

  it('기본 모델도 없으면 에러', () => {
    expect(() => resolveModel({ raw: 'nonexistent' }, catalog, aliasIndex)).toThrow(
      'Model not found',
    );
  });

  it('빈 카탈로그에서 에러', () => {
    const empty = new InMemoryModelCatalog();
    const emptyIndex = buildModelAliasIndex(empty);
    expect(() => resolveModel({ raw: 'anything' }, empty, emptyIndex)).toThrow('Model not found');
  });

  it('공백 포함 입력 처리', () => {
    const result = resolveModel({ raw: '  opus  ' }, catalog, aliasIndex);
    expect(result.modelId).toBe('claude-opus-4-6');
  });
});
