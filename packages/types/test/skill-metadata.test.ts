import { describe, expect, it } from 'vitest';
import { normalizeSkillMetadata } from '../src/index.js';
import type { SkillMetadataInput } from '../src/skill.js';

describe('normalizeSkillMetadata', () => {
  it('신 형식: ToolMetadata 객체 배열은 그대로 통과', () => {
    const input: SkillMetadataInput = {
      name: 'x',
      description: 'd',
      version: '1.0',
      requires: { env: [] },
      tools: [{ name: 'foo', minModel: 'opus', reason: 'r' }],
    };
    const result = normalizeSkillMetadata(input);
    expect(result.tools[0]).toEqual({ name: 'foo', minModel: 'opus', reason: 'r' });
  });

  it('구 형식: string[] → ToolMetadata 변환 (minModel 미지정 유지)', () => {
    const input: SkillMetadataInput = {
      name: 'x',
      description: 'd',
      version: '1.0',
      requires: { env: [] },
      tools: ['foo', 'bar'],
    };
    const result = normalizeSkillMetadata(input);
    expect(result.tools).toEqual([{ name: 'foo' }, { name: 'bar' }]);
  });

  it('혼합 형식: 일부 string, 일부 ToolMetadata', () => {
    const input: SkillMetadataInput = {
      name: 'x',
      description: 'd',
      version: '1.0',
      requires: { env: [] },
      tools: ['foo', { name: 'bar', minModel: 'sonnet' }],
    };
    const result = normalizeSkillMetadata(input);
    expect(result.tools[0]).toEqual({ name: 'foo' });
    expect(result.tools[1]).toEqual({ name: 'bar', minModel: 'sonnet' });
  });

  it('빈 tools 배열도 통과', () => {
    const input: SkillMetadataInput = {
      name: 'x',
      description: 'd',
      version: '1.0',
      requires: { env: [] },
      tools: [],
    };
    const result = normalizeSkillMetadata(input);
    expect(result.tools).toEqual([]);
  });
});
