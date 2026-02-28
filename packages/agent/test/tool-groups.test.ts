import { describe, it, expect } from 'vitest';
import type { ToolGroupId } from '../src/agents/tools/groups.js';
import { BUILT_IN_GROUPS } from '../src/agents/tools/groups.js';

describe('BUILT_IN_GROUPS', () => {
  it('6개 내장 그룹이 정의되어 있다', () => {
    expect(BUILT_IN_GROUPS).toHaveLength(6);
  });

  it('모든 ToolGroupId 값이 포함되어 있다', () => {
    const ids = BUILT_IN_GROUPS.map((g) => g.id);
    const expectedIds: ToolGroupId[] = [
      'finance',
      'system',
      'web',
      'data',
      'communication',
      'custom',
    ];
    expect(ids).toEqual(expectedIds);
  });

  it('각 그룹은 필수 필드를 모두 갖는다', () => {
    for (const group of BUILT_IN_GROUPS) {
      expect(group).toHaveProperty('id');
      expect(group).toHaveProperty('displayName');
      expect(group).toHaveProperty('description');
      expect(group).toHaveProperty('defaultPolicy');
      expect(group).toHaveProperty('includeInPromptWhen');
    }
  });

  it('finance 그룹은 기본 allow, always 포함이다', () => {
    const finance = BUILT_IN_GROUPS.find((g) => g.id === 'finance');
    expect(finance?.defaultPolicy).toBe('allow');
    expect(finance?.includeInPromptWhen).toBe('always');
  });

  it('system 그룹은 기본 require-approval이다', () => {
    const system = BUILT_IN_GROUPS.find((g) => g.id === 'system');
    expect(system?.defaultPolicy).toBe('require-approval');
    expect(system?.includeInPromptWhen).toBe('on-demand');
  });
});
