import { randomUUID } from 'node:crypto';
// packages/server/src/auto-reply/execution-adapter.ts
import type {
  AliasIndex,
  ChatExecutionPort,
  ExecutionToolDispatcher,
  ModelCatalog,
  ModelPricing,
  ProfileHealthMonitor,
  RunnerFactory,
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
  ROUTER_MODEL_ID,
  runWithModelFallback,
  tierToModelId,
  type LlmRouter,
  type ModelRole,
  type RouterDecision,
  type TranscriptEntry,
} from '@finclaw/agent';
import { buildDispatcher, collectToolCalls, extractAssistantText } from '@finclaw/agent';
import type { ToolCallRecord } from '@finclaw/agent';
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

// Phase 39: ToolCallRecord/collectToolCalls/extractAssistantText 는 @finclaw/agent 로 이동.
// 기존 소비자(테스트 포함) 호환을 위해 re-export.
export { collectToolCalls, extractAssistantText } from '@finclaw/agent';
export type { ToolCallRecord } from '@finclaw/agent';

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

// Phase 39: RunnerFactory 는 @finclaw/agent 로 이동 (agent-native). 기존 server 소비자 호환 re-export.
export type { RunnerFactory } from '@finclaw/agent';

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
export class RunnerExecutionAdapter implements ExecutionAdapter, ChatExecutionPort {
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

    // Phase 34/35: LLM 라우터 1회 호출 → intent 기반 모델/도구. signal 전달로 abort 시 취소.
    const routed = await this.routeToChain(
      ctx.normalizedBody,
      toolDefinitions,
      'pipeline.routed',
      signal,
    );

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

      // Phase 34 D-0: 라우터 Haiku 토큰을 메인 호출과 분리하여 byModel 집계.
      // ROUTER_MODEL_ID 의 catalog pricing 으로 비용 환산 → "≤$0.0005" 완료조건 검증 가능.
      if (
        routed?.routerUsage &&
        (routed.routerUsage.inputTokens > 0 || routed.routerUsage.outputTokens > 0)
      ) {
        const routerPricing = this.deps.modelCatalog?.getModel(ROUTER_MODEL_ID)?.pricing;
        this.deps.profileHealth?.recordResult(profileId, {
          success: true,
          modelId: ROUTER_MODEL_ID,
          tokens: {
            input: routed.routerUsage.inputTokens,
            output: routed.routerUsage.outputTokens,
          },
          costUsd: routerPricing
            ? calculateEstimatedCost(
                routed.routerUsage.inputTokens,
                routed.routerUsage.outputTokens,
                routerPricing,
              )
            : 0,
          isFallback: false,
        });
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

    // Phase 34/35: TUI 도 LLM 라우터 사용 (B-3). signal 전달로 abort 시 취소.
    const routed = await this.routeToChain(
      input.userMessage,
      toolDefinitions,
      'tui.routed',
      signal,
    );

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
   * Phase 35: applyRouting/applyTuiRouting 의 공통 코어.
   * 라우터 호출(또는 폴백) → chain + floor + allowedToolNames + routerUsage 구성 + 로깅.
   * 메시지·로그 이벤트명·signal 만 호출자가 주입 (이전 두 헬퍼의 유일한 차이).
   * routerLlm 미주입 시 undefined (라우터 비활성, 기존 fallbackChain 동작).
   */
  private async routeToChain(
    message: string,
    toolDefinitions: readonly { readonly name: string }[],
    logEvent: 'pipeline.routed' | 'tui.routed',
    signal: AbortSignal,
  ): Promise<
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
    const toolNames = toolDefinitions.map((t) => t.name);
    const decision = await this.routeOrFallback(message, toolNames, signal);
    this.deps.logger?.info(logEvent, {
      event: logEvent,
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
   * Phase 35: signal 을 라우터 호출로 전달 (abort 시 in-flight HTTP 취소).
   */
  private async routeOrFallback(
    message: string,
    availableToolNames: readonly string[],
    signal: AbortSignal,
  ): Promise<RouterDecision> {
    const routerLlm = this.deps.routerLlm;
    if (!routerLlm) {
      return this.keywordFallbackDecision(message, availableToolNames);
    }
    try {
      return await routerLlm({
        message,
        availableToolNames: [...availableToolNames],
        abortSignal: signal,
      });
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
