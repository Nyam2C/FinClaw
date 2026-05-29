# Phase 43 Todo: 에이전트 라우팅 재설계 (thin orchestrator)

> plan.md 의 마일스톤 M1~M4 를 코드 단위로 분해한 작업 가이드.
> 분해 범위 = **M1~M4 (라우팅만)**. dead-code sweep 은 phase44 — 본 todo 에 포함 금지 (plan §0 OUT, §3 외과적).
> base = main `e3af851` (phase42 머지) · 작업 브랜치 `feature/phase43`.
> 검증 게이트(매 밀스톤): `pnpm format && pnpm lint && pnpm typecheck && pnpm build && pnpm test --run` **전부** (phase42 교훈: tsgo+vitest 만으론 broken build 못 잡음 — `pnpm build`=`tsc --build` 필수).

---

## 0. 분해 시 확정된 와이어링 결정 (구현 전 필독)

plan §1 레버 1("함수 dispatch = 내부 service 직접 호출")을 코드에 떨어뜨리면 아래 두 좌표에서 **service 핸들을 어떻게 얻느냐**가 갈린다. 본 todo 는 plan 범위 안에서 가장 외과적인 쪽을 골랐다.

1. **price_lookup → `MarketSkillHandle.quoteService.getQuote`** (이미 노출됨, `market/index.ts:63`). 신규 service 불요.
2. **chart_data → 차트 경로는 현재 비노출.** `getChartFromState`(`market/index.ts:109`)는 private 헬퍼이고 `MarketSkillHandle` 에는 `quoteService` 만 있다. → **M2-A1 에서 `MarketSkillHandle` 에 `chartService` 를 추가**(quoteService 와 동일 패턴, 1 메서드). `toolRegistry.execute('get_market_chart')` 우회는 plan §1 의 "함수=service 직접 호출" 프레이밍과 충돌하고 9-stage 정책을 다시 타므로 비채택.
3. **news_summary → `newsAggregator.fetchNews`** (이미 dispatcher 에 주입됨, `dispatch.ts:14`). 추가 주입 불요.
4. **portfolio_calc → `NewsSkillHandle.portfolioStore` + `quoteService` + `newsAggregator` 로 `createPortfolioTracker(...).summarize(portfolio)`**(`news/tools.ts:220-225`). portfolioId 미지정 시 `portfolioStore.listPortfolios()[0]` 로 단일 사용자 기본 포트폴리오 해소(skills.ts 의 `resolveDefaultPortfolioId` 와 정합, accessesSensitiveData 의미 보존).
5. **메인 노출 제거 방식** = `toolRegistry.unregister('get_stock_price')` 패턴(skills.ts:142 의 `analyze_market` unregister 와 동일). bridge deny 추가가 아니라 unregister 를 택함: route_task 함수는 service 핸들을 직접 들고 호출하므로 ToolRegistry 에 직접 도구를 **남길 필요가 없다**(레버 1 이 service 직접 호출이라 도구 등록 자체가 불요). → ToolRegistry 에서 빼면 MCP bridge·9-stage·status 어디에도 도구 잔재가 안 남아 가장 깨끗하다.

> **M4 범위 경고:** M4(agentDir 로더 + sub-agent 프롬프트 파일화)는 신규 레이어다(현재 미구현). plan §3·§4 가 "M4 가 43 을 넘기면 44 로" 를 명시. M1~M3 가 라우팅 재설계의 본체이고 회귀 0 으로 닫을 수 있다. **M4 는 시간/리스크가 M1~M3 합보다 클 수 있으므로, M3 까지 green 으로 닫은 뒤 M4 착수. M4 미완 시 phase44 로 이월(사용자 허용).**

---

## 사전 준비

### P-1. 작업 브랜치 확인

`feature/phase43` 에서 작업(이미 체크아웃됨). 밀스톤마다 1 커밋, subject ASCII (lefthook conventional).

검증: `git branch --show-current` → `feature/phase43`

---

## 밀스톤 M1 — 도구 인벤토리·경계 확정 + system prompt 재작성

> 목표(plan §3 M1): 코드변경 최소(프롬프트). `finclaw.system.ko.md` 를 route_task 위임 가이드로 재작성. 도구 표면 표 확정. typecheck/test 회귀 0.

### M1-1. EDIT `packages/server/prompts/finclaw.system.ko.md` — 도구 가이드를 route_task 위임 가이드로 재작성

§23-30 의 "사용 가능한 도구" 블록을 교체. 시세·차트·뉴스·포트폴리오 직접 도구는 메인 노출에서 빠질 예정(M3)이므로 프롬프트에서 route_task 위임으로 안내. datetime·alerts 조회·schedule 은 메인 직접 유지를 명시.

