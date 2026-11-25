// packages/agent/src/providers/claude-cli/adapter.ts
import type { ConversationMessage } from '@finclaw/types';
import type { ProviderId } from '../../models/catalog.js';
import type { StreamChunk } from '../../models/provider-normalize.js';
import type { ProviderAdapter, ProviderRequestParams } from '../adapter.js';
import { runCliAgent, type RunCliAgentResponse } from './runner.js';
import type { CliBackendConfig } from './types.js';

export interface CliProviderAdapterOptions {
  backend?: CliBackendConfig;
  defaultTimeoutMs?: number;
}

export class CliProviderAdapter implements ProviderAdapter {
  // ★ 멤버명 providerId (id 아님), capability 플래그 제거
  readonly providerId: ProviderId = 'claude-cli';
  // Q1 (A): 단일 사용자 전역 세션 — 첫 응답 session_id 저장 후 다음 호출 --resume.
  #cliSessionId: string | undefined;

  constructor(private readonly opts: CliProviderAdapterOptions = {}) {}

  // ★ async generator: text_delta → usage → done
  async *streamCompletion(params: ProviderRequestParams): AsyncIterable<StreamChunk> {
    // Phase 41: W2 sdkFallback 제거 — CLI 단일 경로. 에러는 상위로 그대로 전파.
    const result: RunCliAgentResponse = await this.#run(params);
    if (result.text) {
      yield { type: 'text_delta', text: result.text };
    }
    if (result.usage) {
      yield {
        type: 'usage',
        usage: {
          inputTokens: result.usage.input ?? 0,
          outputTokens: result.usage.output ?? 0,
          cacheReadTokens: result.usage.cacheRead ?? 0,
          cacheWriteTokens: result.usage.cacheWrite ?? 0,
          // Phase 40 E: 구독 차감 실비용(total_cost_usd). 현재 Runner 는 input/output 토큰만 소비.
          estimatedCostUsd: result.usage.costUsd ?? 0,
        },
      };
    }
    yield { type: 'done' };
  }

  async #run(params: ProviderRequestParams) {
    const result = await runCliAgent({
      prompt: extractPrompt(params.messages),
      systemPrompt: params.systemPrompt,
      modelId: params.model, // ★ model (modelId 아님)
      cliSessionId: this.#cliSessionId, // Q1 (A): 직전 세션 주입
      timeoutMs: this.opts.defaultTimeoutMs ?? 60_000, // params.timeoutMs 미존재 → adapter 옵션
      abortSignal: params.abortSignal,
      backend: this.opts.backend,
    });
    if (result.sessionId) {
      this.#cliSessionId = result.sessionId; // Q1 (A): 세션 갱신
    }
    return result;
  }
}

function extractPrompt(messages: ConversationMessage[]): string {
  return messages
    .map(
      (m) =>
        `${m.role === 'user' ? 'User' : 'Assistant'}: ${typeof m.content === 'string' ? m.content : ''}`,
    )
    .join('\n\n');
}
