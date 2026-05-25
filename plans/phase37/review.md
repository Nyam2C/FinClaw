# Phase 37 Review: 감사 후속 — chat auth 강등 + 싼 P1 정리 (config 스키마 · FTS 임계 · 클라 드리프트)

> todo.md 기반 구현 코드 리뷰. 2026-05-25 전체 코드베이스 감사가 찾은 검증된 P0/P1 중 외과적 4건 + refactor P1-1 테스트 보강.

base SHA: `74fb7fd` ↔ HEAD: `c2e573e` (변경 LOC: +183 / −20, 13 파일)

커밋: `871b598`(A chat auth), `a099bad`(B config schema), `bfc6c72`(C FTS 임계), `c30359a`(D 클라 드리프트), `c2e573e`(refactor P1-1 값-고정 테스트).

---

## 1. 구현 사항 (TODO 일치도)

| 밀스톤          | 내용                                                                    | 상태 | 비고                                      |
| --------------- | ----------------------------------------------------------------------- | ---- | ----------------------------------------- |
| A               | `chat.send`/`chat.stop` authLevel `'session'`→`'token'` + 테스트 재작성 | ✅   | chat.\* 전부 token 일관                   |
| B               | Zod 스키마에 `rag`/`accessLog`/`gateway.auth` 미러 + 회귀               | ✅   | types/config.ts 와 1:1, strict 유지       |
| C               | FTS-only RAG 임계 mode 분리 (fts-only 0.3, hybrid 0.65)                 | ✅   | outer `mode` 분기, dedup/신선도/상한 불변 |
| D               | 클라 드리프트 4건 (web chat.start, CLI agent/alert/news)                | ✅   | 서버 불변, 클라만                         |
| (refactor P1-1) | `FTS_SIMILARITY_THRESHOLD` 값-고정 테스트                               | ✅   | 0.65 와 대칭                              |

**일치도: ✅ 13 / ⚠️ 1 / ❌ 0.** ⚠️ = D6 실 부팅 smoke (실 키 필요, 자동 게이트 밖 — plan/todo 명시 위임, 누락 아님).

## 2. 자동화 검증 결과

| 명령                | 결과                  | 비고                                                |
| ------------------- | --------------------- | --------------------------------------------------- |
| `pnpm typecheck`    | ✅ PASS               | -                                                   |
| `pnpm build`        | ✅ PASS               | -                                                   |
| `pnpm test --run`   | ✅ 1684 pass / 0 fail | baseline 1681 → **+3 회귀**(B×2, A net0, news mock) |
| `pnpm test:storage` | ✅ 154 pass / 0 fail  | baseline 151 → **+3**(C 회귀 2 + FTS 값-고정 1)     |
| `pnpm lint`         | ✅ 0 warnings         | -                                                   |
| mock-only 격리      | ✅ PASS               | API 키 6종 unset 통과                               |

테스트 삭제·skip·only 도입 **0**. 증가분 전부 신규 회귀 테스트.

## 3. 경계면 검증

- **A**: `hasRequiredAuth` 레벨 인덱스 비교로 token 통과 / api_key 거부가 의미있게 동작 (강등 전엔 token 도 UNAUTHORIZED).
- **B**: `RagSchema`/`AccessLogSchema`/`GatewaySchema.auth` 가 `types/config.ts` 와 필드·optional 1:1. 중첩도 `strictObject` 유지 → 오타 거부(`rag.rerank.foobar`) 회귀 살아있음 (over-loosen 아님).
- **C**: `mergeHybridResults` 가 source 를 'hybrid' 로 덮으므로 outer `mode` 변수로 분기. hybrid 경로 0.65 불변, fts-only 만 0.3. 무관 발화 0건은 AND-match 로 구조적 보장(임계 무관).
- **D**: 서버 `finance.news`(`{articles,total}`)·`agent.status`·`alert.list` 핸들러 **불변**. 클라가 실 계약에 맞춰짐. web `chat.start({agentId:'default'})`→`chat.send` 순서, `AppChat` 생성자 시그니처 보존(기존 web 31/31 무회귀).

