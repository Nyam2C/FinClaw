// packages/server/src/composition/providers.ts
// Phase 36: main.ts 274-303 에서 추출. Phase 46: CLI 실행은 agent-runtime 드라이버로 이동 — 도구 레지스트리만 남음.

import { InMemoryToolRegistry } from '@finclaw/agent';
import type { FinClawLogger } from '@finclaw/infra';

export interface BuildProvidersDeps {
  readonly logger: FinClawLogger;
}

export interface ProvidersBundle {
  readonly toolRegistry: InMemoryToolRegistry;
}

export function buildProviders({ logger }: BuildProvidersDeps): ProvidersBundle {
  logger.info('provider.initialized', {
    event: 'provider.initialized',
    providerKind: 'anthropic',
  });
  return { toolRegistry: new InMemoryToolRegistry() };
}
