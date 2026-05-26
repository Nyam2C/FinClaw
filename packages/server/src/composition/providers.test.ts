import type { FinClawLogger } from '@finclaw/infra';
import type { FinClawConfig } from '@finclaw/types';
import { describe, expect, it, vi } from 'vitest';
import { buildProviders } from './providers.js';

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
  flush: vi.fn(),
} as unknown as FinClawLogger;

describe('buildProviders — Phase 40 D keyless CLI boot', () => {
  it('omits sdkAdapter/routerLlm when no anthropicKey (pure CLI)', () => {
    const b = buildProviders({
      finclawConfig: { provider: 'claude-cli' } as unknown as FinClawConfig,
      anthropicKey: undefined,
      logger,
    });
    expect(b.sdkAdapter).toBeUndefined();
    expect(b.routerLlm).toBeUndefined();
    // CLI adapter 는 키 없이도 정상 생성.
    expect(b.providerAdapter).toBeDefined();
    expect(b.toolRegistry).toBeDefined();
  });

  it('creates sdkAdapter + routerLlm when anthropicKey present (dual-path 휴면)', () => {
    const b = buildProviders({
      finclawConfig: { provider: 'claude-cli' } as unknown as FinClawConfig,
      anthropicKey: 'sk-test',
      logger,
    });
    expect(b.sdkAdapter).toBeDefined();
    expect(b.routerLlm).toBeDefined();
  });
});
