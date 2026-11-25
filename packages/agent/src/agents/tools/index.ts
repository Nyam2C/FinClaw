// ── groups ──
export type { ToolGroupId } from './groups.js';

// ── registry ──
export type {
  RegisteredToolDefinition,
  ToolExecutor,
  ToolExecutionContext,
  ToolResult,
  RegisteredTool,
  ToolRegistry,
} from './registry.js';
export { InMemoryToolRegistry, jsonSchemaToZod } from './registry.js';

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
