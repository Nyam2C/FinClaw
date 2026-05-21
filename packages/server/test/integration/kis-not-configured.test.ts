// packages/server/test/integration/kis-not-configured.test.ts
// Phase 33 E2: KIS 미설정 시 brokerage tool 등록 skip (graceful degradation).
// main.ts 의 등록 가드 조건 `kisAppKey && kisAppSecret && kisAccountNo` 를 재현.
import { InMemoryToolRegistry } from '@finclaw/agent';
import { registerBrokerageTools } from '@finclaw/skills-finance';
import { describe, expect, it, vi } from 'vitest';

/** main.ts 의 KIS 키 로드 + skip 가드와 동일 분기 (process.env 기준). */
function wireBrokerageTools(
  registry: InMemoryToolRegistry,
  env: { KIS_APP_KEY?: string; KIS_APP_SECRET?: string; KIS_ACCOUNT_NO?: string },
  logger: { info: (msg: string, meta?: unknown) => void },
): boolean {
  if (env.KIS_APP_KEY && env.KIS_APP_SECRET && env.KIS_ACCOUNT_NO) {
    registerBrokerageTools(registry, {
      syncHoldings: async () => ({ holdingsCount: 0, marketsScanned: [] }),
    });
    logger.info('Brokerage (KIS) tools registered');
    return true;
  }
  logger.info('KIS not configured — skipping brokerage tools');
  return false;
}

describe('KIS not configured (graceful skip)', () => {
  it('키 미설정 → brokerage tool 등록 skip + 로그', () => {
    const registry = new InMemoryToolRegistry();
    const info = vi.fn();
    const wired = wireBrokerageTools(registry, {}, { info });
    expect(wired).toBe(false);
    expect(registry.has('brokerage_sync_holdings')).toBe(false);
    expect(info).toHaveBeenCalledWith('KIS not configured — skipping brokerage tools');
  });

  it('키 설정 → brokerage tool 등록', () => {
    const registry = new InMemoryToolRegistry();
    const info = vi.fn();
    const wired = wireBrokerageTools(
      registry,
      { KIS_APP_KEY: 'k', KIS_APP_SECRET: 's', KIS_ACCOUNT_NO: '50000000' },
      { info },
    );
    expect(wired).toBe(true);
    expect(registry.has('brokerage_sync_holdings')).toBe(true);
  });
});
