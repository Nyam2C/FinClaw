// packages/server/src/composition/runtime.ts
// Phase 36: main.ts 561-591 / 593-653 / 698-757 에서 추출 (순수 이동).

import {
  InMemoryToolRegistry,
  ProfileHealthMonitor,
  Runner,
  type ProviderAdapter,
  type RunnerFactory,
  type RunnerTracerAdapter,
} from '@finclaw/agent';
import { ConcurrencyLane, ConcurrencyLaneManager, type FinClawLogger } from '@finclaw/infra';
import type { MarketSkillHandle, NewsSkillHandle } from '@finclaw/skills-finance';
import {
  createRerankerWithFallback,
  LocalReranker,
  type createStorage,
  type EmbeddingProvider,
} from '@finclaw/storage';
import type { ChannelPlugin, ModelRef, Schedule } from '@finclaw/types';
import { DefaultAttachMemoryService } from '../auto-reply/agent-memory-hook.js';
import { registerBuiltInCommands } from '../auto-reply/commands/built-in.js';
import { InMemoryCommandRegistry } from '../auto-reply/commands/registry.js';
import { RunnerExecutionAdapter } from '../auto-reply/execution-adapter.js';
import { StubFinanceContextProvider } from '../auto-reply/pipeline-context.js';
import { AutoReplyPipeline } from '../auto-reply/pipeline.js';
import { SchedulerService } from '../automation/scheduler.js';
import { createTracer } from '../observability/tracer.js';
import { wireMemoryServices } from './memory-services.js';

type Storage = ReturnType<typeof createStorage>;
type Tracer = ReturnType<typeof createTracer>;

// ───────────────────────── buildExecution (561-591) ─────────────────────────

export interface BuildExecutionDeps {
  readonly storage: Storage;
  readonly providerAdapter: ProviderAdapter;
  readonly lanes: ConcurrencyLaneManager;
  readonly profileHealth: ProfileHealthMonitor;
  readonly logger: FinClawLogger;
  readonly defaultModel: ModelRef;
  readonly systemPrompt: string;
}

export interface ExecutionBundle {
  readonly tracer: Tracer;
  readonly runnerFactory: RunnerFactory;
  readonly adapter: RunnerExecutionAdapter;
}

export function buildExecution(deps: BuildExecutionDeps): ExecutionBundle {
  const { storage, providerAdapter, lanes, profileHealth, logger, defaultModel, systemPrompt } =
    deps;

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

  return { tracer, runnerFactory, adapter };
}

// ───────────────────────── buildPipeline (593-653) ─────────────────────────

export interface BuildPipelineDeps {
  readonly adapter: RunnerExecutionAdapter;
  readonly toolRegistry: InMemoryToolRegistry;
  readonly storage: Storage;
  readonly profileHealth: ProfileHealthMonitor;
  readonly marketHandle: MarketSkillHandle | undefined;
  readonly newsHandle: NewsSkillHandle | undefined;
  readonly embeddingProvider: EmbeddingProvider | undefined;
  readonly finclawConfig: import('@finclaw/types').FinClawConfig;
  readonly tracer: Tracer;
  readonly logger: FinClawLogger;
  readonly defaultModel: ModelRef;
  readonly channelPluginRegistry: Map<string, ChannelPlugin>;
}

export interface PipelineBundle {
  readonly pipeline: AutoReplyPipeline;
  readonly attachMemoryService: DefaultAttachMemoryService;
}

export function buildPipeline(deps: BuildPipelineDeps): PipelineBundle {
  const {
    adapter,
    toolRegistry,
    storage,
    profileHealth,
    marketHandle,
    newsHandle,
    embeddingProvider,
    finclawConfig,
    tracer,
    logger,
    defaultModel,
    channelPluginRegistry,
  } = deps;

  // 5. 파이프라인
  const financeCtxProvider = new StubFinanceContextProvider();
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

  // Phase 26 B/C/D: capture / retrieval / attach 3 service 를 동일 deps 로 wire-up.
  // - capture: 정규식 5종 명시적 선언 저장
  // - retrieval: hybrid (vector+FTS) RAG 주입, embeddingProvider 미주입 시 FTS-only fallback
  // - attach: agent.run output → memory 훅
  // Phase 30 D5: RAG re-ranker (config.rag.rerank.enabled 기본 true).
  // LocalReranker (Xenova ONNX) 가 모델 미존재 시 mock 으로 자동 fallback.
  const rerankCfg = finclawConfig.rag?.rerank;
  const rerankEnabled = rerankCfg?.enabled !== false;
  const reranker = rerankEnabled ? createRerankerWithFallback(new LocalReranker()) : undefined;

  const { memoryCaptureService, memoryRetrievalService, attachMemoryService } = wireMemoryServices(
    {
      db: storage.db,
      embeddingProvider,
      logger,
    },
    {
      reranker,
      rerankTopKFirst: rerankCfg?.topKFirst,
    },
  );

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
      tracer,
    },
  );

  return { pipeline, attachMemoryService };
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
  readonly runnerFactory: RunnerFactory;
  readonly defaultModel: ModelRef;
  readonly systemPrompt: string;
  readonly logger: FinClawLogger;
  readonly profileHealth: ProfileHealthMonitor;
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
  const {
    storage,
    runnerFactory,
    defaultModel,
    systemPrompt,
    logger,
    profileHealth,
    tracer,
    lifecycle,
  } = deps;

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
    runnerFactory,
    lane: scheduleLane,
    defaultModel,
    systemPrompt,
    logger,
    profileHealth,
    profileId: 'default',
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
