// packages/skills-finance/src/toss/tools.ts
// 토스증권 Open API 조회 도구 (plans/toss-openapi.md §4). 전부 읽기 전용이다 —
// TossClient 가 GET 만 보내므로, 여기에 주문·조건주문을 넣는 방법은 없다.
import type { RegisteredToolDefinition, ToolExecutor, ToolRegistry } from '@finclaw/agent';
import type { TossClient, TossQuery } from './client.js';

const MARKETS = ['KOSPI', 'KOSDAQ', 'NYSE', 'NASDAQ', 'AMEX'] as const;
const STOCK_INDEX_TTL_MS = 24 * 60 * 60_000;
/** `stocks/all` 은 초당 1회 한도다. */
const STOCK_ALL_GAP_MS = 1_100;

interface StockEntry {
  readonly symbol: string;
  readonly name: string;
  readonly market: string;
  readonly securityType: string;
}

interface Candle {
  readonly timestamp: string;
  readonly openPrice: string;
  readonly highPrice: string;
  readonly lowPrice: string;
  readonly closePrice: string;
  readonly volume: string;
}

const str = { type: 'string' } as const;
const num = { type: 'number' } as const;

export interface TossToolsOptions {
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function registerTossTools(
  registry: ToolRegistry,
  client: TossClient,
  opts: TossToolsOptions = {},
): void {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const tool = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: readonly string[],
    run: (input: Record<string, unknown>) => Promise<unknown>,
    extra: Partial<RegisteredToolDefinition> = {},
  ): void => {
    const def: RegisteredToolDefinition = {
      name,
      description,
      inputSchema: { type: 'object', properties, required: [...required] },
      group: 'finance',
      requiresApproval: false,
      isTransactional: false,
      accessesSensitiveData: false,
      isExternal: true,
      timeoutMs: 20_000,
      ...extra,
    };
    const executor: ToolExecutor = async (input) => {
      try {
        return { content: JSON.stringify(readable(await run(input))), isError: false };
      } catch (err) {
        // 실패는 모델이 읽는 결과다 — 무엇을 고치면 되는지 말해 준다.
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    };
    registry.register(def, executor);
  };

  // ── 종목 찾기: 이름·코드 → 종목코드 (모델이 코드를 지어내지 않게) ──
  let index: { readonly at: number; readonly entries: readonly StockEntry[] } | undefined;
  let loading: Promise<readonly StockEntry[]> | undefined;
  const stockIndex = (): Promise<readonly StockEntry[]> => {
    if (index && now() - index.at < STOCK_INDEX_TTL_MS) {
      return Promise.resolve(index.entries);
    }
    loading ??= (async () => {
      const entries: StockEntry[] = [];
      for (const [i, market] of MARKETS.entries()) {
        if (i > 0) {
          await sleep(STOCK_ALL_GAP_MS);
        }
        const rows = await client.get<Omit<StockEntry, 'market'>[]>('/api/v1/stocks/all', {
          market,
        });
        for (const r of rows) {
          entries.push({
            symbol: r.symbol,
            name: r.name,
            market,
            securityType: r.securityType,
          });
        }
      }
      index = { at: now(), entries };
      return entries;
    })().finally(() => {
      loading = undefined;
    });
    return loading;
  };

  tool(
    'find_stock',
    '종목 이름이나 코드로 토스증권 거래 가능 종목을 찾는다 (국내 KOSPI·KOSDAQ, 미국 NYSE·NASDAQ·AMEX). 종목코드를 모를 때 다른 도구보다 먼저 쓴다. 최대 10건. 첫 호출은 종목 목록을 받느라 몇 초 걸린다.',
    {
      query: {
        ...str,
        description: '종목명 일부(한글·영문) 또는 종목코드. 예: 삼성전자, 005930, AAPL',
      },
    },
    ['query'],
    async (input) => {
      const q = String(input.query).trim().toLowerCase();
      if (!q) {
        throw new Error('query is empty');
      }
      const entries = await stockIndex();
      const exact = entries.filter(
        (e) => e.symbol.toLowerCase() === q || e.name.toLowerCase() === q,
      );
      const partial = entries.filter(
        (e) =>
          !exact.includes(e) &&
          (e.name.toLowerCase().includes(q) || e.symbol.toLowerCase().startsWith(q)),
      );
      const matches = [...exact, ...partial].slice(0, 10);
      return { query: input.query, matches, total: exact.length + partial.length };
    },
    { timeoutMs: 30_000 },
  );

  tool(
    'get_quote',
    '종목의 현재가와 전일 대비 등락을 조회한다 (토스증권 시세). 국내는 6자리 종목코드(005930), 미국은 티커(AAPL). 한 번에 최대 20종목.',
    {
      symbols: {
        type: 'array',
        items: str,
        description: '종목코드 목록. 예: ["005930", "AAPL"]',
      },
    },
    ['symbols'],
    async (input) => {
      const symbols = symbolList(input.symbols, 20);
      const joined = symbols.join(',');
      const [prices, stocks, candles] = await Promise.all([
        client.get<
          { symbol: string; timestamp: string | null; lastPrice: string; currency: string }[]
        >('/api/v1/prices', { symbols: joined }),
        client.get<{ symbol: string; name: string; market: string }[]>('/api/v1/stocks', {
          symbols: joined,
        }),
        Promise.all(
          symbols.map((symbol) =>
            client
              .get<{ candles: Candle[] }>('/api/v1/candles', { symbol, interval: '1d', count: 2 })
              .then((r) => [symbol, r.candles] as const)
              .catch(() => [symbol, [] as Candle[]] as const),
          ),
        ),
      ]);
      const daily = new Map(candles);
      const info = new Map(stocks.map((s) => [s.symbol, s]));
      return {
        source: '토스증권 Open API',
        quotes: prices.map((p) => {
          // 최신 일봉이 현재가와 같은 날이면 전일 종가는 그 앞 봉, 아니면(장 시작 전) 최신 봉이다.
          const [latest, before] = daily.get(p.symbol) ?? [];
          const sameDay =
            latest && p.timestamp && latest.timestamp.slice(0, 10) === p.timestamp.slice(0, 10);
          const prevClose = sameDay ? before?.closePrice : latest?.closePrice;
          const change = prevClose ? Number(p.lastPrice) - Number(prevClose) : undefined;
          return {
            symbol: p.symbol,
            name: info.get(p.symbol)?.name,
            market: info.get(p.symbol)?.market,
            lastPrice: p.lastPrice,
            currency: p.currency,
            asOf: p.timestamp,
            prevClose,
            change: change === undefined ? undefined : round(change, 4),
            changeRatePct:
              change === undefined || !prevClose
                ? undefined
                : round((change / Number(prevClose)) * 100, 2),
          };
        }),
      };
    },
  );

  tool(
    'get_candles',
    '종목의 캔들(OHLCV)을 최신순으로 조회한다. interval 은 1d(일봉) 또는 1m(1분봉). count 기본 30, 최대 100.',
    {
      symbol: { ...str, description: '종목코드. 예: 005930, AAPL' },
      interval: { ...str, enum: ['1d', '1m'] },
      count: num,
    },
    ['symbol'],
    async (input) => {
      const symbol = oneSymbol(input.symbol);
      const interval = input.interval === '1m' ? '1m' : '1d';
      const count = clamp(input.count, 1, 100, 30);
      const r = await client.get<{ candles: Candle[] }>('/api/v1/candles', {
        symbol,
        interval,
        count,
      });
      return { source: '토스증권 Open API', symbol, interval, candles: r.candles };
    },
  );

  tool(
    'get_orderbook',
    '종목의 현재 호가(매도·매수 잔량)를 조회한다.',
    { symbol: { ...str, description: '종목코드. 예: 005930' } },
    ['symbol'],
    async (input) => ({
      source: '토스증권 Open API',
      symbol: oneSymbol(input.symbol),
      ...(await client.get<Record<string, unknown>>('/api/v1/orderbook', {
        symbol: oneSymbol(input.symbol),
      })),
    }),
  );

  tool(
    'get_stock_signals',
    '국내 종목의 매수 유의사항(투자경고·VI·정리매매 등)과 최근 수급(투자자별 매매동향, 공매도)을 조회한다. 미국 종목은 유의사항만 나온다.',
    { symbol: { ...str, description: '종목코드. 예: 005930' } },
    ['symbol'],
    async (input) => {
      const symbol = oneSymbol(input.symbol);
      const path = `/api/v1/stocks/${symbol}`;
      const optional = <T>(p: Promise<T>): Promise<T | string> =>
        p.catch((err: unknown) => `조회 불가: ${err instanceof Error ? err.message : String(err)}`);
      const [warnings, investorTrading, shortSelling] = await Promise.all([
        optional(client.get<unknown>(`${path}/warnings`)),
        optional(client.get<unknown>(`${path}/investor-trading`, { count: 5 })),
        optional(client.get<unknown>(`${path}/short-selling`, { count: 5 })),
      ]);
      return { source: '토스증권 Open API', symbol, warnings, investorTrading, shortSelling };
    },
  );

  tool(
    'get_market_overview',
    '시장 개황: 코스피·코스닥 지수 현재가, 원/달러 환율, 오늘의 국내·미국 장 운영 시간.',
    {},
    [],
    async () => {
      const [indices, usdKrw, calendarKr, calendarUs] = await Promise.all([
        client.get<unknown>('/api/v1/market-indicators/prices', { symbols: 'KOSPI,KOSDAQ' }),
        client.get<unknown>('/api/v1/exchange-rate', { baseCurrency: 'USD', quoteCurrency: 'KRW' }),
        client.get<{ today?: unknown }>('/api/v1/market-calendar/KR'),
        client.get<{ today?: unknown }>('/api/v1/market-calendar/US'),
      ]);
      return {
        source: '토스증권 Open API',
        indices,
        usdKrw,
        today: { KR: calendarKr.today ?? calendarKr, US: calendarUs.today ?? calendarUs },
      };
    },
  );

  tool(
    'get_rankings',
    '주식 랭킹을 조회한다. type: MARKET_TRADING_AMOUNT(거래대금)·MARKET_TRADING_VOLUME(거래량)·TOP_GAINERS(상승률)·TOP_LOSERS(하락률). market: KR 또는 US. duration: realtime·1d·1w·1mo (상승률·하락률은 realtime 불가). count 기본 10, 최대 20.',
    {
      type: {
        ...str,
        enum: ['MARKET_TRADING_AMOUNT', 'MARKET_TRADING_VOLUME', 'TOP_GAINERS', 'TOP_LOSERS'],
      },
      market: { ...str, enum: ['KR', 'US'] },
      duration: { ...str, enum: ['realtime', '1d', '1w', '1mo'] },
      count: num,
    },
    ['type', 'market'],
    async (input) => {
      const type = String(input.type);
      const moving = type === 'TOP_GAINERS' || type === 'TOP_LOSERS';
      const duration =
        typeof input.duration === 'string' ? input.duration : moving ? '1d' : 'realtime';
      const r = await client.get<{
        rankedAt: string | null;
        rankings: { symbol: string; [k: string]: unknown }[];
      }>('/api/v1/rankings', {
        type,
        marketCountry: String(input.market),
        duration,
        count: clamp(input.count, 1, 20, 10),
      });
      const names = r.rankings.length
        ? await client
            .get<{ symbol: string; name: string }[]>('/api/v1/stocks', {
              symbols: r.rankings.map((x) => x.symbol).join(','),
            })
            .catch(() => [])
        : [];
      const nameOf = new Map(names.map((n) => [n.symbol, n.name]));
      return {
        source: '토스증권 Open API',
        type,
        market: input.market,
        duration,
        rankedAt: r.rankedAt,
        rankings: r.rankings.map((x) => Object.assign({ name: nameOf.get(x.symbol) }, x)),
      };
    },
  );

  // ── 본인 계좌 (계좌 헤더 필요). 계좌번호는 어떤 결과에도 넣지 않는다. ──
  const account = { accessesSensitiveData: true } as const;

  tool(
    'get_holdings',
    '사용자 본인의 토스증권 보유 주식을 조회한다: 총 매입·평가금액·손익과 종목별 수량·평단·현재가·손익. 국내·미국 주식만 포함.',
    {},
    [],
    async () => ({
      source: '토스증권 Open API (본인 계좌)',
      ...(await client.get<Record<string, unknown>>('/api/v1/holdings', {}, { account: true })),
    }),
    account,
  );

  tool(
    'get_account_activity',
    '사용자 본인 계좌의 주문·거래 관련 정보를 조회만 한다. kind: buying_power(매수가능금액)·open_orders(대기 주문)·closed_orders(종료된 주문)·conditional_orders(진행 중 조건주문)·transactions(최근 거래내역). 주문을 내거나 고칠 수는 없다.',
    {
      kind: {
        ...str,
        enum: [
          'buying_power',
          'open_orders',
          'closed_orders',
          'conditional_orders',
          'transactions',
        ],
      },
      currency: { ...str, enum: ['KRW', 'USD'], description: 'buying_power 전용. 기본 KRW' },
    },
    ['kind'],
    async (input) => {
      const requests: Record<string, readonly [string, TossQuery]> = {
        buying_power: [
          '/api/v1/buying-power',
          { currency: input.currency === 'USD' ? 'USD' : 'KRW' },
        ],
        open_orders: ['/api/v1/orders', { status: 'OPEN', limit: 20 }],
        closed_orders: ['/api/v1/orders', { status: 'CLOSED', limit: 20 }],
        conditional_orders: ['/api/v1/conditional-orders', { status: 'OPEN', limit: 20 }],
        transactions: ['/api/v1/transactions', { limit: 20 }],
      };
      const request = requests[String(input.kind)];
      if (!request) {
        throw new Error(
          `unknown kind: ${String(input.kind)} (use ${Object.keys(requests).join(', ')})`,
        );
      }
      return {
        source: '토스증권 Open API (본인 계좌)',
        kind: input.kind,
        result: await client.get<unknown>(request[0], request[1], { account: true }),
      };
    },
    account,
  );
}

/** 종목코드 1개. 경로 조각으로도 쓰이므로 문자 집합을 제한한다. */
function oneSymbol(value: unknown): string {
  const symbol = String(value ?? '')
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9.]{1,12}$/.test(symbol)) {
    throw new Error(`invalid symbol: ${String(value)} — use find_stock to look up the code`);
  }
  return symbol;
}

