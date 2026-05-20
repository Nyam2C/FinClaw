// packages/agent/src/providers/factory.ts
import type { ProviderAdapter } from './adapter.js';
import { AnthropicAdapter } from './anthropic.js';
import { CliProviderAdapter } from './claude-cli/adapter.js';
import type { CliBackendConfig } from './claude-cli/types.js';

// ★ W5: plan 의 ProviderId → ProviderKind 로 rename (catalog ProviderId 와 충돌 회피)
export type ProviderKind = 'anthropic-sdk' | 'claude-cli';

export interface ProviderFactoryConfig {
  kind: ProviderKind;
  apiKey?: string; // SDK 모드 전용
  cliBackend?: CliBackendConfig; // CLI 모드 전용
  defaultTimeoutMs?: number;
  sdkFallback?: ProviderAdapter; // W2: CLI auth 만료 시 위임 (CLI 모드에서만)
}

export function createProviderAdapter(cfg: ProviderFactoryConfig): ProviderAdapter {
  switch (cfg.kind) {
    case 'anthropic-sdk':
      if (!cfg.apiKey) {
        throw new Error('ANTHROPIC_API_KEY required for anthropic-sdk provider');
      }
      return new AnthropicAdapter(cfg.apiKey); // ★ (apiKey) 단일 인자
    case 'claude-cli':
      return new CliProviderAdapter({
        backend: cfg.cliBackend,
        defaultTimeoutMs: cfg.defaultTimeoutMs,
        sdkFallback: cfg.sdkFallback,
      });
    default: {
      const _exhaustive: never = cfg.kind;
      throw new Error(`Unknown provider: ${String(_exhaustive)}`);
    }
  }
}
