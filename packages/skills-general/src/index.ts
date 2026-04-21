import type { ToolRegistry } from '@finclaw/agent';
// packages/skills-general/src/index.ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { registerDatetimeTool } from './datetime.js';
import { registerFileReadTool } from './file-read.js';
import { registerWebFetchTool } from './web-fetch.js';

export { registerDatetimeTool } from './datetime.js';
export { registerFileReadTool } from './file-read.js';
export type { FileReadConfig } from './file-read.js';
export { registerWebFetchTool } from './web-fetch.js';
export type { WebFetchConfig } from './web-fetch.js';

export interface GeneralSkillConfig {
  readonly fileRoot?: string;
  readonly webFetchMaxBytes?: number;
  readonly webFetchTimeoutMs?: number;
  readonly fileReadMaxBytes?: number;
}

/** 범용 도구 번들을 한 번에 등록한다. */
export function registerGeneralTools(
  registry: ToolRegistry,
  config: GeneralSkillConfig = {},
): void {
  registerDatetimeTool(registry);
  registerWebFetchTool(registry, {
    maxBytes: config.webFetchMaxBytes ?? 100_000,
    timeoutMs: config.webFetchTimeoutMs ?? 10_000,
  });
  registerFileReadTool(registry, {
    fileRoot: config.fileRoot ?? resolveDefaultFileRoot(),
    maxBytes: config.fileReadMaxBytes ?? 100_000,
  });
}

export const GENERAL_SKILL_METADATA = {
  name: 'general',
  description: '타임존 시각, 웹 콘텐츠 조회, 로컬 파일 읽기 등 범용 도구 모음.',
  version: '1.0.0',
  requires: {
    env: [],
    optionalEnv: ['FINCLAW_FILE_ROOT'],
  },
  tools: ['get_current_datetime', 'web_fetch', 'read_local_file'],
} as const;

function resolveDefaultFileRoot(): string {
  return process.env.FINCLAW_FILE_ROOT ?? join(homedir(), '.finclaw', 'workspace');
}
