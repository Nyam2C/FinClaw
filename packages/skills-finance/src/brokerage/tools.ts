// packages/skills-finance/src/brokerage/tools.ts
import type { RegisteredToolDefinition, ToolExecutor, ToolRegistry } from '@finclaw/agent';

export interface BrokerageToolDeps {
  /** server 의 BrokerageSyncService.run 을 감싼 콜백 (skills-finance→server 역참조 회피). */
  readonly syncHoldings: () => Promise<{
    holdingsCount: number;
    marketsScanned: readonly string[];
  }>;
}

export function registerBrokerageTools(registry: ToolRegistry, deps: BrokerageToolDeps): void {
  const def: RegisteredToolDefinition = {
    name: 'brokerage_sync_holdings',
    description:
      '한국투자증권(KIS) 계좌의 보유 종목 잔고를 조회하여 포트폴리오를 동기화합니다. read-only(매매 없음). 뉴스 요약 전에 호출하여 최신 보유 종목을 확보하세요.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    group: 'finance',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: true,
    isExternal: true,
    timeoutMs: 30_000,
  };
  const executor: ToolExecutor = async () => {
    try {
      const r = await deps.syncHoldings();
      return {
        content: `잔고 동기화 완료: ${r.holdingsCount}개 종목 (시장: ${r.marketsScanned.join(', ') || '없음'})`,
        isError: false,
      };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  };
  registry.register(def, executor, 'skill');
}
