# Phase 42 계획 — X / FinTwit 소셜 신호 통합 (cashtag 감성 + 계정 피드)

> 작성 2026-05-26 · base = main HEAD `2b1c513` (phase40 single-source jsonSchemaToZod) · 선행: `plans/phase42/kickoff.md`
> 상태: **초안 — 사용자 승인 대기.** 승인 후 todo.md 분해 → 코드. (자동 풀사이클 금지, 코드 전 plan 승인 게이트.)
> 현재 브랜치 `phase40` — plan 은 문서 초안이라 여기 저장 OK 이나, **구현은 별도 feature 브랜치(예: `phase42`) 권장.** **phase41 은 별도 작업(SDK 런타임 제거)용 예약 — 본 기능은 phase42.**

## 0. 목표와 경계

**phase42 목표:** X 실데이터 기반 소셜 신호 2종을 read-only MCP 도구로 추가한다 — ① `get_cashtag_sentiment`(보유/지정 종목 cashtag 멘션량 + 군중 감성), ② `get_fintwit_feed`(선별 X 계정 최신 글). 둘 다 rettiwt-api(guest)를 주 소스로, 기존 ToolRegistry 9단계 + `/mcp` 파이프라인을 그대로 통과해 CLI 의 Claude 에 **여론(opinion)** 으로 노출. = "X 신호가 환각 없이·감사 가능하게 도구로 닿는다."

**경계 (명시적 비대상 — §4 OUT 상세):**

- **유료 Finnhub social-sentiment 비대상.** 무료 우선 제약 정면 충돌(현 키 403, Professional ~$49.99/mo). 결제 의향 발생 시 폴백 F6 으로만(후속).
- **트렌딩 티커 발굴 비대상.** 도구는 입력 심볼(또는 보유 종목 파생)만 집계. "지금 뜨는 종목 찾기"는 후속.
- **실시간 스트리밍 비대상.** 호출 시점 폴링 + SQLite 캐시 TTL. WS push/stream 은 후속.
- **KR 종목 cashtag 비대상.** X cashtag 관행은 US 티커 중심. KR(KIS) 종목 cashtag 매핑은 후속.

## 1. ★ 확정된 아키텍처 — A: FinClaw 내재화 (provider 내부도 자체코드 A, 데몬 C 회피)

claude CLI 가 phase40 의 in-process `/mcp` 호스트에 붙은 채로, FinClaw 가 **자기 프로세스 안에서** rettiwt-api(guest)를 라이브러리로 호출해 X 데이터를 받아 구조화한다. 별도 데몬도, IPC 도, 새 MCP 서버도 없다 — provider seam 1개만 신규.

```
[외부 X]  rettiwt-api(guest)  ── 주 경로 (양 신호) ─────────────┐
          ApeWisdom REST      ── 신호① 폴백 전용 (safeFetchJson) ┤
                                                                 ▼
[Provider 계층 — 신규]  packages/skills-finance/src/social/providers/*.ts
   · NewsProvider 동형 인터페이스 (isAvailable/fetch...) — news/types.ts:31-34 패턴
   · rettiwt: 같은 node 프로세스 내 lib 호출, throw 래핑, source:"rettiwt" 기록
   · apewisdom: safeFetchJson (infra/fetch.ts:46) 직결
   · ★ 회색지대 리스크 100% 가 이 fetch...() 메서드 경계에 격리됨
                                                                 ▼
[집계 — 신규 social/aggregator.ts]  Promise.allSettled (news/aggregator.ts:39-48 패턴)
   · graceful degrade(M4) + SQLite 캐시 getCachedData/setCachedData + window별 TTL
                                                                 ▼
[감성 산출]  cashtag 정규식 인라인(추출=결정론) + analyze_market LLM 위임(score/label)
   · NewsSentiment(types/finance.ts:113) 를 outputSchema 재사용 → M3 자동
   · 무키 환경: AFINN(sentiment, MIT) degrade 폴백(confidence↓) 또는 sentiment 생략
                                                                 ▼
[도구 등록 — 신규 social/tools.ts]  registry.register(def, executor, 'skill')
   · RegisteredToolDefinition: group:'finance', isTransactional:false,
     isExternal:true, timeoutMs:20000 (registry.ts:38-57)
   · 배선: packages/server/src/composition/skills.ts (news 와 같은 위치, skills.ts:119-143 패턴)
                                                                 ▼
[ToolRegistry.execute — 기존 9단계]  registry.ts:229-410
   ① Zod 입력검증 ② 정책 9-stage ③ 루프감지+circuit breaker ④ before훅
   ⑤ 타임아웃 ⑥ executor(isExternal→circuit breaker) ⑦ after훅 ⑧ 이력 ⑨ result-guard
                                                                 ▼
[/mcp 노출]  gateway/src/mcp/bridge.ts:46-81 → host.ts:24-90 (Bearer, stateful)
                                                                 ▼
[Claude CLI]  providers/claude-cli/runner.ts:54-67 (--mcp-config http+Bearer, allowedTools mcp__finclaw__*)
                                                                 ▼
[LLM]  tool_use mcp__finclaw__get_cashtag_sentiment → tool_result(구조화 JSON, signalKind:"social_opinion") → 답변
```

