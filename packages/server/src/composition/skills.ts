// packages/server/src/composition/skills.ts
// Phase 36: main.ts 355 + 363-559 에서 추출 (순수 이동). 조건부 등록·lifecycle.register·로깅 보존.

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryModelCatalog,
  InMemoryToolRegistry,
  NEWS_BRIEF_PROMPT,
  NEWS_BRIEF_SCHEDULE_ID,
  ProfileHealthMonitor,
} from '@finclaw/agent';
import type { DiscordAdapter } from '@finclaw/channel-discord';
import { nextRunAt as computeNextRunAt, parseCron } from '@finclaw/infra';
import type { FinClawLogger } from '@finclaw/infra';
import {
  KeyRotator,
  KisClient,
  KisTokenManager,
  readKeyArray,
  registerAlertTools,
  registerBrokerageTools,
  registerMarketTools,
  registerNewsTools,
  type AlertSkillHandle,
  type BrokerageProvider,
  type MarketSkillHandle,
  type NewsSkillHandle,
} from '@finclaw/skills-finance';
import { registerGeneralTools, registerRouteTaskTool } from '@finclaw/skills-general';
import { addSchedule, getSchedule, type createStorage } from '@finclaw/storage';
import type { FinClawConfig, ModelRef, ScheduleRpc, Timestamp } from '@finclaw/types';
import { createAgentId } from '@finclaw/types';
import { loadPlugins } from '../plugins/loader.js';
import type { ProcessLifecycle } from '../process/lifecycle.js';
import { buildRouteDispatcher } from '../router/dispatch.js';
import { BrokerageSyncService } from '../services/brokerage-sync-service.js';

type Storage = ReturnType<typeof createStorage>;

export interface RegisterSkillsDeps {
  readonly toolRegistry: InMemoryToolRegistry;
  readonly storage: Storage;
  readonly logger: FinClawLogger;
  readonly finclawConfig: FinClawConfig;
  readonly discordAdapter: DiscordAdapter;
  readonly profileHealth: ProfileHealthMonitor;
  readonly modelCatalog: InMemoryModelCatalog;
  readonly defaultModel: ModelRef;
  readonly scheduleRpc: ScheduleRpc;
  readonly lifecycle: ProcessLifecycle;
}

export interface SkillsBundle {
  readonly marketHandle: MarketSkillHandle | undefined;
  readonly newsHandle: NewsSkillHandle | undefined;
  readonly alertHandle: AlertSkillHandle | undefined;
  readonly brokerageSyncService: BrokerageSyncService | undefined;
  readonly kisEnv: 'prod' | 'vts';
}