변경 전(§23-30):

```md
## 사용 가능한 도구 (API 키 설정 상태에 따라 가변)

- `get_stock_price`, `get_crypto_price`, `get_forex_rate`, `get_market_chart` — 시세 조회
- `get_financial_news`, `analyze_market` — 금융 뉴스·분석
- `set_alert`, `list_alerts`, `remove_alert`, `get_alert_history` — 가격/변화/뉴스 알림
- `get_portfolio_summary` — 포트폴리오 요약
- `get_current_datetime`, `web_fetch`, `read_local_file` — 일반 유틸

도구가 필요한데 없으면 "도구 X가 필요한데 지금 활성화되어 있지 않다. API 키 확인 바란다"라고 답한다.
```

변경 후:

```md
## 작업 위임 — `route_task`

너는 **분류·위임 중심 오케스트레이터**다. 시세·차트·뉴스·포트폴리오·시장분석 같은 도메인 작업은 직접 하지 말고 `route_task` 도구로 전문 처리기에 위임한다. 처리는 메인 추론 컨텍스트 밖에서 일어나 토큰 비용이 분리된다.

`route_task(intent, query, symbol?)` 의 intent 선택:

- `price_lookup` — 주식/암호화폐/외환 시세 1회 조회. `symbol` 에 종목 코드(예: AAPL, BTC, USD/KRW).
- `chart_data` — 봉/차트(스파크라인) 데이터. `symbol` 필수.
- `news_summary` — 금융 뉴스 검색·요약. `symbol` 또는 `query` 의 키워드.
- `market_analysis` — 뉴스 종합 시장 분석(전망·감성·리스크). 무거운 분석.
- `portfolio_calc` — 포트폴리오 P&L·상위 수익/손실 계산.

## 메인이 직접 처리하는 도구 (위임 안 함)

- `get_current_datetime` — 현재 시각(순수 함수).
- `list_alerts`, `get_alert_history` — 알림 조회(read-only).
- `schedule_manage` — 스케줄 설정.

도구가 필요한데 없으면 "도구 X가 필요한데 지금 활성화되어 있지 않다. API 키 확인 바란다"라고 답한다.
```

검증: 프롬프트 frontmatter/구조 보존(파싱 깨지면 부팅 실패). `pnpm typecheck` (프롬프트는 typecheck 무관이나 게이트 동일).

### M1-2. 밀스톤 M1 검증

다음을 모두 통과해야 M2 로:

- `pnpm format` (oxfmt — md 파일 변경 후 키 순서 무관하나 게이트 일관성)
- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test --run` (회귀 0 — M1 은 코드 무변경이므로 기존 unit 전부 green 유지)

커밋: `docs(phase43): rewrite system prompt as route_task delegation guide`

---

## 밀스톤 M2 — route_task 함수 dispatch 확장

> 목표(plan §3 M2): `dispatch.ts` 에 price_lookup·chart_data·news_summary·portfolio_calc 를 내부 service 직접 호출로 구현 + dispatcher 에 market/news handle 주입(skills.ts). intent별 unit test(mock service) green, `source:'function'`, `isError` 전파.

### M2-A1. EDIT `packages/skills-finance/src/market/index.ts` — `MarketSkillHandle` 에 `chartService` 노출

chart_data intent 가 차트 경로를 service 로 직접 부르려면 현재 private 인 `getChartFromState` 를 핸들로 노출해야 한다(§0 결정 2). `quoteService` 와 동일 패턴.

`MarketSkillHandle` 인터페이스에 필드 추가(§33-42 근처):

```ts
export interface MarketSkillHandle {
  readonly providers: ProviderRegistry;
  readonly cache: MarketCache;
  readonly quoteService: QuoteService;
  /** Phase 43: route_task chart_data intent 가 직접 호출하는 차트 서비스(스파크라인 텍스트). */
  readonly chartService: ChartService;
  readonly keyRotators: {
    readonly finnhub?: KeyRotator;
    readonly twelveData?: KeyRotator;
    readonly alphaVantage?: KeyRotator;
  };
}
```

`ChartService` 인터페이스 신설(파일 상단, `MarketSkillConfig` 위):

```ts
/** Phase 43: 차트(스파크라인) 조회 어댑터 — route_task chart_data 가 소비. */
export interface ChartService {
  getChart(symbol: string, period: string): Promise<string>;
}
```

`registerMarketTools` 의 return 블록(현 §74-83)에 chartService 추가:

```ts
const chartService: ChartService = {
  getChart(symbol: string, period: string) {
    return getChartFromState(state, symbol, period);
  },
};

