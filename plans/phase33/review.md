# Phase 33 Review: 한투 KIS 잔고 동기화 + 뉴스 요약 메모리화 (FINAL)

> todo.md 기반 구현 코드 리뷰. 구현 완료 상태, 코드 품질, 리팩토링 사항, 알려진 제약을 기록한다. **FinClaw 의 마지막 plan** — 종료 후 1개월 사용 검증 후 유지보수 모드.

base SHA: `567c07f` (phase31+32 머지된 main) ↔ HEAD: `32b867e` (변경 LOC: 약 +1402 / -24, 7 커밋)
branch: `feature/kis-sync-news-memory`

매일 09:00 KST cron → KIS 잔고 동기화(read-only) → 보유 종목 24h 뉴스 요약 → memories 자동 적재 → 다음 대화 자동 회상. plan 인스펙션 보강으로 phase31/32 상호작용 교정(★ SDK 전용, ★ source 컬럼).

---

## 1. 구현 사항 (TODO 일치도)

집계: ✅ 36 / ⚠️ 4 / ❌ 0. ⚠️ 4건은 모두 정당한 편차/범위외 (D3 Zod inline, D4 views 경로, E3 7일운영, C2 prompt — C2 는 본 PR P0 fix 로 배선됨).

| 밀스톤                          | 단계                                                                                                            | 상태  | 비고                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 사전                            | P-1 브랜치 · P-2 의존                                                                                           | ✅    | SCHEMA_VERSION 11→12, 신규 dep 0                                                                                                                          |
| A (KIS adapter)                 | A1 types · A2 auth · A3 client · A4 holdings · A5 index · A6 test · A7 검증                                     | ✅    | TokenManager(캐시+5분마진+mutex), TokenBucket(prod5/vts20), read-only get만. **grep order\|cancel\|modify = 0**                                           |
| B (source 컬럼 + KIS-as-tool) ★ | B1 v12 · B2 recompute · B3 export · B4 migration test · B5 sync-service · B6 회귀 · B7 tool · B8 test · B9 검증 | ✅    | `source` 컬럼 + CHECK, recomputeHoldings `WHERE source='tx'`, replaceAllHoldings kis-only, `brokerage_sync_holdings` 도구. KIS row 보존 storage test 실증 |
| C (news 메모리화)               | C1 memorizer · C2 prompt · C3 main 배선 · C4 test · C5 검증                                                     | ✅    | parseSymbolSections + absorb→addMemoryWithEmbedding, metadata{kind,symbol,briefDate}. **C2 prompt/schedule 배선은 본 PR P0 fix 로 완성 (§7)**             |
| D (secret+회복+UI)              | D1 redact · D2 withRetry · D3 RPC · D4 settings · D5 docs · D6 검증                                             | ✅/⚠️ | Bearer redact, recoverable retry, `brokerage.{sync.run,health.get}` RPC(Zod inline ⚠️정당), settings-view(views/ ⚠️정당)                                  |
| E + 최종                        | E1 daily-brief integration · E2 kis-not-configured · E3 7일운영 · 최종검증                                      | ✅/⚠️ | 적재→회상 라운드트립 mock, 등록 가드. E3=⚠️범위외(plan 운영)                                                                                              |

---

## 2. 자동화 검증 결과

| 명령                       | 결과                  | 비고                                                                   |
| -------------------------- | --------------------- | ---------------------------------------------------------------------- |
| `pnpm typecheck` (tsgo)    | ✅ PASS               | 0 에러                                                                 |
| `pnpm build` (tsc --build) | ✅ PASS               | tsgo+tsc 둘 다 게이트 (phase32 교훈)                                   |
| `pnpm test`                | ✅ 1646 pass / 0 fail | 191 files                                                              |
| `pnpm test:storage`        | ✅ 151 pass / 0 fail  | 23 files, v11→v12 + KIS row 보존 + replaceAllHoldings + addSchedule id |
| `pnpm lint`                | ✅ 0 / 0              | 573 files                                                              |
| read-only guard            | ✅ 0 trade endpoints  | `grep order\|cancel\|modify` brokerage/ = 0                            |
| mock 격리                  | ✅ OK                 | API 키 unset, 실제 KIS 호출 0 (fetch mock)                             |
| live 격리                  | ✅ OK                 | KIS `*.live.test.ts` 0, `test:live` 미실행                             |
| 회귀                       | ✅ 0                  | v12 ALTER 기존 row 무영향, recomputeHoldings KIS-free DB 동일          |

---