export async function registerSkills(deps: RegisterSkillsDeps): Promise<SkillsBundle> {
  const {
    toolRegistry,
    storage,
    logger,
    finclawConfig,
    discordAdapter,
    profileHealth,
    modelCatalog,
    defaultModel,
    scheduleRpc,
    lifecycle,
  } = deps;

  registerGeneralTools(toolRegistry, { scheduleRpc });

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
      defaultModel,
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

  // 결정 5 PoC: route_task 도구 등록 + analyze_market 메인 노출 제거.
  // dispatcher 가 market_analysis intent 를 sub-agent (좁은 컨텍스트 CLI) 로 위임.
  if (newsHandle) {
    const dispatcher = buildRouteDispatcher({ newsAggregator: newsHandle.aggregator });
    registerRouteTaskTool(toolRegistry, dispatcher);
    toolRegistry.unregister('analyze_market');
    logger.info('route_task tool registered (analyze_market hidden from main agent)', {
      event: 'route_task.registered',
    });
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

  // Phase 33 B-4/B-6 / Phase 41: 브로커리지 read-only 잔고 동기화. BROKERAGE_PROVIDER (기본 kis) 분기.
  const brokerageProvider = (process.env.BROKERAGE_PROVIDER ?? 'kis') as BrokerageProvider;

  /** 1인 사용자 기본 portfolio 보장 — 없으면 'default' 생성. */
  const resolveDefaultPortfolioId = (): string => {
    const existing = storage.db
      .prepare('SELECT id FROM portfolios ORDER BY updated_at ASC LIMIT 1')
      .get() as { id: string } | undefined;
    if (existing) {
      return existing.id;
    }
    storage.db
      .prepare(`INSERT INTO portfolios (id, name, currency, updated_at) VALUES (?, ?, ?, ?)`)
      .run('default', 'Default', 'USD', Date.now());
    return 'default';
  };

  let brokerageSyncService: BrokerageSyncService | undefined;
  let kisEnv: 'prod' | 'vts' = 'prod';

  if (brokerageProvider === 'toss') {
    // Phase 41: Toss Open API 미발급/스펙 미공개 — 인터페이스 경계만. 실 구현은 별 phase.
    logger.warn('brokerage.provider_unimplemented', {
      event: 'brokerage.provider_unimplemented',
      provider: 'toss',
      note: 'Toss brokerage client not implemented (awaiting Open API). Skipping brokerage tools.',
    });
  } else {
    // provider === 'kis' (기본)
    const kisAppKey = process.env.KIS_APP_KEY;
    const kisAppSecret = process.env.KIS_APP_SECRET;
    const kisAccountNo = process.env.KIS_ACCOUNT_NO;
    const kisAccountProductCode = process.env.KIS_ACCOUNT_PRODUCT_CODE ?? '01';
    kisEnv = (process.env.KIS_ENV ?? 'prod') as 'prod' | 'vts';

    if (kisAppKey && kisAppSecret && kisAccountNo) {
      const creds = {
        env: kisEnv,
        appKey: kisAppKey,
        appSecret: kisAppSecret,
        accountNo: kisAccountNo,
        accountProductCode: kisAccountProductCode,
      };
      const kisClient = new KisClient(creds, new KisTokenManager(creds));
      brokerageSyncService = new BrokerageSyncService({
        db: storage.db,
        client: kisClient,
        logger,
        resolvePortfolioId: resolveDefaultPortfolioId,
      });
      const syncService = brokerageSyncService;
      registerBrokerageTools(toolRegistry, {
        syncHoldings: async () => {
          const r = await syncService.run();
          return { holdingsCount: r.holdingsCount, marketsScanned: r.marketsScanned };
        },
      });
      logger.info('Brokerage (KIS) tools registered', { env: kisEnv });

      // Phase 33 C / Phase 40: news-brief seed — CLI 모드는 seed skip (brokerage_sync_holdings MCP deny).
      const isCliMode = (finclawConfig.provider ?? 'claude-cli') === 'claude-cli';
      if (isCliMode) {
        logger.warn('news_brief.seed_skipped_cli', {
          event: 'news_brief.seed_skipped_cli',
          note: 'read-only CLI mode denies brokerage_sync_holdings (humans-only); the holdings brief needs it. Seed skipped — use SDK mode for the scheduled brief.',
        });
      } else if (getSchedule(storage.db, NEWS_BRIEF_SCHEDULE_ID) === null) {
        const briefCron = '0 0 * * *';
        const briefNext = computeNextRunAt(parseCron(briefCron), Date.now());
        addSchedule(storage.db, {
          id: NEWS_BRIEF_SCHEDULE_ID,
          name: 'Daily holdings news brief',
          cron: briefCron,
          agentId: createAgentId('default'),
          prompt: NEWS_BRIEF_PROMPT,
          deliveryChannel: 'web',
          deliveryTarget: 'broadcast',
          enabled: true,
          nextRunAt: briefNext === null ? undefined : (briefNext as Timestamp),
        });
        logger.info('Seeded news-brief-daily schedule', {
          event: 'schedule.seeded',
          id: NEWS_BRIEF_SCHEDULE_ID,
          cron: briefCron,
        });
      }
    } else {
      logger.info('KIS not configured — skipping brokerage tools');
    }
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

  // Phase 40 D: 이전의 'provider.cli_tools_disabled' 경고 제거 — CLI 모드는 이제 in-process /mcp
  // 로 도구를 활성화하므로(read-only 필터) "tools are inactive" 가정이 거짓이 됨.

  return { marketHandle, newsHandle, alertHandle, brokerageSyncService, kisEnv };
}
