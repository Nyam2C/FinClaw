// packages/server/src/composition/providers.ts
// Phase 36: main.ts 274-303 에서 추출. Phase 41: SDK dual-path 제거 (CLI 단일).

import {
  createProviderAdapter,
  DEFAULT_CLAUDE_BACKEND,
  InMemoryToolRegistry,
} from '@finclaw/agent';
import { signToken } from '@finclaw/gateway';
import { ConcurrencyLaneManager, type FinClawLogger } from '@finclaw/infra';
import type { FinClawConfig } from '@finclaw/types';

export interface BuildProvidersDeps {
  readonly finclawConfig: FinClawConfig;
  readonly logger: FinClawLogger;
  readonly mcpEndpoint?: { readonly url: string; readonly jwtSecret: string };
}

export interface ProvidersBundle {
  readonly providerAdapter: ReturnType<typeof createProviderAdapter>;
  readonly lanes: ConcurrencyLaneManager;
  readonly toolRegistry: InMemoryToolRegistry;
}

export function buildProviders({
  finclawConfig,
  logger,
  mcpEndpoint,
}: BuildProvidersDeps): ProvidersBundle {
  const cliBackend =
    finclawConfig.cliBackend || mcpEndpoint
      ? {
          ...DEFAULT_CLAUDE_BACKEND,
          command: finclawConfig.cliBackend?.command ?? 'claude',
          ...(finclawConfig.cliBackend?.watchdog
            ? { reliability: { watchdog: finclawConfig.cliBackend.watchdog } }
            : {}),
          ...(mcpEndpoint
            ? {
                mcp: {
                  url: mcpEndpoint.url,
                  mintToken: () =>
                    signToken({ sub: 'finclaw', sessionId: 'mcp' }, mcpEndpoint.jwtSecret),
                  allowedTools: 'mcp__finclaw__*',
                },
              }
            : {}),
        }
      : undefined;
  const providerAdapter = createProviderAdapter({
    kind: 'claude-cli',
    cliBackend,
    defaultTimeoutMs: finclawConfig.cliBackend?.timeoutMs ?? 60_000,
  });
  logger.info('provider.initialized', {
    event: 'provider.initialized',
    providerKind: 'claude-cli',
  });
  const lanes = new ConcurrencyLaneManager();
  const toolRegistry = new InMemoryToolRegistry();

  return { providerAdapter, lanes, toolRegistry };
}
