// packages/agent/src/providers/adapter.ts
import type { ConversationMessage } from '@finclaw/types';
import type { ProviderId } from '../models/catalog.js';
import type { StreamChunk } from '../models/provider-normalize.js';

/** 제공자 API 호출 파라미터 */
export interface ProviderRequestParams {
  readonly model: string;
  readonly messages: ConversationMessage[];
  readonly systemPrompt?: string;
  readonly abortSignal?: AbortSignal;
}

/** 제공자 어댑터 인터페이스 */
export interface ProviderAdapter {
  readonly providerId: ProviderId;
  streamCompletion(params: ProviderRequestParams): AsyncIterable<StreamChunk>;
}
