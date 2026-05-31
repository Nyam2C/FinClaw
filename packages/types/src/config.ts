import type { LogLevel } from './common.js';

/** FinClaw 루트 설정 타입 */
export interface FinClawConfig {
  gateway?: GatewayConfig;
  agents?: AgentsConfig;
  channels?: ChannelsConfig;
  session?: SessionConfig;
  logging?: LoggingConfig;
  models?: ModelsConfig;
  plugins?: PluginsConfig;
  finance?: FinanceConfig;
  meta?: ConfigMeta;
  /** Phase 30 C4: access-log retention (SQLite 행 보존 기간). */
  accessLog?: AccessLogConfig;
  /** Phase 30 D3: RAG re-ranking 토글. */
  rag?: RagConfig;
  /** Phase 32 W6: 백엔드 경로 선택 (모델 벤더 의미의 agents.defaults.provider 와 분리). */
  provider?: 'claude-cli';
  /** Phase 32 W6: claude-cli 백엔드 옵션 (provider='claude-cli' 일 때만 유효). */
  cliBackend?: CliBackendOptions;
}

/** Phase 32 W6: claude-cli 백엔드 config 오버라이드. */
export interface CliBackendOptions {
  command?: string;
  timeoutMs?: number;
  watchdog?: {
    fresh?: { noOutputTimeoutRatio?: number };
    resume?: { noOutputTimeoutRatio?: number };
  };
}

export interface AccessLogConfig {
  /** 보존 기간 (일). 기본 30. 매일 04:00 (또는 24h interval) 에 oldest 삭제. */
  readonly retentionDays?: number;
}

export interface RagConfig {
  rerank?: {
    /** 기본 true. false 면 1차 hybrid 결과를 그대로 사용. */
    readonly enabled?: boolean;
    /** 1차 hybrid topK (기본 10). reranker 가 후보 풀로 사용. */
    readonly topKFirst?: number;
    /** rerank 후 최종 반환 topK (기본 3). */
    readonly topKFinal?: number;
  };
}

export interface GatewayConfig {
  port?: number;
  host?: string;
  tls?: boolean;
  corsOrigins?: string[];
  auth?: { token?: string };
}

export interface AgentsConfig {
  defaults?: AgentDefaultsConfig;
  entries?: Record<string, AgentEntry>;
}

export interface AgentEntry {
  agentDir?: string;
  model?: string;
  provider?: string;
  maxConcurrent?: number;
  systemPrompt?: string;
  skills?: string[];
}

export interface AgentDefaultsConfig {
  model?: string;
  provider?: string;
  maxConcurrent?: number;
  maxTokens?: number;
  temperature?: number;
}

export interface ChannelsConfig {
  discord?: DiscordChannelConfig;
  cli?: CliChannelConfig;
  web?: WebChannelConfig;
}

export interface DiscordChannelConfig {
  botToken?: string;
  applicationId?: string;
  guildIds?: string[];
}

export interface CliChannelConfig {
  enabled?: boolean;
}

export interface WebChannelConfig {
  enabled?: boolean;
  port?: number;
}

export interface SessionConfig {
  mainKey?: string;
  resetPolicy?: 'daily' | 'idle' | 'never';
  idleTimeoutMs?: number;
}

export interface LoggingConfig {
  level?: LogLevel;
  file?: boolean;
  redactSensitive?: boolean;
}

export interface ModelsConfig {
  definitions?: Record<string, ModelDefinition>;
  aliases?: Record<string, string>;
  defaultModel?: string;
  fallbacks?: string[];
}

export interface ModelDefinition {
  provider: string;
  model: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  costPer1kInput?: number;
  costPer1kOutput?: number;
}

export interface PluginsConfig {
  enabled?: string[];
  disabled?: string[];
}

export interface FinanceConfig {
  portfolios?: Record<string, PortfolioConfig>;
}

export interface PortfolioConfig {
  name: string;
  holdings: HoldingConfig[];
}

export interface HoldingConfig {
  symbol: string;
  quantity: number;
  avgCost?: number;
  currency?: string;
}

export interface ConfigMeta {
  lastTouchedVersion?: string;
  lastTouchedAt?: string;
}

export interface ConfigValidationIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}
