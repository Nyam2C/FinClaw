// packages/server/src/auto-reply/pipeline-context.ts
import type {
  Alert,
  ChannelCapabilities,
  MsgContext,
  NewsItem,
  Portfolio,
  Timestamp,
  TraceContext,
} from '@finclaw/types';
import type { RetrievalResult } from './stages/memory-retrieval.js';

/**
 * 파이프라인 전용 메시지 컨텍스트
 *
 * 기존 MsgContext를 상속하고, 파이프라인에서 필요한 확장 필드만 추가한다.
 */
export interface PipelineMsgContext extends MsgContext {
  // --- 정규화 결과 ---
  readonly normalizedBody: string;
  readonly mentions: readonly string[];
  readonly urls: readonly string[];

  // --- 채널 확장 ---
  readonly channelCapabilities: ChannelCapabilities;

  // --- 사용자 확장 ---
  readonly userRoles: readonly string[];
  readonly isAdmin: boolean;

  // --- AI 확장 ---
  readonly resolvedModel?: string;

  // --- 금융 도메인 컨텍스트 ---
  readonly marketSession?: MarketSession;
  readonly activeAlerts?: readonly Alert[];
  readonly portfolioSnapshot?: Portfolio | null;
  readonly watchlist?: readonly string[];
  readonly newsContext?: readonly NewsItem[];

  // --- 기억 capture (Phase 26 B) ---
  /** capture 단계가 명시적 선언을 저장했을 때 deliver 가 꼬리표 부착에 사용 */
  readonly capturedMemory?: {
    readonly memoryId: string;
    readonly type: 'fact' | 'preference';
    readonly content: string;
    readonly duplicate: boolean;
  };

  // --- 기억 retrieval (Phase 26 C) ---
  /** Context 직후 retrieval 결과. execution-adapter 가 system prompt 에 주입. */
  readonly retrievalResult?: RetrievalResult;

  // --- 관찰성 (Phase 30 A6) ---
  /** Pipeline 진입 시 active span 의 trace/spanId. execute 단계가 agent_runs 부착에 사용. */
  readonly traceContext?: TraceContext;
}

/** 시장 세션 상태 */
export interface MarketSession {
  readonly isOpen: boolean;
  readonly market: string;
  readonly nextOpenAt: Timestamp | null;
  readonly timezone: string;
}

/**
 * 금융 컨텍스트 프로바이더
 *
 * enrichContext()에서 사용하는 금융 데이터 조회 인터페이스.
 */
export interface FinanceContextProvider {
  getActiveAlerts(senderId: string, signal: AbortSignal): Promise<readonly Alert[]>;
  getPortfolio(senderId: string, signal: AbortSignal): Promise<Portfolio | null>;
  getRecentNews(signal: AbortSignal): Promise<readonly NewsItem[]>;
  getMarketSession(): MarketSession;
  getWatchlist(senderId: string): Promise<readonly string[]>;
}

/**
 * Phase 21 Milestone A용 빈 Provider.
 *
 * 금융 도메인 밖 범용 비서로 동작할 때 사용. Milestone D 이후 DB 기반
 * 실제 구현으로 교체 가능.
 */
export class StubFinanceContextProvider implements FinanceContextProvider {
  async getActiveAlerts(): Promise<readonly Alert[]> {
    return [];
  }
  async getPortfolio(): Promise<Portfolio | null> {
    return null;
  }
  async getRecentNews(): Promise<readonly NewsItem[]> {
    return [];
  }
  getMarketSession(): MarketSession {
    return {
      isOpen: false,
      market: 'NONE',
      nextOpenAt: null,
      timezone: 'Asia/Seoul',
    };
  }
  async getWatchlist(): Promise<readonly string[]> {
    return [];
  }
}

export interface EnrichContextDeps {
  readonly financeContextProvider: FinanceContextProvider;
  readonly channelCapabilities: ChannelCapabilities;
}

/**
 * MsgContext → PipelineMsgContext 확장
 *
 * 금융 데이터는 Promise.allSettled로 병렬 로딩하며, 개별 실패를 허용한다.
 */
export async function enrichContext(
  ctx: MsgContext,
  deps: EnrichContextDeps,
  signal: AbortSignal,
): Promise<PipelineMsgContext> {
  const { financeContextProvider } = deps;

  // 금융 데이터 병렬 로딩 (3초 타임아웃, 개별 실패 허용)
  const financeSignal = AbortSignal.any([signal, AbortSignal.timeout(3000)]);

  const [alertsResult, portfolioResult, newsResult, watchlistResult] = await Promise.allSettled([
    financeContextProvider.getActiveAlerts(ctx.senderId, financeSignal),
    financeContextProvider.getPortfolio(ctx.senderId, financeSignal),
    financeContextProvider.getRecentNews(financeSignal),
    financeContextProvider.getWatchlist(ctx.senderId),
  ]);

  const marketSession = financeContextProvider.getMarketSession();

  return {
    ...ctx,
    normalizedBody: ctx.body.trim().replace(/\s+/g, ' '),
    // mentions/urls: contextStage()에서 NormalizedMessage의 값으로 덮어쓰므로 여기서는 빈 배열로 초기화.
    mentions: [],
    urls: [],
    channelCapabilities: deps.channelCapabilities,
    userRoles: [],
    isAdmin: false,
    marketSession,
    activeAlerts: alertsResult.status === 'fulfilled' ? alertsResult.value : undefined,
    portfolioSnapshot: portfolioResult.status === 'fulfilled' ? portfolioResult.value : undefined,
    newsContext: newsResult.status === 'fulfilled' ? newsResult.value : undefined,
    watchlist: watchlistResult.status === 'fulfilled' ? watchlistResult.value : undefined,
  };
}
