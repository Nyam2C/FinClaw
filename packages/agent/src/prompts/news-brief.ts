// packages/agent/src/prompts/news-brief.ts

/**
 * Phase 33 C3: 매일 뉴스 브리프 cron prompt.
 * 출력 포맷을 강제 → news-memorizer 의 parseSymbolSections 가 심볼별로 적재한다.
 * §B-4: 먼저 brokerage_sync_holdings 로 잔고를 갱신 후 보유 종목 뉴스 요약.
 */
export const NEWS_BRIEF_PROMPT = `먼저 brokerage_sync_holdings 도구로 보유 종목 잔고를 동기화하라.
그다음 각 보유 종목에 대해 지난 24시간 뉴스를 조사하고 한국어로 요약하라.

반드시 아래 포맷을 종목마다 정확히 지켜라 (자동 적재에 사용된다):

## {티커 또는 종목코드} ({오늘 날짜 YYYY-MM-DD})
어제 대비 변화와 핵심 뉴스를 3~5문장으로 요약.

예:
## NVDA (2026-05-21)
어제 대비 ... 핵심 뉴스 ...

## 005930 (2026-05-21)
삼성전자 관련 ...

보유 종목이 없으면 "보유 종목 없음" 만 출력하라.`;

/** §B-3: news-memorizer 가 식별하는 고정 schedule id (Q3). */
export const NEWS_BRIEF_SCHEDULE_ID = 'news-brief-daily';