**왜 A 인가 (조사 근거):**

- **B(외부 X-MCP 직결) = 기각.** 외부 MCP 도구는 `toolRegistry.execute` 9단계를 **우회** → M2 정면 위반(`plans/phase40/plan.md:38`, `00-*.md §4`). result-guard·정책·감사 부재. FinClaw 핵심가치 붕괴. analyst 가 이미 탈락 확정.
- **C(OSS 데몬+IPC) = 정상 경로에서 회피.** §7 통일 후 주 소스 rettiwt-api 가 **순수 Node TS 라이브러리**(같은 프로세스 내 호출, subprocess 0)이고 ApeWisdom 은 `safeFetchJson` 직결. C 가 필요한 후보(twscrape·twikit·FinBERT)는 전부 폴백/탈락이므로 데몬 수명·node 절대경로·데몬死 degrade(phase40 kickoff §30 류)를 떠안지 않는다. **C 는 twscrape 폴백(F1-b) 발동 시에만 등장하는 격리 시나리오.**
- **provider seam = 단일 소스.** 외부(스크래핑) ↔ 내부 경계가 `social/providers/*` 의 `fetch...()` 1개 → 회색지대 리스크를 1파일에 격리. 그 안쪽은 전부 기존 news 파이프라인 재사용(M2~M6 기존 코드로 충족).
- **감성 OSS 미사용.** CLI 토큰 자유로 `analyze_market` LLM 위임(`enforceStructuredOutput` + opus minModel)으로 방향감성 산출 → 무거운 Python/ONNX 의존 0개(`20-*.md §3-4`).

**검증된 전제 (조사 완료):**

- provider/aggregator/tools/skills-배선 4-레이어 복제처가 news 에 존재(`news/types.ts:31`·`news/aggregator.ts:39`·`news/tools.ts:154`·`skills.ts:119`). `social/` 디렉터리는 **현재 미존재 → 신규 배선 확정**(당일 `ls` 확인).
- `NewsSentiment {score,label,confidence}` = `packages/types/src/finance.ts:113`. `outputSchema`+`enforceStructuredOutput` 패턴 = `news/tools.ts:148-155`(`analyze_market`).
- `safeFetchJson` = `infra/src/fetch.ts:46`(SSRF/타임아웃/redirect:error). ApeWisdom 은 이걸로 래핑.
- rettiwt 엔진 = Node^22.21, FinClaw node>=22 ESM(`package.json:6,39`)과 정합. MIT(repo)/ISC(npm) 둘 다 permissive.
- 강제 deny(`bridge.ts:13-20`)·`analyze_market` 무키 skip 게이트(`news/index.ts:103`)·MCP `mcp:*` require-approval 정책(`skills.ts:246-249`) 전부 그대로 활용 가능.

**검증된 전제 vs 유일하지 않은 미확인 (★ go/no-go — 첫 마일스톤 스파이크):** phase40(단일 미확인)과 달리 **본 phase 는 외부 fragile 의존이라 미확인이 G1~G4 로 다수**다. 은폐하지 않고 첫 마일스톤에서 전부 실증한다.

