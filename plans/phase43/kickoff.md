# Phase 42 킥오프 — X / FinTwit 소셜 신호 통합 (cashtag 감성 + 계정 피드)

> 작성 2026-05-26 · base = main HEAD `2b1c513` (phase40 single-source jsonSchemaToZod) · 산출물: 이 kickoff + plan.md
> 상태: **초안 — 사용자 승인 대기.** plan.md 가 아래 열린 질문을 해소한다.
> **phase41 은 별도 작업(SDK 런타임 제거)용으로 예약 — 본 기능은 phase42.** (사용자 지시)

## 목표 (사용자 확정)

FinClaw 에 **X(트위터) 실데이터 기반 소셜 신호 2종**을 read-only MCP 도구로 추가한다:

- **신호① — cashtag 감성:** 보유/지정 종목의 `$TICKER` 멘션량 + 군중 감성 집계.
- **신호② — FinTwit 피드:** 사용자가 선별·신뢰하는 X 계정들의 최신 게시물.

데이터는 "무료 우선·회색지대 허용". read-only 우선·환각 방지·1인 감사 가능성 불변식은 **불변**. 소셜 신호는 사실(시세/뉴스)과 출력에서 명확히 구분되는 **여론(opinion)** 으로만 노출한다.

## 왜 지금인가 (동기)

- **phase40 의 CLI(구독) 전환으로 토큰이 자유로워졌다.** 감성 산출을 별도 OSS 감성 라이브러리(FinBERT/ONNX/정지 렉시콘) 없이 **기존 `analyze_market` LLM 위임**(`enforceStructuredOutput` + `NewsSentiment` 재사용)으로 풀 수 있다 — 무거운 의존 0개. CLI 전환 전이었다면 LLM 감성은 비용 부담이 컸다.
- **MCP 파이프라인이 이미 완성됐다.** phase40 이 `/mcp` 호스트 + `bridge.ts`(강제 deny·allowlist) + ToolRegistry 9단계(정책/가드/감사)를 깔아놨다. 소셜 도구는 그 위에 **provider seam 1개**만 새로 얹으면 기존 파이프라인(execute → guard → /mcp → CLI)을 그대로 통과한다. 통합 비용이 "데이터 수집부 신규 + 나머지 재사용".

## 범위 (한눈에)

- **IN:** `packages/skills-finance/src/social/` provider 디렉터리 신규 배선, 도구 2개(`get_cashtag_sentiment`·`get_fintwit_feed`), rettiwt-api(guest) 실 X 데이터 경로, LLM 위임 감성 + cashtag 정규식 인라인 + AFINN degrade 폴백, ApeWisdom 신호① 폴백 전용.
- **OUT:** 유료 Finnhub social-sentiment, 트렌딩 티커 발굴, 실시간 스트리밍, KR 종목 cashtag.

## 확정 사항 (이 값으로 plan 작성 — 사용자/리서치 결정)

| 항목             | 확정값                                                                                                                                                              | 근거                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 아키텍처         | **A (FinClaw 내재화)**                                                                                                                                              | 20-\*.md §3-1. B(외부 MCP 직결)=M2 우회로 탈락, C(데몬)=twscrape 폴백 시에만 |
| 신호①②의 주 소스 | **둘 다 rettiwt-api(guest) 실 X 데이터로 통일**                                                                                                                     | 20-\*.md **§7 사용자 최종 결정** (원 요청 "X에서"에 충실)                    |
| ApeWisdom        | **신호① 폴백 전용으로 강등**                                                                                                                                        | 20-\*.md §7-1 (1차 추천의 "주 소스"에서 격하)                                |
| 감성 산출        | LLM 위임(`analyze_market` 패턴) + cashtag 정규식 인라인 + 무키 AFINN(`sentiment`) degrade                                                                           | 20-\*.md §3-4 (감성 라이브러리 미사용)                                       |
| 도구 표면        | `get_cashtag_sentiment`·`get_fintwit_feed` (read-only, isExternal, `signalKind:"social_opinion"`+`disclaimer`+`source`+`sampleSize`+`verified`, 표본 0건 `dataGap`) | 00-\*.md §3                                                                  |

