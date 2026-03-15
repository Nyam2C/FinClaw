# Phase 17 Code Review

## 파일 구조: 15/15 파일 완성 (PASS)

---

## 발견된 이슈 (7건)

| ID  | 심각도 | 파일                                  | 내용                                                                              |
| --- | ------ | ------------------------------------- | --------------------------------------------------------------------------------- |
| I-1 | Medium | `package.json`                        | feedsmith 버전 `^2.9.0` — plan 명세는 `^3.0.0`. API 호환 확인 필요                |
| I-2 | Medium | `portfolio/tracker.ts:15`             | `_newsAggregator` 미사용 변수. DI 주입만 되고 실제 사용 없음                      |
| I-3 | Medium | `portfolio/tracker.ts:72-76`          | `summarize()`에서 `getQuote()` 이중 호출 (valuate에서 1회 + dailyChange 계산 1회) |
| I-4 | Low    | 3개 프로바이더                        | `hashUrl()` 동일 함수 3곳 중복 정의                                               |
| I-5 | Low    | `newsapi.ts`, `alpha-vantage-news.ts` | `isTransientError()` 동일 함수 2곳 중복 정의                                      |
| I-6 | Low    | `tools.ts:63`                         | `input.category as any` — `NewsCategory` 타입으로 캐스트해야 함                   |
| I-7 | Info   | `aggregator.ts:50`, `rss.ts:34`       | `publishedAt as number` 캐스트 — Timestamp 브랜드 타입이라 동작하지만 비관용적    |

---

## 리팩토링 권장사항 (3건)

| ID  | 내용                                                                                  |
| --- | ------------------------------------------------------------------------------------- |
| R-1 | `hashUrl()`, `isTransientError()`를 `news/utils.ts`로 추출 (I-4, I-5 해소)            |
| R-2 | `tracker.ts`의 `valuate()` 결과에 `quote.change`를 포함시켜 이중 호출 제거 (I-3 해소) |
| R-3 | `_newsAggregator` 제거하거나 포트폴리오 뉴스 필터링 기능 구현 시 활용 (I-2 해소)      |