| 게이트 | 미확인                                                              | NO-GO 시                                                                                       |
| ------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **G1** | rettiwt guest 가 **계정 timeline(신호②)** 에 충분한가               | 폴백 F1: (a) user 모드(밴 위험) / (b) twscrape 데몬 C / (c) 신호② 보류                         |
| **G2** | rettiwt guest 가 **cashtag 검색·집계(신호①)** 에 충분한가           | **§7 통일로 치명적** → ApeWisdom+LLM 폴백(F2)으로 신호① 자동 격하                              |
| **G3** | rettiwt **CJS→ESM default import interop** 이 FinClaw ESM 에서 동작 | interop shim(~수 줄) 추가, 비용 산정                                                           |
| **G4** | rettiwt **safeFetch 미경유(R2)** 제품 수용 여부                     | 코드상 회피 불가 → 파이프라인 레벨 방어(timeout+circuit breaker+isExternal)로 수용 판정 (정책) |

### 1-1. 레퍼런스 충실도

- **MCP 노출 + 파이프라인 통과 + 도구 등록부**: phase40 의 `bridge.ts`·`host.ts`·news provider 등록(`news/index.ts:100`)에 1:1 레퍼런스 — 그대로 복제.
- **외부 수집부(rettiwt guest 호출)**: FinClaw 내 레퍼런스 없음 = 신규. rettiwt-api npm 을 통째 의존(단일 유지되는 JS guest 경로). rettiwt 사망 시(F3)는 `agent-twitter-client` 포크의 **"쿠키+GraphQL 호출 방식만 참고"**(deprecated 엔진 의존 금지, `20-*.md §3-5`).

## 2. kickoff "plan 이 반드시 결정할 것" 8개 — 해소

### go/no-go (코드 PoC = 마일스톤 A) — 결정은 스파이크 결과에 위임, 폴백 분기 확정

| #   | 항목                          | 결정 / 폴백 분기                                                                                                                                                                                                                                                 |
| --- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | rettiwt guest → 계정 timeline | **마일스톤 A 스파이크로 판정.** GO → 신호② rettiwt guest 확정. NO-GO → F1 분기(plan §5 R1, 사용자에 user모드/twscrape/보류 택1 재확인).                                                                                                                          |
| G2  | rettiwt guest → cashtag 검색  | **마일스톤 A 스파이크로 판정.** GO → 신호① 주 경로 rettiwt. NO-GO → 신호① **ApeWisdom 폴백(F2)** 으로 자동 격하(topPosts:[] degrade). 기능 전체는 생존.                                                                                                          |
| G3  | rettiwt ESM interop           | **마일스톤 A 에서 `import` 1줄 실증.** 실패 시 `createRequire`/dynamic import shim(~3줄).                                                                                                                                                                        |
| G4  | safeFetch 미경유 수용         | **수용.** rettiwt 자체 HTTP 스택 + x.com 도메인 하드코딩이라 SSRF 표면 낮음. 파이프라인 방어(timeoutMs+circuit breaker `registry.ts:354`+isExternal)로 보완. plan §5 R2 에 **정직히 "구조적 한계"로 명시**(우회 아님). ApeWisdom 은 `safeFetchJson` 경유라 무관. |

### 정책·설계 (코드 외) — plan 확정

| #   | 항목                         | 결정                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `accessesSensitiveData`      | **기본 = "심볼 명시 권장"**, 보유 종목 자동 파생을 **허용하되 그 경로일 때 `accessesSensitiveData:true`**. finance-safety 가 경고 로그만 남기므로(`policy.ts:206`) 차단 아님. 보수적으로 true 두면 감사 추적에 포트폴리오 접근 기록. (구현 단순화 위해 도구 정의는 `accessesSensitiveData:false` 로 두되, 보유 종목 파생 시 audit note 첨부도 대안 — 마일스톤 C 에서 최종.) |
| D2  | group                        | **`finance`(default allow).** read-only 조회 + UX(매호출 승인 회피). 단 회색지대 출처 방어는 **출력 라벨(M7)·핸들 화이트리스트(MN2)·강제 deny(bridge)** 로 충분. `mcp` 그룹은 매호출 require-approval(`skills.ts:246-249`)이라 조회 UX 파괴 → 비채택.                                                                                                                       |
| D3  | 화이트리스트 + TTL           | **선언적 config**(`config.example.json5`)에 신뢰 핸들·집계 티커 배열(1인 감사 가능성). 키/시크릿 아님이므로 env 아닌 config 적합. **캐시 TTL**: window별 차등 — `1h`=2분, `24h`=10분, `7d`=30분(news 5분보다 보수적, ApeWisdom fair-use 보호 R4).                                                                                                                           |
| D4  | 회색지대 수용 + degrade 문구 | **수용**(사용자 "회색지대 허용"). 차단/표본0 시 `dataGap:true` + degrade 메시지(예: "X 데이터 일시 미가용 — 캐시 또는 폴백 사용"). rettiwt 死 → 신호① ApeWisdom, 신호② 폴백 F1.                                                                                                                                                                                             |

