// packages/server/src/composition/runtime.ts
// Phase 36: main.ts 561-591 / 593-653 / 698-757 에서 추출 (순수 이동).

import {
  InMemoryToolRegistry,
  ProfileHealthMonitor,
  Runner,
  type AgentDriver,
  type AgentRunPort,
  type ProviderAdapter,
  type RunnerFactory,
  type RunnerTracerAdapter,
} from '@finclaw/agent';
import { signToken } from '@finclaw/gateway';
import { ConcurrencyLane, ConcurrencyLaneManager, type FinClawLogger } from '@finclaw/infra';
import type { MarketSkillHandle, NewsSkillHandle } from '@finclaw/skills-finance';
import {
  createRerankerWithFallback,
  LocalReranker,
  type createStorage,
  type EmbeddingProvider,
} from '@finclaw/storage';
import type { ChannelPlugin, FinClawConfig, ModelRef, Schedule } from '@finclaw/types';
import { AgentRuntime } from '../agent-runtime/runtime.js';
import type { DefaultAttachMemoryService } from '../auto-reply/agent-memory-hook.js';
import { registerBuiltInCommands } from '../auto-reply/commands/built-in.js';
import { InMemoryCommandRegistry } from '../auto-reply/commands/registry.js';
import { RunnerExecutionAdapter } from '../auto-reply/execution-adapter.js';
import { AutoReplyPipeline } from '../auto-reply/pipeline.js';
import { SchedulerService } from '../automation/scheduler.js';
import { createTracer } from '../observability/tracer.js';
import { wireMemoryServices } from './memory-services.js';

type Storage = ReturnType<typeof createStorage>;
type Tracer = ReturnType<typeof createTracer>;

/** [TQ3] N7: Discord pipeline 타임아웃 > 메인 overall 300s — runtime 의 timeout 분류(고정 문구)가 먼저 나도록. */
const PIPELINE_TIMEOUT_MS = 330_000;

// ───────────────────────── buildExecution (561-591) ─────────────────────────

export interface BuildExecutionDeps {
  readonly storage: Storage;
  readonly providerAdapter: ProviderAdapter;
  readonly lanes: ConcurrencyLaneManager;
  readonly profileHealth: ProfileHealthMonitor;
  readonly logger: FinClawLogger;
  readonly defaultModel: ModelRef;
  readonly systemPrompt: string;
  /** Phase 46 M3 */
  readonly driver: AgentDriver;
  readonly embeddingProvider: EmbeddingProvider | undefined;
  readonly finclawConfig: FinClawConfig;
  /** per-run JWT mint 용 (/mcp 와 같은 secret). */
  readonly mcp: { readonly url: string; readonly jwtSecret: string };
}

export interface ExecutionBundle {
  readonly tracer: Tracer;
  readonly runnerFactory: RunnerFactory; // M5 삭제
  readonly adapter: RunnerExecutionAdapter; // M5 삭제
  readonly runtime: AgentRuntime;
  readonly attachMemoryService: DefaultAttachMemoryService;
}

export function buildExecution(deps: BuildExecutionDeps): ExecutionBundle {
  const {
    storage,
    providerAdapter,
    lanes,
    profileHealth,
    logger,
    defaultModel,
    systemPrompt,
    driver,
    embeddingProvider,
    finclawConfig,
    mcp,
  } = deps;

  // Phase 30 A6: OTel tracer — span 을 SQLite spans 테이블에 SQL exporter 로 기록.
  // Phase 30 hotfix P0-2: Runner 에 tracer adapter 주입 — agent.turn / provider.stream span 활성화.
  const tracer = createTracer({ db: storage.db });
  const tracerAdapter: RunnerTracerAdapter = {
    withSpan: (name, attrs, fn) => tracer.withSpan(name, attrs, async () => fn()),
  };

  const runnerFactory: RunnerFactory = () =>
    new Runner({
      provider: providerAdapter,
      laneManager: lanes,
      tracer: tracerAdapter,
    });

  // 4b. 실행 어댑터 (storage 주입 — 대화 이력 load/save)
  const adapter = new RunnerExecutionAdapter({
    runnerFactory,
    defaultModel,
    systemPrompt,
    storage,
    logger,
    profileHealth,
    profileId: 'default',
  });

  // Phase 26 B/C/D + Phase 30 D5 (buildPipeline 에서 이동): capture / retrieval / attach 3 service.
  const rerankCfg = finclawConfig.rag?.rerank;
  const rerankEnabled = rerankCfg?.enabled !== false;
  const reranker = rerankEnabled ? createRerankerWithFallback(new LocalReranker()) : undefined;
  const { memoryCaptureService, memoryRetrievalService, attachMemoryService } = wireMemoryServices(
    { db: storage.db, embeddingProvider, logger },
    { reranker, rerankTopKFirst: rerankCfg?.topKFirst },
  );

  // Phase 46 M3: 채널 무관 런타임 — Discord(pipeline) 부터 사용. M4 에서 chat·cron·agent.run 도 합류.
  const runtime = new AgentRuntime({
    driver,
    storage,
    db: storage.db,
    systemPrompt,
    defaultModel: defaultModel.model,
    mcp: {
      url: mcp.url,
      // N3: 도구 ctx.sessionId = sessionKey (bridge identity)
      mintToken: (sessionKey) =>
        signToken({ sub: 'finclaw', sessionId: sessionKey }, mcp.jwtSecret),
    },
    capture: memoryCaptureService,
    retrieval: memoryRetrievalService,
    profileHealth,
    tracer,
    logger,
  });

  return { tracer, runnerFactory, adapter, runtime, attachMemoryService };
}

