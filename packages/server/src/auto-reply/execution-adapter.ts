import { randomUUID } from 'node:crypto';
// packages/server/src/auto-reply/execution-adapter.ts
import type {
  AliasIndex,
  ExecutionToolDispatcher,
  ModelCatalog,
  ModelPricing,
  ProfileHealthMonitor,
  Runner,
  StreamEventListener,
  ToolRegistry,
} from '@finclaw/agent';
import {
  calculateEstimatedCost,
  compactContext,
  DEFAULT_FALLBACK_TRIGGERS,
  evaluateContextWindow,
  ExecutionToolDispatcher as ToolDispatcherCtor,
  resolveModel,
  runWithModelFallback,
  tierToModelId,
  type LlmRouter,
  type ModelRole,
  type RouterDecision,
  type TranscriptEntry,
} from '@finclaw/agent';
import type { FinClawLogger } from '@finclaw/infra';
import type {
  AgentId,
  AgentRunParams,
  ContentBlock,
  ConversationMessage,
  ModelRef,
  ModelTier,
  SessionKey,
  StorageAdapter,
  Timestamp,
} from '@finclaw/types';
import { createAgentId } from '@finclaw/types';
import type { PipelineMsgContext } from './pipeline-context.js';
import { formatBackgroundSection } from './stages/memory-retrieval.js';
import { buildDispatcher } from './tool-dispatcher-adapter.js';

/**
 * 메시지 본문에서 role 추론 — 단순 키워드 휴리스틱 (Phase 24).
 *
 * 우선순위: analysis > fetch > chat
 * - analysis: 명시적 분석/판단 요청 → Opus + 모든 도구 (analyze_market 포함)
 * - fetch: 단순 시세/가격/환율/차트 조회 → Haiku + haiku-min 도구 11개
 * - chat: 그 외 일반 대화 → Sonnet + sonnet-min 이하 도구 13개
 *
 * 사용자 직접 입력이라 모호하므로 키워드 명시 시에만 fetch/analysis 로 승격.
 */
const ANALYSIS_KEYWORDS = ['분석', '리포트', '판단', 'analyze', 'report'];
const FETCH_KEYWORDS = [
  '얼마',
  '가격',
  '시세',
  '주가',
  '환율',
  '차트',
  'price',
  'quote',
  'rate',
  'chart',
];

function inferRole(message: string): ModelRole {
  const lower = message.toLowerCase();
  if (ANALYSIS_KEYWORDS.some((kw) => lower.includes(kw))) {
    return 'analysis';
  }
  if (FETCH_KEYWORDS.some((kw) => lower.includes(kw))) {
    return 'fetch';
  }
  return 'chat';
}

/**
 * Phase 9 AI 실행 엔진과의 브릿지 인터페이스
 *
 * Phase 8은 "무엇을 실행할지" 결정하고, Phase 9는 "어떻게 실행할지" 담당한다.
 */
export interface ExecutionAdapter {
  execute(ctx: PipelineMsgContext, signal: AbortSignal): Promise<ExecutionResult>;
}

/** Phase 22: 도구 호출 감사용 메타데이터 — DeliverStage 출처 footer·DB 병렬 저장에서 소비 */
export interface ToolCallRecord {
  readonly name: string;
  readonly input: unknown;
  readonly output: string;
  readonly source?: string;
  readonly timestamp: number;
  readonly durationMs?: number;
  readonly isError?: boolean;
}

export interface ExecutionResult {
  readonly content: string;
  readonly usage?: { inputTokens: number; outputTokens: number };
  readonly toolCalls?: readonly ToolCallRecord[];
  /** Phase 29 B: 응답 텍스트에서 추출한 [mem:xxxxxx] 인용을 retrievalResult.snippets 와 매칭한 결과 */
  readonly usedMemoryIds?: readonly string[];
}

/**
 * Phase 29 B: 응답 텍스트의 `[mem:xxxxxx]` 마커 (id 첫 6-8자, 또는 콤마 구분 다중)
 * 를 추출하여 candidates 의 실제 id 와 prefix-match.
 *
 * - 마커가 없으면 빈 배열.
 * - 같은 id 가 여러 마커에 매칭돼도 한 번만 결과에 포함.
 * - candidates 순서를 유지.
 */
