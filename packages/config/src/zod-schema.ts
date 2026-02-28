// packages/config/src/zod-schema.ts
import { z } from 'zod/v4';

/** 게이트웨이 설정 스키마 */
const GatewaySchema = z.strictObject({
  port: z.number().int().min(1).max(65535),
  host: z.string(),
  tls: z.boolean(),
  corsOrigins: z.array(z.string()),
});

/** 에이전트 기본값 스키마 */
const AgentDefaultsSchema = z.strictObject({
  model: z.string(),
  provider: z.string(),
  maxConcurrent: z.number().int().min(1).max(10),
  maxTokens: z.number().int().min(1),
  temperature: z.number().min(0).max(2),
});

/** 에이전트 엔트리 스키마 */
const AgentEntrySchema = z.strictObject({
  agentDir: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  maxConcurrent: z.number().int().optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(z.string()).optional(),
});

/** 세션 설정 스키마 */
const SessionSchema = z.strictObject({
  mainKey: z.string(),
  resetPolicy: z.enum(['daily', 'idle', 'never']),
  idleTimeoutMs: z.number().int().min(0),
});

/** 로깅 설정 스키마 */
const LoggingSchema = z.strictObject({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
  file: z.boolean(),
  redactSensitive: z.boolean(),
});

/** 모델 정의 스키마 */
const ModelDefinitionSchema = z.strictObject({
  provider: z.string(),
  model: z.string(),
  contextWindow: z.number().int().optional(),
  maxOutputTokens: z.number().int().optional(),
  costPer1kInput: z.number().optional(),
  costPer1kOutput: z.number().optional(),
});

/** Discord 채널 설정 스키마 */
const DiscordChannelSchema = z.strictObject({
  botToken: z.string(),
  applicationId: z.string(),
  guildIds: z.array(z.string()).optional(),
});

/** 데이터 프로바이더 스키마 */
const DataProviderSchema = z.strictObject({
  name: z.string(),
  apiKey: z.string().optional(),
  baseUrl: z.url().optional(),
  rateLimit: z.number().int().optional(),
});

/** 알림 기본값 스키마 */
const AlertDefaultsSchema = z.strictObject({
  cooldownMs: z.number().int(),
  maxActiveAlerts: z.number().int(),
});

/** 보유 종목 스키마 */
const HoldingSchema = z.strictObject({
  symbol: z.string(),
  quantity: z.number(),
  avgCost: z.number().optional(),
  currency: z.string().optional(),
});

/** 포트폴리오 스키마 */
const PortfolioSchema = z.strictObject({
  name: z.string(),
  holdings: z.array(HoldingSchema),
});

/** 금융 설정 스키마 */
const FinanceSchema = z.strictObject({
  dataProviders: z.array(DataProviderSchema).optional(),
  newsFeeds: z
    .array(
      z.strictObject({
        name: z.string(),
        url: z.url(),
        refreshIntervalMs: z.number().int().optional(),
      }),
    )
    .optional(),
  alertDefaults: AlertDefaultsSchema.optional(),
  portfolios: z.record(z.string(), PortfolioSchema).optional(),
});

/**
 * FinClawConfig 루트 스키마
 *
 * - z.strictObject() 사용: 알 수 없는 키 감지 (오타 방지)
 * - 모든 최상위 섹션은 optional (빈 {} 허용)
 * - .default()는 사용하지 않음 — 7단계 defaults.ts에서 별도 적용
 */
export const FinClawConfigSchema = z.strictObject({
  gateway: GatewaySchema.partial().optional(),
  agents: z
    .strictObject({
      defaults: AgentDefaultsSchema.partial().optional(),
      entries: z.record(z.string(), AgentEntrySchema).optional(),
    })
    .optional(),
  channels: z
    .strictObject({
      discord: DiscordChannelSchema.optional(),
      cli: z.strictObject({ enabled: z.boolean() }).partial().optional(),
      web: z
        .strictObject({
          enabled: z.boolean(),
          port: z.number().int().optional(),
        })
        .partial()
        .optional(),
    })
    .optional(),
  session: SessionSchema.partial().optional(),
  logging: LoggingSchema.partial().optional(),
  models: z
    .strictObject({
      definitions: z.record(z.string(), ModelDefinitionSchema).optional(),
      aliases: z.record(z.string(), z.string()).optional(),
      defaultModel: z.string().optional(),
      fallbacks: z.array(z.string()).optional(),
    })
    .optional(),
  plugins: z
    .strictObject({
      enabled: z.array(z.string()).optional(),
      disabled: z.array(z.string()).optional(),
    })
    .optional(),
  finance: FinanceSchema.optional(),
  meta: z
    .strictObject({
      lastTouchedVersion: z.string().optional(),
      lastTouchedAt: z.string().optional(),
    })
    .optional(),
});

export type ValidatedFinClawConfig = z.infer<typeof FinClawConfigSchema>;
