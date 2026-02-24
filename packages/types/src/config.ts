import type { LogLevel } from './common.js';

/** FinClaw 루트 설정 타입 -- OpenClaw의 OpenClawConfig 대응 */
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
}

export interface GatewayConfig {
  port?: number;
  host?: string;
  tls?: boolean;
  corsOrigins?: string[];
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
  dataProviders?: DataProviderConfig[];
  newsFeeds?: NewsFeedConfig[];
  alertDefaults?: AlertDefaultsConfig;
  portfolios?: Record<string, PortfolioConfig>;
}

export interface DataProviderConfig {
  name: string;
  apiKey?: string;
  baseUrl?: string;
  rateLimit?: number;
}

export interface NewsFeedConfig {
  name: string;
  url: string;
  refreshIntervalMs?: number;
}

export interface AlertDefaultsConfig {
  cooldownMs?: number;
  maxActiveAlerts?: number;
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

/** 설정 파일 스냅샷 */
export interface ConfigFileSnapshot {
  path: string;
  exists: boolean;
  raw?: string;
  parsed?: unknown;
  valid: boolean;
  config: FinClawConfig;
  hash?: string;
  issues: ConfigValidationIssue[];
}

export interface ConfigValidationIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

/** 설정 변경 이벤트 */
export type ConfigChangeEvent = {
  previous: FinClawConfig;
  current: FinClawConfig;
  changedPaths: string[];
};

/** 설정 I/O 의존성 -- OpenClaw ConfigIoDeps 축소판 (DI용) */
export interface ConfigIoDeps {
  /** 설정 파일 읽기 */
  readFile(path: string): Promise<string>;
  /** 설정 파일 쓰기 */
  writeFile(path: string, content: string): Promise<void>;
  /** 파일 존재 여부 확인 */
  exists(path: string): Promise<boolean>;
  /** 환경 변수 조회 */
  env(key: string): string | undefined;
  /** 로그 출력 */
  log(level: LogLevel, message: string): void;
}
