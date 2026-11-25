// @finclaw/agent — complete barrel export

// ─── models: catalog ───
export { InMemoryModelCatalog } from './models/catalog.js';
export type { ProviderId, ModelPricing, ModelEntry, ModelCatalog } from './models/catalog.js';

// ─── models: catalog data ───
export { BUILT_IN_MODELS } from './models/catalog-data.js';

// ─── models: provider normalize ───
export { calculateEstimatedCost } from './models/provider-normalize.js';
export type { NormalizedUsage, StreamChunk } from './models/provider-normalize.js';

// ─── providers ───
export type { ProviderAdapter, ProviderRequestParams } from './providers/adapter.js';

// ─── providers (Phase 32 Backend-as-CLI) ───
export { CliProviderAdapter } from './providers/claude-cli/adapter.js';
export { runCliAgent } from './providers/claude-cli/runner.js';
export { CliFailoverError, classifyCliError } from './providers/claude-cli/errors.js';
export type { CliFailoverReason } from './providers/claude-cli/errors.js';
export { DEFAULT_CLAUDE_BACKEND, normalizeClaudeModel } from './providers/claude-cli/backends.js';
export type {
  CliBackendConfig,
  CliWatchdogProfile,
  CliReliabilityConfig,
} from './providers/claude-cli/types.js';

// ─── auth: health ───
export { ProfileHealthMonitor } from './auth/health.js';
export type {
  HealthThresholds,
  ModelStats,
  ProfileHealthStatus,
  RecordOptions,
} from './auth/health.js';

// ── Phase 7: Tools ──
export type {
  ToolGroupId,
  RegisteredToolDefinition,
  ToolExecutor,
  ToolExecutionContext,
  ToolResult,
  RegisteredTool,
  ToolRegistry,
  PolicyVerdict,
  PolicyRule,
  PolicyContext,
  PolicyStage,
  PolicyStageResult,
  PolicyEvaluationResult,
  GuardedToolResult,
  ResultGuardOptions,
} from './agents/tools/index.js';
export {
  InMemoryToolRegistry,
  jsonSchemaToZod,
  evaluateToolPolicy,
  matchToolPattern,
  guardToolResult,
  FINANCIAL_REDACT_PATTERNS,
} from './agents/tools/index.js';

// ── Phase 9: Execution ──
export { Runner, extractAssistantText } from './execution/index.js';
export type {
  StreamEvent,
  StreamEventListener,
  ExecutionResult,
  RunnerOptions,
  RunnerTracerAdapter,
  RunnerFactory,
  ChatExecutionPort,
  TuiExecutionResultLike,
} from './execution/index.js';

// ── Phase 33: News brief cron prompt ──
export { NEWS_BRIEF_PROMPT, NEWS_BRIEF_SCHEDULE_ID } from './prompts/news-brief.js';
