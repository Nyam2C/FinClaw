// packages/agent/src/providers/factory.ts
import type { ProviderAdapter } from './adapter.js';
import { CliProviderAdapter } from './claude-cli/adapter.js';
import type { CliBackendConfig } from './claude-cli/types.js';

export type ProviderKind = 'claude-cli';

export interface ProviderFactoryConfig {
  kind: ProviderKind;
  cliBackend?: CliBackendConfig;
  defaultTimeoutMs?: number;
}

export function createProviderAdapter(cfg: ProviderFactoryConfig): ProviderAdapter {
  // Phase 41: CLI 단일 런타임 — SDK 모드 영구 제거.
  return new CliProviderAdapter({
    backend: cfg.cliBackend,
    defaultTimeoutMs: cfg.defaultTimeoutMs,
  });
}
