// packages/skills-general/src/index.ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolRegistry } from '@finclaw/agent';
import type { ScheduleRpc } from '@finclaw/types';
import { registerDatetimeTool } from './datetime.js';
import { registerFileReadTool } from './file-read.js';
import { registerScheduleTool } from './schedule-tool.js';
import { registerWebFetchTool } from './web-fetch.js';

export { registerDatetimeTool } from './datetime.js';
export { registerFileReadTool } from './file-read.js';
export type { FileReadConfig } from './file-read.js';
export { registerScheduleTool } from './schedule-tool.js';
export { registerWebFetchTool } from './web-fetch.js';
export type { WebFetchConfig } from './web-fetch.js';
export { registerRouteTaskTool } from './route-task.js';

export interface GeneralSkillConfig {
  readonly fileRoot?: string;
  readonly webFetchMaxBytes?: number;
  readonly webFetchTimeoutMs?: number;
  readonly fileReadMaxBytes?: number;
  /** Phase 31 F: 주입 시 schedule_manage 도구 등록 (agent 가 자동화 schedule 생성/조회/삭제). */
  readonly scheduleRpc?: ScheduleRpc;
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
  if (config.scheduleRpc) {
    registerScheduleTool(registry, config.scheduleRpc);
  }
}

function resolveDefaultFileRoot(): string {
  return process.env.FINCLAW_FILE_ROOT ?? join(homedir(), '.finclaw', 'workspace');
}
