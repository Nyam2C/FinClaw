# 리서치 레인 분류 + scout 평가 기준

오케스트레이터 Phase 2 에서 레인을 나눌 때, 그리고 scout 가 후보를 채점할 때 참조.

## 레인 분류 원칙

레인은 "찾는 대상의 종류" 로 나눈다 — 한 scout 가 한 레인. 너무 잘게 쪼개면(레인 6+) 조율 비용↑, 너무 뭉치면(레인 1) 병렬성 0. **3~4 레인이 기본.**

레인 분할 축:

1. **접근 방식별** — 무인증 스크래핑 / 공식·유료 API / 제3자 집계 서비스
2. **포장 형태별** — 라이브러리(직접 통합) / 기성 MCP 서버(프로토콜 통합) / 단일 엔드포인트 SaaS
3. **신호 종류별** — 사용자가 고른 정보 범위가 이질적이면 신호별로(예: cashtag 감성 vs 계정 피드)

### 이번 X/소셜 도메인 권장 레인 (4)

| 레인                   | 찾는 것                                  | 대표 검색어                                                                               |
| ---------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| L1. X 무인증 접근      | X 를 키 없이/쿠키로 읽는 라이브러리·도구 | `twscrape`, `twikit`, `snscrape`, `nitter`, "twitter scraper github maintained 2025/2026" |
| L2. 소셜 MCP 서버      | 기성 Twitter/X·소셜 MCP server           | "twitter mcp server", "x mcp server modelcontextprotocol", "social media mcp"             |
| L3. cashtag·감성 OSS   | 종목 멘션 추출·금융 감성 분석 OSS        | "cashtag sentiment github", "fintwit sentiment analysis", "stock mention nlp"             |
| L4. 제3자 FinTwit 소스 | X 우회 동등 신호 API/피드                | "stocktwits api", "fintwit data api", "social sentiment finance api free tier"            |

> "무료 우선·회색지대 허용" 선호 → L1·L3·L4 가 1순위, L2 는 "있으면 좋고" (대개 미성숙). 선호가 "합법·안정 우선" 이면 L4(공식)·X API 가 1순위.

## scout 평가 기준 (FinClaw 특화)

후보마다 아래를 점검. analyst 의 `00-integration-contract.md` §5 가 이 목록을 도메인에 맞게 구체화한다.

1. **실재·생존** — repo 실제 존재(WebFetch 확인), ★, 마지막 커밋/릴리스 날짜, 아카이브/차단 호소 이슈 여부.
2. **런타임 호환** — FinClaw 는 Node 22 ESM. `node:fetch` 로 되는가? Python 전용/별도 데몬(예: Nitter 인스턴스)이 필요하면 통합 비용↑.
3. **인증·접근** — 키리스? 쿠키/세션 필요? 계정 차단(밴) 위험? FinClaw 의 키리스 CLI 부팅 철학과 정합하는가.
4. **출력 구조화 / 감사 가능성** — 구조화 JSON 을 주는가(감사 로그·도구 반환에 적합)? 자유 텍스트만이면 파싱 부담 + 환각 표면↑.
5. **ToS·법적 리스크** — 플랫폼 ToS 위반 가능성, 차단 내성, 구조 변경 취약성(fragile). 정직하게.
6. **라이선스** — MIT/Apache 등 통합·재배포 가능? GPL/AGPL/불명이면 표기.
7. **graceful degrade** — 차단·rate limit·빈 결과 시 깨지지 않고 degrade 되는가(FinClaw 의 키 없으면 도구 skip 패턴과 동형).
8. **통합 비용(상/중/하)** — 위를 종합해 "FinClaw 에 붙이는 데 드는 일".

## 안티패턴 (scout 가 피할 것)

- 기억으로 repo 를 단정(검증 없이 "○○가 표준" 류) — 반드시 fetch.
- 스타 수만 보고 추천 — 죽은 인기 repo 다수. 신선도·생존이 우선.
- ToS 리스크 누락 — "무료" 라고 리스크를 안 적으면 안 됨.
- 레인 침범 — 비교는 synthesizer 몫.
