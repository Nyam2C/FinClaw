// packages/server/src/auto-reply/agent-memory-hook.ts
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FinClawLogger } from '@finclaw/infra';
import type { EmbeddingProvider } from '@finclaw/storage';
import { addMemory, addMemoryWithEmbedding, linkMemoryToAgentRun } from '@finclaw/storage';
import type { MemoryEntry, SessionKey, Timestamp } from '@finclaw/types';
import { createTimestamp } from '@finclaw/types';

/**
 * 밀스톤 D: agent.run output → memory 저장 정책의 출력 길이 하한.
 * plan.md line 298 "output 길이 > 100 자".
 */
export const MIN_MEMORY_OUTPUT_LENGTH = 100;

/** prompt 일부를 metadata 에 보존할 때 잘라낼 문자수. */
const PROMPT_SNIPPET_MAX = 200;

/** agent.run 종료 후 hook 으로 넘어오는 입력. */
export interface AgentRunMemoryInput {
  readonly agentRunId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly output: string;
  readonly error?: string;
  readonly sessionKey: SessionKey;
  readonly createdAt: number;
}

/** skip 사유. */
export type AttachMemorySkipReason = 'too-short' | 'has-error' | 'embedding-failed';

export type AttachMemoryResult =
  | { readonly memoryId: string }
  | { readonly skipped: AttachMemorySkipReason };

export interface AttachMemoryService {
  attach(input: AgentRunMemoryInput): Promise<AttachMemoryResult>;
}

export interface AttachMemoryServiceDeps {
  readonly db: DatabaseSync;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly logger: FinClawLogger;
}

/**
 * 기본 구현.
 *
 * 흐름:
 * 1. error 가 truthy → skip 'has-error'.
 * 2. output 길이 ≤ MIN_MEMORY_OUTPUT_LENGTH → skip 'too-short'.
 * 3. addMemoryWithEmbedding (provider 있을 때) 시도. throw 시 raw addMemory fallback + warn.
 *    raw addMemory 도 throw 시 skip 'embedding-failed'.
 * 4. 성공 시 linkMemoryToAgentRun(agentRunId, memoryId) 호출.
 *
 * raw output 그대로 memory.content 에 저장 (요약·압축 없음, 단순함 우선).
 */
export class DefaultAttachMemoryService implements AttachMemoryService {
  constructor(private readonly deps: AttachMemoryServiceDeps) {}

  async attach(input: AgentRunMemoryInput): Promise<AttachMemoryResult> {
    if (input.error) {
      this.deps.logger.debug('agent.run memory skipped — error present', {
        event: 'agent.run.memory.skipped',
        agentRunId: input.agentRunId,
        reason: 'has-error',
      });
      return { skipped: 'has-error' };
    }

    if (input.output.length <= MIN_MEMORY_OUTPUT_LENGTH) {
      this.deps.logger.debug('agent.run memory skipped — output too short', {
        event: 'agent.run.memory.skipped',
        agentRunId: input.agentRunId,
        reason: 'too-short',
        outputLength: input.output.length,
      });
      return { skipped: 'too-short' };
    }

    const entry: MemoryEntry = {
      id: randomUUID(),
      sessionKey: input.sessionKey,
      content: input.output,
      type: 'financial',
      createdAt: createTimestamp(input.createdAt) as Timestamp,
      metadata: {
        source: 'agent.run',
        agentRunId: input.agentRunId,
        agentId: input.agentId,
        promptSnippet: input.prompt.slice(0, PROMPT_SNIPPET_MAX),
      },
    };

    try {
      if (this.deps.embeddingProvider) {
        await addMemoryWithEmbedding(this.deps.db, entry, this.deps.embeddingProvider);
      } else {
        addMemory(this.deps.db, entry);
      }
    } catch (err) {
      // 임베딩 프로바이더 장애 → raw addMemory fallback (FTS-only 인덱싱)
      this.deps.logger.warn('agent.run memory: embedding failed, falling back to FTS-only', {
        event: 'agent.run.memory.embedding_failed',
        agentRunId: input.agentRunId,
        memoryId: entry.id,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        addMemory(this.deps.db, entry);
      } catch (fallbackErr) {
        this.deps.logger.error('agent.run memory: fallback addMemory also failed', {
          event: 'agent.run.memory.failed',
          agentRunId: input.agentRunId,
          memoryId: entry.id,
          error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
        return { skipped: 'embedding-failed' };
      }
    }

    linkMemoryToAgentRun(this.deps.db, input.agentRunId, entry.id);

    this.deps.logger.info('agent.run memory attached', {
      event: 'agent.run.memory.attached',
      agentRunId: input.agentRunId,
      memoryId: entry.id,
    });

    return { memoryId: entry.id };
  }
}