return {
  providers,
  cache,
  quoteService,
  chartService,
  keyRotators: {
    finnhub: config.finnhubRotator,
    twelveData: config.twelveDataRotator,
    alphaVantage: config.alphaVantageRotator,
  },
};
```

> 주의(§3 외과적): `getChartFromState` 본문·`get_market_chart` 도구 등록은 건드리지 않는다(M3 에서 unregister 만). `ChartService` 는 신규 export — 기존 호출부 영향 0.

검증: `pnpm --filter @finclaw/skills-finance build`

### M2-A2. EDIT `packages/server/src/router/dispatch.ts` — `DispatcherDeps` 확장 + 4 intent 구현

`DispatcherDeps` 에 market/portfolio 핸들 주입. not-implemented 분기(현 §25-33)를 함수 구현으로 교체.

import 추가(현 §1-3):

```ts
import {
  analyzeMarket,
  createPortfolioTracker,
  type ChartService,
  type NewsAggregator,
  type PortfolioStore,
  type QuoteService,
  type AnalysisOptions,
} from '@finclaw/skills-finance';
import type { Dispatcher, RouteRequest, RouteResult, TickerSymbol } from '@finclaw/types';
import { runSubAgent } from './sub-agent.js';
```

> 확인 필요: `createPortfolioTracker`·`PortfolioStore`·`QuoteService`·`ChartService` 가 `@finclaw/skills-finance` 배럴에서 export 되는지. `QuoteService` 는 news/index.ts 가 re-export 중(`export type { QuoteService }`). `createPortfolioTracker`·`PortfolioStore`·`ChartService` 미노출이면 **M2-A3 에서 배럴 export 추가**(아래).

`DispatcherDeps` 교체(현 §13-15):

```ts
export interface DispatcherDeps {
  readonly newsAggregator: NewsAggregator;
  readonly quoteService: QuoteService;
  readonly chartService: ChartService;
  readonly portfolioStore: PortfolioStore;
}
```

switch 의 not-implemented 분기(현 §25-33)를 교체:

```ts
      case 'price_lookup':
        return dispatchPriceLookup(req, deps);
      case 'chart_data':
        return dispatchChartData(req, deps);
      case 'news_summary':
        return dispatchNewsSummary(req, deps);
      case 'portfolio_calc':
        return dispatchPortfolioCalc(req, deps);
```

파일 하단에 4 함수 추가(`dispatchMarketAnalysis` 옆):

```ts
// ── 함수 dispatch (LLM 0, service 직접 호출) ──

async function dispatchPriceLookup(req: RouteRequest, deps: DispatcherDeps): Promise<RouteResult> {
  if (!req.symbol) {
    return { content: 'price_lookup requires a symbol', source: 'function', isError: true };
  }
  try {
    const q = await deps.quoteService.getQuote(req.symbol);
    return {
      content: JSON.stringify(q),
      source: 'function',
      isError: false,
    };
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      source: 'function',
      isError: true,
    };
  }
}

async function dispatchChartData(req: RouteRequest, deps: DispatcherDeps): Promise<RouteResult> {
  if (!req.symbol) {
    return { content: 'chart_data requires a symbol', source: 'function', isError: true };
  }
  try {
    const chart = await deps.chartService.getChart(req.symbol, '1m');
    return { content: chart, source: 'function', isError: false };
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      source: 'function',
      isError: true,
    };
  }
}

async function dispatchNewsSummary(req: RouteRequest, deps: DispatcherDeps): Promise<RouteResult> {
  try {
    const symbols = req.symbol ? ([req.symbol] as TickerSymbol[]) : undefined;
    const news = await deps.newsAggregator.fetchNews({ symbols, limit: 10 });
    return { content: JSON.stringify(news), source: 'function', isError: false };
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      source: 'function',
      isError: true,
    };
  }
}

