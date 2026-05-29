# Phase 41 Review — Anthropic SDK 전면 제거 + analyze_market CLI 재배선 + LLM 라우터 삭제 + KIS→Toss 추상화

> base `dea0a0d` (phase40 #75) → HEAD `6ea9ca7` (feature/phase41-sdk-removal). 커밋 5개.
> 순 변경 **+236 / −1731 LOC** (40 파일). 검토: phase-refactor-expert + phase-qa-engineer (2026-05-27).
> 결론: **전 축 green, 회귀 0, P0(머지 차단) 0건 — 머지 권고.**

---

## 1. 구현 사항 (TODO 일치도 ✅38 / ⚠️2 / ❌0)

| 밀스톤 | 커밋      | 내용                                                                                                                                                                                                  | 상태 |
| ------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| A      | `4d37328` | sentiment 죽은 feature 삭제 (sentiment.ts/test + loadSentimentPrompt + prompt-loader.test 블록 + sentiment.system.md)                                                                                 | ✅   |
| B      | `97a30b6` | analyze_market → `runAnalysis` 콜백 (기본 runCliAgent, queueKey='claude-analysis' 세션 비공유 stateless opus) + runner `queueKey?` override + skills-finance SDK dep 제거                             | ✅   |
| C      | `3e13d61` | Anthropic SDK 전면 제거 (anthropic.ts, factory anthropic-sdk 분기, sdkFallback/W2, provider enum 단일화, sdkAdapter/routerLlm/summarizer 배선, agent SDK dep) ⚠️비가역                                | ✅   |
| D      | `93689d9` | LLM 라우터 하위시스템 삭제 (llm-router.ts, execution-adapter routeToChain/routeOrFallback/keywordFallbackDecision/inferRole/routed 분기) + 정적 sonnet 기본 (`DEFAULT_FALLBACK_CHAIN=[sonnet,haiku]`) | ✅   |
| E      | `6ea9ca7` | KIS→Toss `BrokerageClient` 인터페이스 추출 + KisClient implements + sync-service 타입 완화 + `BROKERAGE_PROVIDER` 분기                                                                                | ✅   |

**⚠️ 2건 (구현자 보고 + QA 검증 — 전부 정당)**:

- B 의 `skills.ts` destructured `anthropicKey` 가 oxlint `no-unused-vars` 로 B 에서 조기 제거됨 (C11 의 일부 앞당김). 나머지(`RegisterSkillsDeps.anthropicKey` 필드 + main.ts threading)는 C 에서 처리 — 누락 없음.
- C 에서 `adapter.test.ts` 의 anthropic-sdk factory 테스트 2건이 todo(C2/C13) 누락분이었으나 enum 단일화로 컴파일 불가 → 삭제 (제거된 기능의 테스트라 정당).

**구현자 todo 이탈 4건 — refactor·qa 양측 "전부 외과적 범위 내, scope creep 0":**

1. B anthropicKey 조기제거 (oxlint unused 필연) · 2. C adapter.test 2건 추가삭제 (타입 dead 필연) · 3. C 커밋 `!` 제거 + body `BREAKING:` (lefthook conventional 절충) · 4. D5 `executeForTui` dead 변수(usedModelId/usedPricing/usedIsFallback) 정리 (execute() 의 동명 변수는 fallback 회계용으로 **보존** — 올바름).

---

## 2. 자동화 검증 결과 (실측, 전부 PASS)

| 검증                             | 결과                                           |
| -------------------------------- | ---------------------------------------------- |
| `pnpm typecheck` (tsgo --noEmit) | ✅ exit 0                                      |
| `pnpm test --run` (unit)         | ✅ **1641 pass / 0 fail / 0 skip** (191 files) |
| `pnpm test:storage`              | ✅ **154 pass / 0 fail** (23 files)            |
| `pnpm lint` (oxlint, 584 files)  | ✅ 0 warnings / 0 errors                       |
| `tsc --build`                    | ✅ exit 0                                      |

baseline 1700 → **1641** (−59). 회계: −15(A sentiment 11+loader 4) +2(B queue-override) −11(C summarize 4+cli-fallback 2+structured 2+adapter 2+providers 1) −36(D llm-router 9+routing-accuracy **23**+execution-adapter 4). plan §6 추정 1665 와의 차이는 전적으로 `routing-accuracy.test.ts` 가 data-driven 23 tests 였던 추정 오차 — **코드 이상 아님, 회귀 0**.

---

## 3. 경계면 검증 (4/4 shape 일치)

- **analyze_market 재배선**: `AnalyzeRunner` shape ↔ `index.ts` runCliAgent 기본 주입 클로저(queueKey='claude-analysis', 세션 비공유, usage 매핑) ↔ `runner.ts` `queueKey?` override — 일관.
  - **중첩 spawn 데드락 불가 — 4중 증명** (정밀 추적): ① 코드 리터럴 outer `'claude'`/`'claude:<sid>'`(adapter.ts:52→runner.ts:87) ≠ inner `'claude-analysis'`(index.ts:112 하드코딩, cliSessionId 미전달) ② `enqueueCliRun`(queue.ts:9) 은 같은 key 만 `.then` 체이닝 → 다른 key 는 즉시 독립 ③ 런타임 테스트로 same-key 데드락 재현 + different-key 독립실행 확인(임시, 삭제됨) ④ 커밋된 `queue-override.test` 가 분리 단언(mock-only). `runCliAgent` 호출처는 outer(adapter.ts:52)·inner(index.ts:107) **단 2곳**, 제3 경로 없음. 프로세스 레벨: outer claude 는 MCP tool/call 대기 중에도 큐 턴 _점유(실행 중)_ → inner 가 별도 큐에서 즉시 실행·반환 → outer 재개, wait-cycle 없음.
- **BrokerageClient(E)**: `brokerage/types.ts` 인터페이스 ↔ `KisClient implements` ↔ `brokerage-sync-service.ts` `client.fetchHoldings()` ↔ gateway `brokerage.ts` RPC(불변) — shape 일치. barrel 이 `BrokerageClient`/`BrokerageProvider` 노출.
- **SDK 제거**: `factory.ts`(claude-cli 단일) ↔ `providers.ts` ↔ `main.ts` ↔ provider enum(config.ts/zod-schema.ts claude-cli 단일) — 키 없는 부팅 경로만 잔존.
- **정적 sonnet(D)**: `DEFAULT_FALLBACK_CHAIN=[sonnet,haiku]` ↔ `execute` `effectiveChain=fallbackChain` 직결. opus 는 analyze_market inner 에서만.

**mock-only 격리**: API 키/토큰 전부 unset 에서 변경 38건 + 전체 1641 green. 라이브 CLI/네트워크 잔재 0. e2e/live 미실행(기본).

---

## 4. 리팩토링 사항 (P0:0 / P1:3 / P2:5)

심볼 고아 0건, dead 분기 0건, gateway→server 역참조 0건. **머지 차단 없음.**

**P1 재평가 (refactor 재호출) — fix-now 0건, phase41 추가 커밋 불필요:**

1. ~~runner.ts:198 stale 주석~~ → **파일 오인 정정**: 실제 위치는 `agent/src/execution/runner.ts`(phase38 `6a408b7` 작성, phase41 diff 0줄)로 phase41 이 건드린 `claude-cli/runner.ts` 와 **다른 파일**. phase41 커밋에 묶으면 §3(요청 안 한 인접 주석 개선) 위반 → **stale 주석 일괄 정리 백로그**(§7).
2. `brokerage/types.ts:2` `NormalizedHolding` 역의존 → **Toss phase defer**. import 영향 = brokerage/ 내부 5파일(type-only), server/gateway/storage 직접 명명 import 0건. KIS 단일 구현이라 실질 피해 0 — `TossClient` 구현 시 중립 위치 승격이 적절(§7).
3. ~~news/index.ts:41 주석~~ → **오탐 철회**: 주석 "role='analysis' 로 호출되어 modelRef 결정" 은 `tools.ts:174-179` `deps.router({role:'analysis'})` 가 phase41 후에도 동작하므로 **정확한 문서**. RouterHelper(살아있음)↔삭제된 LlmRouter 혼동이었음 — 손대지 않음.

**P2 — 선택 (대부분 "유지 권장")**: factory 단일-종류 간접층(호출부 호환 — 유지), `adapter.ts:30` 삭제기록 주석(유지), `tools.ts:34` `provider:'anthropic'`(ModelRef.provider 정상값 — 불변), 기타 주석 중복.

---

## 5. 범위 밖 발견 — `ANTHROPIC_API_KEY` 잔재 정밀 추적 결과

qa-engineer 가 `ANTHROPIC_API_KEY` 잔재 7개 위치를 import/호출 + `git grep dea0a0d` 로 추적. **결론: phase41 C 가 고아화한 dead = 0건. 지금 청소할 것 없음.** (refactor §초안의 "SDK 가 노출한 dead" 분류는 정정 — 실제는 intentional / base-pre-existing / 테스트 샘플.)

| 위치                                               | 분류                                   | 근거                                                                                                                         |
| -------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `agent/.../claude-cli/backends.ts:49` (`clearEnv`) | **intentional + live**                 | runner.ts:78 가 spawn 시 env 를 실제 비움 → CLI 구독 인증 강제. **SDK 제거의 핵심 동작** (dead 아님)                         |
| `claude-cli/types.ts:36` + `main.ts:91`            | intentional (타입/주석)                | 위 필드 정의 + C 가 추가한 설명 주석                                                                                         |
| `agent/src/auth/resolver.ts:34,37,50`              | base 부터 미사용                       | `resolveApiKeyForProvider` production 호출 0건 — **base `dea0a0d` 부터** (C 무관). phase41 diff 가 이 파일 미변경            |
| `server/.../security/audit.ts:66`                  | live 코드 / 의미론 stale               | `runSecurityAudit` production 배선 0건 — base 부터. ANTHROPIC 을 required 로 보는 의미론만 stale (미배선이라 실 오작동 없음) |
| `main.test.ts:20-25` · `audit.test.ts:17,80`       | live 테스트 / 키 이름 non-load-bearing | `requireEnv` 는 DISCORD 토큰 검증에 실사용. 테스트는 throw 동작만 검증, 키 이름 임의 샘플                                    |

→ **어느 것도 CLAUDE.md §3 의 "C 변경이 고아화한 것"에 해당 안 됨** → phase41 마무리 청소 대상 0. 머지 권고(통과) 유지.

---

## 6. 위험 신호 (둘 다 비차단)

- **W1 (trivial, repo 영향 0)**: `packages/agent/dist/providers/anthropic.*` + `dist/router/llm-router.*` stale 산물이 로컬에 잔존. **dist 는 gitignore + git 미추적 확인 → PR/repo 영향 없음, 순수 로컬 빌드 위생.** 정리 시 `rm -rf packages/agent/dist && tsc --build`.
- **W2 (비회귀)**: baseline 1641 vs plan 추정 1664 차이 = routing-accuracy data-driven 23 tests 추정 오차. 0 fail/0 skip.
- **W3 (P3, 데드락 검증서 잔여 — 비차단)**: ① inner 재귀(`analyze_market`→`analyze_market`)가 같은 `claude-analysis` 큐를 잡으면 _이론적_ 자기충돌 — 현재 트리거 경로 미확인이고 outer↔inner 분리와 무관, 후속 백로그. ② 매직스트링 drift — inner `'claude-analysis'`(index.ts:112) ↔ outer `'claude'`(runner.ts:90) 별도 리터럴(공유 상수 없음). 현재 일치, 상수화는 cosmetic.

---

## 7. 다음 phase 후보

- **phase42 — orchestrator-worker 에이전트 라우터** (이미 결정·기록: plan §8). `finclaw-feature-plan` 리서치부터. phase41 의 라우터 삭제가 깨끗한 바닥 + D7 queueKey override 토대 제공.
- **`runSecurityAudit` required-key 의미론 정리** (§5 #4·#6) — SDK 제거 후 ANTHROPIC 을 required 로 보는 의미론 stale. 단순 라인 삭제가 아니라 required-key 목록 재설계 + production 배선 여부 결정이 필요해 외과적 범위 밖 → 별 phase 백로그. (base 부터 미배선이라 현 오작동 없음.)
- `BrokerageClient` 추상화 정렬(P1-2) — Toss Open API 발급 시 `TossClient` 구현 + NormalizedHolding 중립 위치 승격(brokerage/ 내부 5파일 type-only import 갱신).
- stale 주석 일괄 정리 — `execution/runner.ts:198` 등 phase38~40 잔재 죽은 모드명 주석(phase41 무관, 별 청소 phase).
- news-brief CLI 모드 재설계 (phase41 D3 deferred).

---

## 운영 노트 (비가역 D1)

- SDK 전면 제거로 **CLI auth(`claude login`) 만료 시 SDK 폴백 없음** → 수동 재인증 필요.
- compaction 요약기 영구 off (historyLimit=20 + CLI 자체 컨텍스트 관리로 영향 제한적).
- 모델: 기본 sonnet, opus 는 analyze_market 전용 (구독 쿼터 관리).
