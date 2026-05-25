// packages/server/src/composition/providers.ts
// Phase 36: main.ts 274-303 에서 추출 (순수 이동).

import {
  AnthropicAdapter,
  createLlmRouter,
  createProviderAdapter,
  DEFAULT_CLAUDE_BACKEND,
  InMemoryToolRegistry,
} from '@finclaw/agent';
import { ConcurrencyLaneManager, type FinClawLogger } from '@finclaw/infra';
import type { FinClawConfig } from '@finclaw/types';

export interface BuildProvidersDeps {
  readonly finclawConfig: FinClawConfig;
  readonly anthropicKey: string;
  readonly logger: FinClawLogger;
}

export interface ProvidersBundle {
  readonly sdkAdapter: AnthropicAdapter;
  readonly routerLlm: ReturnType<typeof createLlmRouter>;
  readonly providerAdapter: ReturnType<typeof createProviderAdapter>;
  readonly lanes: ConcurrencyLaneManager;
  readonly toolRegistry: InMemoryToolRegistry;
}

export function buildProviders({
  finclawConfig,
  anthropicKey,
  logger,
}: BuildProvidersDeps): ProvidersBundle {
  // Phase 32 F: dual-path provider — config.provider 로 SDK / claude-cli 전환 (기본 SDK).
  const sdkAdapter = new AnthropicAdapter(anthropicKey);
  // Phase 34: LLM 오케스트레이터 라우터 — SDK Haiku 고정 (B-0). CLI 모드여도 SDK.
  // 선례: summarizer 도 항상 sdkAdapter (Phase 32 F).
  const routerLlm = createLlmRouter(sdkAdapter);
  const providerAdapter = createProviderAdapter({
    kind: finclawConfig.provider ?? 'anthropic-sdk',
    apiKey: anthropicKey,
    cliBackend: finclawConfig.cliBackend
      ? {
          ...DEFAULT_CLAUDE_BACKEND,
          command: finclawConfig.cliBackend.command ?? 'claude',
          reliability: finclawConfig.cliBackend.watchdog
            ? { watchdog: finclawConfig.cliBackend.watchdog }
            : undefined,
        }
      : undefined,
    defaultTimeoutMs: finclawConfig.cliBackend?.timeoutMs ?? 60_000,
    sdkFallback: sdkAdapter, // W2: CLI auth 만료 시 SDK 위임 (CLI 모드일 때만 쓰임)
  });
  logger.info('provider.initialized', {
    event: 'provider.initialized',
    providerKind: finclawConfig.provider ?? 'anthropic-sdk',
    ...(finclawConfig.provider === 'claude-cli'
      ? { note: 'CLI mode: streaming/caching/tool_use disabled' }
      : {}),
  });
  const lanes = new ConcurrencyLaneManager();
  const toolRegistry = new InMemoryToolRegistry();

  return { sdkAdapter, routerLlm, providerAdapter, lanes, toolRegistry };
}
