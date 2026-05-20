// packages/agent/src/providers/claude-cli/types.ts

export type CliOutputMode = 'json' | 'jsonl' | 'text';

export interface CliWatchdogProfile {
  noOutputTimeoutMs?: number; // 명시 값 (있으면 ratio 무시)
  noOutputTimeoutRatio: number; // 0.05~0.95
  minMs: number;
  maxMs: number;
}

export interface CliReliabilityConfig {
  watchdog?: {
    fresh?: Partial<CliWatchdogProfile>;
    resume?: Partial<CliWatchdogProfile>;
  };
}

export interface CliBackendConfig {
  command: string; // "claude"
  args: string[]; // 첫 호출 시
  resumeArgs?: string[]; // --resume 시
  output: CliOutputMode;
  resumeOutput?: CliOutputMode;
  input: 'arg' | 'stdin';
  modelArg: string; // "--model"
  modelAliases?: Record<string, string>;
  sessionArg?: string; // "--session-id"
  sessionMode?: 'always' | 'existing';
  sessionIdFields?: string[];
  systemPromptArg?: string; // "--append-system-prompt"
  systemPromptMode?: 'append' | 'replace';
  systemPromptWhen?: 'first' | 'always';
  imageArg?: string;
  imageMode?: 'repeat' | 'csv';
  clearEnv?: string[]; // ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD"]
  env?: Record<string, string>;
  reliability?: CliReliabilityConfig;
  serialize?: boolean;
}
