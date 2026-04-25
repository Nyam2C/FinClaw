// packages/server/src/auto-reply/execution-adapter.ts
import type {
  AliasIndex,
  ExecutionToolDispatcher,
  ModelCatalog,
  ProfileHealthMonitor,
  Runner,
  StreamEventListener,
  ToolRegistry,
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
import {
  DEFAULT_FALLBACK_TRIGGERS,
  ExecutionToolDispatcher as ToolDispatcherCtor,
  modelIdToTier,
  resolveModel,
  runWithModelFallback,
  type ModelRole,
} from '@finclaw/agent';
import { createAgentId } from '@finclaw/types';
import { randomUUID } from 'node:crypto';
import type { PipelineMsgContext } from './pipeline-context.js';
import type { RouterHelper } from './router-helper.js';
import { buildDispatcher } from './tool-dispatcher-adapter.js';

/**
 * 메시지 본문에서 role 추론 — 단순 키워드 휴리스틱 (Phase 24, B1).
 * 사용자 직접 입력이라 모호하므로 분석 키워드만 'analysis' 로 승격, 그 외 'chat'.
 */
const ANALYSIS_KEYWORDS = ['분석', '리포트', '판단', 'analyze', 'report'];

function inferRole(message: string): ModelRole {
  const lower = message.toLowerCase();
  if (ANALYSIS_KEYWORDS.some((kw) => lower.includes(kw))) {
    return 'analysis';
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
   * 모델 라우터 (Phase 24) — 제공 시 execute/executeForTui 가 매 요청마다
   * 라우터 결정 모델로 fallbackChain/defaultModel 을 대체한다.
   */
  readonly router?: RouterHelper;
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

    // Phase 24: 라우터가 주입되면 매 요청마다 role 추론 + 라우팅 결정.
    const routed = this.applyRouting({
      message: ctx.normalizedBody,
      toolDefinitions,
      automation: false,
    });

    const buildParams = (model: ModelRef): AgentRunParams => ({
      agentId: this.defaultAgentId,
      sessionKey: ctx.sessionKey,
      model,
      systemPrompt: this.deps.systemPrompt,
      messages: [...priorMessages, userMessage],
      tools: toolDefinitions.length > 0 ? [...toolDefinitions] : undefined,
      abortSignal: signal,
    });

    try {
      const { modelCatalog, modelAliasIndex, fallbackChain } = this.deps;
      // 라우터 활성: routed.chain (라우터 결정 모델 선두) + routed.floor 로 floor 미만 차단.
      // 라우터 미주입: 기존 fallbackChain 동작 (floor 없음 → AggregateError).
      const effectiveChain = routed?.chain ?? fallbackChain;
      const effectiveFloor = routed?.floor;
      let result;
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
      } else {
        result = await runner.execute(buildParams(this.deps.defaultModel));
      }

      const toolCalls = collectToolCalls(result.messages, startedAt);
      await this.persistHistory(ctx.sessionKey, this.defaultAgentId, result.messages);

      this.deps.profileHealth?.recordResult(profileId, true);

      return {
        content: extractAssistantText(result.messages),
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        },
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
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

    // Phase 24: 라우터 주입 시 chain + floor 로 runWithModelFallback 사용.
    // 미주입 시 input.model 단일 사용 (기존 동작).
    const routed = this.applyTuiRouting({ input, toolDefinitions });

    const buildParams = (model: ModelRef): AgentRunParams => ({
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      model,
      systemPrompt: this.deps.systemPrompt,
      messages: [...priorMessages, userMessage],
      tools: toolDefinitions.length > 0 ? [...toolDefinitions] : undefined,
      abortSignal: signal,
    });

    const { modelCatalog, modelAliasIndex } = this.deps;
    let result;
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
    } else {
      result = await runner.execute(buildParams(input.model), listener);
    }

    await this.persistHistory(input.sessionKey, input.agentId, result.messages);

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
   * Phase 24: 라우팅 결정 → fallback chain 구성. 라우터 미주입 시 undefined.
   *
   * - chain: 라우터 결정 모델을 선두로, 나머지 fallbackChain 모델을 뒤에 배치.
   *   fallback.ts 의 floor 필터가 floor 미만 제거 — 호출자는 신경쓰지 않음.
   * - floor: routing 결정의 floor (밀스톤 D, B6).
   */
  private applyRouting(args: {
    readonly message: string;
    readonly toolDefinitions: readonly { readonly name: string }[];
    readonly automation: boolean;
  }): { readonly chain: readonly string[]; readonly floor: ModelTier } | undefined {
    const router = this.deps.router;
    if (!router) {
      return undefined;
    }
    const role = inferRole(args.message);
    const toolNames = args.toolDefinitions.map((t) => t.name);
    const { decision, modelId } = router({
      role,
      toolNames,
      automation: args.automation,
    });
    this.deps.logger?.info('pipeline.routed', {
      event: 'pipeline.routed',
      role,
      chosenModel: modelId,
      floor: decision.floor,
      reason: decision.reason,
    });
    const others = (this.deps.fallbackChain ?? []).filter((m) => m !== modelId);
    return { chain: [modelId, ...others], floor: decision.floor };
  }

  /**
   * Phase 24: TUI/RPC chat.send 전용 라우팅. role='chat' 고정 + userHint 적용.
   * 라우터 미주입 시 undefined — 호출자가 input.model 그대로 사용.
   */
  private applyTuiRouting(args: {
    readonly input: {
      readonly model: ModelRef;
      readonly userMessage: string;
      readonly userHint?: ModelTier;
    };
    readonly toolDefinitions: readonly { readonly name: string }[];
  }): { readonly chain: readonly string[]; readonly floor: ModelTier } | undefined {
    const router = this.deps.router;
    if (!router) {
      return undefined;
    }
    const userHint = args.input.userHint ?? modelIdToTier(args.input.model.model);
    const toolNames = args.toolDefinitions.map((t) => t.name);
    const { decision, modelId } = router({
      role: 'chat',
      toolNames,
      userHint,
    });
    this.deps.logger?.info('tui.routed', {
      event: 'tui.routed',
      userHint,
      chosenModel: modelId,
      floor: decision.floor,
      reason: decision.reason,
    });
    const others = (this.deps.fallbackChain ?? []).filter((m) => m !== modelId);
    return { chain: [modelId, ...others], floor: decision.floor };
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
