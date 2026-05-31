// @finclaw/agent — complete barrel export

// ─── errors ───
export { FailoverError, classifyFallbackError } from './errors.js';
export type { FallbackReason } from './errors.js';

// ─── models: catalog ───
export { InMemoryModelCatalog } from './models/catalog.js';
export type {
  ProviderId,
  ModelCapabilities,
  ModelPricing,
  ModelEntry,
  ModelCatalog,
} from './models/catalog.js';

// ─── models: catalog data ───
export { BUILT_IN_MODELS, DEFAULT_FALLBACK_CHAIN } from './models/catalog-data.js';

// ─── models: alias index ───
export { buildModelAliasIndex } from './models/alias-index.js';
export type { AliasIndex } from './models/alias-index.js';

// ─── models: selection ───
export { resolveModel } from './models/selection.js';
export type { UnresolvedModelRef, ResolvedModel } from './models/selection.js';

// ─── models: provider normalize ───
export { calculateEstimatedCost } from './models/provider-normalize.js';
export type { NormalizedUsage, StreamChunk } from './models/provider-normalize.js';

// ─── models: fallback ───
export { DEFAULT_FALLBACK_TRIGGERS, runWithModelFallback } from './models/fallback.js';
export type {
  FallbackConfig,
  FallbackTrigger,
  FallbackResult,
  FallbackAttempt,
} from './models/fallback.js';

// ─── providers ───
export { getBreakerForProvider, resetBreakers } from './providers/adapter.js';
export type { ProviderAdapter, ProviderRequestParams } from './providers/adapter.js';

// ─── providers (Phase 32 Backend-as-CLI) ───
export { createProviderAdapter } from './providers/factory.js';
export type { ProviderKind, ProviderFactoryConfig } from './providers/factory.js';
export { CliProviderAdapter } from './providers/claude-cli/adapter.js';
export { runCliAgent } from './providers/claude-cli/runner.js';
export { CliFailoverError, classifyCliError } from './providers/claude-cli/errors.js';
export type { CliFailoverReason } from './providers/claude-cli/errors.js';
export {
  DEFAULT_CLAUDE_BACKEND,
  resolveClaudeBackend,
  normalizeClaudeModel,
} from './providers/claude-cli/backends.js';
export type {
  CliBackendConfig,
  CliWatchdogProfile,
  CliReliabilityConfig,
  CliOutputMode,
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
  BeforeToolExecutePayload,
  AfterToolExecutePayload,
  ToolRegistryHooks,
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

// Phase 31 C — token counter 어댑터.
export { approxTokenCount } from './execution/token-fn.js';

// ── Phase 9: Execution ──
export {
  ToolInputBuffer,
  StreamStateMachine,
  ExecutionToolDispatcher,
  TokenCounter,
  Runner,
  buildDispatcher,
  collectToolCalls,
  extractAssistantText,
} from './execution/index.js';
export type {
  StreamState,
  StreamEvent,
  StreamEventListener,
  ExecutionResult,
  ToolHandler,
  ExecutionToolResult,
  RunnerOptions,
  RunnerTracerAdapter,
  RunnerFactory,
  BuiltDispatcher,
  DispatcherContextBase,
  ToolCallRecord,
  ChatExecutionPort,
  TuiExecutionResultLike,
} from './execution/index.js';

// ── Phase 33: News brief cron prompt ──
export { NEWS_BRIEF_PROMPT, NEWS_BRIEF_SCHEDULE_ID } from './prompts/news-brief.js';