function symbolList(value: unknown, max: number): string[] {
  const symbols = [...new Set((Array.isArray(value) ? value : [value]).map(oneSymbol))];
  if (symbols.length === 0 || symbols.length > max) {
    throw new Error(`pass 1 to ${max} symbols`);
  }
  return symbols;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(Math.max(n, min), max);
}

function round(n: number, digits: number): number {
  return Number(n.toFixed(digits));
}

/**
 * 결과 가드가 10~14자리 숫자를 계좌번호로 보고 지운다. 거래대금·발행주식수 같은 큰 수가 지워지지 않게
 * 정수부 10자리 이상인 숫자 문자열에 천 단위 쉼표를 넣고, 계좌번호 필드는 아예 뺀다.
 */
function readable(value: unknown): unknown {
  if (typeof value === 'string') {
    return /^-?\d{10,}(\.\d+)?$/.test(value) ? withSeparators(value) : value;
  }
  if (typeof value === 'number') {
    return Math.abs(value) >= 1e9 ? withSeparators(String(value)) : value;
  }
  if (Array.isArray(value)) {
    return value.map(readable);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'accountNo')
        .map(([key, v]) => [key, readable(v)]),
    );
  }
  return value;
}

function withSeparators(numeric: string): string {
  const [int, frac] = numeric.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac === undefined ? grouped : `${grouped}.${frac}`;
}
