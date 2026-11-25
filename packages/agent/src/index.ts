// @finclaw/agent — complete barrel export

// ─── providers ───
export type { ProviderAdapter } from './providers/adapter.js';

// ─── providers (Phase 32 Backend-as-CLI) ───
export { CliProviderAdapter } from './providers/claude-cli/adapter.js';
export { runCliAgent } from './providers/claude-cli/runner.js';

export { DEFAULT_CLAUDE_BACKEND } from './providers/claude-cli/backends.js';

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

// ── Phase 9: Execution ──
export { Runner, extractAssistantText } from './execution/index.js';
export type {
  StreamEvent,
  StreamEventListener,
  ExecutionResult,
  RunnerTracerAdapter,
  RunnerFactory,
  ChatExecutionPort,
} from './execution/index.js';

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
