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

/** D2: signal = registry 가 timeout·외부 abort 를 합친 ctx.abortSignal — 서브에이전트 spawn 까지 전달. */
export type Dispatcher = (req: RouteRequest, signal?: AbortSignal) => Promise<RouteResult>;
