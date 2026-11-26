# 토스증권 Open API 연동 (읽기 전용)

> 작성 2026-11-26 · 상태: 1단계 구현됨 (클라이언트 + 조회 도구, `feature/toss-openapi`) — 결과와 남은 일은 §8
> 사용자 결정: 금융 데이터 API 는 토스증권 Open API 를 쓴다. **읽기만** 한다.

## 1. 실측으로 확인한 것 (2026-11-26, 이 기기)

사용자가 발급한 live 키로 `GET` 만 호출해 확인했다. 계좌 응답은 값이 아니라 필드 구조만 확인했다.

| 호출                                                           | 결과                                        |
| -------------------------------------------------------------- | ------------------------------------------- |
| `POST /oauth2/token` (client credentials)                      | 200, Bearer, `expires_in` 86399 (24시간)    |
| `GET /api/v1/stocks?symbols=005930,AAPL`                       | 200, 종목명 · 시장 · 통화 · 상장 상태       |
| `GET /api/v1/prices?symbols=005930,AAPL`                       | 200, `lastPrice` · `timestamp` · `currency` |
| `GET /api/v1/candles?symbol=005930&interval=1d&count=2`        | 200, OHLCV 최신순                           |
| `GET /api/v1/orderbook?symbol=005930`                          | 200, 호가                                   |
| `GET /api/v1/exchange-rate?baseCurrency=USD&quoteCurrency=KRW` | 200, 환율 (1분 갱신)                        |
| `GET /api/v1/market-calendar/KR`                               | 200, 세션별 장 시간                         |
| `GET /api/v1/market-indicators/prices?symbols=KOSPI,KOSDAQ`    | 200, 지수 현재가                            |
| `GET /api/v1/stocks/all?market=KOSPI`                          | 200, 2,485 종목 (gzip 41KB)                 |
| `GET /api/v1/accounts`                                         | 200, 계좌 1개 (`accountSeq`)                |
| `GET /api/v1/holdings` (+ 계좌 헤더)                           | 200, 합산 평가 · 종목별 수량 · 평단 · 손익  |
| `GET /api/v1/buying-power?currency=KRW`                        | 200                                         |
| `GET /api/v1/transactions?limit=3`                             | 200, 거래내역 (커서 페이지)                 |
| `GET /api/v1/conditional-orders?status=OPEN`                   | 200, 진행 중 조건주문                       |
| `GET /api/v1/commissions`                                      | 200                                         |

문서: 색인 `https://developers.tossinvest.com/llms.txt`, 스펙 `https://openapi.tossinvest.com/openapi-docs/latest/openapi.json` (v1.2.28, 경로 40개).

## 2. 이 API 의 성질 — 설계를 정하는 사실

1. **읽기 전용 권한이 없다.** OAuth scope 가 비어 있어, 같은 토큰으로 실제 주문(`POST /api/v1/orders`)과 조건주문 등록·취소가 된다. 읽기 전용은 FinClaw 코드가 보장해야 한다.
2. **쓰기는 전부 `POST`·`DELETE`, 읽기는 전부 `GET` 이다.** 토큰 발급(`POST /oauth2/token`)만 예외.
3. **유효한 토큰은 클라이언트당 1개다.** 새로 발급하면 직전 토큰이 즉시 `401 token-revoked` 가 된다. 프로세스마다 따로 발급하면 서로를 죽인다.
4. **허용 IP 에서만 호출된다.** 다른 네트워크에서는 `403 ip-not-allowed`.
5. **한도는 그룹별 초당 횟수다** (시세 15, 차트 20, 종목 5, 계좌 1, 자산 5 …). 429 에는 `Retry-After` 가 온다.
6. 계좌 · 자산 · 주문 조회는 `X-Tossinvest-Account: <accountSeq>` 헤더가 필요하다.
7. 숫자는 전부 문자열로 온다. 가격 응답에는 전일 대비 등락이 없다 (`lastPrice` 뿐) — 등락률은 일봉 2개로 계산한다.

## 3. 결정

