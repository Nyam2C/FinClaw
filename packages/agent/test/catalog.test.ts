import { describe, it, expect } from 'vitest';
import { BUILT_IN_MODELS } from '../src/models/catalog-data.js';
import { InMemoryModelCatalog } from '../src/models/catalog.js';

describe('InMemoryModelCatalog', () => {
  const catalog = new InMemoryModelCatalog(BUILT_IN_MODELS);

  it('내장 모델 6종을 모두 조회한다', () => {
    expect(catalog.listModels()).toHaveLength(6);
  });

  it('ID로 모델을 조회한다', () => {
    const opus = catalog.getModel('claude-opus-4-6');
    expect(opus).toBeDefined();
    expect(opus?.displayName).toBe('Claude Opus 4.6');
    expect(opus?.provider).toBe('anthropic');
  });

  it('존재하지 않는 ID → undefined', () => {
    expect(catalog.getModel('nonexistent')).toBeUndefined();
  });

  it('제공자별 필터링', () => {
    const anthropicModels = catalog.getModelsByProvider('anthropic');
    expect(anthropicModels.length).toBeGreaterThanOrEqual(3);
    expect(anthropicModels.every((m) => m.provider === 'anthropic')).toBe(true);

    const openaiModels = catalog.getModelsByProvider('openai');
    expect(openaiModels.length).toBeGreaterThanOrEqual(2);
    expect(openaiModels.every((m) => m.provider === 'openai')).toBe(true);
  });

  it('기능 요구사항으로 필터링', () => {
    const thinkingModels = catalog.findModels({ extendedThinking: true });
    expect(thinkingModels.length).toBeGreaterThanOrEqual(2);
    expect(thinkingModels.every((m) => m.capabilities.extendedThinking)).toBe(true);
  });

  it('numericalReasoningTier로 필터링', () => {
    const highTier = catalog.findModels({ numericalReasoningTier: 'high' });
    expect(highTier.length).toBeGreaterThanOrEqual(2); // opus + o3
  });

  it('registerModel()로 커스텀 모델 등록', () => {
    const custom = new InMemoryModelCatalog();
    const entry = {
      id: 'custom-model',
      provider: 'anthropic' as const,
      displayName: 'Custom',
      contextWindow: 100_000,
      maxOutputTokens: 4096,
      capabilities: {
        vision: false,
        functionCalling: false,
        streaming: false,
        jsonMode: false,
        extendedThinking: false,
        numericalReasoningTier: 'low' as const,
      },
      pricing: { inputPerMillion: 1, outputPerMillion: 5 },
      aliases: ['custom'],
      deprecated: false,
      releaseDate: '2025-01-01',
    };
    custom.registerModel(entry);
    expect(custom.getModel('custom-model')).toBe(entry);
  });

  it('중복 모델 등록 시 에러', () => {
    const dup = new InMemoryModelCatalog(BUILT_IN_MODELS);
    expect(() => dup.registerModel(BUILT_IN_MODELS[0])).toThrow('already registered');
  });

  it('빈 카탈로그 → listModels() = []', () => {
    const empty = new InMemoryModelCatalog();
    expect(empty.listModels()).toEqual([]);
  });
});
