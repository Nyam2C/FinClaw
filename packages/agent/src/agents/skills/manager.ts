/**
 * 스킬 로딩/관리 — 기본 수준 스텁 구현
 *
 * Phase 7에서는 스킬 정의 인터페이스와 기본 로딩만 구현.
 * 핫 리로드, 의존성 해결 등은 후속 Phase에서 확장.
 */

import type { ToolDefinition } from '@finclaw/types';

/** 스킬 정의 */
export interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly tools: readonly ToolDefinition[];
}

/** 스킬 매니저 인터페이스 */
export interface SkillManager {
  load(skill: SkillDefinition): void;
  unload(name: string): boolean;
  get(name: string): SkillDefinition | undefined;
  list(): readonly SkillDefinition[];
  getTools(): readonly ToolDefinition[];
}

/** 인메모리 스킬 매니저 */
export class InMemorySkillManager implements SkillManager {
  private readonly skills = new Map<string, SkillDefinition>();

  load(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
  }

  unload(name: string): boolean {
    return this.skills.delete(name);
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  list(): readonly SkillDefinition[] {
    return [...this.skills.values()];
  }

  /** 모든 스킬의 도구를 합쳐 반환 */
  getTools(): readonly ToolDefinition[] {
    return [...this.skills.values()].flatMap((s) => s.tools);
  }
}