| #   | 결정               | 내용                                                                                                                                                                                                                                               |
| --- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | 읽기 전용을 구조로 | `TossClient` 의 공개 메서드는 `get(path, query, opts)` 하나다. 임의 메서드를 받는 `request()` 는 만들지 않는다. `POST` 는 토큰 발급 함수 안에만 있다. 테스트가 "토큰 외에 GET 아닌 요청이 나가지 않는다"와 "주문 경로 호출 수단이 없다"를 고정한다 |
| T2  | 경로 허용 목록     | `get()` 은 §4 의 조회 경로 접두사만 받는다. 목록 밖 경로는 요청을 보내지 않고 throw. 모델이 경로를 조립하는 일은 없다 (도구가 고정 경로를 쓴다)                                                                                                    |
| T3  | 토큰은 하나를 공유 | 메모리 캐시 + `~/.finclaw/toss-token.json` (0600). 만료 60초 전까지 재사용. `expired-token` · `token-revoked` 면 1회 재발급 후 재시도. 서버 재시작과 CLI 가 같은 파일을 읽어 서로 무효화하지 않는다                                                |
| T4  | 한도 대응은 최소   | 429 는 `Retry-After` 만큼 기다려 1회 재시도. 클라이언트 측 토큰 버킷은 만들지 않는다 (1인 사용 · 알림 폴링은 `prices` 다건 조회 1회)                                                                                                               |
| T5  | 대체 범위          | 미국 주식 프로바이더 3종(Finnhub · Twelve Data · Alpha Vantage)과 KIS 잔고 동기화를 지우고 토스로 바꾼다 (같은 일을 한다). 코인(CoinGecko) · 외환(Frankfurter) · 뉴스는 토스가 제공하지 않으므로 그대로 둔다                                       |
| T6  | 종목 이름 찾기     | `stocks/all` 을 시장별로 하루 1회 받아 메모리에 두고 이름 · 코드로 검색한다. 모델이 종목코드를 지어내지 않게 한다 (환각 방지)                                                                                                                      |
| T7  | 계좌 데이터 노출   | 보유 종목 · 매수가능금액 · 거래내역 · 주문 · 조건주문은 조회 도구로만 준다. 계좌번호(`accountNo`)는 도구 결과에 넣지 않는다                                                                                                                        |
| T8  | 키가 없을 때       | `TOSS_CLIENT_ID` · `TOSS_CLIENT_SECRET` 이 없으면 토스 도구를 등록하지 않고 부팅은 계속한다 (지금의 "키 없으면 건너뜀"과 같다)                                                                                                                     |

## 4. 도구 (전부 조회)

| 도구                   | 토스 경로                                                         | 비고                            |
| ---------------------- | ----------------------------------------------------------------- | ------------------------------- |
| `find_stock`           | (`stocks/all` 캐시)                                               | 이름 · 코드 검색, 상위 10건     |
| `get_quote`            | `prices` + `stocks` + `candles(1d,2)`                             | 현재가 · 전일 대비 · 통화, 다건 |
| `get_candles`          | `candles`                                                         | 1분봉 · 일봉, 최대 200          |
| `get_orderbook`        | `orderbook`                                                       |                                 |
| `get_stock_signals`    | `stocks/{symbol}/warnings` · `investor-trading` · `short-selling` | 유의사항 · 수급 (국내)          |
| `get_market_overview`  | `market-indicators/prices` · `exchange-rate` · `market-calendar`  | 지수 · 환율 · 장 운영           |
| `get_rankings`         | `rankings`                                                        | 거래대금 · 거래량 · 등락률      |
| `get_holdings`         | `holdings`                                                        | 계좌 헤더                       |
| `get_account_activity` | `buying-power` · `orders` · `conditional-orders` · `transactions` | 계좌 헤더, 조회만               |

기존 `route_task` 의 `price_lookup` · `chart_data` 는 위 직접 도구로 대체한다 (에이전트 루프 계획 `agent-core.md` 와 함께 정리).

## 5. 구현 순서

1. `packages/skills-finance/src/toss/` — `client.ts` (T1~T4), `auth.ts` (T3), `types.ts`, `stock-index.ts` (T6). 단위 테스트는 `fetch` 를 가짜로 바꿔 돌린다.
2. 도구 등록 `toss/tools.ts` + `composition/skills.ts` 배선 (T8).
3. 알림 모니터의 시세 조회와 보유 종목 동기화를 토스로 교체, 기존 프로바이더 · KIS 삭제 (T5).
4. `*.live.test.ts` 1개 — 실키로 `GET` 스모크 (수동 실행 tier).
5. README · `.env.example` 갱신.

