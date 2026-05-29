// ─── 모델 라우팅용 메타데이터 (Phase 24) ───
//
// 각 스킬이 자체 객체로 export 하던 *_SKILL_METADATA 들을 한 타입으로 묶는다.

export interface ToolMetadata {
  readonly name: string;
  readonly reason?: string;
}

export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly requires: {
    readonly env: ReadonlyArray<string>;
    readonly optionalEnv?: ReadonlyArray<string>;
  };
  readonly tools: ReadonlyArray<ToolMetadata>;
}

/** 구 형식(string[]) 도 받는 입력 타입 */
export type SkillMetadataInput = Omit<SkillMetadata, 'tools'> & {
  readonly tools: ReadonlyArray<string | ToolMetadata>;
};

/** 입력(구 형식 string[] 포함)을 ToolMetadata 배열로 정규화. */
export function normalizeSkillMetadata(input: SkillMetadataInput): SkillMetadata {
  return {
    ...input,
    tools: input.tools.map((t) => (typeof t === 'string' ? { name: t } : t)),
  };
}