## 4. 리팩토링 사항

### P0 — 즉시 (병합 전)

없음. (refactor+QA 교차: 테스트 약화 0, §3 위반 0, 서버 계약 누수 0, scope creep 0.)

### P1 — 권장

1. **FTS 임계 값-고정 테스트 부재 → ✅ 조치 완료** (`c2e573e`): 0.65 는 값-고정 테스트가 있었으나 0.3 은 없어 비대칭 가드였음. `expect(FTS_SIMILARITY_THRESHOLD).toBe(0.3)` 추가로 대칭화.

### P2 — 선택 (조치 불요)

1. `chat.stop` 전용 auth 테스트 부재 — todo 가 "authLevel 변경으로 충분" 명시 수용, chat.send 가 같은 게이트 경로 회귀 커버.
2. web `chat.start` fire-and-forget 의 빈 catch(`app.ts`) — 의도(다른 탭 보존) 정당하나 실패 시 무음. UX 로그 1줄 여지(선호).
3. CLI `result.data?.X ?? []` 추출 패턴 2회(alert/news) — 추출 임계(3회) 미달, 현 인라인이 정답(§2).

## 5. 범위 밖 발견 (참고)

- **`agent.list` CLI 형제 드리프트** (QA 발견): 서버 `agent.ts:172` 가 `{agents:[...]}` 반환하나 CLI `agent.ts:15` 가 bare array 캐스트 → 항상 "No agents registered". **F7/F8 와 동종 버그인데 감사가 누락** → phase37 이 정당하게 미터치(범위 밖). 1줄 수정, 후속 후보.

## 6. scope creep 의심

- 없음. plan 비대상(P0-2 미등록 메서드 `system.shutdown`/`finance.alert.remove`/`channel.*`, P1-6 tier 발산, P2 dead code, 서버 RPC 계약) 전부 미터치. D 커밋이 `gateway/rpc` 0건 터치. 신규 export 2개(`FTS_SIMILARITY_THRESHOLD`/`AppChat.setSessionId`) 즉시 소비(dead 아님).

## 7. 위험 신호

- **클라 드리프트(D)의 end-to-end 는 실 키/네트워크 의존 → 자동 테스트 불가**. 단위/계약 정합은 검증됐으나 실제 web 채팅·CLI 명령 동작은 수동 부팅 smoke 필요(P0-1 강등 + F5 와 합류). 핸드오프의 "실 키 e2e 미검증" 과 동일 지점.

## 8. 다음 phase 후보

- **P0-2 — CLI 미등록 메서드** (`system.shutdown`/`finance.alert.remove`/`channel.*`): 메서드 등록 vs CLI 명령 제거 결정 필요.
- **`agent.list` CLI 드리프트** (§5): F7/F8 동종, 1줄.
- **P1-6 analysis tier 발산** (sonnet vs opus): 라우팅 정책 설계 결정.
- **P2 dead code 정리**: phase30 tracer 전환 잔재(execution:_/agent:run:_ 이벤트, always-NULL 컬럼, DefaultPipelineObserver), README 39→45.

## 9. 측정값

- 변경 파일 수: 13 (소스 8 + 테스트 5)
- 변경 LOC: +183 / −20
- 새 테스트: 6 (B config 3, C FTS 회상 2, FTS 값-고정 1) + A 재작성(net 0) + news mock 정정
- 커밋 수: 5 (밀스톤 4 + 테스트 보강 1)
- review 생성 일시: 2026-05-25

## 10. 권고 — 머지 가능 여부

**판정: ✅ 머지 가능 (단, 클라 드리프트는 머지 후 수동 부팅 smoke 권장)**

- P0 없음. refactor+QA 교차로 테스트 진위 검증(C 회귀가 0.65 복원 시 실제 FAIL, D mock 은 실 계약 교정 — 둘 다 약화 아님).
- 전 게이트 green, scope guard 통과(서버 계약 불변, 비대상 미터치), 회귀 테스트가 감사 버그를 실제로 포착.
- 잔여 = 클라 드리프트 e2e(실 키 필요) — 자동 검증 구조적 한계.