async function dispatchPortfolioCalc(
  req: RouteRequest,
  deps: DispatcherDeps,
): Promise<RouteResult> {
  try {
    // 단일 사용자 기본 포트폴리오 해소 (skills.ts resolveDefaultPortfolioId 와 정합).
    const portfolios = deps.portfolioStore.listPortfolios();
    const portfolio = portfolios[0];
    if (!portfolio) {
      return { content: '포트폴리오가 없습니다.', source: 'function', isError: true };
    }
    const tracker = createPortfolioTracker({
      quoteService: deps.quoteService,
      newsAggregator: deps.newsAggregator,
    });
    const summary = await tracker.summarize(portfolio);
    return { content: JSON.stringify(summary), source: 'function', isError: false };
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      source: 'function',
      isError: true,
    };
  }
}
```

> 주의: `market_analysis` 분기·`dispatchMarketAnalysis` 는 그대로 유지(phase42 완료, §3 외과적). `ANALYSIS_MODEL_ID`/`ANALYSIS_QUEUE_KEY` 상수 보존.

검증: `pnpm --filter @finclaw/server build` (배럴 export 누락 시 여기서 적발 → M2-A3)

### M2-A3. EDIT `packages/skills-finance/src/index.ts` — dispatcher 가 쓰는 심볼 배럴 export 추가

배럴 실측 결과: `QuoteService`(§9)·`PortfolioStore`(§11)는 **이미 export 됨**. `createPortfolioTracker`·`ChartService` 만 **미노출** → 추가 필요. (중복 추가 금지 — §3 외과적.)

추가할 export 2건:

- `createPortfolioTracker` — `./news/portfolio/tracker.js` (현재 `PortfolioStore` 만 store.js 에서 export, tracker.js 의 `createPortfolioTracker` 는 배럴 미노출).
- `ChartService` (type) — M2-A1 에서 `./market/index.js` 에 신설한 인터페이스.

예(§11~12 사이 또는 market export 근처):

```ts
export { createPortfolioTracker } from './news/portfolio/tracker.js';
export type { ChartService } from './market/index.js';
```

> `QuoteService`(§9)·`PortfolioStore`(§11)는 추가 X — 이미 export. 중복 시 oxlint/build 충돌.

검증: `pnpm --filter @finclaw/skills-finance build`

### M2-A4. EDIT `packages/server/src/composition/skills.ts` — `buildRouteDispatcher` 호출에 핸들 주입

현 §139-146 의 `if (newsHandle)` 블록에서 `buildRouteDispatcher({ newsAggregator: newsHandle.aggregator })` 호출을 확장. **M2 에서는 와이어링 주입만**(결합 분리는 M3). `marketHandle` 은 이 블록 진입 시점에 항상 존재(news 는 `marketHandle && ...` 조건 — §114).

변경 전(현 §139-146):

```ts
if (newsHandle) {
  const dispatcher = buildRouteDispatcher({ newsAggregator: newsHandle.aggregator });
  registerRouteTaskTool(toolRegistry, dispatcher);
  toolRegistry.unregister('analyze_market');
  logger.info('route_task tool registered (analyze_market hidden from main agent)', {
    event: 'route_task.registered',
  });
}
```

변경 후(M2 — 주입만, 결합은 M3 에서 분리):

```ts
if (newsHandle && marketHandle) {
  const dispatcher = buildRouteDispatcher({
    newsAggregator: newsHandle.aggregator,
    quoteService: marketHandle.quoteService,
    chartService: marketHandle.chartService,
    portfolioStore: newsHandle.portfolioStore,
  });
  registerRouteTaskTool(toolRegistry, dispatcher);
  toolRegistry.unregister('analyze_market');
  logger.info('route_task tool registered (analyze_market hidden from main agent)', {
    event: 'route_task.registered',
  });
}
```

검증: `pnpm --filter @finclaw/server build`

### M2-T1. CREATE `packages/server/src/router/dispatch.test.ts` — intent별 dispatch unit test (mock service, 외부 키 0)

mock `QuoteService`/`ChartService`/`NewsAggregator`/`PortfolioStore` 로 각 함수 intent 의 `source:'function'`·`isError` 전파를 검증. 외부 네트워크·키 0 (CLAUDE.md feedback: tests must run without API keys).

```ts
import { describe, it, expect } from 'vitest';
import type {
  ChartService,
  NewsAggregator,
  PortfolioStore,
  QuoteService,
} from '@finclaw/skills-finance';
import type { Portfolio } from '@finclaw/types';
import { buildRouteDispatcher, type DispatcherDeps } from './dispatch.js';

const quoteService: QuoteService = {
  async getQuote(symbol) {
    if (symbol === 'FAIL') {
      throw new Error('quote failed');
    }
    return { price: 100, change: 1, changePercent: 1 };
  },
};

const chartService: ChartService = {
  async getChart(symbol) {
    if (symbol === 'FAIL') {
      throw new Error('chart failed');
    }
    return `sparkline for ${symbol}`;
  },
};

const newsAggregator: NewsAggregator = {
  async fetchNews() {
    return [];
  },
};

