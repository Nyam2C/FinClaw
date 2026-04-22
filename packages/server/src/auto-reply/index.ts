// packages/server/src/auto-reply/index.ts — barrel export (외부 공개 API만)

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

// Pipeline context (외부에서 주입하는 FinanceContextProvider·ctx 타입)
export { StubFinanceContextProvider } from './pipeline-context.js';
export type {
  PipelineMsgContext,
  MarketSession,
  FinanceContextProvider,
} from './pipeline-context.js';

// Execution adapter (서버가 직접 소비)
export { RunnerExecutionAdapter } from './execution-adapter.js';
export type {
  ExecutionAdapter,
  ExecutionResult,
  RunnerExecutionAdapterDeps,
  RunnerFactory,
  ToolCallRecord,
} from './execution-adapter.js';

// Commands (서버 부팅 시 registerBuiltInCommands 호출)
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