// ───────────────────────── buildPipeline (593-653) ─────────────────────────

export interface BuildPipelineDeps {
  readonly runtime: AgentRunPort;
  readonly toolRegistry: InMemoryToolRegistry;
  readonly storage: Storage;
  readonly profileHealth: ProfileHealthMonitor;
  readonly marketHandle: MarketSkillHandle | undefined;
  readonly newsHandle: NewsSkillHandle | undefined;
  readonly tracer: Tracer;
  readonly logger: FinClawLogger;
  readonly defaultModel: ModelRef;
  readonly channelPluginRegistry: Map<string, ChannelPlugin>;
}

export interface PipelineBundle {
  readonly pipeline: AutoReplyPipeline;
}

export function buildPipeline(deps: BuildPipelineDeps): PipelineBundle {
  const {
    runtime,
    toolRegistry,
    storage,
    profileHealth,
    marketHandle,
    newsHandle,
    tracer,
    logger,
    defaultModel,
    channelPluginRegistry,
  } = deps;

  // 5. 파이프라인
  const commandRegistry = new InMemoryCommandRegistry();
  registerBuiltInCommands(commandRegistry, {
    toolRegistry,
    storage,
    profileHealth,
    profileId: 'default',
    defaultModel,
    marketHandle,
    newsHandle,
  });

  const pipeline = new AutoReplyPipeline(
    {
      commandPrefix: '!finclaw ',
      timeoutMs: PIPELINE_TIMEOUT_MS,
    },
    {
      runtime,
      commandRegistry,
      logger,
      getChannel: (id) => channelPluginRegistry.get(id),
      tracer,
    },
  );

  return { pipeline };
}

// ───────────────────────── buildAutomation (698-757) ─────────────────────────

export type DeliveryHook = (args: {
  schedule: Schedule;
  agentRunId: string | null;
  output: string;
  error?: string;
}) => Promise<void>;

export interface BuildAutomationDeps {
  readonly storage: Storage;
  readonly runtime: AgentRunPort;
  readonly logger: FinClawLogger;
  readonly tracer: Tracer;
  readonly lifecycle: { register(fn: () => void | Promise<void>): void };
}

export interface AutomationBundle {
  readonly scheduler: SchedulerService;
  readonly scheduleLane: ConcurrencyLane;
  /** main 이 gateway 생성 후 호출 — 원본 864 의 deliveryHook 대입과 동일 시점. */
  readonly setDeliveryHook: (fn: DeliveryHook) => void;
}

export function buildAutomation(deps: BuildAutomationDeps): AutomationBundle {
  const { storage, runtime, logger, tracer, lifecycle } = deps;

  // Phase 28: schedule 동시 실행 1개로 제한하는 lane.
  // agent.run 큐잉 lane 과 별개로 schedule 전용 (대기열 5분 보유).
  const scheduleLane = new ConcurrencyLane({
    maxConcurrent: 1,
    maxQueueSize: 50,
    waitTimeoutMs: 5 * 60_000,
  });

  // Phase 28: SchedulerService — 매 분 폴러로 schedules 검사 + agent.run 직접 실행.
  // delivery hook 은 gateway 생성 후 lateinit (broadcaster/connections 가 그때 가용).
  let deliveryHook: DeliveryHook | null = null;
  const setDeliveryHook = (fn: DeliveryHook): void => {
    deliveryHook = fn;
  };
  const maxFailRaw = process.env.AUTOMATION_MAX_CONSECUTIVE_FAILURES;
  const maxConsecutiveFailures = maxFailRaw ? Number(maxFailRaw) : 3;
  const scheduler = new SchedulerService({
    db: storage.db,
    runtime,
    lane: scheduleLane,
    logger,
    maxConsecutiveFailures,
    // Phase 30 hotfix P0-1: schedule 실행을 새 trace 로 감싸 agent_runs.trace_id 부착.
    tracer,
    onRunComplete: async (args) => {
      if (deliveryHook) {
        await deliveryHook(args);
      }
    },
  });
  lifecycle.register(() => scheduler.stop());

  return { scheduler, scheduleLane, setDeliveryHook };
}
