// packages/agent/src/router/__tests__/fixtures/routing-cases.ts
// Phase 34 D: 라우터 정확도 회귀 fixture. 실 LLM 100건 실측은 live/수동 (D3 NOTE).
import type { RouterIntent } from '../../llm-router.js';

export interface RoutingCase {
  readonly message: string;
  readonly expectedIntent: RouterIntent;
  /** 도구 노출 기대 — greeting/memory/other 는 false(미전달). */
  readonly expectsTools: boolean;
}

export const ROUTING_CASES: ReadonlyArray<RoutingCase> = [
  // greeting (도구 미전달)
  { message: '안녕', expectedIntent: 'greeting', expectsTools: false },
  { message: '고마워', expectedIntent: 'greeting', expectsTools: false },
  { message: '넌 누구야', expectedIntent: 'greeting', expectsTools: false },
  { message: '잘 지냈어?', expectedIntent: 'greeting', expectsTools: false },
  // fetch (시세/가격/환율/차트 조회 → 도구 노출)
  { message: '삼성전자 얼마야?', expectedIntent: 'fetch', expectsTools: true },
  { message: '달러 환율 알려줘', expectedIntent: 'fetch', expectsTools: true },
  { message: '비트코인 가격', expectedIntent: 'fetch', expectsTools: true },
  { message: '나스닥 차트 보여줘', expectedIntent: 'fetch', expectsTools: true },
  { message: '엔화 시세', expectedIntent: 'fetch', expectsTools: true },
  // analysis (분석/판단/추천 → 모든 도구)
  { message: '삼성전자 지금 사도 될까?', expectedIntent: 'analysis', expectsTools: true },
  { message: '이 종목 분석해줘', expectedIntent: 'analysis', expectsTools: true },
  { message: '테슬라 어때?', expectedIntent: 'analysis', expectsTools: true },
  { message: '지금 시장 전망 어떻게 봐?', expectedIntent: 'analysis', expectsTools: true },
  { message: '리포트 써줘', expectedIntent: 'analysis', expectsTools: true },
  // portfolio (보유 종목·수익률 → 도구 노출)
  { message: '내 포트폴리오 수익률 어때', expectedIntent: 'portfolio', expectsTools: true },
  { message: '내 보유 종목 알려줘', expectedIntent: 'portfolio', expectsTools: true },
  { message: '내 자산 현황', expectedIntent: 'portfolio', expectsTools: true },
  // memory (과거 회상 → RAG, 도구 미전달)
  { message: '내가 전에 어떤 투자 성향이라 했지', expectedIntent: 'memory', expectsTools: false },
  { message: '예전에 관심 있다던 종목이 뭐였지', expectedIntent: 'memory', expectsTools: false },
  // other (도구 미전달)
  { message: '오늘 날씨 어때', expectedIntent: 'other', expectsTools: false },
  { message: '점심 뭐 먹지', expectedIntent: 'other', expectsTools: false },
];
