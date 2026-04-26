import type { ChannelPlugin, ConfigValidationIssue, FinClawConfig, ModelRef } from '@finclaw/types';
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
  MARKET_SKILL_METADATA,
  NEWS_SKILL_METADATA,
  registerMarketTools,
  registerNewsTools,
  registerAlertTools,
  type AlertSkillHandle,
  type MarketSkillHandle,
  type NewsSkillHandle,
} from '@finclaw/skills-finance';
import { GENERAL_SKILL_METADATA, registerGeneralTools } from '@finclaw/skills-general';
import { createStorage } from '@finclaw/storage';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GatewayServerConfig } from './gateway/rpc/types.js';
import { registerBuiltInCommands } from './auto-reply/commands/built-in.js';
import { InMemoryCommandRegistry } from './auto-reply/commands/registry.js';
import { RunnerExecutionAdapter, type RunnerFactory } from './auto-reply/execution-adapter.js';
import { StubFinanceContextProvider } from './auto-reply/pipeline-context.js';
import { AutoReplyPipeline } from './auto-reply/pipeline.js';
import { buildToolMetaIndex, makeRouterHelper } from './auto-reply/router-helper.js';
import { initChannels } from './channels/index.js';
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

const DEFAULT_SYSTEM_PROMPT = [
  '너는 사용자의 **개인 금융 파트너(Personal Finance Partner)** FinClaw다.',
  '',
  '## 역할',
  '- 시장 데이터 조회, 뉴스 요약, 포트폴리오 추적, 가격 알림 관리가 주 업무다.',
  '- 사용자 본인의 돈이 걸린 판단을 보조한다. 신중하고 정직하게 답하라.',
  '',
  '## 원칙',
  '1. **읽기 전용.** 매매 실행·자금 이체·계좌 변경은 절대 제안하지 않는다. 요청받으면 "나는 조회·분석만 한다"라고 명확히 거절한다.',
  '2. **환각 금지.** 수치·뉴스·날짜는 반드시 도구로 확인하고 답한다. 도구 없이 지식에서 가격·뉴스를 지어내지 말 것. 확인 불가면 "확인할 수 없다"라고 답한다.',
  '3. **출처 명시.** 수치 언급 시 어느 API·어느 시각 데이터인지 밝혀라. 응답 끝에 시스템이 자동으로 출처를 첨부하지만, 본문에서도 인용하면 더 좋다.',
  '4. **불확실성 수치화.** 예측·전망은 숫자(범위, 확률, 신뢰도)로 표현한다. "잘 모르겠지만" 같은 모호한 표현 최소화.',
  '5. **간결한 한국어.** 불필요한 인사·군더더기 없이 핵심부터. 긴 설명은 불릿으로.',
  '',
  '## 사용 가능한 도구 (API 키 설정 상태에 따라 가변)',
  '- `get_stock_price`, `get_crypto_price`, `get_forex_rate`, `get_market_chart` — 시세 조회',
  '- `get_financial_news`, `analyze_market` — 금융 뉴스·분석',
  '- `set_alert`, `list_alerts`, `remove_alert`, `get_alert_history` — 가격/변화/뉴스 알림',
  '- `get_portfolio_summary` — 포트폴리오 요약',
  '- `get_current_datetime`, `web_fetch`, `read_local_file` — 일반 유틸',
  '',
  '도구가 필요한데 없으면 "도구 X가 필요한데 지금 활성화되어 있지 않다. API 키 확인 바란다"라고 답한다.',
  '',
  '## 도구 결과 처리',
  '도구 결과가 모델 일시 불가 안내(예: "analyze_market 사용 불가: opus 이상 모델…")를 반환하면 가짜 분석을 만들지 말고 어느 모델이 일시 불가하며 약 60초 후 재시도 가능하다는 점을 사용자에게 한국어로 그대로 전달한다.',
].join('\n');

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

  const alphaVantageKey = process.env.ALPHA_VANTAGE_KEY;
  const coinGeckoKey = process.env.COINGECKO_API_KEY;

  let marketHandle: MarketSkillHandle | undefined;
  let newsHandle: NewsSkillHandle | undefined;

  if (alphaVantageKey || coinGeckoKey) {
    marketHandle = await registerMarketTools(toolRegistry, {
      db: storage.db,
      alphaVantageKey,
      coinGeckoKey,
    });
    logger.info('Market tools registered');
  } else {
    logger.info('ALPHA_VANTAGE_KEY/COINGECKO_API_KEY not set — skipping market tools');
  }

  if (marketHandle && alphaVantageKey) {
    newsHandle = await registerNewsTools(toolRegistry, {
      db: storage.db,
      alphaVantageKey,
      quoteService: marketHandle.quoteService,
      anthropicApiKey: anthropicKey,
      router: routerHelper,
      defaultModel: DEFAULT_MODEL,
      // Phase 24 E: 스킬 내부 analyze_market LLM 호출도 status 분포에 포함.
      profileHealth,
      profileId: 'default',
      modelCatalog,
    });
    logger.info('News tools registered');
  } else if (marketHandle) {
    logger.info('ALPHA_VANTAGE_KEY not set — skipping news tools');
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
  });
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
    },
  });
  logger.info('finance.* / agent.* RPC methods wired');
  lifecycle.register(() => gateway.stop());
  lifecycle.init();
  await gateway.start();
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