> **§7 결정의 파급 (plan §1·§5 가 반드시 반영):** 신호①②가 단일 fragile 의존(rettiwt)에 1차로 묶여 **가용성 분산 효과가 소멸**한다. 이로 인해 **R1(rettiwt fragile)이 "신호② 전용"에서 "기능 전체" 리스크로 승격**하고, go/no-go **G1(계정 timeline)·G2(cashtag 검색)가 둘 다 출시 가부 1순위 게이트**가 된다.

## plan.md 가 반드시 결정할 것 (감독 포인트)

### go/no-go 게이트 (코드 PoC 로만 판정 — 첫 마일스톤 스파이크)

- **G1 [GO/NO-GO] — rettiwt guest 권한이 신호②(계정 timeline)에 충분한가.** NO-GO 시 폴백 F1(user 모드 밴 위험 / twscrape 데몬 C / 신호② 보류).
- **G2 [GO/NO-GO] — rettiwt guest 가 신호①(cashtag 검색·집계)에 충분한가.** §7 통일로 **이제 치명적** — NO-GO 면 신호①의 주 경로 붕괴 → ApeWisdom 폴백으로 자동 격하(F2).
- **G3 [GO/NO-GO] — rettiwt CJS→ESM default import interop** 이 FinClaw ESM(`"type":"module"`)에서 동작하는가. 실패 시 interop shim 비용 산정.
- **G4 [확인] — rettiwt safeFetch 미경유(R2)를 제품 차원에서 수용**할지 (코드상 회피 불가 → 정책 결정).

### 정책·설계 결정 (코드 외)

- **D1 — `accessesSensitiveData` 분류.** cashtag 도구가 보유 종목을 자동 파생 시 포트폴리오 노출 → `true`? vs "심볼 명시 필수"로 회피.
- **D2 — group: `finance`(default allow) vs `mcp`(require-approval).** read-only 조회라 `finance` 권장이나 회색지대 출처라 매호출 승인도 일리.
- **D3 — 화이트리스트 저장 위치 + 캐시 TTL.** 신뢰 계정·집계 티커를 env/config/SQLite 중 어디에. 소셜 TTL 차등(window별).
- **D4 — 회색지대 수용 폭 + degrade 사용자 문구.** rettiwt 차단·ApeWisdom fair-use 시 M4 degrade 메시지.

## 스탠딩 리스크

- **레퍼런스 비대칭:** MCP 파이프라인·도구 등록은 news provider 패턴(`news/*`)에 1:1 레퍼런스가 있으나, **외부(스크래핑) ↔ 내부 경계는 `social/providers/*` 의 `fetch...()` 1개에 회색지대 리스크 100%가 집중**된다. rettiwt fragile(2026-04 #867/#862 구조변경 런타임에러)이 그 경계의 최대 미확인.
- **단일 fragile 의존:** §7 통일로 두 신호가 rettiwt 에 1차로 묶임 → 동시 1차 경로 상실 가능. graceful degrade·가용성 폴백(ApeWisdom/유저모드/twscrape)을 plan 이 명시.

## 컨벤션

- 테스트 baseline: unit **1679** / storage 154 (phase40 기준, 착수 시 재확인). mock-only 유지 — 실 키/실 X 접속 테스트 금지, 라이브 rettiwt 검증은 수동(스파이크)으로 분리.
- 각 밀스톤: typecheck + build + test + lint green, 밀스톤당 1커밋. **첫 밀스톤 = rettiwt guest go/no-go 스파이크(G1+G2 둘 다 PoC).**
- 참고 산출물: `_workspace/feature-research/x-fintwit/00-integration-contract.md`(통합 계약·불변식·통합 지점 지도), `20-comparison-and-recommendation.md`(비교·추천 + **§7 사용자 최종 결정**).