export function extractCitedMemoryIds(
  text: string,
  candidates: ReadonlyArray<{ readonly id: string }>,
): string[] {
  const prefixes = new Set<string>();
  const re = /\[mem:([a-f0-9]{6,8}(?:,[a-f0-9]{6,8})*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    for (const p of m[1].split(',')) {
      prefixes.add(p);
    }
  }
  const matched: string[] = [];
  for (const c of candidates) {
    for (const p of prefixes) {
      if (c.id.startsWith(p)) {
        matched.push(c.id);
        break;
      }
    }
  }
  return matched;
}

/**
 * Phase 8 테스트용 Mock 어댑터
 * RunnerExecutionAdapter는 실제 Runner를 사용하지만, Mock은 단위 테스트에서 유지.
 */
export class MockExecutionAdapter implements ExecutionAdapter {
  constructor(private readonly defaultResponse: string = 'Mock response') {}

  async execute(_ctx: PipelineMsgContext, _signal: AbortSignal): Promise<ExecutionResult> {
    return {
      content: this.defaultResponse,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

/**
 * Runner 생성 팩토리 — per-request dispatcher를 받아 Runner를 반환.
 *
 * Runner는 생성 시점에 `toolExecutor`를 고정하므로 요청마다 새 Runner가 필요하다.
 * provider와 laneManager는 공유 자원이므로 팩토리 클로저에서 재사용한다.
 */
export type RunnerFactory = (dispatcher: ExecutionToolDispatcher) => Runner;

export interface RunnerExecutionAdapterDeps {
  readonly runnerFactory: RunnerFactory;
  readonly defaultModel: ModelRef;
  readonly systemPrompt: string;
  readonly defaultAgentId?: AgentId;
  readonly storage?: StorageAdapter;
  readonly toolRegistry?: ToolRegistry;
  readonly logger?: FinClawLogger;
  /** 이력 로드 시 최근 메시지 수 (기본 20) */
  readonly historyLimit?: number;
  /** 모델 카탈로그 — 제공 시 fallbackChain과 함께 runWithModelFallback 활성화 */
  readonly modelCatalog?: ModelCatalog;
  /** 별칭 색인 — modelCatalog과 함께 전달 */
  readonly modelAliasIndex?: AliasIndex;
  /** 폴백 모델 ID 체인 (우선순위 순) */
  readonly fallbackChain?: readonly string[];
  /** 프로필 건강 모니터 — API 호출 결과 기록 */
  readonly profileHealth?: ProfileHealthMonitor;
  /** 건강 기록용 프로필 ID (기본 'default') */
  readonly profileId?: string;
  /**
   * Phase 34: LLM 오케스트레이터 라우터 (SDK Haiku 고정). 주입 시 매 요청마다
   * intent 분류 → {modelTier, allowedToolNames}. 실패 시 inferRole 키워드 폴백 (B-2).
   * 키워드 RouterHelper(Phase 24) 정상 경로는 폐기 — main.ts 는 routerLlm 만 주입.
   */
  readonly routerLlm?: LlmRouter;
}

/**
 * Runner 기반 실행 어댑터
 *
 * - Milestone A: storage/toolRegistry 없이 단발 호출
 * - Milestone B: storage로 대화 이력 load/save + toolRegistry로 per-request dispatcher 구성
 */
export class RunnerExecutionAdapter implements ExecutionAdapter {
  private readonly defaultAgentId: AgentId;
  private readonly historyLimit: number;

  constructor(private readonly deps: RunnerExecutionAdapterDeps) {
    this.defaultAgentId = deps.defaultAgentId ?? createAgentId('default');
    this.historyLimit = deps.historyLimit ?? 20;
  }

  async execute(ctx: PipelineMsgContext, signal: AbortSignal): Promise<ExecutionResult> {
    const priorMessages = await this.loadHistory(ctx.sessionKey);
    const userMessage: ConversationMessage = { role: 'user', content: ctx.normalizedBody };

    const { dispatcher, toolDefinitions } = this.buildRequestDispatcher({
      sessionId: ctx.sessionKey as string,
      userId: ctx.senderId,
      channelId: ctx.channelId as unknown as string,
    });
    const runner = this.deps.runnerFactory(dispatcher);
    const profileId = this.deps.profileId ?? 'default';
    const startedAt = Date.now();

    // Phase 34: LLM 라우터 1회 호출 → intent 기반 모델/도구 결정. 실패 시 키워드 폴백.
    const routed = await this.applyRouting({
      message: ctx.normalizedBody,
      toolDefinitions,
      automation: false,
    });

    // Phase 24 보정: 라우터가 결정한 allowedToolNames 만 LLM 에 노출.
    // minModel 미충족 도구는 자동 제외되어 chat → Opus 부작용 방지.
    const exposedTools = routed
      ? toolDefinitions.filter((t) => routed.allowedToolNames.includes(t.name))
      : toolDefinitions;

    // Phase 26 C: retrievalResult 가 있으면 "사용자 배경지식" 섹션을 system prompt 끝에 합성.
    // 빈 섹션 (snippets·transactions 모두 0) 이면 base 그대로 — 빈 헤더 노출 방지.
    const baseSystemPrompt = this.deps.systemPrompt;
    const backgroundSection = ctx.retrievalResult
      ? formatBackgroundSection(ctx.retrievalResult)
      : '';
    const composedSystemPrompt = backgroundSection
      ? `${baseSystemPrompt}\n\n${backgroundSection}`
      : baseSystemPrompt;

    // Phase 31 C: 컨텍스트 윈도우 critical/exceeded 시 compaction. 미주입 시 원본 그대로.
    const requestMessages = await maybeCompactMessages(
      [...priorMessages, userMessage],
      this.deps.defaultModel,
      ctx,
      this.deps.logger,
    );

    const buildParams = (model: ModelRef): AgentRunParams => ({
      agentId: this.defaultAgentId,
      sessionKey: ctx.sessionKey,
      model,
      systemPrompt: composedSystemPrompt,
      messages: requestMessages,
      tools: exposedTools.length > 0 ? [...exposedTools] : undefined,
      abortSignal: signal,
    });

    try {
      const { modelCatalog, modelAliasIndex, fallbackChain } = this.deps;
      // 라우터 활성: routed.chain (라우터 결정 모델 선두) + routed.floor 로 floor 미만 차단.
      // 라우터 미주입: 기존 fallbackChain 동작 (floor 없음 → AggregateError).
      const effectiveChain = routed?.chain ?? fallbackChain;
      const effectiveFloor = routed?.floor;
      let result;
      // Phase 24 E: byModel 집계용 — fallback path 에서만 정확한 modelId/pricing 확보.
      let usedModelId: string | undefined;
      let usedPricing: ModelPricing | undefined;
      let usedIsFallback = false;
      if (modelCatalog && modelAliasIndex && effectiveChain && effectiveChain.length > 0) {
        const fallback = await runWithModelFallback(
          {
            models: effectiveChain.map((raw) => ({ raw })),
            maxRetriesPerModel: 1,
            retryBaseDelayMs: 500,
            fallbackOn: DEFAULT_FALLBACK_TRIGGERS,
            abortSignal: signal,
            floor: effectiveFloor,
          },
          async (resolved) => {
            const model: ModelRef = {
              ...this.deps.defaultModel,
              provider: resolved.provider,
              model: resolved.modelId,
              contextWindow: resolved.entry.contextWindow,
              maxOutputTokens: Math.min(
                resolved.entry.maxOutputTokens,
                this.deps.defaultModel.maxOutputTokens,
              ),
            };
            return runner.execute(buildParams(model));
          },
          (ref) => resolveModel(ref, modelCatalog, modelAliasIndex),
        );
        result = fallback.result;
        usedModelId = fallback.modelUsed.modelId;
        usedPricing = fallback.modelUsed.entry.pricing;
        usedIsFallback = fallback.modelUsed.modelId !== effectiveChain[0];
      } else {
        result = await runner.execute(buildParams(this.deps.defaultModel));
      }

      const toolCalls = collectToolCalls(result.messages, startedAt);
      await this.persistHistory(ctx.sessionKey, this.defaultAgentId, result.messages);

      if (usedModelId && usedPricing) {
        this.deps.profileHealth?.recordResult(profileId, {
          success: true,
          modelId: usedModelId,
          tokens: { input: result.usage.inputTokens, output: result.usage.outputTokens },
          costUsd: calculateEstimatedCost(
            result.usage.inputTokens,
            result.usage.outputTokens,
            usedPricing,
          ),
          isFallback: usedIsFallback,
        });
      } else {
        this.deps.profileHealth?.recordResult(profileId, true);
      }

      const content = extractAssistantText(result.messages);
      // Phase 29 B6: 응답 텍스트에서 [mem:xxxxxx] 인용 추출 → retrievalResult 의 snippets 와 prefix 매칭.
      const usedMemoryIds = ctx.retrievalResult?.snippets
        ? extractCitedMemoryIds(content, ctx.retrievalResult.snippets)
        : [];
      return {
        content,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        },
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usedMemoryIds: usedMemoryIds.length > 0 ? usedMemoryIds : undefined,
      };
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        this.deps.profileHealth?.recordResult(profileId, false);
      }
      throw err;
    }
  }

  /**
   * TUI 경로 전용 실행 — WebSocket 스트리밍 listener를 받는다.
   *
   * execute()와의 차이:
   * - PipelineMsgContext 대신 sessionKey/agentId/model을 직접 받음 (채널 개념 없음)
   * - StreamEventListener를 runner에 전달해 text_delta/tool_use_* 이벤트를 WS로 팬아웃
   * - 세션에서 선택한 model을 사용 (deps.defaultModel이 아닌 인자 model)
   */
  async executeForTui(
    input: {
      readonly sessionKey: SessionKey;
      readonly agentId: AgentId;
      readonly userMessage: string;
      readonly model: ModelRef;
      /** Phase 24: 사용자 modelHint (chat.send.modelHint 또는 chat.start.model 유래) */
      readonly userHint?: ModelTier;
    },
    listener: StreamEventListener | undefined,
    signal: AbortSignal,
  ): Promise<TuiExecutionResult> {
    const priorMessages = await this.loadHistory(input.sessionKey);
    const userMessage: ConversationMessage = { role: 'user', content: input.userMessage };

    const { dispatcher, toolDefinitions } = this.buildRequestDispatcher({
      sessionId: input.sessionKey as string,
      userId: 'tui',
      channelId: 'tui',
    });
    const runner = this.deps.runnerFactory(dispatcher);

    // Phase 34: TUI 도 LLM 라우터 사용 (B-3). userHint 키워드 승격 폐기.
    const routed = await this.applyTuiRouting({ input, toolDefinitions });

    // Phase 24 보정: 라우터 결정 allowedToolNames 만 LLM 노출.
    const exposedTools = routed
      ? toolDefinitions.filter((t) => routed.allowedToolNames.includes(t.name))
      : toolDefinitions;

    const buildParams = (model: ModelRef): AgentRunParams => ({
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      model,
      systemPrompt: this.deps.systemPrompt,
      messages: [...priorMessages, userMessage],
      tools: exposedTools.length > 0 ? [...exposedTools] : undefined,
      abortSignal: signal,
    });

    const { modelCatalog, modelAliasIndex } = this.deps;
    let result;
    // Phase 24 E: byModel 집계용 — fallback path 에서만 정확한 modelId/pricing.
    let usedModelId: string | undefined;
    let usedPricing: ModelPricing | undefined;
    let usedIsFallback = false;
    if (routed && modelCatalog && modelAliasIndex) {
      const fallback = await runWithModelFallback(
        {
          models: routed.chain.map((raw) => ({ raw })),
          maxRetriesPerModel: 1,
          retryBaseDelayMs: 500,
          fallbackOn: DEFAULT_FALLBACK_TRIGGERS,
          abortSignal: signal,
          floor: routed.floor,
        },
        async (resolved) => {
          const model: ModelRef = {
            ...input.model,
            provider: resolved.provider,
            model: resolved.modelId,
            contextWindow: resolved.entry.contextWindow,
            maxOutputTokens: Math.min(resolved.entry.maxOutputTokens, input.model.maxOutputTokens),
          };
          return runner.execute(buildParams(model), listener);
        },
        (ref) => resolveModel(ref, modelCatalog, modelAliasIndex),
      );
      result = fallback.result;
      usedModelId = fallback.modelUsed.modelId;
      usedPricing = fallback.modelUsed.entry.pricing;
      usedIsFallback = fallback.modelUsed.modelId !== routed.chain[0];
    } else {
      result = await runner.execute(buildParams(input.model), listener);
    }

    await this.persistHistory(input.sessionKey, input.agentId, result.messages);

    // Phase 24 E: TUI/chat.send 도 모델 분포에 기록 (execute() 와 동일 정책).
    const profileId = this.deps.profileId ?? 'default';
    if (usedModelId && usedPricing) {
      this.deps.profileHealth?.recordResult(profileId, {
        success: true,
        modelId: usedModelId,
        tokens: { input: result.usage.inputTokens, output: result.usage.outputTokens },
        costUsd: calculateEstimatedCost(
          result.usage.inputTokens,
          result.usage.outputTokens,
          usedPricing,
        ),
        isFallback: usedIsFallback,
      });
    } else {
      this.deps.profileHealth?.recordResult(profileId, true);
    }

    return {
      messageId: randomUUID(),
      content: extractAssistantText(result.messages),
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      },
    };
  }

  /**
   * Phase 34: LLM 라우터 호출 → chain + floor + allowedToolNames 구성.
   * - routerLlm 주입: Haiku 라우터 1회 호출. 실패/타임아웃 시 inferRole 키워드 폴백 (B-2).
   * - routerLlm 미주입: undefined (라우터 비활성, 기존 fallbackChain 동작).
   */
  private async applyRouting(args: {
    readonly message: string;
    readonly toolDefinitions: readonly { readonly name: string }[];
    readonly automation: boolean;
  }): Promise<
    | {
        readonly chain: readonly string[];
        readonly floor: ModelTier;
        readonly allowedToolNames: ReadonlyArray<string>;
        readonly routerUsage: { readonly inputTokens: number; readonly outputTokens: number };
      }
    | undefined
  > {
    if (!this.deps.routerLlm) {
      return undefined;
    }
    const toolNames = args.toolDefinitions.map((t) => t.name);
    const decision = await this.routeOrFallback(args.message, toolNames);
    this.deps.logger?.info('pipeline.routed', {
      event: 'pipeline.routed',
      intent: decision.intent,
      tier: decision.modelTier,
      allowedToolNames: decision.allowedToolNames,
      reason: decision.reason,
      fallback: decision.fallback,
      filteredCount: toolNames.length - decision.allowedToolNames.length,
      routerInputTokens: decision.routerUsage.inputTokens,
      routerOutputTokens: decision.routerUsage.outputTokens,
    });
    const modelId = tierToModelId(decision.modelTier);
    const others = (this.deps.fallbackChain ?? []).filter((m) => m !== modelId);
    return {
      chain: [modelId, ...others],
      floor: decision.modelTier,
      allowedToolNames: decision.allowedToolNames,
      routerUsage: decision.routerUsage,
    };
  }

  /**
   * Phase 34 B-2: LLM 라우터 호출, 실패 시 inferRole 키워드 폴백.
   * 폴백 시 routerUsage=0 (라우터 LLM 미과금), fallback=true 로 로그/비용 구분.
   */
  private async routeOrFallback(
    message: string,
    availableToolNames: readonly string[],
  ): Promise<RouterDecision> {
    const routerLlm = this.deps.routerLlm;
    if (!routerLlm) {
      return this.keywordFallbackDecision(message, availableToolNames);
    }
    try {
      return await routerLlm({ message, availableToolNames: [...availableToolNames] });
    } catch (err) {
      this.deps.logger?.warn('router.fallback', {
        event: 'router.fallback',
        reason: toMessage(err),
      });
      return this.keywordFallbackDecision(message, availableToolNames);
    }
  }

  /** inferRole 키워드 휴리스틱 → RouterDecision 폴백. analysis=모든 도구, fetch/chat=sonnet 도구. */
  private keywordFallbackDecision(
    message: string,
    availableToolNames: readonly string[],
  ): RouterDecision {
    const role = inferRole(message); // 잔존: 폴백 전용 (B-2)
    const intent = role === 'analysis' ? 'analysis' : role === 'fetch' ? 'fetch' : 'other';
    const modelTier: ModelTier = role === 'analysis' ? 'sonnet' : 'haiku';
    // 폴백은 보수적: analysis 면 전체 노출, 그 외는 전체 노출(키워드 시대 동작 보존).
    return {
      intent,
      modelTier,
      allowedToolNames: [...availableToolNames],
      reason: `keyword-fallback(role=${role})`,
      routerUsage: { inputTokens: 0, outputTokens: 0 },
      fallback: true,
    };
  }

  /**
   * Phase 34 B-3: TUI/RPC chat.send 전용 라우팅. execute() 와 동일 LLM 라우터.
   * userHint 기반 키워드 tier 승격(Phase 24) 폐기 — 라우터 결정 tier 그대로.
   * routerLlm 미주입 시 undefined (호출자가 input.model 사용).
   */
  private async applyTuiRouting(args: {
    readonly input: {
      readonly model: ModelRef;
      readonly userMessage: string;
      readonly userHint?: ModelTier;
    };
    readonly toolDefinitions: readonly { readonly name: string }[];
  }): Promise<
    | {
        readonly chain: readonly string[];
        readonly floor: ModelTier;
        readonly allowedToolNames: ReadonlyArray<string>;
        readonly routerUsage: { readonly inputTokens: number; readonly outputTokens: number };
      }
    | undefined
  > {
    if (!this.deps.routerLlm) {
      return undefined;
    }
    const toolNames = args.toolDefinitions.map((t) => t.name);
    const decision = await this.routeOrFallback(args.input.userMessage, toolNames);
    this.deps.logger?.info('tui.routed', {
      event: 'tui.routed',
      intent: decision.intent,
      tier: decision.modelTier,
      allowedToolNames: decision.allowedToolNames,
      reason: decision.reason,
      fallback: decision.fallback,
      filteredCount: toolNames.length - decision.allowedToolNames.length,
      routerInputTokens: decision.routerUsage.inputTokens,
      routerOutputTokens: decision.routerUsage.outputTokens,
    });
    const modelId = tierToModelId(decision.modelTier);
    const others = (this.deps.fallbackChain ?? []).filter((m) => m !== modelId);
    return {
      chain: [modelId, ...others],
      floor: decision.modelTier,
      allowedToolNames: decision.allowedToolNames,
      routerUsage: decision.routerUsage,
    };
  }

  private async loadHistory(sessionKey: SessionKey): Promise<ConversationMessage[]> {
    const { storage } = this.deps;
    if (!storage) {
      return [];
    }
    try {
      const record = await storage.getConversation(sessionKey);
      if (!record?.messages.length) {
        return [];
      }
      return sliceHistoryRespectingToolPairs(record.messages, this.historyLimit);
    } catch (err) {
      this.deps.logger?.warn(
        `Failed to load conversation history for ${sessionKey}: ${toMessage(err)}`,
      );
      return [];
    }
  }

  private buildRequestDispatcher(ctx: {
    readonly sessionId: string;
    readonly userId: string;
    readonly channelId: string;
  }): {
    dispatcher: ExecutionToolDispatcher;
    toolDefinitions: readonly import('@finclaw/types').ToolDefinition[];
  } {
    if (!this.deps.toolRegistry) {
      return { dispatcher: new ToolDispatcherCtor(), toolDefinitions: [] };
    }
    return buildDispatcher(this.deps.toolRegistry, ctx);
  }

  private async persistHistory(
    sessionKey: SessionKey,
    agentId: AgentId,
    messages: readonly ConversationMessage[],
  ): Promise<void> {
    const { storage } = this.deps;
    if (!storage) {
      return;
    }
    try {
      const now = Date.now() as Timestamp;
      await storage.upsertConversation({
        sessionKey,
        agentId,
        messages: [...messages],
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      this.deps.logger?.warn(
        `Failed to persist conversation history for ${sessionKey}: ${toMessage(err)}`,
      );
    }
  }
}

export interface TuiExecutionResult {
  readonly messageId: string;
  readonly content: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export function extractAssistantText(messages: readonly ConversationMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== 'assistant') {
      continue;
    }
    if (typeof msg.content === 'string') {
      return msg.content;
    }
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('');
    }
  }
  return '';
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** ConversationMessage 의 content (string | ContentBlock[]) 를 단일 문자열로 평탄화. */
function flattenContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text;
        case 'tool_result':
          return block.content;
        case 'tool_use':
          return JSON.stringify(block.input);
        default:
          return '';
      }
    })
    .join('\n');
}

