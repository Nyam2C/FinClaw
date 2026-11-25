// packages/server/src/composition/skills.ts
// Phase 36: main.ts 355 + 363-559 에서 추출 (순수 이동). 조건부 등록·lifecycle.register·로깅 보존.

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { InMemoryToolRegistry } from '@finclaw/agent';
import type { DiscordAdapter } from '@finclaw/channel-discord';
import type { FinClawLogger } from '@finclaw/infra';
import {
  createMarketSkill,
  createNewsSkill,
  KeyRotator,
  KisClient,
  KisTokenManager,
  readKeyArray,
  registerAlertTools,
  type AlertSkillHandle,
  type BrokerageProvider,
  type MarketSkillHandle,
  type NewsSkillHandle,
} from '@finclaw/skills-finance';
import { registerDatetimeTool, registerRouteTaskTool } from '@finclaw/skills-general';
import type { createStorage } from '@finclaw/storage';
import { loadPlugins } from '../plugins/loader.js';
import type { ProcessLifecycle } from '../process/lifecycle.js';
import { buildRouteDispatcher } from '../router/dispatch.js';
import { BrokerageSyncService } from '../services/brokerage-sync-service.js';

type Storage = ReturnType<typeof createStorage>;

export interface RegisterSkillsDeps {
  readonly toolRegistry: InMemoryToolRegistry;
  readonly storage: Storage;
  readonly logger: FinClawLogger;
  readonly discordAdapter: DiscordAdapter;
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
  const { toolRegistry, storage, logger, discordAdapter, lifecycle } = deps;

  registerDatetimeTool(toolRegistry);

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
    marketHandle = await createMarketSkill({
      db: storage.db,
      finnhubRotator,
      twelveDataRotator,
      alphaVantageRotator,
      coinGeckoKey,
    });
    logger.info('Market providers initialized', {
      providers: [
        finnhubRotator && 'finnhub',
        twelveDataRotator && 'twelve-data',
        alphaVantageRotator && 'alpha-vantage',
        coinGeckoKey && 'coingecko',
      ].filter(Boolean),
    });
  } else {
    logger.info('No market keys set — skipping market/news/route_task');
  }

  const newsdataKeys = readKeyArray('NEWSDATA_API_KEY');
  const newsdataRotator = newsdataKeys.length > 0 ? new KeyRotator(newsdataKeys) : undefined;

  if (marketHandle && (alphaVantageRotator || newsdataRotator || finnhubRotator)) {
    newsHandle = createNewsSkill({
      db: storage.db,
      alphaVantageKey: alphaVantageKeys[0],
      newsdataRotator,
      finnhubRotator, // 시세 KeyRotator 와 동일 인스턴스 공유
    });
    logger.info('News providers initialized', {
      providers: [
        alphaVantageRotator && 'alpha-vantage',
        newsdataRotator && 'newsdata',
        finnhubRotator && 'finnhub-news',
      ].filter(Boolean),
    });
  } else if (marketHandle) {
    logger.info('No news keys set — route_task news intents disabled');
  }

  // Phase 43 M3: 도메인 조회/분석은 route_task 하나로만 노출 (메인은 thin orchestrator).
  // 뉴스 키가 없으면 뉴스 의존 intent 는 dispatcher 가 에러 결과를 돌려준다.
  if (marketHandle) {
    const dispatcher = buildRouteDispatcher({
      quoteService: marketHandle.quoteService,
      chartService: marketHandle.chartService,
      newsAggregator: newsHandle?.aggregator,
      portfolioStore: newsHandle?.portfolioStore,
    });
    registerRouteTaskTool(toolRegistry, dispatcher);
    logger.info('route_task registered', {
      event: 'route_task.registered',
      news: newsHandle !== undefined,
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
      note: 'Toss brokerage client not implemented (awaiting Open API). Skipping brokerage sync.',
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
      logger.info('Brokerage (KIS) sync service ready', { env: kisEnv });
    } else {
      logger.info('KIS not configured — skipping brokerage sync');
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
  for (const d of pluginResult.diagnostics) {
    if (d.severity !== 'info') {
      logger.warn(`Plugin ${d.pluginName} (${d.phase}): ${d.message}`);
    }
  }
  lifecycle.register(async () => {
    for (const h of pluginResult.mcpHandles) {
      await h.shutdown();
    }
  });

  // Phase 40 D: 이전의 'provider.cli_tools_disabled' 경고 제거 — CLI 모드는 이제 in-process /mcp
  // 로 도구를 활성화하므로(read-only 필터) "tools are inactive" 가정이 거짓이 됨.

  return { marketHandle, newsHandle, alertHandle, brokerageSyncService, kisEnv };
}
