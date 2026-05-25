// packages/server/src/composition/memory-services.ts
// Phase 36: main.ts 155-174 에서 추출 (순수 이동). Phase 26 의 3-service wire 헬퍼.

import { DefaultAttachMemoryService } from '../auto-reply/agent-memory-hook.js';
import { DefaultMemoryCaptureService } from '../auto-reply/stages/memory-capture.js';
import { DefaultMemoryRetrievalService } from '../auto-reply/stages/memory-retrieval.js';

/**
 * Phase 26: capture / retrieval / attach 3 service 를 동일 deps 로 인스턴스화.
 *
 * 3 service 모두 `{db, embeddingProvider?, logger}` shape 를 받으며 같은 embedding
 * 인스턴스를 공유한다 (키 하나로 4 영역 활성). embeddingProvider 미주입 시 각 service
 * 가 자체적으로 FTS-only fallback 으로 동작.
 */
export function wireMemoryServices(
  deps: ConstructorParameters<typeof DefaultMemoryCaptureService>[0],
  retrievalExtras?: {
    reranker?: import('@finclaw/storage').Reranker;
    rerankTopKFirst?: number;
  },
): {
  memoryCaptureService: DefaultMemoryCaptureService;
  memoryRetrievalService: DefaultMemoryRetrievalService;
  attachMemoryService: DefaultAttachMemoryService;
} {
  return {
    memoryCaptureService: new DefaultMemoryCaptureService(deps),
    memoryRetrievalService: new DefaultMemoryRetrievalService({
      ...deps,
      ...retrievalExtras,
    }),
    attachMemoryService: new DefaultAttachMemoryService(deps),
  };
}