## 3. 경계면 검증 (PASS 5/5, 불일치 0)

- **B 마이그레이션**: database v12 ↔ MIGRATIONS[12] ALTER ↔ SCHEMA_DDL `source ... CHECK(IN('tx','kis'))` (fresh+ALTER 양쪽 동일) ↔ recomputeHoldings(WHERE tx)/replaceAllHoldings(WHERE kis) 영역 분리 ↔ storage test idempotent ✅
- **KIS adapter ↔ tool ↔ service ↔ main ↔ RPC**: read-only fetchBalances ↔ fetchNormalizedHoldings ↔ BrokerageSyncService(replaceAllHoldings source='kis') ↔ `brokerage_sync_holdings` 콜백 ↔ 수동 RPC `{syncedAt,holdingsCount,marketsScanned}`/`{configured,env,kisHoldingsCount}` ↔ web 동일 ✅
- **news-memorizer**: prompt `## SYMBOL (date)` ↔ SECTION_RE ↔ addMemoryWithEmbedding(type='financial', metadata.kind) ↔ retrieval SEARCHABLE_TYPES∋financial + 임계 0.65 + 신선도 90 → 적재→회상 라운드트립 ✅
- **onRunComplete**: scheduler `{schedule,agentRunId,output,error?}` ↔ main.ts `id===NEWS_BRIEF_SCHEDULE_ID && !error` → absorb. error skip 정상 ✅
- **secret redact**: KIS Bearer 토큰은 authorization 헤더에만, log/tool content 출력 0 + FINANCIAL_REDACT_PATTERNS Bearer 방어 ✅

---

## 4. 리팩토링 사항

### P0 — 즉시 (병합 전)

**처리 완료 (본 PR `32b867e`).** ↓ §7 참조.

### P1 — 권장 (다음 단계 / 운영 중)

1. **`claude-cli/client.ts:102-116` withRetry 의 `token_expired`/`auth` invalidate 분기 dead** — `token_expired` 는 어디서도 throw 안 됨, `auth` 는 `recoverable:false` 라 재시도 가드(L106)에서 차단 → invalidate 분기 도달 불가. 단순화(분기 삭제, rate_limit/server retry 만) 또는 401→token_expired(recoverable) 분류로 실효화. **동작 버그 아님** (non-recoverable auth 즉시 throw 가 올바름).
2. **`brokerage.health.get` 휴리스틱** — `source='kis' COUNT>0` 를 동기화 신호로 사용 → 전량 매도(0종목) 시 "미동기화" 오표시, 마지막 sync 시각 미저장. plan D3 의 "최근 5회 결과/토큰 valid until" 대비 과소. 1인 MVP 수용 가능, 후속 보강.
3. **`brokerage-sync-service.ts:7` `errors:[]` 항상 빈 배열** — `fetchNormalizedHoldings` 가 Promise.all 로 한쪽 실패 시 전체 throw → 부분 동기화(KR 성공/US 실패) 미지원. errors 필드 죽은 형태 → 제거 또는 부분실패 지원.

### P2 — 선택

- `kis/holdings.ts:21` `num()` silent 0 fallback — KIS 응답 형식 변경 시 조용히 0주/평단 0 위험 (qty>0 필터로 실해 제한적).
- `news-brief.ts` 한국 종목 헤딩 — 6자리 코드는 SECTION_RE 매칭하나 `extractSymbols`(회상측)는 영문 대문자만 → KR 종목 자동 회상 누락 가능. prompt 가 코드 유도라 자기정합이나 회상측 한계.
- `kis/client.ts` `fetchBalances` 가 항상 KR+US 양쪽 endpoint 조회 (한쪽만 보유해도) — 1인 무해.
- `chatCompletion`/`extractPrompt` 등 인터페이스 계약 boilerplate — 보존.

---

## 5. 범위 밖 발견 (참고)

- SCHEMA_VERSION 12 bump 으로 인한 버전 단언 6곳 수정 (database.migration/cli-session.migration/agent-runs/transactions.storage/database.test + `b54b6ed`) + result-guard `toHaveLength(3→4)` — CLAUDE.md §3 "자기변경 유발 회귀 정리"에 부합. 숫자만 갱신, 로직 무변경. scope creep 아님.
- `recomputeHoldings` v12 변경은 KIS-free 기존 DB 에서 전 row 가 source='tx'(DEFAULT) → 동작 동일. 마이그레이션 안전성 PASS.

---

## 6. 알려진 제약 (사용자 인지)

