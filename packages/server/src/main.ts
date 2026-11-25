import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
// packages/server/src/main.ts
import { createCliDriver, ProfileHealthMonitor } from '@finclaw/agent';
import { DiscordAccountSchema, DiscordAdapter } from '@finclaw/channel-discord';
import { ConfigValidationError, loadConfig, validateConfigStrict } from '@finclaw/config';
import { createGatewayServer, type GatewayServerConfig } from '@finclaw/gateway';
import type { FinClawLogger } from '@finclaw/infra';
import {
  assertPortAvailable,
  assertSupportedRuntime,
  ConcurrencyLane,
  createLogger,
  formatPortOccupant,
  inspectPortOccupant,
  loadDotenv,
  PortInUseError,
  setupUnhandledRejectionHandler,
} from '@finclaw/infra';
import {
  assertEmbeddingDimension,
  createEmbeddingProvider,
  createStorage,
  purgeAccessLog,
  type EmbeddingProvider,
} from '@finclaw/storage';
import type { ChannelPlugin, ConfigValidationIssue } from '@finclaw/types';
import { deliverScheduleResult } from './automation/delivery.js';
import { initChannels } from './channels/index.js';
import { DEFAULT_MODEL, defaultConfig } from './composition/constants.js';
import { issueLocalToken, resolveJwtSecret } from './composition/local-auth.js';
import { buildProviders } from './composition/providers.js';
import { buildAutomation, buildExecution, buildPipeline } from './composition/runtime.js';
import { registerSkills } from './composition/skills.js';
import { ProcessLifecycle } from './process/lifecycle.js';
import { MessageRouter } from './process/message-router.js';
import { loadPrompt, requireFrontmatterKeys } from './prompts/loader.js';

/**
 * Phase 46 M11 (I8): DISCORD_BOT_TOKEN 이 없으면 Discord 만 비활성 — gateway·scheduler·Web/TUI 는 그대로.
 * 테스트 가능하도록 export (main() 은 VITEST 에서 실행되지 않음).
 */
export async function setupDiscord(
  token: string | undefined,
  deps: { readonly logger: FinClawLogger; readonly lifecycle: Pick<ProcessLifecycle, 'register'> },
): Promise<DiscordAdapter | undefined> {
  if (!token) {
    deps.logger.warn('discord.disabled', {
      event: 'discord.disabled',
      reason: 'DISCORD_BOT_TOKEN not set',
    });
    return undefined;
  }
  const adapter = new DiscordAdapter();
  const cleanup = await adapter.setup(DiscordAccountSchema.parse({ botToken: token }));
  deps.lifecycle.register(cleanup);
  deps.logger.info('Discord adapter logged in');
  return adapter;
}

