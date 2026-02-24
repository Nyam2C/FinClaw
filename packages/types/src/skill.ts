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
