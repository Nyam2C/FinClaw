# Phase 38 Review: FinClaw Claude 전용 확정 (dead multi-provider 흔적 + dead config 제거)

> todo.md 기반 구현 코드 리뷰. 사용자 결정(2026-05-26): Claude 전용 못박기. **동작 0 변화(dead 제거)가 성공 기준.**

base SHA: `d3975d6` ↔ HEAD: `7504016` (변경 LOC: +19 / −631, lockfile 포함 / 코드만 +19 / −430, 19 파일)

커밋: `01a5b3d`(A dead OpenAI 표면+ProviderId 좁히기, +12/−559), `7504016`(B truncate de-speculate+dead finance config, +7/−72).

---

## 1. 구현 사항 (TODO 일치도)

| 밀스톤 | 내용                                                                                                     | 상태 |
| ------ | -------------------------------------------------------------------------------------------------------- | ---- |
| A      | dead `OpenAIAdapter`+export+`openai` dep+gpt 카탈로그+ProviderId 'openai'+ENV_KEY_MAP+health.test 정합   | ✅   |
| B      | `runner.ts` truncate 주석 de-speculate + dead finance config(dataProviders/newsFeeds/alertDefaults) 제거 | ✅   |

**오케스트레이터 Q1~Q4 결정 적용:**

- Q1 ✅ `openai.test.ts` 삭제, `catalog.test.ts` 모델 수 단언 수정.
- Q2 ✅ (override) `fallback.test.ts` cross-provider fixture `'openai'`→`'claude-cli'` 재작성 (캐스트 X, 유효 ProviderId).
- Q3 ✅ (해소) zod URL 테스트 삭제(dead z.url() 검증분), 배열-path 테스트 `portfolios.holdings` retarget.
- Q4 ✅ `portfolios`/Portfolio·Holding 타입·스키마 유지.

## 2. 자동화 검증 결과

| 명령                             | 결과                       | 비고                                                                                          |
| -------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                 | ✅ PASS                    | ProviderId 좁히기 ripple 전수 통과                                                            |
| `pnpm build`                     | ✅ PASS                    | -                                                                                             |
| `pnpm test --run`                | ⚠️ 1678 pass / **1 flaky** | unit 1679 (=1684 baseline −5 삭제). 1 fail = `plugins/__tests__/mcp.test.ts` **부하성 flaky** |
| `pnpm test:storage`              | ✅ 154 pass / 0 fail       | -                                                                                             |
| `pnpm lint`                      | ✅ 0 warnings              | 고아 import 0                                                                                 |
| `pnpm install --frozen-lockfile` | ✅ PASS                    | lockfile 에서 openai 트리 0                                                                   |

**flaky 판정(QA+refactor 교차):** `mcp.test.ts`(MCP e2e 서브프로세스 spawn)가 full-suite 병렬 부하 시 30s timeout. **격리 5/5 PASS**(본문 12s), milestone-B full run PASS. phase38 이 `plugins/` 0개 변경·SUT 가 변경 심볼 0개 참조 → **diff 무관 기존 flake**. 머지 차단 아님(CI flake 시 재실행).

## 3. 경계면 검증

- **ProviderId 좁히기**: `ProviderId='anthropic'|'claude-cli'`(`catalog.ts:4`). `'openai'`만 제거, `'claude-cli'` **유지**(CLI 어댑터 `claude-cli/adapter.ts:19` 무손상). `ENV_KEY_MAP` openai 엔트리만 제거, `Record<ProviderId>` 완전성 typecheck 통과. ripple = catalog/resolver/fallback.test/health.test 4곳으로 최소.
- **dead 제거 완결**: `from 'openai'` grep = 0, agent/server src `'openai'` LLM 리터럴 = 0, 카탈로그 non-Claude 0, lockfile openai 0.
- **유지 표면 무손상(과잉제거 0)**: `gateway/openai-compat/*`(test green, diff 미포함) · `storage/embeddings/*`(`EmbeddingMode='openai'` 유지, 5 pass) · dual-path(`ProviderKind` 무손상) · `provider-normalize.ts`·catalog machinery · `portfolios`/Portfolio·Holding 전부 생존.