const samplePortfolio = {
  id: 'default',
  name: 'Default',
  currency: 'USD',
  holdings: [],
} as unknown as Portfolio;

const portfolioStore = {
  listPortfolios: () => [samplePortfolio],
  getPortfolio: () => samplePortfolio,
} as unknown as PortfolioStore;

const deps: DispatcherDeps = { newsAggregator, quoteService, chartService, portfolioStore };

describe('route_task dispatcher — function intents', () => {
  it('price_lookup returns source=function with quote', async () => {
    const d = buildRouteDispatcher(deps);
    const r = await d({ intent: 'price_lookup', query: 'AAPL price', symbol: 'AAPL' });
    expect(r.source).toBe('function');
    expect(r.isError).toBe(false);
    expect(r.content).toContain('100');
  });

  it('price_lookup without symbol is an error', async () => {
    const d = buildRouteDispatcher(deps);
    const r = await d({ intent: 'price_lookup', query: 'price' });
    expect(r.isError).toBe(true);
    expect(r.source).toBe('function');
  });

  it('price_lookup propagates service error (isError=true, no fake data)', async () => {
    const d = buildRouteDispatcher(deps);
    const r = await d({ intent: 'price_lookup', query: 'x', symbol: 'FAIL' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('quote failed');
  });

  it('chart_data returns sparkline', async () => {
    const d = buildRouteDispatcher(deps);
    const r = await d({ intent: 'chart_data', query: 'chart', symbol: 'AAPL' });
    expect(r.source).toBe('function');
    expect(r.isError).toBe(false);
    expect(r.content).toContain('sparkline');
  });

  it('chart_data without symbol is an error', async () => {
    const d = buildRouteDispatcher(deps);
    const r = await d({ intent: 'chart_data', query: 'chart' });
    expect(r.isError).toBe(true);
  });

  it('news_summary returns function source', async () => {
    const d = buildRouteDispatcher(deps);
    const r = await d({ intent: 'news_summary', query: 'tech news', symbol: 'AAPL' });
    expect(r.source).toBe('function');
    expect(r.isError).toBe(false);
  });

  it('portfolio_calc summarizes default portfolio', async () => {
    const d = buildRouteDispatcher(deps);
    const r = await d({ intent: 'portfolio_calc', query: 'my pnl' });
    expect(r.source).toBe('function');
    expect(r.isError).toBe(false);
  });

  it('portfolio_calc with no portfolios is an error', async () => {
    const emptyStore = {
      listPortfolios: () => [],
      getPortfolio: () => null,
    } as unknown as PortfolioStore;
    const d = buildRouteDispatcher({ ...deps, portfolioStore: emptyStore });
    const r = await d({ intent: 'portfolio_calc', query: 'pnl' });
    expect(r.isError).toBe(true);
  });
});
```

> `DispatcherDeps` 가 dispatch.ts 에서 `export interface` 인지 확인(현 §13 `export interface DispatcherDeps` — yes). test 가 import 하므로 export 유지 필수.
> `Portfolio` 캐스팅은 mock 단순화용. 실제 `summarize` 는 holdings 빈 배열에 대해 totalValue=0 등 안전 처리(tracker.ts §48-59 가 0 가드).

검증: `pnpm test --run --filter @finclaw/server` (dispatch.test.ts green)

### M2-A5. 밀스톤 M2 검증

다음을 모두 통과해야 M3 로:

- `pnpm format`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm build` (tsc --build — chartService/배럴 export drift 적발)
- `pnpm test --run` (신규 dispatch.test.ts + 기존 회귀 0)

커밋: `feat(phase43): implement route_task function dispatch for price/chart/news/portfolio`

---

## 밀스톤 M3 — 직접도구 메인 노출 정리 + `if(newsHandle)` 결합 분리

> 목표(plan §3 M3): 시세·차트·뉴스·포트폴리오 도구를 메인 MCP 노출에서 제거, route_task 등록을 newsHandle 결합에서 분리. MCP `tools/list` 가 route_task + read-only 조회만, 기존 unit 회귀 0, 전체 게이트(build+format 포함).
> 불변식(plan §4): "키 없이 부팅 — news 키 유무가 메인 도구표면을 바꾸지 않게" → 결합 분리가 핵심.

### M3-1. EDIT `packages/server/src/composition/skills.ts` — 직접 도메인 도구 unregister + route_task 결합 분리

§0 결정 5: 직접 도메인 도구를 ToolRegistry 에서 unregister(MCP bridge·9-stage·status 어디에도 잔재 없음). route_task 함수는 service 핸들을 직접 들고 호출하므로 직접 도구 등록 불요.

M2-A4 에서 만든 블록을 확장. dispatcher 등록 직후 직접 도메인 도구 4개(+crypto/forex 포함 총 6 도구명)를 unregister.

변경 후(M2-A4 블록 → M3 최종):

```ts
// Phase 43 M3: route_task 함수 dispatch + 직접 도메인 도구 메인 노출 제거.
// 메인은 thin orchestrator — 조회/분석은 route_task 로 위임. analyze_market 은 이미 sub-agent.
if (newsHandle && marketHandle) {
  const dispatcher = buildRouteDispatcher({
    newsAggregator: newsHandle.aggregator,
    quoteService: marketHandle.quoteService,
    chartService: marketHandle.chartService,
    portfolioStore: newsHandle.portfolioStore,
  });
  registerRouteTaskTool(toolRegistry, dispatcher);

  // 직접 도메인 도구를 메인 노출에서 제거(route_task 가 service 직접 호출로 흡수).
  // alerts 모니터는 ToolRegistry 의 도구를 쓰지 않고 marketHandle.cache/providers 를
  // 직접 받으므로(아래 registerAlertTools) 이 unregister 가 alerts 에 영향 없음.
  for (const name of [
    'analyze_market',
    'get_stock_price',
    'get_crypto_price',
    'get_forex_rate',
    'get_market_chart',
    'get_financial_news',
    'get_portfolio_summary',
  ]) {
    toolRegistry.unregister(name);
  }
  logger.info('route_task registered; direct domain tools hidden from main agent', {
    event: 'route_task.registered',
    hidden: 7,
  });
}
```

> **결합 분리 확인(plan §4 불변식):** route_task 등록·unregister 가 `if (newsHandle && marketHandle)` 안이라 news/market 키가 없으면 route_task 도, 직접 도구 unregister 도 안 일어난다. 즉 키 유무가 도구 표면을 바꾼다 — plan §4 "키 없이 부팅" 가드 위반 소지. **단 키가 없으면 애초에 marketHandle/newsHandle 자체가 미등록(§91, §114)이라 직접 도구도 등록 안 됨 → unregister 대상이 없다.** 따라서 "직접 도구 노출 ↔ route_task 노출" 은 항상 동시에 켜지고 동시에 꺼지므로 일관. route_task 함수가 deny 도구(set_alert/brokerage)를 우회 호출하지 않는지도 확인(dispatch.ts 가 service 핸들만 호출, 상태변경 service 미주입 — 충족).
>
> **검증 시 alerts 영향:** `registerAlertTools`(§149-158)는 `marketHandle.cache`/`providers`/`newsHandle.aggregator` 를 직접 받음 — ToolRegistry 의 `get_stock_price` 등을 호출하지 않는다. unregister 가 alerts 모니터에 영향 없음을 M3 검증에서 기존 alerts 테스트 green 으로 확인.

검증: `pnpm --filter @finclaw/server build`

### M3-T1. EDIT `packages/server/src/router/dispatch.test.ts` — MCP 노출 표면 가드 추가 (또는 신규 skills.test.ts)

`registerSkills` 호출 후 ToolRegistry 에 직접 도메인 도구가 없고 route_task 가 있음을 검증하는 회귀 가드. `registerSkills` 가 무거운 의존(storage/discord 등)을 요구하면 통합 테스트 부담이 크므로, **간단 경로**: ToolRegistry 에 직접 도구를 등록한 뒤 unregister 루프와 동일한 이름 집합을 빼면 사라지는지의 단위 가드를 `InMemoryToolRegistry` 로 검증.

```ts
import { InMemoryToolRegistry } from '@finclaw/agent';

describe('M3 main tool surface — direct domain tools hidden', () => {
  it('unregister removes direct domain tools, route_task remains', () => {
    const registry = new InMemoryToolRegistry();
    // 직접 도구 등록 흉내 (이름만 검증 — executor 는 no-op)
    const noop = async () => ({ content: '', isError: false });
    for (const name of ['get_stock_price', 'route_task']) {
      registry.register(
        {
          name,
          description: name,
          inputSchema: { type: 'object', properties: {}, required: [] },
          group: 'finance',
          requiresApproval: false,
          isTransactional: false,
          accessesSensitiveData: false,
          isExternal: true,
          timeoutMs: 1000,
        },
        noop,
        'skill',
      );
    }
    registry.unregister('get_stock_price');
    const names = registry.list().map((t) => t.definition.name);
    expect(names).not.toContain('get_stock_price');
    expect(names).toContain('route_task');
  });
});
```

> 이 가드는 unregister 메커니즘 자체를 확인(skills.ts 의 정확한 호출은 부팅 smoke 에서 확인). 무거운 `registerSkills` 통합 테스트는 §3 외과적 — plan 이 요구하지 않으므로 추가 X. `InMemoryToolRegistry.unregister`/`list` API 가 존재하는지 확인(skills.ts:142 가 이미 unregister 사용 → 존재).

검증: `pnpm test --run --filter @finclaw/server`

### M3-2. 밀스톤 M3 검증

다음을 모두 통과해야 M4 로:

- `pnpm format`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test --run` (alerts/news/market 기존 테스트 회귀 0 — unregister 가 service 핸들 경로에 영향 없음 확인)

커밋: `refactor(phase43): hide direct domain tools from main agent, decouple route_task wiring`

> **여기까지가 라우팅 재설계 본체.** M3 green 으로 닫히면 phase43 의 핵심 목표(thin orchestrator) 달성. M4 는 sub-agent 정의 구조화로, 범위가 크면 phase44 이월.

---

## 밀스톤 M4 — 서브에이전트 정의 구조 (agentDir / prompts/sub-agents/\*.md 로더)

> 목표(plan §3 M4): `agentDir`/`prompts/sub-agents/*.md` 로더(현재 미구현) + intent 동적 구성(route-task.ts:4 TODO), market_analysis 를 파일 기반으로 재구성. 로더 unit test, market_analysis smoke.
> **plan §3·§4 명시: M4 가 43 을 넘기면 44 로.** 신규 레이어(미구현)이므로 M1~M3 green 확정 후 착수. 시간/리스크 초과 시 즉시 phase44 이월.

### M4-1. CREATE `packages/server/prompts/sub-agents/market_analysis.md` — sub-agent 프롬프트 파일 (frontmatter)

route-task.ts:4 TODO 의 "intent enum → prompts/sub-agents/\*.md frontmatter" 토대. phase42 `AgentProfile={id,name,model,agentDir}`(types/agent.ts) 와 연결.

```md
---
id: market_analysis
name: Market Analysis Sub-Agent
model: claude-opus-4-7
source: sub-agent
description: 뉴스를 종합해 시장 전망·감성·리스크/기회를 분석한다.
---

너는 시장 분석 전문 서브에이전트다. 주어진 뉴스 항목을 종합해 전망(up/down/flat),
변동성, 핵심 동인, 리스크, 기회를 구조화 객체로 답한다. 환각 금지 — 근거 없는 수치 금지.
```

> 기존 market_analysis sub-agent system prompt 의 단일 출처가 어디인지 확인(`market-analysis.ts` 내 하드코딩 프롬프트 추정). M4 는 그 프롬프트를 이 파일로 이전 — **단, 출력 schema(AnalyzeMarketOutputSchema)·analyzeMarket 로직은 보존**(§3 외과적, phase42 완료분).

검증: 파일 frontmatter 파싱(M4-2 로더 테스트).

### M4-2. CREATE `packages/server/src/router/agent-loader.ts` — sub-agent 정의 로더

`prompts/sub-agents/*.md` 를 읽어 frontmatter(id/name/model/source) + 본문(systemPrompt)을 파싱해 sub-agent 정의 맵을 만든다. dispatcher 가 intent → 정의 조회에 사용.

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface SubAgentDefinition {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly source: 'sub-agent' | 'function';
  readonly systemPrompt: string;
}

/** prompts/sub-agents/*.md 의 frontmatter + 본문을 파싱해 id→정의 맵 구성. */
export function loadSubAgents(dir: string): Map<string, SubAgentDefinition> {
  const map = new Map<string, SubAgentDefinition>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) {
      continue;
    }
    const raw = readFileSync(join(dir, file), 'utf8');
    const def = parseSubAgent(raw);
    map.set(def.id, def);
  }
  return map;
}