async function main(): Promise<void> {
  // 0a. 부팅 안전장치 — .env 자동 로드 후 Node 런타임 가드(config 로드 전 조기 실패).
  loadDotenv();
  assertSupportedRuntime();

  // 0. 시스템 프롬프트 외부 .md 로드 — 본문은 system prompt, frontmatter 는 agent 메타.
  const systemPromptDoc = await loadPrompt('finclaw.system.ko.md', 'main:systemPrompt');
  requireFrontmatterKeys(
    systemPromptDoc,
    'finclaw.system.ko.md',
    ['id', 'name', 'description'],
    'main:agentMeta',
  );
  const DEFAULT_SYSTEM_PROMPT = systemPromptDoc.body;
  const AGENT_METADATA = [
    {
      id: systemPromptDoc.frontmatter.id,
      name: systemPromptDoc.frontmatter.name,
      description: systemPromptDoc.frontmatter.description,
    },
  ];

  // 1a. GATEWAY_PORT 검증
  const gatewayPortRaw = process.env.GATEWAY_PORT;
  const gatewayPort = gatewayPortRaw ? Number(gatewayPortRaw) : defaultConfig.port;
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) {
    throw new ConfigValidationError(`Invalid GATEWAY_PORT: ${gatewayPortRaw}`, {
      issues: [{ path: 'GATEWAY_PORT', message: 'must be an integer 1-65535', severity: 'error' }],
    });
  }

  // 2. 기반 (로거, 라이프사이클, 스토리지)
  const logger = createLogger({ name: 'finclaw', level: 'info' });
  setupUnhandledRejectionHandler(logger);
  const lifecycle = new ProcessLifecycle({ logger });

  // 2a. 전체 config 로드 + strict 재검증
  const finclawConfig = loadConfig({ logger });
  validateConfigStrict(finclawConfig);

  // Phase 46 M10 (B6/B10): JWT secret (env → ~/.finclaw/gateway.secret). 로컬 토큰 파일은 포트 검사 뒤(8). 값은 로그 금지.
  const jwtSecret = resolveJwtSecret();

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

  // 2b. 채널 도크 자동 등록 (discord)
  initChannels(logger);

  // 3. Discord (선택) — alerts DM 핸들 때문에 skills 등록 전에 로그인
  const discordAdapter = await setupDiscord(process.env.DISCORD_BOT_TOKEN, { logger, lifecycle });

  // 4. Agent 레이어 (툴 레지스트리)
  const { toolRegistry } = buildProviders({ logger });

  // 4a. 프로필 건강 모니터.
  const profileHealth = new ProfileHealthMonitor();

  // Phase 46 M3: stream-json 드라이버 (격리 cwd 고정, Q12). 버전 로그는 스키마 drift(R1) 추적용 — 실패해도 부팅 계속.
  const cliCommand = finclawConfig.cliBackend?.command ?? 'claude';
  const driver = createCliDriver({
    command: cliCommand,
    cwd: join(homedir(), '.finclaw', 'agent'),
    logger,
  });
  execFile(cliCommand, ['--version'], { timeout: 10_000 }, (err, stdout) => {
    if (err) {
      logger.warn('cli.version_unavailable', {
        event: 'cli.version_unavailable',
        error: err.message,
      });
      return;
    }
    logger.info('cli.version', { event: 'cli.version', version: stdout.trim() });
  });

  // Phase 36: skills/tools/KIS/mcp/plugins 등록 (구 363-559 흡수)
  const { marketHandle, newsHandle, alertHandle, brokerageSyncService, kisEnv } =
    await registerSkills({
      toolRegistry,
      storage,
      logger,
      discordClient: discordAdapter?.getClient() ?? undefined,
      lifecycle,
      driver,
    });

  // Phase 36: 실행 레이어 (tracer + runtime) — 구 561-591
  const { tracer, runtime, attachMemoryService } = buildExecution({
    storage,
    profileHealth,
    logger,
    defaultModel: DEFAULT_MODEL,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    driver,
    embeddingProvider,
    finclawConfig,
    mcp: {
      url: `http://127.0.0.1:${gatewayPort}/mcp`,
      jwtSecret,
    },
  });
  lifecycle.register(async () => runtime.abortAll());

  // 5. 파이프라인 — 구 593-653. channelPluginRegistry 는 main 이 소유 (router/discord set).
  const channelPluginRegistry = new Map<string, ChannelPlugin>();
  const { pipeline } = buildPipeline({
    runtime,
    toolRegistry,
    storage,
    profileHealth,
    marketHandle,
    newsHandle,
    tracer,
    logger,
    defaultModel: DEFAULT_MODEL,
    channelPluginRegistry,
  });

  // 6. MessageRouter
  const router = new MessageRouter({
    logger,
    onProcess: (ctx) => pipeline.process(ctx),
  });

  // 7. Discord onMessage 등록 — 토큰이 있을 때만
  if (discordAdapter) {
    channelPluginRegistry.set(discordAdapter.id as string, discordAdapter);
    discordAdapter.onMessage(async (msg) => {
      await router.route(msg);
    });
    logger.info('Discord adapter connected');
  }

  // 8. Gateway — FINCLAW_API_KEY 환경변수로 API 키 기반 인증 활성화
  const gatewayConfig: GatewayServerConfig = {
    ...defaultConfig,
    host: process.env.GATEWAY_HOST || defaultConfig.host,
    port: gatewayPort,
    auth: {
      ...defaultConfig.auth,
      jwtSecret,
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
  // 포트 검사 뒤 — 이미 떠 있는 서버가 있으면 그 서버의 토큰 파일을 덮어쓰지 않고 종료한다
  issueLocalToken(jwtSecret);
  const alertHandleForRpc = alertHandle;
  const agentRunLane = new ConcurrencyLane({
    maxConcurrent: 1,
    maxQueueSize: 10,
    waitTimeoutMs: 120_000,
  });

  // Phase 36: scheduler/automation — 구 698-757. scheduleLane 은 빌더 내부 생성 (구 698 위치 보존).
  // gateway 생성 직전에 호출 → lifecycle ⑤(scheduler.stop) 가 ⑦(gateway.stop) 보다 먼저 등록.
  const { scheduler, setDeliveryHook } = buildAutomation({
    storage,
    runtime,
    logger,
    tracer,
    lifecycle,
  });

  const gateway = createGatewayServer(gatewayConfig, {
    defaultModel: DEFAULT_MODEL,
    runtime,
    toolRegistry, // Phase 40 A: /mcp in-process 호출용 (top-level — agentDeps.toolRegistry 와 동일 인스턴스)
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
      agents: AGENT_METADATA,
      runtime,
      agentRunLane,
      profileHealth,
      logger,
      profileId: 'default',
      // Phase 26 D: agent.run 종료 후 output → memory 저장 훅 (rpc-engineer 가 호출 위치 결정).
      attachMemoryService,
      // Phase 30 hotfix P0-1: agent.run RPC 진입을 span 으로 감싸 traceId 강제.
      tracer,
    },
    // Phase 28: schedule.* RPC 배선.
    scheduleDeps: { db: storage.db, scheduler },
    // Phase 33 D: brokerage.* RPC 배선 (수동 sync 버튼용). syncService 미주입 시 sync.run = not_configured.
    brokerageDeps: { db: storage.db, syncService: brokerageSyncService, env: kisEnv },
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
    // Phase 30 C3: access-log SQLite dual-write + traceId 부착.
    accessLogDb: storage.db,
    getTraceId: () => tracer.getCurrentContext()?.traceId,
  });

  // Phase 30 C4: access-log retention purge — 24h 주기 (scheduler internal cron 미지원이므로 setInterval).
  // 기본 30 일, finclawConfig.accessLog.retentionDays 로 override.
  const retentionDays = finclawConfig.accessLog?.retentionDays ?? 30;
  const purgeIntervalMs = 24 * 60 * 60 * 1000;
  const accessLogPurgeTimer = setInterval(() => {
    try {
      const removed = purgeAccessLog(storage.db, retentionDays);
      logger.info('access_log.purged', {
        event: 'access_log.purged',
        removed,
        retentionDays,
      });
    } catch (err) {
      logger.warn('access_log.purge_failed', {
        event: 'access_log.purge_failed',
        error: (err as Error).message,
      });
    }
  }, purgeIntervalMs);
  // Node 가 timer 때문에 종료 안되는 것 방지 — daemon 모드에서만 활성.
  accessLogPurgeTimer.unref();
  lifecycle.register(async () => {
    clearInterval(accessLogPurgeTimer);
  });
  logger.info('finance.* / memory.* / agent.* RPC methods wired');
  lifecycle.register(() => gateway.stop());

  // Phase 28: gateway 생성 후 delivery hook 활성화. broadcaster/connections 는 gateway.ctx 에서 가져온다.
  // Phase 36: deliveryHook let 은 buildAutomation 내부로 이동 — setter 로 같은 시점(구 864) 대입.
  setDeliveryHook((args) =>
    deliverScheduleResult(
      {
        discordClient: discordAdapter?.getClient() ?? undefined,
        broadcaster: gateway.ctx.broadcaster,
        connections: gateway.ctx.connections,
        logger,
      },
      args,
    ),
  );
  // phase47 M1: 가격 알림 → WS broadcast. setDeliveryHook 과 같은 late-bind (alerts 가 gateway 보다 먼저 생성됨).
  alertHandle?.setBroadcast((data) =>
    gateway.ctx.broadcaster.broadcastToChannel(gateway.ctx.connections, 'alert.triggered', data),
  );

  lifecycle.init();
  await gateway.start();
  scheduler.start();
  logger.info(`Gateway listening on ${gatewayConfig.host}:${gatewayConfig.port}`);
}

if (!process.env.VITEST) {
  main().catch((err) => {
    if (err instanceof ConfigValidationError) {
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
