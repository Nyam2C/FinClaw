import { homedir } from 'node:os';
import { join } from 'node:path';
// packages/server/src/main.ts
import {
  AnthropicAdapter,
  BUILT_IN_MODELS,
  buildModelAliasIndex,
  DEFAULT_FALLBACK_CHAIN,
  InMemoryModelCatalog,
  InMemoryToolRegistry,
  ProfileHealthMonitor,
  Runner,
} from '@finclaw/agent';
import { DiscordAccountSchema, DiscordAdapter } from '@finclaw/channel-discord';
import { ConfigValidationError, loadConfig, validateConfigStrict } from '@finclaw/config';
import {
  assertPortAvailable,
  ConcurrencyLane,
  ConcurrencyLaneManager,
  createLogger,
  formatPortOccupant,
  getEventBus,
  inspectPortOccupant,
  PortInUseError,
} from '@finclaw/infra';
import {
  ALERT_SKILL_METADATA,
  KeyRotator,
  MARKET_SKILL_METADATA,
  NEWS_SKILL_METADATA,
  readKeyArray,
  registerMarketTools,
  registerNewsTools,
  registerAlertTools,
  type AlertSkillHandle,
  type MarketSkillHandle,
  type NewsSkillHandle,
} from '@finclaw/skills-finance';
import { GENERAL_SKILL_METADATA, registerGeneralTools } from '@finclaw/skills-general';
import {
  assertEmbeddingDimension,
  createEmbeddingProvider,
  createStorage,
  type EmbeddingProvider,
} from '@finclaw/storage';
import type {
  ChannelPlugin,
  ConfigValidationIssue,
  FinClawConfig,
  ModelRef,
  Schedule,
} from '@finclaw/types';
import { DefaultAttachMemoryService } from './auto-reply/agent-memory-hook.js';
import { registerBuiltInCommands } from './auto-reply/commands/built-in.js';
import { InMemoryCommandRegistry } from './auto-reply/commands/registry.js';
import { RunnerExecutionAdapter, type RunnerFactory } from './auto-reply/execution-adapter.js';
import { StubFinanceContextProvider } from './auto-reply/pipeline-context.js';
import { AutoReplyPipeline } from './auto-reply/pipeline.js';
import { buildToolMetaIndex, makeRouterHelper } from './auto-reply/router-helper.js';
import { DefaultMemoryCaptureService } from './auto-reply/stages/memory-capture.js';
import { DefaultMemoryRetrievalService } from './auto-reply/stages/memory-retrieval.js';
import { deliverScheduleResult } from './automation/delivery.js';
import { SchedulerService } from './automation/scheduler.js';
import { initChannels } from './channels/index.js';
import type { GatewayServerConfig } from './gateway/rpc/types.js';
import { createGatewayServer } from './gateway/server.js';
import { loadPlugins } from './plugins/loader.js';
import { ProcessLifecycle } from './process/lifecycle.js';
import { MessageRouter } from './process/message-router.js';
import { loadPrompt } from './prompts/loader.js';

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
  model: 'claude-sonnet-4-6',
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
};

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

/**
 * Phase 26: capture / retrieval / attach 3 service 를 동일 deps 로 인스턴스화.
 *
 * 3 service 모두 `{db, embeddingProvider?, logger}` shape 를 받으며 같은 embedding
 * 인스턴스를 공유한다 (키 하나로 4 영역 활성). embeddingProvider 미주입 시 각 service
 * 가 자체적으로 FTS-only fallback 으로 동작.
 */
function wireMemoryServices(deps: ConstructorParameters<typeof DefaultMemoryCaptureService>[0]): {
  memoryCaptureService: DefaultMemoryCaptureService;
  memoryRetrievalService: DefaultMemoryRetrievalService;
  attachMemoryService: DefaultAttachMemoryService;
} {
  return {
    memoryCaptureService: new DefaultMemoryCaptureService(deps),
    memoryRetrievalService: new DefaultMemoryRetrievalService(deps),
    attachMemoryService: new DefaultAttachMemoryService(deps),
  };
}