## 6. 검증

- 단위: 경로 허용 목록 밖 호출 거부 · GET 외 메서드 부재 · 토큰 재사용 · `token-revoked` 1회 재발급 · 429 `Retry-After` · 숫자 문자열 파싱 · 계좌번호 미노출.
- 라이브(수동): §1 표의 호출이 클라이언트 코드로 다시 통과.
- 공개 레포이므로 픽스처는 합성 값만 쓴다 (실계좌 응답을 커밋하지 않는다).

## 7. 하지 않는 것

- 주문 · 조건주문 등록/정정/취소 — 코드 경로 자체를 두지 않는다.
- 웹소켓 실시간 시세 — 알림은 지금처럼 폴링. 필요해지면 별도 계획.
- 섹터 · 프로그램매매 · 신용 · 대차 조회 — 도구 수를 늘리지 않는다. 필요해지면 추가.

## 8. 구현 결과 (2026-11-26)

**된 것 (§5 의 1 · 2 · 4 · 5)**

- `toss/client.ts` — T1~T4 그대로. `get()` 하나만 공개, `/api/v1/` 아래 경로만 허용, 토큰은 메모리 + `~/.finclaw/toss-token.json`(0600) 공유, `token-revoked` 1회 재발급, 429 `Retry-After` 1회 재시도.
- `toss/tools.ts` — §4 의 도구 9개. 등록 조건은 T8 (`TOSS_CLIENT_ID` · `TOSS_CLIENT_SECRET`).
- 시스템 프롬프트의 도구 안내를 토스 도구 중심으로 바꿨다. `route_task` 는 뉴스용으로만 남는다.

**구현하며 알게 된 것**

- 레지스트리의 결과 가드가 10~14자리 숫자를 계좌번호로 보고 `[REDACTED]` 로 지운다. 거래대금 · 발행주식수가 여기에 걸려, 도구가 정수부 10자리 이상인 수에 천 단위 쉼표를 넣어 내보낸다. 계좌번호(`accountNo`) 필드는 결과에서 뺀다 (T7).
- 가격 응답에 전일 대비가 없어 일봉 2개로 계산한다. 최신 일봉이 현재가와 같은 날이면 그 앞 봉이, 아니면(장 시작 전) 최신 봉이 전일 종가다.
- 종목 목록(`stocks/all`)은 시장 5개를 초당 1회 한도에 맞춰 순서대로 받는다. 첫 `find_stock` 은 5초쯤 걸리고 그 뒤 24시간은 메모리에서 찾는다.

**실측 (이 기기, 실키, 실서버 + 맥 앱 `--smoke`)**

| 질문                                                   | 에이전트가 한 일                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| "삼성전자랑 애플 지금 얼마야? 전일 대비도"             | `get_quote` 1회 → 두 종목 현재가 · 전일 종가 · 등락률로 답                                     |
| "에코프로비엠 종목코드 찾아서 현재가, 코스피 · 환율도" | `find_stock` 과 `get_market_overview` 를 병렬로 → `get_quote` → 답                             |
| "내 보유 종목이랑 진행 중인 조건주문 확인"             | `get_holdings` 와 `get_account_activity` 를 병렬로 호출, 오류 없음 (답 내용은 확인하지 않았다) |
| "삼성전자 1주 시장가로 매수 주문 넣어줘"               | 도구를 부르지 않고 거절                                                                        |

단위 테스트 14개 (클라이언트 7 · 도구 7), 라이브 테스트 2개 통과.

**남은 일 (§5 의 3)**

- 예전 시세 프로바이더(Finnhub · Twelve Data · Alpha Vantage)와 KIS 잔고 동기화를 토스로 바꾸고 지우는 일 (T5). 가격 알림 모니터가 토스 시세를 쓰게 하려면 토스를 `MarketDataProvider` 로도 붙여야 한다.
- `route_task` · 서브에이전트 · 디스패처 삭제와 뉴스 직접 도구(`get_news`). 알림 · 뉴스 분석 코드가 디스패처 타입에 걸려 있어 이번에는 건드리지 않았다.
- Discord 로 계좌 도구를 쓰려면 `DISCORD_ALERT_USER_ID`(소유자 id)를 설정해야 한다 — 없으면 Discord 대화 자체를 받지 않는다.
