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
  type MarketSkillHandle,
  type NewsSkillHandle,
} from '@finclaw/skills-finance';
import { registerGeneralTools } from '@finclaw/skills-general';
import { addSchedule, getSchedule, type createStorage } from '@finclaw/storage';
import type { FinClawConfig, ModelRef, ScheduleRpc, Timestamp } from '@finclaw/types';
import { createAgentId } from '@finclaw/types';
import type { makeRouterHelper } from '../auto-reply/router-helper.js';
import { nextRunAt as computeNextRunAt, parseCron } from '../automation/cron.js';
import { loadPlugins } from '../plugins/loader.js';
import type { ProcessLifecycle } from '../process/lifecycle.js';
import { BrokerageSyncService } from '../services/brokerage-sync-service.js';

type Storage = ReturnType<typeof createStorage>;
type RouterHelper = ReturnType<typeof makeRouterHelper> | undefined;

export interface RegisterSkillsDeps {
  readonly toolRegistry: InMemoryToolRegistry;
  readonly storage: Storage;
  readonly logger: FinClawLogger;
  readonly finclawConfig: FinClawConfig;
  readonly anthropicKey: string;
  readonly discordAdapter: DiscordAdapter;
  readonly routerHelper: RouterHelper;
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
    anthropicKey,
    discordAdapter,
    routerHelper,
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
      anthropicApiKey: anthropicKey,
      router: routerHelper,
      defaultModel,
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

  // Phase 33 B-4/B-6: 한국투자증권(KIS) read-only 잔고 동기화 tool.
  // 키 미설정 시 등록 skip (server 정상 부팅). 자동화는 SDK 모드 전용(§B-0).
  const kisAppKey = process.env.KIS_APP_KEY;
  const kisAppSecret = process.env.KIS_APP_SECRET;
  const kisAccountNo = process.env.KIS_ACCOUNT_NO;
  const kisAccountProductCode = process.env.KIS_ACCOUNT_PRODUCT_CODE ?? '01';
  const kisEnv = (process.env.KIS_ENV ?? 'prod') as 'prod' | 'vts';

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

    // Phase 33 C: 매일 뉴스 브리프 cron 을 idempotent seed — 고정 id 라 onRunComplete 의
    // news-memorizer 분기(§B-3 화이트리스트)가 실제로 발동한다. SDK 모드 전용(§B-0): CLI 모드는
    // tool_use 비활성이라 brokerage_sync_holdings 가 안 돌아 seed 를 skip (조용한 빈 출력 방지).
    const isCliMode = (finclawConfig.provider ?? 'anthropic-sdk') === 'claude-cli';
    if (isCliMode) {
      logger.warn('news_brief.seed_skipped_cli', {
        event: 'news_brief.seed_skipped_cli',
        note: 'CLI mode disables tool_use; news-brief cron needs SDK mode. Schedule not seeded.',
      });
    } else if (getSchedule(storage.db, NEWS_BRIEF_SCHEDULE_ID) === null) {
      const briefCron = '0 0 * * *'; // 매일 00:00 UTC = 09:00 KST
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

  // Phase 32 P1-1: CLI 모드는 tool_use 를 bypass — 등록된 도구가 비활성임을 부팅 시 경고로 가시화.
  // (CLI adapter 의 streamCompletion 은 text-only 라 skills-finance/general 도구가 호출되지 않음.)
  if (finclawConfig.provider === 'claude-cli') {
    const toolCount = toolRegistry.list().length;
    if (toolCount > 0) {
      logger.warn('provider.cli_tools_disabled', {
        event: 'provider.cli_tools_disabled',
        toolCount,
        note: 'CLI mode bypasses tool_use; registered tools are inactive. Use provider=anthropic-sdk for live data.',
      });
    }
  }

  return { marketHandle, newsHandle, alertHandle, brokerageSyncService, kisEnv };
}