> 해소 출처: G1~G4 = `20-*.md §6`, D1~D4 = `00-*.md §6` + `20-*.md §6`. 아키텍처(A)·감성(LLM 위임)은 `20-*.md §3-1/§3-4` 에서 이미 확정(kickoff 확정표).

## 3. 마일스톤 (각 = typecheck + build + test --run + test:storage + lint green, 1커밋)

### A. rettiwt guest go/no-go 스파이크 (G1+G2+G3 둘 다 PoC) — **게이트**

- rettiwt-api(guest)를 의존 추가 + 격리된 스파이크 스크립트로 **수동 검증**: (1) **G1 — 단일 FinTwit 핸들 timeline 취득**, (2) **G2 — cashtag(`$TSLA` 등) 검색·집계**, (3) **G3 — `import Rettiwt from 'rettiwt-api'` ESM interop** 동작.
- **게이트 판정:** G1 NO-GO → 신호② F1 분기(사용자 재확인). G2 NO-GO → 신호① ApeWisdom 폴백 확정(plan §1·§5 갱신). G3 실패 → interop shim.
- 건드릴 패키지: `packages/skills-finance/package.json`(의존 추가), `_workspace/`(스파이크 스크립트 — 커밋 제외). 라이브 X 접속은 **수동 검증으로 분리**(실 X 테스트 금지, MN4).
- **검증:** 스파이크 수동 실행 1회 성공 로그 + go/no-go 결과를 plan §1 표에 기록(green 커밋은 의존 추가 + 빈 social 디렉터리 scaffold).

### B. social provider 계층 + 집계 (rettiwt + ApeWisdom 폴백)

- 신규 `packages/skills-finance/src/social/providers/rettiwt.ts`·`apewisdom.ts`: NewsProvider 동형 인터페이스(`news/types.ts:31-34`). rettiwt provider 가 lib 호출을 **throw 래핑**(graceful degrade M4) + `source:"rettiwt"` 기록. ApeWisdom 은 `safeFetchJson`(`infra/fetch.ts:46`) 경유 + `source:"apewisdom(reddit+4chan)"` 정직 라벨(M7).
- 신규 `social/aggregator.ts`: `Promise.allSettled` fan-out(`news/aggregator.ts:39-48` 패턴) + SQLite 캐시(window별 TTL, D3) + 부분 실패 흡수.
- 건드릴 패키지: `packages/skills-finance/src/social/*`(신규), `packages/infra`(safeFetch 재사용 — 변경 없음).
- **검증:** **mock fetch**(MN4)로 provider 정상/throw/부분실패 + aggregator allSettled degrade + 캐시 TTL 단위 테스트.

### C. 도구 2개 등록 + 감성 산출 + 환각 경계

