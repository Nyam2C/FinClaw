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
export {
  normalizers,
  normalizeAnthropicResponse,
  normalizeOpenAIResponse,
  calculateEstimatedCost,
} from './models/provider-normalize.js';
export type {
  NormalizedResponse,
  NormalizedUsage,
  StopReason,
  StreamChunk,
  ResponseNormalizer,
} from './models/provider-normalize.js';

// ─── models: fallback ───
export { runWithModelFallback, DEFAULT_FALLBACK_TRIGGERS } from './models/fallback.js';
export type {
  FallbackConfig,
  FallbackTrigger,
  FallbackResult,
  FallbackAttempt,
} from './models/fallback.js';

// ─── providers ───
export {
  createProviderAdapter,
  getBreakerForProvider,
  resetBreakers,
} from './providers/adapter.js';
export type { ProviderAdapter, ProviderRequestParams } from './providers/adapter.js';
export { AnthropicAdapter } from './providers/anthropic.js';
export { OpenAIAdapter } from './providers/openai.js';

// ─── auth: cooldown ───
export { CooldownTracker } from './auth/cooldown.js';
export type { CooldownEntry } from './auth/cooldown.js';

// ─── auth: health ───
export { ProfileHealthMonitor } from './auth/health.js';
export type { ProfileHealthStatus, HealthThresholds } from './auth/health.js';

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

// ── Phase 7: System Prompt ──
export type {
  PromptSection,
  InvestmentProfile,
  PromptModelCapabilities,
  PromptBuildContext,
  PromptBuildMode,
} from './agents/system-prompt.js';
export {
  buildSystemPrompt,
  buildIdentitySection,
  buildToolsSection,
  buildFinanceContextSection,
  buildComplianceSection,
  buildRiskDisclaimerSection,
} from './agents/system-prompt.js';

// ── Phase 7: Skills ──
export type { SkillDefinition, SkillManager } from './agents/skills/manager.js';
export { InMemorySkillManager } from './agents/skills/manager.js';
