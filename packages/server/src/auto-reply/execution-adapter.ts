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
  DEFAULT_FALLBACK_TRIGGERS,
  ExecutionToolDispatcher as ToolDispatcherCtor,
  resolveModel,
  runWithModelFallback,
} from '@finclaw/agent';
import { buildDispatcher, collectToolCalls, extractAssistantText } from '@finclaw/agent';
import type { ToolCallRecord } from '@finclaw/agent';
import type { FinClawLogger } from '@finclaw/infra';
import type {
  AgentId,
  AgentRunParams,
  ConversationMessage,
  ModelRef,
  SessionKey,
  StorageAdapter,
  Timestamp,
} from '@finclaw/types';
import { createAgentId } from '@finclaw/types';
import type { PipelineMsgContext } from './pipeline-context.js';
import { formatBackgroundSection } from './stages/memory-retrieval.js';

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

    const { dispatcher } = this.buildRequestDispatcher({
      sessionId: ctx.sessionKey as string,
      userId: ctx.senderId,
      channelId: ctx.channelId as unknown as string,
    });
    const runner = this.deps.runnerFactory(dispatcher);
    const profileId = this.deps.profileId ?? 'default';
    const startedAt = Date.now();

    // Phase 26 C: retrievalResult 가 있으면 "사용자 배경지식" 섹션을 system prompt 끝에 합성.
    // 빈 섹션 (snippets·transactions 모두 0) 이면 base 그대로 — 빈 헤더 노출 방지.
    const baseSystemPrompt = this.deps.systemPrompt;
    const backgroundSection = ctx.retrievalResult
      ? formatBackgroundSection(ctx.retrievalResult)
      : '';
    const composedSystemPrompt = backgroundSection
      ? `${baseSystemPrompt}\n\n${backgroundSection}`
      : baseSystemPrompt;

    const requestMessages = [...priorMessages, userMessage];

    const buildParams = (model: ModelRef): AgentRunParams => ({
      agentId: this.defaultAgentId,
      sessionKey: ctx.sessionKey,
      model,
      systemPrompt: composedSystemPrompt,
      messages: requestMessages,
      abortSignal: signal,
    });

    try {
      const { modelCatalog, modelAliasIndex, fallbackChain } = this.deps;
      const effectiveChain = fallbackChain;
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
          },
          async (resolved) => {
            const model: ModelRef = {
              ...this.deps.defaultModel,
              provider: resolved.provider,
              model: resolved.modelId,
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
    },
    listener: StreamEventListener | undefined,
    signal: AbortSignal,
  ): Promise<TuiExecutionResult> {
    const priorMessages = await this.loadHistory(input.sessionKey);
    const userMessage: ConversationMessage = { role: 'user', content: input.userMessage };

    const { dispatcher } = this.buildRequestDispatcher({
      sessionId: input.sessionKey as string,
      userId: 'tui',
      channelId: 'tui',
    });
    const runner = this.deps.runnerFactory(dispatcher);

    const buildParams = (model: ModelRef): AgentRunParams => ({
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      model,
      systemPrompt: this.deps.systemPrompt,
      messages: [...priorMessages, userMessage],
      abortSignal: signal,
    });

    // Phase 41: LLM 라우터 제거 — TUI 는 사용자 세션 model 단발 경로 보존 (sonnet 강제 X).
    // byModel 집계(modelId/pricing)는 fallback path 전용이었으므로 단발 경로는 success-only 기록.
    const result = await runner.execute(buildParams(input.model), listener);

    await this.persistHistory(input.sessionKey, input.agentId, result.messages);

    // Phase 24 E / Phase 41: TUI/chat.send 도 모델 분포에 기록 (단발 경로 — success-only).
    const profileId = this.deps.profileId ?? 'default';
    this.deps.profileHealth?.recordResult(profileId, true);

    return {
      messageId: randomUUID(),
      content: extractAssistantText(result.messages),
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      },
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
  } {
    if (!this.deps.toolRegistry) {
      return { dispatcher: new ToolDispatcherCtor() };
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
