import type { ModelTier } from './config.js';
import type { MsgContext } from './message.js';

/** 스킬 정의 */
export interface SkillDefinition {
  name: string;
  description: string;
  version: string;
  category: SkillCategory;
  commands: SkillCommand[];
  tools?: SkillTool[];
}

export type SkillCategory = 'finance' | 'utility' | 'system' | 'custom';

/** 스킬 커맨드 */
export interface SkillCommand {
  name: string;
  aliases?: string[];
  description: string;
  args?: SkillArgDef[];
  handler: string;
}

/** 스킬 인자 정의 */
export interface SkillArgDef {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  description?: string;
  default?: unknown;
}

/** 스킬 도구 (LLM function calling용) */
export interface SkillTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: string;
}

/** 스킬 실행 컨텍스트 */
export interface SkillContext {
  msg: MsgContext;
  args: Record<string, unknown>;
  config: Record<string, unknown>;
}

/** 스킬 실행 결과 */
export interface SkillResult {
  text?: string;
  data?: unknown;
  media?: SkillMedia[];
  error?: string;
}

/** 스킬 미디어 산출물 */
export interface SkillMedia {
  type: 'image' | 'chart' | 'table' | 'file';
  url?: string;
  content?: string;
  mimeType?: string;
  title?: string;
}

// ─── 모델 라우팅용 메타데이터 (Phase 24) ───
//
// 기존 SkillDefinition / SkillTool 과 별개의 통합 메타.
// 각 스킬이 자체 객체로 export 하던 *_SKILL_METADATA 들을 한 타입으로 묶고
// minModel hint 를 도구 단위로 부여한다.

export interface ToolMetadata {
  readonly name: string;
  readonly minModel?: ModelTier;
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

/** 입력을 ToolMetadata 배열로 정규화. 누락된 minModel 은 그대로 둔다 (라우터 기본값). */
export function normalizeSkillMetadata(input: SkillMetadataInput): SkillMetadata {
  return {
    ...input,
    tools: input.tools.map((t) => (typeof t === 'string' ? { name: t } : t)),
  };
}
