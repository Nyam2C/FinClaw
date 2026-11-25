// packages/server/src/auto-reply/pipeline-context.ts
import type { ChannelCapabilities, MsgContext } from '@finclaw/types';
import type { RetrievalResult } from './stages/memory-retrieval.js';

/**
 * 파이프라인 전용 메시지 컨텍스트
 *
 * 기존 MsgContext를 상속하고, 파이프라인에서 필요한 확장 필드만 추가한다.
 */
export interface PipelineMsgContext extends MsgContext {
  // --- 정규화 결과 ---
  readonly normalizedBody: string;
  readonly mentions: readonly string[];
  readonly urls: readonly string[];

  // --- 채널 확장 ---
  readonly channelCapabilities: ChannelCapabilities;

  // --- 사용자 확장 ---
  readonly userRoles: readonly string[];

  // --- 기억 capture (Phase 26 B) ---
  /** capture 단계가 명시적 선언을 저장했을 때 deliver 가 꼬리표 부착에 사용 */
  readonly capturedMemory?: {
    readonly memoryId: string;
    readonly type: 'fact' | 'preference';
    readonly content: string;
    readonly duplicate: boolean;
  };

  // --- 기억 retrieval (Phase 26 C) ---
  /** Context 직후 retrieval 결과. execution-adapter 가 system prompt 에 주입. */
  readonly retrievalResult?: RetrievalResult;
}
