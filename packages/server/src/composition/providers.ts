// packages/server/src/composition/providers.ts
// Phase 36: main.ts 274-303 에서 추출 (순수 이동).

import {
  AnthropicAdapter,
  createLlmRouter,
  createProviderAdapter,
  DEFAULT_CLAUDE_BACKEND,
  InMemoryToolRegistry,
} from '@finclaw/agent';
import { signToken } from '@finclaw/gateway';
import { ConcurrencyLaneManager, type FinClawLogger } from '@finclaw/infra';
import type { FinClawConfig } from '@finclaw/types';

export interface BuildProvidersDeps {
  readonly finclawConfig: FinClawConfig;
  readonly anthropicKey: string;
  readonly logger: FinClawLogger;
  /**
   * Phase 40 C: in-process HTTP MCP 엔드포인트 — 설정 시 cliBackend 에 mcp 배선(signToken minter).
   * gateway /mcp URL + JWT 발급용 secret.
   */
  readonly mcpEndpoint?: { readonly url: string; readonly jwtSecret: string };
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
  mcpEndpoint,
}: BuildProvidersDeps): ProvidersBundle {
  // Phase 32 F: dual-path provider — config.provider 로 SDK / claude-cli 전환 (기본 SDK).
  const sdkAdapter = new AnthropicAdapter(anthropicKey);
  // Phase 34: LLM 오케스트레이터 라우터 — SDK Haiku 고정 (B-0). CLI 모드여도 SDK.
  // 선례: summarizer 도 항상 sdkAdapter (Phase 32 F).
  const routerLlm = createLlmRouter(sdkAdapter);
  // Phase 40 C: cliBackend 은 finclawConfig.cliBackend 또는 mcpEndpoint 주입 시 구성.
  // mcpEndpoint 가 있으면 mcp 필드(signToken per-spawn minter)를 배선 → runner 가 --mcp-config 주입.
  const cliBackend =
    finclawConfig.cliBackend || mcpEndpoint
      ? {
          ...DEFAULT_CLAUDE_BACKEND,
          command: finclawConfig.cliBackend?.command ?? 'claude',
          // watchdog override 가 있을 때만 reliability 교체, 아니면 DEFAULT 유지.
          ...(finclawConfig.cliBackend?.watchdog
            ? { reliability: { watchdog: finclawConfig.cliBackend.watchdog } }
            : {}),
          ...(mcpEndpoint
            ? {
                mcp: {
                  url: mcpEndpoint.url,
                  // per-spawn JWT — 단일 사용자 전역 세션 (sessionId 'mcp'). 매 호출 fresh.
                  mintToken: () =>
                    signToken({ sub: 'finclaw', sessionId: 'mcp' }, mcpEndpoint.jwtSecret),
                  allowedTools: 'mcp__finclaw__*',
                },
              }
            : {}),
        }
      : undefined;
  const providerAdapter = createProviderAdapter({
    kind: finclawConfig.provider ?? 'anthropic-sdk',
    apiKey: anthropicKey,
    cliBackend,
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
