import { randomUUID } from 'node:crypto';
// packages/server/src/auto-reply/execution-adapter.ts
import type {
  ChatExecutionPort,
  ProfileHealthMonitor,
  RunnerFactory,
  StreamEventListener,
} from '@finclaw/agent';
import { extractAssistantText } from '@finclaw/agent';
import type { FinClawLogger } from '@finclaw/infra';
import type {
  AgentId,
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

export interface ExecutionResult {
  readonly content: string;
  readonly usage?: { inputTokens: number; outputTokens: number };
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

export interface RunnerExecutionAdapterDeps {
  readonly runnerFactory: RunnerFactory;
  readonly defaultModel: ModelRef;
  readonly systemPrompt: string;
  readonly defaultAgentId?: AgentId;
  readonly storage?: StorageAdapter;
  readonly logger?: FinClawLogger;
  /** 이력 로드 시 최근 메시지 수 (기본 20) */
  readonly historyLimit?: number;
  /** 프로필 건강 모니터 — API 호출 결과 기록 */
  readonly profileHealth?: ProfileHealthMonitor;
  /** 건강 기록용 프로필 ID (기본 'default') */
  readonly profileId?: string;
}

/**
 * Runner 기반 실행 어댑터
 *
 * - storage 주입 시 대화 이력 load/save
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
    const runner = this.deps.runnerFactory();
    const profileId = this.deps.profileId ?? 'default';

    // Phase 26 C: retrievalResult 가 있으면 "사용자 배경지식" 섹션을 system prompt 끝에 합성.
    // 빈 섹션 (snippets·transactions 모두 0) 이면 base 그대로 — 빈 헤더 노출 방지.
    const baseSystemPrompt = this.deps.systemPrompt;
    const backgroundSection = ctx.retrievalResult
      ? formatBackgroundSection(ctx.retrievalResult)
      : '';
    const composedSystemPrompt = backgroundSection
      ? `${baseSystemPrompt}\n\n${backgroundSection}`
      : baseSystemPrompt;

    const model = this.deps.defaultModel;

    try {
      const result = await runner.execute({
        agentId: this.defaultAgentId,
        sessionKey: ctx.sessionKey,
        model,
        systemPrompt: composedSystemPrompt,
        messages: [...priorMessages, userMessage],
        abortSignal: signal,
      });

      await this.persistHistory(ctx.sessionKey, this.defaultAgentId, result.messages);
      this.deps.profileHealth?.recordResult(profileId, { success: true, modelId: model.model });

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
   * - StreamEventListener를 runner에 전달해 text_delta 이벤트를 WS로 팬아웃
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

    // Phase 41: TUI 는 사용자 세션 model 사용 (sonnet 강제 X).
    const result = await this.deps.runnerFactory().execute(
      {
        agentId: input.agentId,
        sessionKey: input.sessionKey,
        model: input.model,
        systemPrompt: this.deps.systemPrompt,
        messages: [...priorMessages, userMessage],
        abortSignal: signal,
      },
      listener,
    );

    await this.persistHistory(input.sessionKey, input.agentId, result.messages);

    // Phase 24 E / Phase 41: TUI/chat.send 도 건강 상태에 기록 (success-only).
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
      return record.messages.slice(-this.historyLimit);
    } catch (err) {
      this.deps.logger?.warn(
        `Failed to load conversation history for ${sessionKey}: ${toMessage(err)}`,
      );
      return [];
    }
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