async function main(): Promise<void> {
  // 0. 시스템 프롬프트 외부 .md 로드 (Phase 25)
  const systemPromptDoc = await loadPrompt('finclaw.system.ko.md', 'main:DEFAULT_SYSTEM_PROMPT');
  const DEFAULT_SYSTEM_PROMPT = systemPromptDoc.body;

  // 1. env 검증
  const anthropicKey = requireEnv('ANTHROPIC_API_KEY');
  const discordToken = requireEnv('DISCORD_BOT_TOKEN');
  const discordAppId = requireEnv('DISCORD_APPLICATION_ID');

  // 1a. GATEWAY_PORT strict 검증 (config 전면 도입 전 과도기)
  const gatewayPortRaw = process.env.GATEWAY_PORT;
  const gatewayPort = gatewayPortRaw ? Number(gatewayPortRaw) : defaultConfig.port;
  validateConfigStrict({
    gateway: { host: defaultConfig.host, port: gatewayPort },
  });

  // 2. 기반 (로거, 라이프사이클, 스토리지)
  const logger = createLogger({ name: 'finclaw', level: 'info' });
  const lifecycle = new ProcessLifecycle({ logger });

  // 2a. 전체 config 로드 + strict 재검증 (Phase 24 — routing 등 잘못된 설정으로 기동 차단)
  const finclawConfig = loadConfig({ logger });
  validateConfigStrict(finclawConfig);
  const routing = finclawConfig.routing;
  if (routing) {
    logger.info('Model routing table loaded', {
      event: 'routing.loaded',
      table: {
        fetch: routing.roles.fetch.preferred,
        chat: routing.roles.chat.preferred,
        analysis: routing.roles.analysis.preferred,
        summarize: routing.roles.summarize.preferred,
      },
      automation: routing.automation,
      override: routing.override,
    });
  } else {
    logger.warn('routing config not found, using defaults', { event: 'routing.config_missing' });
  }

  // Phase 24: 라우터 helper 구축 — 4개 스킬 메타에서 도구 인덱스 수집.
  // routing 미주입 시 helper 생성하지 않음 (어댑터/agent.run 모두 fallback 동작).
  const routerHelper = routing
    ? makeRouterHelper(
        routing,
        buildToolMetaIndex([
          MARKET_SKILL_METADATA,
          NEWS_SKILL_METADATA,
          ALERT_SKILL_METADATA,
          GENERAL_SKILL_METADATA,
        ]),
      )
    : undefined;
  const dbPath = process.env.FINCLAW_DB_PATH ?? join(homedir(), '.finclaw', 'db.sqlite');
  const storage = createStorage({ dbPath });
  await storage.initialize();
  lifecycle.register(async () => {
    await storage.close();
  });

  // Phase 26 B / Phase 29 C: memory.search hybrid 검색용 embedding provider (best-effort).
  // 키 미설정/생성 실패 시 undefined → memory.search 는 FTS-only fallback.
  // OpenAI 만 있으면 dimensions=storage.vectorDimension truncation 으로 vec0 매칭.
  let embeddingProvider: EmbeddingProvider | undefined;
  if (process.env.VOYAGE_API_KEY || process.env.OPENAI_API_KEY) {
    try {
      embeddingProvider = await createEmbeddingProvider('auto', {
        dimensions: storage.vectorDimension,
      });
      assertEmbeddingDimension(embeddingProvider, storage.vectorDimension);
      logger.info('Embedding provider created', {
        event: 'memory.embedding_ready',
        model: embeddingProvider.model,
        dimensions: embeddingProvider.dimensions,
      });
    } catch (err) {
      logger.warn('Failed to create embedding provider — memory.search will use FTS-only', {
        event: 'memory.embedding_unavailable',
        error: (err as Error).message,
      });
      embeddingProvider = undefined;
    }
  }

  // 2b. 채널 도크 자동 등록 (discord, http-webhook)
  initChannels(logger);

  // 3. Discord 클라이언트 먼저 로그인 (alerts가 DM 전달 핸들을 필요로 함)
  const discordAdapter = new DiscordAdapter();
  const discordAccount = DiscordAccountSchema.parse({
    botToken: discordToken,
    applicationId: discordAppId,
  });
  const cleanup = await discordAdapter.setup(discordAccount);
  lifecycle.register(cleanup);
  logger.info('Discord adapter logged in');

  // 4. Agent 레이어 (툴 레지스트리 + 러너 팩토리)
  const anthropicAdapter = new AnthropicAdapter(anthropicKey);
  const lanes = new ConcurrencyLaneManager();
  const toolRegistry = new InMemoryToolRegistry();
  registerGeneralTools(toolRegistry);

  // 4a. 모델 카탈로그 + 별칭 인덱스 + 프로필 건강 모니터.
  // (스킬 등록보다 먼저 생성 — Phase 24 E 의 analyze_market 등록 시점에 주입 필요.)
  const modelCatalog = new InMemoryModelCatalog(BUILT_IN_MODELS);
  const modelAliasIndex = buildModelAliasIndex(modelCatalog);
  const profileHealth = new ProfileHealthMonitor();

  const finnhubKeys = readKeyArray('FINNHUB_KEY');
  const twelveDataKeys = readKeyArray('TWELVE_DATA_KEY');
  const alphaVantageKeys = readKeyArray('ALPHA_VANTAGE_KEY');
  const coinGeckoKey = process.env.COINGECKO_API_KEY;

  const finnhubRotator = finnhubKeys.length > 0 ? new KeyRotator(finnhubKeys) : undefined;
  const twelveDataRotator = twelveDataKeys.length > 0 ? new KeyRotator(twelveDataKeys) : undefined;
  const alphaVantageRotator =
    alphaVantageKeys.length > 0 ? new KeyRotator(alphaVantageKeys) : undefined;

  let marketHandle: MarketSkillHandle | undefined;
  let newsHandle: NewsSkillHandle | undefined;

  if (finnhubRotator || twelveDataRotator || alphaVantageRotator || coinGeckoKey) {
    marketHandle = await registerMarketTools(toolRegistry, {
      db: storage.db,
      finnhubRotator,
      twelveDataRotator,
      alphaVantageRotator,
      coinGeckoKey,
    });
    logger.info('Market tools registered', {
      providers: [
        finnhubRotator && 'finnhub',
        twelveDataRotator && 'twelve-data',
        alphaVantageRotator && 'alpha-vantage',
        coinGeckoKey && 'coingecko',
      ].filter(Boolean),
    });
  } else {
    logger.info('No market keys set — skipping market tools');
  }

  const newsdataKeys = readKeyArray('NEWSDATA_API_KEY');
  const newsdataRotator = newsdataKeys.length > 0 ? new KeyRotator(newsdataKeys) : undefined;

  if (marketHandle && (alphaVantageRotator || newsdataRotator || finnhubRotator)) {
    newsHandle = await registerNewsTools(toolRegistry, {
      db: storage.db,
      alphaVantageKey: alphaVantageKeys[0],
      newsdataRotator,
      finnhubRotator, // 시세 KeyRotator 와 동일 인스턴스 공유
      quoteService: marketHandle.quoteService,
      anthropicApiKey: anthropicKey,
      router: routerHelper,
      defaultModel: DEFAULT_MODEL,
      // Phase 24 E: 스킬 내부 analyze_market LLM 호출도 status 분포에 포함.
      profileHealth,
      profileId: 'default',
      modelCatalog,
    });
    logger.info('News tools registered', {
      providers: [
        alphaVantageRotator && 'alpha-vantage',
        newsdataRotator && 'newsdata',
        finnhubRotator && 'finnhub-news',
      ].filter(Boolean),
    });
  } else if (marketHandle) {
    logger.info('No news keys set — skipping news tools');
  }

  let alertHandle: AlertSkillHandle | undefined;
  if (marketHandle && newsHandle) {
    const discordClient = discordAdapter.getClient();
    alertHandle = await registerAlertTools(toolRegistry, {
      db: storage.db,
      cache: marketHandle.cache,
      registry: marketHandle.providers,
      newsAggregator: newsHandle.aggregator,
      logger,
      discordClient: discordClient ?? undefined,
    });
    const handle = alertHandle;
    lifecycle.register(async () => {
      handle.monitor.stop();
    });
    logger.info('Alert monitor started');
  } else {
    logger.info('market/news tools unavailable — skipping alerts');
  }

  // Phase 29 D9: MCP 도구 group=mcp 정책 — require-approval (사용자 결정 5).
  toolRegistry.addPolicyRule({
    pattern: 'mcp:*',
    verdict: 'require-approval',
    reason: 'MCP external tools require explicit approval',
    priority: 100,
  });

  // Phase 29 D9: plugin loader 호출. plugins 디렉터리 미존재 시 no-op (loader 가 silently 처리).
  const pluginsDir = process.env.FINCLAW_PLUGINS_DIR ?? join(homedir(), '.finclaw', 'plugins');
  const pluginResult = await loadPlugins([pluginsDir], [pluginsDir], toolRegistry);
  logger.info('Plugins loaded', {
    event: 'plugins.loaded',
    loaded: pluginResult.loaded,
    failed: pluginResult.failed,
    mcpServers: pluginResult.mcpHandles.length,
  });
  lifecycle.register(async () => {
    for (const h of pluginResult.mcpHandles) {
      await h.shutdown();
    }
  });

  const runnerFactory: RunnerFactory = (dispatcher) =>
    new Runner({
      provider: anthropicAdapter,
      toolExecutor: dispatcher,
      laneManager: lanes,
    });

  // 4b. 실행 어댑터 (storage + toolRegistry 주입 — per-request dispatcher를 빌드)
  const adapter = new RunnerExecutionAdapter({
    runnerFactory,
    defaultModel: DEFAULT_MODEL,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    storage,
    toolRegistry,
    logger,
    modelCatalog,
    modelAliasIndex,
    fallbackChain: DEFAULT_FALLBACK_CHAIN,
    profileHealth,
    profileId: 'default',
    router: routerHelper,
  });

  // 5. 파이프라인
  const financeCtxProvider = new StubFinanceContextProvider();
  const commandRegistry = new InMemoryCommandRegistry();
  registerBuiltInCommands(commandRegistry, {
    toolRegistry,
    storage,
    profileHealth,
    profileId: 'default',
    defaultModel: DEFAULT_MODEL,
    marketHandle,
    newsHandle,
  });
  const channelPluginRegistry = new Map<string, ChannelPlugin>();

  // Phase 26 B/C/D: capture / retrieval / attach 3 service 를 동일 deps 로 wire-up.
  // - capture: 정규식 5종 명시적 선언 저장
  // - retrieval: hybrid (vector+FTS) RAG 주입, embeddingProvider 미주입 시 FTS-only fallback
  // - attach: agent.run output → memory 훅
  const { memoryCaptureService, memoryRetrievalService, attachMemoryService } = wireMemoryServices({
    db: storage.db,
    embeddingProvider,
    logger,
  });

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
      memoryCaptureService,
      memoryRetrievalService,
    },
  );

  // 6. MessageRouter
  const routerConfig: FinClawConfig = {};
  const router = new MessageRouter({
    config: routerConfig,
    logger,
    onProcess: (ctx, match, signal) => pipeline.process(ctx, match, signal),
  });

  // 7. Discord onMessage 등록 (client는 이미 위에서 로그인 완료)
  channelPluginRegistry.set(discordAdapter.id as string, discordAdapter);
  discordAdapter.onMessage(async (msg) => {
    await router.route(msg);
  });
  logger.info('Discord adapter connected');

  // 8. Gateway — FINCLAW_API_KEY 환경변수로 API 키 기반 인증 활성화
  const gatewayConfig: GatewayServerConfig = {
    ...defaultConfig,
    port: gatewayPort,
    auth: {
      ...defaultConfig.auth,
      apiKeys: process.env.FINCLAW_API_KEY ? [process.env.FINCLAW_API_KEY] : [],
    },
  };
  try {
    await assertPortAvailable(gatewayConfig.port);
  } catch (err) {
    if (err instanceof PortInUseError) {
      const occupant = await inspectPortOccupant(gatewayConfig.port);
      console.error(`[fatal] ${formatPortOccupant(gatewayConfig.port, occupant)}`);
      process.exit(1);
    }
    throw err;
  }
  const alertHandleForRpc = alertHandle;
  const agentRunLane = new ConcurrencyLane({
    maxConcurrent: 1,
    maxQueueSize: 10,
    waitTimeoutMs: 120_000,
  });

  // Phase 28: schedule 동시 실행 1개로 제한하는 lane.
  // agent.run 큐잉 lane 과 별개로 schedule 전용 (대기열 5분 보유).
  const scheduleLane = new ConcurrencyLane({
    maxConcurrent: 1,
    maxQueueSize: 50,
    waitTimeoutMs: 5 * 60_000,
  });

  // Phase 28: SchedulerService — 매 분 폴러로 schedules 검사 + agent.run 직접 실행.
  // delivery hook 은 gateway 생성 후 lateinit (broadcaster/connections 가 그때 가용).
  let deliveryHook:
    | ((args: {
        schedule: Schedule;
        agentRunId: string | null;
        output: string;
        error?: string;
      }) => Promise<void>)
    | null = null;
  const maxFailRaw = process.env.AUTOMATION_MAX_CONSECUTIVE_FAILURES;
  const maxConsecutiveFailures = maxFailRaw ? Number(maxFailRaw) : 3;
  const scheduler = new SchedulerService({
    db: storage.db,
    toolRegistry,
    runnerFactory,
    lane: scheduleLane,
    defaultModel: DEFAULT_MODEL,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    logger,
    profileHealth,
    profileId: 'default',
    router: routerHelper,
    modelCatalog,
    modelAliasIndex,
    fallbackChain: DEFAULT_FALLBACK_CHAIN,
    maxConsecutiveFailures,
    onRunComplete: async (args) => {
      if (deliveryHook) {
        await deliveryHook(args);
      }
    },
  });
  lifecycle.register(() => scheduler.stop());

  const gateway = createGatewayServer(gatewayConfig, {
    storage,
    defaultModel: DEFAULT_MODEL,
    adapter,
    financeDeps: {
      quoteService: marketHandle?.quoteService,
      newsAggregator: newsHandle?.aggregator,
      alertStore: alertHandleForRpc?.store,
      portfolioStore: newsHandle?.portfolioStore,
      evaluateAlertOnce: alertHandleForRpc
        ? (alertId: string) => alertHandleForRpc.monitor.evaluateOnce(alertId)
        : undefined,
      // Phase 26 A: finance.transaction.* + finance.portfolio.get(recentTransactions) 용.
      db: storage.db,
    },
    // Phase 26 B: memory.* RPC 용. embeddingProvider 가 없으면 memory.search 는 FTS-only.
    memoryDeps: {
      db: storage.db,
      embeddingProvider,
    },
    agentDeps: {
      toolRegistry,
      runnerFactory,
      agentRunLane,
      profileHealth,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      defaultModel: DEFAULT_MODEL,
      logger,
      profileId: 'default',
      router: routerHelper,
      modelCatalog,
      modelAliasIndex,
      fallbackChain: DEFAULT_FALLBACK_CHAIN,
      // Phase 26 D: agent.run 종료 후 output → memory 저장 훅 (rpc-engineer 가 호출 위치 결정).
      attachMemoryService,
      // Phase 26 D: agent_runs 영속화 + agent.runs.* RPC 가 사용 (server.ts 에서 재패스).
      db: storage.db,
    },
    // Phase 28: schedule.* RPC 배선.
    scheduleDeps: { db: storage.db, scheduler },
    // Phase 29 E6: /readyz 의 db / embedding 컴포넌트 헬스 체커.
    dbHealthCheck: async () => {
      storage.db.prepare('SELECT 1').get();
    },
    embeddingHealthCheck: embeddingProvider
      ? async () => {
          // 짧은 query 1건 — 실패 시 throw → degraded
          await embeddingProvider.embedQuery('healthz');
        }
      : undefined,
  });
  logger.info('finance.* / memory.* / agent.* RPC methods wired');
  lifecycle.register(() => gateway.stop());

  // Phase 29 E6: dev 모드에서만 hot reload — prompts 디렉터리 watch.
  if (process.env.NODE_ENV !== 'production') {
    const { createHotReloader } = await import('./gateway/hot-reload.js');
    const promptsPath = join(import.meta.dirname, '..', 'prompts', 'finclaw.system.ko.md');
    const hotReloader = createHotReloader(
      { configPath: promptsPath, debounceMs: 500, validateBeforeApply: false, mode: 'watch' },
      gateway.ctx,
      () => ({ success: true }),
    );
    hotReloader.on('change', (e) => {
      logger.info('Prompts hot-reloaded', { event: 'prompts.reloaded', path: e.path });
    });
    await hotReloader.start();
    lifecycle.register(async () => {
      hotReloader.stop();
    });
  }

  // Phase 28: gateway 생성 후 delivery hook 활성화. broadcaster/connections 는 gateway.ctx 에서 가져온다.
  deliveryHook = (args) =>
    deliverScheduleResult(
      {
        discordClient: discordAdapter.getClient() ?? undefined,
        broadcaster: gateway.ctx.broadcaster,
        connections: gateway.ctx.connections,
        logger,
      },
      args,
    );

  lifecycle.init();
  await gateway.start();
  scheduler.start();
  logger.info(`Gateway listening on ${gatewayConfig.host}:${gatewayConfig.port}`);

  getEventBus().emit('system:ready');
}

if (!process.env.VITEST) {
  main().catch((err) => {
    if (err instanceof MissingEnvError) {
      console.error(`[fatal] Missing required env: ${err.envName}`);
    } else if (err instanceof ConfigValidationError) {
      console.error('[fatal] Invalid configuration:');
      const issues = (err.details?.issues as ConfigValidationIssue[] | undefined) ?? [];
      for (const issue of issues) {
        console.error(`  - ${issue.path}: ${issue.message}`);
      }
    } else {
      console.error('Failed to start gateway server:', err);
    }
    process.exit(1);
  });
}