- 신규 `social/tools.ts`: `get_cashtag_sentiment`·`get_fintwit_feed` 의 `RegisteredToolDefinition`(group:'finance', isTransactional:false, isExternal:true, timeoutMs:20000 — `registry.ts:38-57`). 반환 = `JSON.stringify` 구조화(M3) + `signalKind:"social_opinion"`+`disclaimer`+`source`+`sampleSize`+`verified`.
- **cashtag 추출**: 정규식 인라인(결정론, `mentionCount`/`sampleSize` 는 실 표본 산출 — MN5). **방향 감성**: `analyze_market` 패턴 LLM 위임 — `NewsSentiment`(`types/finance.ts:113`)를 `outputSchema`+`enforceStructuredOutput`(`news/tools.ts:148-155`)로. 무키 환경 → AFINN(`sentiment`) degrade(confidence↓) 또는 sentiment 생략.
- **환각 경계**: 표본 0건 → LLM 호출 skip + `dataGap:true` + sentiment 생략(`news/tools.ts:167` 패턴, MN5). 신호② **핸들 화이트리스트 강제** — 입력 핸들 ∩ config 화이트리스트만, 나머지 `deniedHandles`(MN2). cashtag 도구 보유 종목 파생 시 D1 분류 적용.
- 건드릴 패키지: `packages/skills-finance/src/social/tools.ts`(신규), `packages/types`(필요 시 social 결과 타입 — NewsSentiment 재사용 우선).
- **검증:** mock registry → 도구 정의 검증 + 표본0 dataGap + 화이트리스트 거부 + LLM 감성 mock(실 LLM 금지) + 무키 AFINN degrade 단위 테스트.

### D. composition 배선 + config + 키/소스 게이트

- `packages/server/src/composition/skills.ts`: news 와 같은 위치(`skills.ts:119-143` 패턴)에서 social 도구 등록. **소스 미가용 시 등록 skip + 로그**(M4) — rettiwt 의존만 있으면 신호 활성, anthropicKey 없으면 감성 LLM degrade(AFINN). ApeWisdom 은 키리스라 항상 폴백 가용.
- `config.example.json5`: 신뢰 핸들·집계 티커·TTL config 추가(D3).
- bridge 검토: 새 도구는 read-only 라 `DEFAULT_MCP_TOOL_DENY`(`bridge.ts:13`) 대상 아님 + group='finance' allowlist 통과 확인(별도 deny 불필요).
- 건드릴 패키지: `packages/server/src/composition/skills.ts`, `config.example.json5`, `packages/gateway`(bridge 노출 확인 — 변경 최소).
- **검증:** 소스 가용/미가용 부팅 composition 단위 테스트 + config 파싱 + MCP 노출 목록에 social 도구 포함(mock) 단위 테스트.

### E. 관찰성·문서·정리 (필수분만)

- `/mcp` 핸들러 경유 호출별 audit/observer 이벤트가 social 도구에도 자동 emit 확인(in-process 무료 — phase40 인프라).
- 문서: README(도구 표면·여론 라벨·회색지대 리스크 명시) + CLAUDE.md(있으면) + 본 phase 노트 갱신.
- **검증:** social 도구 audit 이벤트 emit 단위 테스트 + 전체 회귀(unit ≥ baseline, storage 회귀 0).

## 4. 스코프 IN / OUT

**IN:** `social/` provider 디렉터리(rettiwt + ApeWisdom 폴백), 집계+window별 캐시 TTL, 도구 2개(`get_cashtag_sentiment`·`get_fintwit_feed`), LLM 위임 감성 + cashtag 정규식 인라인 + AFINN degrade, 핸들 화이트리스트, `signalKind`/`disclaimer`/`source`/`sampleSize`/`verified`/`dataGap` 출력 규약(M7/MN5), composition 배선·config·소스 게이트, 호출별 관찰성.

**OUT (phase43+):** 유료 Finnhub social-sentiment(폴백 F6), 트렌딩 티커 발굴, 실시간 스트리밍(WS push), KR 종목 cashtag, twscrape 데몬 C(폴백 F1-b 발동 시에만), rettiwt user 모드(F1-a 발동 시에만), 자체 fetch GraphQL provider(F3 발동 시에만).

## 5. 리스크