function toTranscriptEntry(msg: ConversationMessage): TranscriptEntry {
  return {
    role: msg.role,
    content: flattenContent(msg.content),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Phase 31 C — 컨텍스트 윈도우 평가 후 critical/exceeded 면 compactContext 로 압축.
 *
 * tokenCounter/summarizer 미주입 시 원본 messages 그대로 반환 (compaction 비활성).
 * 압축 결과는 string content 의 ConversationMessage[] 로 환원하고, 선두 orphan tool 메시지를
 * 제거해 Anthropic tool_use/tool_result 페어 제약을 지킨다.
 */
export async function maybeCompactMessages(
  messages: readonly ConversationMessage[],
  model: ModelRef,
  ctx: Pick<PipelineMsgContext, 'tokenCounter' | 'summarizer'>,
  logger?: FinClawLogger,
): Promise<ConversationMessage[]> {
  const { tokenCounter, summarizer } = ctx;
  if (!tokenCounter || !summarizer) {
    return [...messages];
  }

  const entries = messages.map(toTranscriptEntry);
  const windowState = evaluateContextWindow(
    entries,
    model.contextWindow,
    model.maxOutputTokens,
    { warningThreshold: 0.7, criticalThreshold: 0.85, reserveTokens: 4096 },
    tokenCounter,
  );

  if (windowState.status !== 'critical' && windowState.status !== 'exceeded') {
    return [...messages];
  }

  logger?.warn('context.compaction_triggered', {
    event: 'context.compaction_triggered',
    status: windowState.status,
    usedTokens: windowState.currentTokens,
    maxTokens: windowState.maxTokens,
  });

  const result = await compactContext(
    entries,
    {
      strategy: 'summarize',
      targetTokens: Math.floor(model.contextWindow * 0.5),
      preserveRecentMessages: 4,
      preserveSystemPrompt: false,
    },
    summarizer,
    tokenCounter,
  );

  logger?.info('context.compacted', {
    event: 'context.compacted',
    strategy: result.strategy,
    beforeTokens: result.beforeTokens,
    afterTokens: result.afterTokens,
  });

  const compactedMessages: ConversationMessage[] = result.compactedEntries.map((e) => ({
    role: e.role,
    content: e.content,
  }));
  return sliceHistoryRespectingToolPairs(compactedMessages, compactedMessages.length);
}

/**
 * 대화 이력을 historyLimit으로 자르되, tool_use ↔ tool_result 페어를 깨지 않게 정리한다.
 *
 * Anthropic API는 `tool_result` 블록이 바로 앞 메시지의 `tool_use` 블록과 1:1로 대응해야
 * 한다(400: "unexpected tool_use_id in tool_result blocks"). 단순 slice(-N)은 페어 경계를
 * 무시해 잘린 첫 메시지가 고아 tool_result가 될 수 있으므로, slice 후 선두의 고아 메시지를
 * 건너뛴다.
 *
 * @internal 테스트 접근을 위해 export하나, 외부 소비자는 없어야 한다.
 */
export function sliceHistoryRespectingToolPairs(
  messages: readonly ConversationMessage[],
  limit: number,
): ConversationMessage[] {
  let start = messages.length > limit ? messages.length - limit : 0;
  // slice 경계뿐 아니라 저장 이력이 고아 상태로 남은 경우도 방어
  while (start < messages.length && isOrphanedToolResult(messages[start])) {
    start++;
  }
  return messages.slice(start);
}

function isOrphanedToolResult(msg: ConversationMessage | undefined): boolean {
  if (!msg) {
    return false;
  }
  if (msg.role === 'tool') {
    return true;
  }
  if (Array.isArray(msg.content) && msg.content.length > 0) {
    return msg.content.every((b) => b.type === 'tool_result');
  }
  return false;
}

/** assistant tool_use 블록과 뒤따르는 tool tool_result 블록을 페어링해 감사 레코드 생성 */
export function collectToolCalls(
  messages: readonly ConversationMessage[],
  fallbackTimestamp: number,
): ToolCallRecord[] {
  const records: ToolCallRecord[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) {
      continue;
    }
    for (const block of msg.content) {
      if (block.type !== 'tool_use') {
        continue;
      }
      const resultMsg = messages.slice(i + 1).find((r) => r?.role === 'tool');
      const resultBlock =
        resultMsg && Array.isArray(resultMsg.content)
          ? resultMsg.content.find((b) => b.type === 'tool_result' && b.toolUseId === block.id)
          : undefined;
      records.push({
        name: block.name,
        input: block.input,
        output: resultBlock?.type === 'tool_result' ? resultBlock.content : '',
        timestamp: fallbackTimestamp,
        isError: resultBlock?.type === 'tool_result' ? resultBlock.isError : undefined,
      });
    }
  }
  return records;
}
