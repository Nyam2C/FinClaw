// packages/server/src/auto-reply/execution-adapter.ts
import type { ExecutionToolDispatcher, Runner, ToolRegistry } from '@finclaw/agent';
import type { FinClawLogger } from '@finclaw/infra';
import type {
  AgentId,
  AgentRunParams,
  ContentBlock,
  ConversationMessage,
  ModelRef,
  StorageAdapter,
  Timestamp,
} from '@finclaw/types';
import { ExecutionToolDispatcher as ToolDispatcherCtor } from '@finclaw/agent';
import { createAgentId } from '@finclaw/types';
import type { PipelineMsgContext } from './pipeline-context.js';
import { buildDispatcher } from './tool-dispatcher-adapter.js';

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
    const priorMessages = await this.loadHistory(ctx);
    const userMessage: ConversationMessage = { role: 'user', content: ctx.normalizedBody };

    const { dispatcher, toolDefinitions } = this.buildRequestDispatcher(ctx, signal);
    const runner = this.deps.runnerFactory(dispatcher);

    const params: AgentRunParams = {
      agentId: this.defaultAgentId,
      sessionKey: ctx.sessionKey,
      model: this.deps.defaultModel,
      systemPrompt: this.deps.systemPrompt,
      messages: [...priorMessages, userMessage],
      tools: toolDefinitions.length > 0 ? [...toolDefinitions] : undefined,
      abortSignal: signal,
    };

    const result = await runner.execute(params);

    await this.persistHistory(ctx, result.messages);

    return {
      content: extractAssistantText(result.messages),
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      },
    };
  }

  private async loadHistory(ctx: PipelineMsgContext): Promise<ConversationMessage[]> {
    const { storage } = this.deps;
    if (!storage) {
      return [];
    }
    try {
      const record = await storage.getConversation(ctx.sessionKey);
      if (!record?.messages.length) {
        return [];
      }
      return record.messages.slice(-this.historyLimit);
    } catch (err) {
      this.deps.logger?.warn(
        `Failed to load conversation history for ${ctx.sessionKey}: ${toMessage(err)}`,
      );
      return [];
    }
  }

  private buildRequestDispatcher(
    ctx: PipelineMsgContext,
    _signal: AbortSignal,
  ): {
    dispatcher: ExecutionToolDispatcher;
    toolDefinitions: readonly import('@finclaw/types').ToolDefinition[];
  } {
    if (!this.deps.toolRegistry) {
      return { dispatcher: new ToolDispatcherCtor(), toolDefinitions: [] };
    }
    return buildDispatcher(this.deps.toolRegistry, {
      sessionId: ctx.sessionKey as string,
      userId: ctx.senderId,
      channelId: ctx.channelId as unknown as string,
    });
  }

  private async persistHistory(
    ctx: PipelineMsgContext,
    messages: readonly ConversationMessage[],
  ): Promise<void> {
    const { storage } = this.deps;
    if (!storage) {
      return;
    }
    try {
      const now = Date.now() as Timestamp;
      await storage.upsertConversation({
        sessionKey: ctx.sessionKey,
        agentId: this.defaultAgentId,
        messages: [...messages],
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      this.deps.logger?.warn(
        `Failed to persist conversation history for ${ctx.sessionKey}: ${toMessage(err)}`,
      );
    }
  }
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