1. **자동화 = SDK 모드 전용 (★ B-0).** CLI 모드(`provider:'claude-cli'`)는 tool_use 비활성 → KIS sync/뉴스 도구가 안 돎. news-brief seed 도 CLI 모드면 skip(경고). 자동화는 SDK(API 과금), 비용 0(CLI)는 수동 대화 전용 — 동시 활성 불가.
2. **read-only 만.** KIS 매매(주문/취소) endpoint 코드에 부재 (구조적 보장). 잔고 조회만.
3. **멀티모달/한글 종목명 회상 미지원.** 뉴스 브리프 헤딩은 영문 티커/6자리 코드, 한글명은 자동 회상 누락 가능.
4. **메모리 폭증 관리 = 신선도 감쇠만.** 90일 반감기로 자연 강등(명시적 archival 컬럼 없음). 1개월 사용 후 실측 시 archived 컬럼(v12+) 후속.

---

## 7. P0 처리 내역 (본 PR `32b867e`)

**문제 (refactor P0 / qa P1):** `onRunComplete` 의 메모리화 분기가 `schedule.id === NEWS_BRIEF_SCHEDULE_ID('news-brief-daily')` 에 의존하나, `addSchedule` 가 항상 `randomUUID()` 로 id 생성 → 그 id 의 schedule 을 만들 경로가 없어 분기가 영원히 false. **수동 생성으로도 불가**(UUID ≠ news-brief-daily). 즉 phase33 핵심 목표(매일 자동 회상)가 end-to-end 미작동. integration test 가 서비스 직접 인스턴스화로 우회해 갭을 가림.

**수정:**

- `AddScheduleInput.id?` 추가 → `addSchedule` 가 `input.id ?? randomUUID()` (storage test +1: 명시 id 사용 + idempotent).
- `main.ts`: KIS 설정 시 부팅에서 `news-brief-daily` schedule 을 idempotent seed (`NEWS_BRIEF_PROMPT`, 매일 00:00 UTC=09:00 KST, getSchedule 가드로 중복 방지).
- **SDK 모드 게이트 (B-0)**: `provider==='claude-cli'` 면 seed skip + `news_brief.seed_skipped_cli` 경고 (CLI 모드의 조용한 빈 출력 방지).

**결과:** KIS 설정 + SDK 모드에서 매일 cron → sync → 요약 → 적재 → 회상 end-to-end 가 실제로 닫힘. typecheck/build/lint/test(1646)/storage(151) 전부 green 유지.

---

## 8. 위험 신호

**P0/P1 차단 위험 없음** (P0 본 PR 처리). 빌드/타입/테스트/린트 green, read-only 구조적 보장, secret 누출 0, 회귀 0.

---

## 9. 다음 단계 후보 (운영/유지보수)

- P1-1 withRetry dead 분기 정리, P1-2 health 메타(마지막 sync 시각/토큰 valid until), P1-3 부분 동기화 errors.
- README RPC 테이블에 `brokerage.{sync.run,health.get}` 반영 (document-release).
- 1개월 사용 후: 메모리 폭증 실측 → archived 컬럼 필요성 판단, 한글 종목명 회상.
- **FinClaw 마지막 plan** — 이후 신규 phase 없이 사용 기반 유지보수.

---

## 10. 측정값

- 변경 파일 수: 신규 ~14 + 수정 ~11
- 변경 LOC: 약 +1402 / -24 (KIS adapter ~440, service/tool/memorizer ~340, 마이그레이션·테스트 ~400, P0 fix ~55)
- 새 테스트: KIS/brokerage/news-memorizer/integration 13 + storage(migration+addSchedule id) + 회귀 갱신
- 커밋: 7 (`00e4f9c` A · `87b6e27` B · `4f6f5cd` C · `59d763c` D · `7519850` E · `b54b6ed` 회귀 · `32b867e` P0 fix)
- review-draft 생성 일시: 2026-05-21

---

## 11. 권고 — 머지 가능 여부

**판정: ✅ 머지 가능**

- P0 (news-brief 미배선) **본 PR 에서 처리 완료** — 매일 자동 시나리오 end-to-end 닫힘.
- 자동화 7/7 PASS (build 포함). 경계면 5/5. read-only 구조적 보장. secret 누출 0. mock+live 격리 OK. ❌ 0. 회귀 0.
- ⚠️ 4건 정당, Q1 upsertHolding 엣지 무해 (SQLite ON CONFLICT 가 source 보존).
- 머지 후 운영 권장: §9 (withRetry 정리, health 메타, README). FinClaw 마지막 plan → 유지보수 모드 진입.