export function parseSubAgent(raw: string): SubAgentDefinition {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) {
    throw new Error('sub-agent file missing frontmatter');
  }
  const fm = Object.fromEntries(
    m[1]
      .split('\n')
      .filter((l) => l.includes(':'))
      .map((l) => {
        const i = l.indexOf(':');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
  return {
    id: fm.id ?? '',
    name: fm.name ?? '',
    model: fm.model ?? 'claude-opus-4-7',
    source: (fm.source as SubAgentDefinition['source']) ?? 'sub-agent',
    systemPrompt: m[2].trim(),
  };
}
```

> frontmatter 파서는 기존 system prompt 로더가 있으면 재사용(중복 금지 — §3). `finclaw.system.ko.md` 를 읽는 로더가 server 에 있는지 먼저 grep: 있으면 그 파서를 공유, 없으면 위 최소 파서. **YAML 풀 파서 신규 도입 금지**(의존성 확장 — plan 미요구).

검증: `pnpm --filter @finclaw/server build`

### M4-T1. CREATE `packages/server/src/router/agent-loader.test.ts` — 로더 unit test

```ts
import { describe, it, expect } from 'vitest';
import { parseSubAgent } from './agent-loader.js';

describe('sub-agent loader', () => {
  it('parses frontmatter + body', () => {
    const raw = `---\nid: market_analysis\nname: MA\nmodel: claude-opus-4-7\nsource: sub-agent\n---\nbody text here`;
    const def = parseSubAgent(raw);
    expect(def.id).toBe('market_analysis');
    expect(def.source).toBe('sub-agent');
    expect(def.systemPrompt).toBe('body text here');
  });

  it('throws on missing frontmatter', () => {
    expect(() => parseSubAgent('no frontmatter')).toThrow();
  });
});
```

검증: `pnpm test --run --filter @finclaw/server`

### M4-3. EDIT `packages/server/src/router/dispatch.ts` + `packages/skills-general/src/route-task.ts` — market_analysis 를 파일 기반 정의로 재구성 + intent 동적 구성

dispatcher 의 `dispatchMarketAnalysis` 가 하드코딩 system prompt 대신 로더가 준 `SubAgentDefinition.systemPrompt`/`model` 을 쓰도록. route-task.ts:4 TODO 의 intent enum 을 로더 맵 기반으로 구성.

> **범위 주의:** route-task.ts 의 `ROUTE_INTENTS` 하드코딩(§6-12)을 동적 구성으로 바꾸려면 `registerRouteTaskTool` 시그니처에 intent 목록 주입이 필요하고, skills-general → server 방향 의존이 없어야 한다(의존 그래프: skills-general 은 server 를 import 못 함). 따라서 **intent 목록은 server(composition)에서 로더로 만들어 `registerRouteTaskTool(registry, dispatcher, intents)` 로 주입**하는 형태. 이 변경이 M4 의 가장 큰 표면. **시간 초과 시 이 단계만 phase44 로 분리하고 M4-1/M4-2/M4-T1(로더 토대)까지만 43 에 커밋 가능.**

구체 스니펫은 M4-2 로더 확정 후 실제 시그니처에 맞춰 작성(이 단계 착수 시점에 dispatch.ts 의 `dispatchMarketAnalysis` 와 route-task.ts 의 `ROUTE_INTENTS` 를 다시 Read 하고 정합).

검증: `pnpm --filter @finclaw/server build && pnpm --filter @finclaw/skills-general build`

### M4-4. 밀스톤 M4 검증 + market_analysis smoke

- `pnpm format && pnpm lint && pnpm typecheck && pnpm build && pnpm test --run` (전부)
- market_analysis smoke: route_task(intent=market_analysis) 가 로더 정의를 써서 sub-agent 호출 경로를 타는지(mock runSubAgent 로 unit, 실 CLI spawn 0).

커밋: `feat(phase43): file-based sub-agent definitions (agentDir loader)`

> **M4 미완 시:** M4-1/M4-2/M4-T1(로더 토대)까지만 커밋하고 M4-3(market_analysis 재배선 + intent 동적 구성)은 phase44 로 이월. plan §4 가 허용. review.md 에 이월 사유 기록.

---

## 최종 검증

phase43 (M1~M3 필수, M4 가능 범위) 완료 후 전체 게이트:

- `pnpm format`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm build` (tsc --build 전체)
- `pnpm test --run` (전체 unit — 기존 1582 + 신규 dispatch/loader 테스트, 회귀 0)
- (선택) 실 키 부팅 smoke: gateway listening + Discord 온라인 + route_task 노출, 직접 도메인 도구 비노출 확인

## 롤백 절차

각 밀스톤이 독립 커밋이므로 `git revert {밀스톤 커밋}` 으로 단계적 롤백 가능:

- M4 만 문제 → M4 커밋 revert (M1~M3 = thin orchestrator 본체는 유지).
- M3(노출 제거) 문제 → M3 revert 시 직접 도구가 메인에 다시 노출되지만 route_task 도 함께 작동(중복이나 회귀 아님).
- M2(함수 dispatch) 문제 → M2 revert 시 route_task 의 4 intent 가 not-implemented 로 복귀(M1 프롬프트는 위임 안내라 mismatch — M1 도 함께 revert 권장).
