// packages/agent/src/providers/claude-cli/types.ts

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
  modelArg: string; // "--model"
  modelAliases?: Record<string, string>;
  sessionIdFields?: string[];
  systemPromptArg?: string; // "--append-system-prompt"
  systemPromptWhen?: 'first' | 'always';
  clearEnv?: string[]; // ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD"]
  env?: Record<string, string>;
  reliability?: CliReliabilityConfig;
  /**
   * Phase 40 C: in-process HTTP MCP 엔드포인트 (FinClaw gateway /mcp).
   * 설정 시 runner 가 --mcp-config(http) + 격리 플래그(--tools "" 등)를 argv 에 주입.
   * 미설정 시 기존 텍스트 전용 동작 (회귀 없음).
   */
  mcp?: {
    /** /mcp URL (예: http://127.0.0.1:3000/mcp). */
    url: string;
    /** spawn 별 Bearer 토큰 mint (sessionId 운반). 매 호출마다 fresh. */
    mintToken: () => string;
    /** 자동 승인 도구 패턴 (기본 "mcp__finclaw__*"). */
    allowedTools?: string;
  };
}
