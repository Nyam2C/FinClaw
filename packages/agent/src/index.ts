// @finclaw/agent — complete barrel export

// ─── errors ───
export { FailoverError, classifyFallbackError, maskApiKey } from './errors.js';
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
export { normalizeAnthropicResponse, calculateEstimatedCost } from './models/provider-normalize.js';
export type {
  NormalizedResponse,
  NormalizedUsage,
  StopReason,
  StreamChunk,
} from './models/provider-normalize.js';

// ─── models: fallback ───
export {
  DEFAULT_FALLBACK_TRIGGERS,
  ModelFloorExhaustedError,
  runWithModelFallback,
} from './models/fallback.js';
export type {
  FallbackConfig,
  FallbackTrigger,
  FallbackResult,
  FallbackAttempt,
} from './models/fallback.js';

// ─── models: routing (Phase 24) ───
export {
  computeFloor,
  maxTier,
  modelIdToTier,
  resolveModelForRequest,
  tierToModelId,
} from './models/routing.js';
export type {
  ModelRole,
  RouteDecision,
  RouteRequest,
  RouterHelper,
  RouterHelperRequest,
  RouterHelperResult,
} from './models/routing.js';

// ─── providers ───
export { getBreakerForProvider, resetBreakers } from './providers/adapter.js';
export type { ProviderAdapter, ProviderRequestParams } from './providers/adapter.js';
export { AnthropicAdapter } from './providers/anthropic.js';

// ─── auth: cooldown ───
export { CooldownTracker } from './auth/cooldown.js';
export type { CooldownEntry } from './auth/cooldown.js';

// ─── auth: health ───
export { ProfileHealthMonitor } from './auth/health.js';
export type {
  HealthThresholds,
  ModelStats,
  ProfileHealthStatus,
  RecordOptions,
} from './auth/health.js';

// ─── auth: profiles ───
export { InMemoryAuthProfileStore } from './auth/profiles.js';
export type { ManagedAuthProfile, AuthProfileStore, CreateProfileInput } from './auth/profiles.js';

// ─── auth: resolver ───
export { resolveApiKeyForProvider } from './auth/resolver.js';
export type {
  ResolverOptions,
  ResolvedApiKey,
  ApiKeySource,
  AgentResolverConfig,
} from './auth/resolver.js';

// ── Phase 7: Tools ──
export type {
  ToolGroupId,
  ToolGroup,
  ToolInputSchema,
  ToolPropertySchema,
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
  BUILT_IN_GROUPS,
  toApiToolDefinition,
  InMemoryToolRegistry,
  evaluateToolPolicy,
  matchToolPattern,
  guardToolResult,
  FINANCIAL_REDACT_PATTERNS,
} from './agents/tools/index.js';

// ── Phase 7: Session ──
export type {
  LockResult,
  LockOptions,
  TranscriptEntry,
  CorruptionType,
  DetectedCorruption,
  CorruptionReport,
} from './agents/session/index.js';
export {
  acquireWriteLock,
  resetHeldLocks,
  detectCorruption,
  repairTranscript,
} from './agents/session/index.js';

// ── Phase 7: Context ──
export type {
  TokenBreakdown,
  ContextWindowState,
  WindowGuardConfig,
  CompactionStrategy,
  CompactionOptions,
  CompactionResult,
} from './agents/context/index.js';
export { evaluateContextWindow, compactContext } from './agents/context/index.js';

// ── Phase 9: Execution ──
export {
  ToolInputBuffer,
  StreamStateMachine,
  ExecutionToolDispatcher,
  TokenCounter,
  Runner,
} from './execution/index.js';
export type {
  StreamState,
  StreamEvent,
  StreamEventListener,
  ExecutionResult,
  ToolHandler,
  ExecutionToolResult,
  RunnerOptions,
} from './execution/index.js';
