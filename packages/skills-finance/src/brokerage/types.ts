// packages/skills-finance/src/brokerage/types.ts
import type { NormalizedHolding } from './kis/types.js';

/** 벤더 중립 브로커리지 클라이언트. 구현: KisClient (Toss 는 API 발급 후 별 phase). */
export interface BrokerageClient {
  /** read-only: 정규화된 보유 종목 조회 (벤더별 raw → NormalizedHolding 변환은 구현 내부). */
  fetchHoldings(): Promise<readonly NormalizedHolding[]>;
}

/** 브로커리지 벤더 선택자 (env BROKERAGE_PROVIDER). */
export type BrokerageProvider = 'kis' | 'toss';