## 4. 리팩토링 사항

### P0 — 즉시 (병합 전)

없음. (테스트 약화 0, 과잉제거 0, 경계 위반 0 — QA+refactor 교차 확인.)

### P1 — 권장

없음.

### P2 — 선택 (기록용, 조치 불요)

1. `fallback.test.ts` cross-provider describe **서사 표류**: 'openai'→'claude-cli' 재작성으로 게이트가 *벤더 경계*가 아니라 _provider-id 경계_(anthropic↔claude-cli) 검증으로 의미 미묘 변화. 게이트 로직은 provider 값 무관 동치 필터라 커버리지 등가, override 가 타입상 더 정직. (anthropic↔claude-cli 폴백 차단이 바람직한지는 별도 판단.)
2. `zod-schema.test.ts` URL 케이스 삭제 → **config 스키마 전체 `z.url()` 사용처 0**. dead 제거의 정당한 귀결이나, 추후 URL config 필드 추가 시 검증 테스트 신규 필요(인지).
3. 배열-path retarget 이 top-level → 중첩(`portfolios.main.holdings[0]`)으로 깊이 증가 — 살아있는 schema 경로라 오히려 견고. 무해.

## 5. 범위 밖 발견 (참고)

- `catalog-data.ts:5` `TODO(M6)` 주석(config.models.definitions 등록 로직) — Claude 전용 후 유효성 불명, phase38 비대상 미터치.
- `mcp.test.ts` 부하성 flaky(§2) — 기존 e2e infra 이슈, diff 무관. 격리/timeout 상향은 별도.

## 6. scope creep 의심

- 없음. 유지 목록 전수 생존, plan 비대상(execution:_/agent:run:_ 이벤트·always-NULL 컬럼·DefaultPipelineObserver·README) 미터치. 변경 19 파일 전부 밀스톤 A/B + typecheck/test 강제 ripple(Q1~Q3).

## 7. 위험 신호

- **mcp.test.ts flaky** → CI Quality Gate 에서 부하 시 red 가능. **diff 무관 기존 flake** 이므로 red 면 재실행. 본 phase 결함 아님.

## 8. 다음 phase 후보

- **gateway 패키지 추출(옵션 C) = phase39 후보**(phase38 이 Claude-only 번호를 씀 → 추출은 39). 감독 필요.
- 감사 잔여 백로그: P0-2 CLI 미등록 메서드, agent.list 드리프트, tier 발산, P2 dead code(mcp flaky infra 포함).

## 9. 측정값

- 변경 파일 수: 19 (코드 9 + 테스트 9 + lockfile 1)
- 변경 LOC: +19 / −631 (lockfile 포함). dead 제거 대량 음수 — `providers/openai.ts` 1파일이 −대부분.
- 테스트 삭제 5건(전부 dead 표면 검증분: openai.test 2, structured-output openai 1, zod URL 2), 재작성 2건(fallback claude-cli, validation 배열 retarget) — 약화 0.
- 커밋 수: 2 (밀스톤당 1)
- review 생성 일시: 2026-05-26

## 10. 권고 — 머지 가능 여부

**판정: ✅ 머지 가능**

- P0/P1 없음. 동작 0 변화(dead 제거) 성공 기준 충족 — typecheck/build/lint/storage green, ProviderId 좁히기 정확(claude-cli 유지), 유지 표면 전수 무손상.
- 테스트 삭제/재작성 5+2건 전부 정당(QA+refactor 교차: dead 표면 제거 + 유효 ProviderId 재작성, 약화 0).
- 유일 ⚠️ = mcp.test.ts 부하성 flaky(diff 무관) → CI red 시 재실행, 차단 아님.
