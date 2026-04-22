import type { ChannelPlugin, FinClawConfig, ModelRef } from '@finclaw/types';
// packages/server/src/main.ts
import { AnthropicAdapter, InMemoryToolRegistry, Runner } from '@finclaw/agent';
import { DiscordAccountSchema, DiscordAdapter } from '@finclaw/channel-discord';
import {
  assertPortAvailable,
  ConcurrencyLaneManager,
  createLogger,
  getEventBus,
} from '@finclaw/infra';
import { registerMarketTools } from '@finclaw/skills-finance';
import { registerGeneralTools } from '@finclaw/skills-general';
import { createStorage } from '@finclaw/storage';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GatewayServerConfig } from './gateway/rpc/types.js';
import { InMemoryCommandRegistry } from './auto-reply/commands/registry.js';
import { RunnerExecutionAdapter, type RunnerFactory } from './auto-reply/execution-adapter.js';
import { StubFinanceContextProvider } from './auto-reply/pipeline-context.js';
import { AutoReplyPipeline } from './auto-reply/pipeline.js';
import { createGatewayServer } from './gateway/server.js';
import { ProcessLifecycle } from './process/lifecycle.js';
import { MessageRouter } from './process/message-router.js';

/** 기본 게이트웨이 설정 */
const defaultConfig: GatewayServerConfig = {
  host: '0.0.0.0',
  port: 3000,
  cors: {
    origins: ['*'],
    maxAge: 600,
  },
  auth: {
    apiKeys: [],
    jwtSecret: process.env.GATEWAY_JWT_SECRET ?? 'dev-secret',
    sessionTtlMs: 30 * 60_000,
  },
  ws: {
    heartbeatIntervalMs: 30_000,
    heartbeatTimeoutMs: 10_000,
    maxPayloadBytes: 1024 * 1024,
    handshakeTimeoutMs: 10_000,
    maxConnections: 100,
  },
  rpc: {
    maxBatchSize: 10,
    timeoutMs: 60_000,
  },
};

const DEFAULT_MODEL: ModelRef = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
};

const DEFAULT_SYSTEM_PROMPT =
  'You are FinClaw, a helpful personal assistant. 한국어로 자연스럽게 대답해.';

export class MissingEnvError extends Error {
  constructor(public readonly envName: string) {
    super(`Missing required env: ${envName}`);
    this.name = 'MissingEnvError';
  }
}

/**
 * 환경 변수 조회 (테스트 가능한 형태).
 * 값이 없으면 MissingEnvError throw.
 */
export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (!value) {
    throw new MissingEnvError(name);
  }
  return value;
}

async function main(): Promise<void> {
  // 1. env 검증
  const anthropicKey = requireEnv('ANTHROPIC_API_KEY');
  const discordToken = requireEnv('DISCORD_BOT_TOKEN');
  const discordAppId = requireEnv('DISCORD_APPLICATION_ID');

  // 2. 기반 (로거, 라이프사이클, 스토리지)
  const logger = createLogger({ name: 'finclaw', level: 'info' });
  const lifecycle = new ProcessLifecycle({ logger });
  const dbPath = process.env.FINCLAW_DB_PATH ?? join(homedir(), '.finclaw', 'db.sqlite');
  const storage = createStorage({ dbPath });
  await storage.initialize();
  lifecycle.register(async () => {
    await storage.close();
  });

  // 3. Agent 레이어 (툴 레지스트리 + 러너 팩토리)
  const anthropicAdapter = new AnthropicAdapter(anthropicKey);
  const lanes = new ConcurrencyLaneManager();
  const toolRegistry = new InMemoryToolRegistry();
  registerGeneralTools(toolRegistry);

  const alphaVantageKey = process.env.ALPHA_VANTAGE_KEY;
  const coinGeckoKey = process.env.COINGECKO_API_KEY;
  if (alphaVantageKey || coinGeckoKey) {
    await registerMarketTools(toolRegistry, {
      db: storage.db,
      alphaVantageKey,
      coinGeckoKey,
    });
    logger.info('Market tools registered');
  } else {
    logger.info('ALPHA_VANTAGE_KEY/COINGECKO_API_KEY not set — skipping market tools');
  }

  const runnerFactory: RunnerFactory = (dispatcher) =>
    new Runner({
      provider: anthropicAdapter,
      toolExecutor: dispatcher,
      laneManager: lanes,
    });

  // 4. 실행 어댑터 (storage + toolRegistry 주입 — per-request dispatcher를 빌드)
  const adapter = new RunnerExecutionAdapter({
    runnerFactory,
    defaultModel: DEFAULT_MODEL,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    storage,
    toolRegistry,
    logger,
  });

  // 5. 파이프라인
  const financeCtxProvider = new StubFinanceContextProvider();
  const commandRegistry = new InMemoryCommandRegistry();
  const channelPluginRegistry = new Map<string, ChannelPlugin>();
  const pipeline = new AutoReplyPipeline(
    {
      enableAck: true,
      commandPrefix: '!finclaw ',
      maxResponseLength: 2000,
      timeoutMs: 60_000,
      respectMarketHours: false,
    },
    {
      executionAdapter: adapter,
      financeContextProvider: financeCtxProvider,
      commandRegistry,
      logger,
      getChannel: (id) => channelPluginRegistry.get(id),
    },
  );

  // 6. MessageRouter
  const routerConfig: FinClawConfig = {};
  const router = new MessageRouter({
    config: routerConfig,
    logger,
    onProcess: (ctx, match, signal) => pipeline.process(ctx, match, signal),
  });

  // 7. Discord
  const discordAdapter = new DiscordAdapter();
  const discordAccount = DiscordAccountSchema.parse({
    botToken: discordToken,
    applicationId: discordAppId,
  });
  const cleanup = await discordAdapter.setup(discordAccount);
  lifecycle.register(cleanup);
  channelPluginRegistry.set(discordAdapter.id as string, discordAdapter);
  discordAdapter.onMessage(async (msg) => {
    await router.route(msg);
  });
  logger.info('Discord adapter connected');

  // 8. Gateway
  await assertPortAvailable(defaultConfig.port);
  const gateway = createGatewayServer(defaultConfig, {
    storage,
    defaultModel: DEFAULT_MODEL,
  });
  lifecycle.register(() => gateway.stop());
  lifecycle.init();
  await gateway.start();
  logger.info(`Gateway listening on ${defaultConfig.host}:${defaultConfig.port}`);

  getEventBus().emit('system:ready');
}

if (!process.env.VITEST) {
  main().catch((err) => {
    if (err instanceof MissingEnvError) {
      console.error(`[fatal] Missing required env: ${err.envName}`);
    } else {
      console.error('Failed to start gateway server:', err);
    }
    process.exit(1);
  });
}