- **#1 (go/no-go) R1 — rettiwt fragile [기능 전체로 승격].** §7 통일로 신호①② 둘 다 rettiwt 단일 의존에 1차로 묶임 → 2026-04 #867/#862 류 X 구조변경 재발 시 **두 신호 동시 1차 경로 상실.** 완화: provider throw → `Promise.allSettled`(`aggregator.ts:39`) 흡수 + circuit breaker(`registry.ts:354`, isExternal) + timeout(`registry.ts:338`). **가용성 폴백**: 신호① → ApeWisdom+LLM(F2), 신호② → F1(user모드/twscrape/보류). rettiwt 버전 핀 + 업스트림 이슈 모니터. 사망 시 F3(자체 fetch). **되돌리기:** 소스 미가용이면 도구 등록 skip(M4) — 기능 OFF 일 뿐 부팅·타 도구 정상.
- **R2 — rettiwt safeFetch 미경유 (M5 부분, G4).** rettiwt 자체 HTTP 스택 → `safeFetch`로 못 감쌈. **구조적 한계로 정직 명시(우회 아님).** 완화: x.com 도메인 하드코딩이라 SSRF 표면 낮음 + 파이프라인 방어(timeoutMs+circuit breaker+isExternal). ApeWisdom 은 `safeFetchJson` 경유라 무관.
- **R3 — ToS/차단 [§7 로 노출 상승].** 신호①도 X 직접 스크래핑이 되어 ToS 표면 확대(ApeWisdom 안전판 소멸). 완화: guest 모드 = 계정 밴 위험 ≈ 0. user 모드 전환 시(F1-a)에만 밴 위험 상승. 사용자 "회색지대 허용" 정합.
- **R4 — ApeWisdom fair-use (폴백).** rate-limit 미게시 → 공격적 폴링 금지. SQLite 캐시 + window별 TTL(D3, news 보다 보수적) 호출 최소화. 도메인 하드코딩(MN2).
- **R5 — 라이선스.** rettiwt MIT(repo)/ISC(npm) 둘 다 permissive → 무해, plan 확인만. twitter-text 회피(정규식 인라인). sentimind 금지(스쿼팅 의심).
- **R6 — 공급망.** agent-twitter-client 의존 금지(deprecated)·**호출 방식만 참고**. rettiwt 는 활발 유지·npm 정식이라 의존 허용. 신규 의존 최소(인라인 정규식 + LLM 위임, AFINN 은 폴백만).
- **#2 (환각) R7 — 소셜을 "사실"로 오신뢰 (M7).** 완화: **모든 반환에 `signalKind:"social_opinion"` + `disclaimer` 강제**. 도구 description 첫 문장 "검증된 사실 아닌 소셜 여론". `sampleSize`/`verified`/`source` 노출로 감사(M3): "근거 X글 N건·미인증·rettiwt" 추적. 뉴스/시세엔 이 필드 없어 LLM·사용자 즉시 구분. **되돌리기:** 라벨은 출력 규약이라 회귀 없음.
- **R8 — 표본 0건 환각 (MN5).** 표본 0/차단 시 sentiment·mentionCount 생성 금지 → `dataGap:true` + sentiment 생략(`news/tools.ts:167` 패턴).
- **R9 — 자동 매매/기억 트리거 (MN1/MN3).** 도구 `isTransactional:false`, FS/DB 쓰기 없음, 알림 생성 없음, X 글 자동 기억추출 없음(명시 선언 시만). `bridge.ts:13-20` deny 가 mutating 최후 차단.

## 6. 컨벤션

- 테스트 baseline: unit **1679** / storage **154** (phase40 기준 — **착수 시 `pnpm test --run` / `pnpm test:storage` 로 재확인**, 신규 테스트로 증가 OK, 회귀 금지).
- **mock-only 유지** — 실 키·실 X 접속 테스트 금지(MN4). 라이브 rettiwt 검증은 마일스톤 A 수동 스파이크로 분리. LLM 감성은 mock(실 LLM 금지).
- 각 밀스톤: typecheck + build + `test --run` + `test:storage` + lint green, **밀스톤당 1커밋.**
- **외과적 변경 (CLAUDE.md §3):** kickoff/plan 이 요구하지 않은 인접 코드 비건드림. social 은 신규 디렉터리라 기존 코드 변경은 composition 배선(`skills.ts`)·config·의존 추가로 최소.
- 참고 산출물: `_workspace/feature-research/x-fintwit/00-integration-contract.md`(불변식 M1~M7/MN1~MN5·통합 지점 지도·도구 표면·scout 기준), `20-comparison-and-recommendation.md`(비교·추천 + **§7 사용자 최종 결정 우선**).
