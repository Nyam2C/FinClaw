import type { RegisteredToolDefinition, ToolExecutor, ToolRegistry } from '@finclaw/agent';
import type { Dispatcher, RouteIntent } from '@finclaw/types';

// TODO(future): intent enum 은 `prompts/sub-agents/*.md` 의 frontmatter id 로 동적 구성.
// 새 sub-agent 추가가 이 파일 수정 없이 가능해짐. 현재 PoC 는 하드코딩.
const ROUTE_INTENTS: readonly RouteIntent[] = [
  'price_lookup',
  'chart_data',
  'news_summary',
  'market_analysis',
  'portfolio_calc',
];

/**
 * route_task 도구 — 메인 에이전트가 trivial 조회·OSS 계산·전문 분석을 sub-agent 로 위임할 때 사용.
 * intent 별 분기는 주입된 Dispatcher 가 결정 (함수/OSS/sub-agent).
 */
export function registerRouteTaskTool(registry: ToolRegistry, dispatcher: Dispatcher): void {
  const def: RegisteredToolDefinition = {
    name: 'route_task',
    description:
      '단순 시세 조회·차트 데이터·뉴스 요약·시장 분석·포트폴리오 계산을 전문 처리기로 위임합니다. ' +
      '메인 추론 컨텍스트 밖에서 처리되어 토큰 비용이 분리됩니다.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          enum: [...ROUTE_INTENTS],
          description:
            'price_lookup: 시세 1회 조회. chart_data: 봉/차트 데이터. ' +
            'news_summary: 뉴스 요약. market_analysis: 종합 시장 분석. ' +
            'portfolio_calc: 포트폴리오 계산.',
        },
        query: {
          type: 'string',
          description: '자연어 요청 본문 (sub-agent 가 처리할 입력).',
        },
        symbol: {
          type: 'string',
          description: '대상 종목 코드 (선택, 단일 종목 대상 시).',
        },
      },
      required: ['intent', 'query'],
    },
    group: 'custom',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: false,
    isExternal: true,
    timeoutMs: 90_000,
  };

  const executor: ToolExecutor = async (input) => {
    const intent = input.intent as RouteIntent;
    const query = (input.query as string) ?? '';
    const symbol = input.symbol as string | undefined;

    if (!ROUTE_INTENTS.includes(intent)) {
      return { content: `unknown intent: ${String(intent)}`, isError: true };
    }
    if (query.length === 0) {
      return { content: 'query is required', isError: true };
    }

    try {
      const result = await dispatcher({ intent, query, symbol });
      return {
        content: result.content,
        isError: result.isError,
        metadata: { source: result.source, modelUsed: result.modelUsed },
      };
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  };

  registry.register(def, executor, 'skill');
}
