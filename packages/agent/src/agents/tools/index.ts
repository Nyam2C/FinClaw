// ── groups ──
export type { ToolGroupId, ToolGroup } from './groups.js';
export { BUILT_IN_GROUPS } from './groups.js';

// ── registry ──
export type {
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
} from './registry.js';
export { toApiToolDefinition, InMemoryToolRegistry } from './registry.js';

// ── policy ──
export type {
  PolicyVerdict,
  PolicyRule,
  PolicyContext,
  PolicyStage,
  PolicyStageResult,
  PolicyEvaluationResult,
} from './policy.js';
export { evaluateToolPolicy, matchToolPattern } from './policy.js';

// ── result guard ──
export type { GuardedToolResult, ResultGuardOptions } from './result-guard.js';
export { guardToolResult, FINANCIAL_REDACT_PATTERNS } from './result-guard.js';
