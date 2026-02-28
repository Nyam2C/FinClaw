// packages/server/src/auto-reply/index.ts — barrel export

// Pipeline orchestrator
export { AutoReplyPipeline } from './pipeline.js';
export type {
  PipelineConfig,
  PipelineDependencies,
  PipelineResult,
  StageResult,
} from './pipeline.js';

// Errors
export { PipelineError } from './errors.js';
export type { PipelineErrorCode } from './errors.js';

// Pipeline context
export { enrichContext } from './pipeline-context.js';
export type {
  PipelineMsgContext,
  MarketSession,
  FinanceContextProvider,
  EnrichContextDeps,
} from './pipeline-context.js';

// Execution adapter
export { MockExecutionAdapter } from './execution-adapter.js';
export type { ExecutionAdapter, ExecutionResult } from './execution-adapter.js';

// Control tokens
export { CONTROL_TOKENS, extractControlTokens } from './control-tokens.js';
export type { ControlToken, ControlTokenResult } from './control-tokens.js';

// Response formatter
export { formatResponse, formatFinancialNumber, splitMessage } from './response-formatter.js';
export type {
  FormatOptions,
  SupportedFormat,
  FormattedResponse,
  ResponsePart,
} from './response-formatter.js';

// Commands
export { InMemoryCommandRegistry } from './commands/registry.js';
export { registerBuiltInCommands } from './commands/built-in.js';
export type {
  CommandRegistry,
  CommandDefinition,
  CommandExecutor,
  CommandResult,
  ParsedCommand,
  CommandCategory,
} from './commands/registry.js';

// Observer
export { DefaultPipelineObserver } from './observer.js';
export type { PipelineObserver } from './observer.js';

// Stages
export { normalizeMessage } from './stages/normalize.js';
export type { NormalizedMessage } from './stages/normalize.js';
export { commandStage } from './stages/command.js';
export { ackStage, createTypingController } from './stages/ack.js';
export type { TypingController } from './stages/ack.js';
export { contextStage } from './stages/context.js';
export { executeStage } from './stages/execute.js';
export type { ExecuteStageResult } from './stages/execute.js';
export { deliverResponse } from './stages/deliver.js';
