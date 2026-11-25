// @finclaw/agent — complete barrel export

// ─── auth: health ───
export { ProfileHealthMonitor } from './auth/health.js';
export type { ModelStats } from './auth/health.js';

// ── Phase 7: Tools ──
export type {
  ToolGroupId,
  RegisteredToolDefinition,
  ToolExecutor,
  ToolExecutionContext,
  ToolRegistry,
} from './agents/tools/index.js';
export { InMemoryToolRegistry, jsonSchemaToZod } from './agents/tools/index.js';

// ── Phase 46: AgentRuntime driver seam ──
export { buildCliArgs, createCliDriver, type CliDriverOptions } from './runtime/cli-driver.js';
export type {
  AgentDriver,
  AgentErrorReason,
  AgentEvent,
  AgentRunPort,
  AgentRunRequest,
  AgentUsage,
  DriverRequest,
} from './runtime/types.js';
