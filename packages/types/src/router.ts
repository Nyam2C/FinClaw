/**
 * route_task 디스패치 계약.
 * 메인 에이전트가 `route_task` 도구로 위임할 때의 입출력 + 디스패처 시그니처.
 */

export type RouteIntent =
  | 'price_lookup'
  | 'chart_data'
  | 'news_summary'
  | 'market_analysis'
  | 'portfolio_calc';

export interface RouteRequest {
  readonly intent: RouteIntent;
  readonly query: string;
  readonly symbol?: string;
}

export interface RouteResult {
  readonly content: string;
  readonly source: 'function' | 'oss' | 'sub-agent';
  readonly modelUsed?: string;
  readonly isError: boolean;
}

export type Dispatcher = (req: RouteRequest) => Promise<RouteResult>;
