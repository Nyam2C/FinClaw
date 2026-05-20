# Phase 32 Review: Backend-as-CLI (Claude Max 구독 활용 → API 비용 0원)

> todo.md 기반 구현 코드 리뷰. 구현 완료 상태, 코드 품질 이슈, 리팩토링 사항, 알려진 제약을 기록한다.

base SHA: `a15758e` (phase31 머지된 main) ↔ HEAD: `a105b04` (변경 LOC: 약 +1587 / -18, 9 커밋)
branch: `feature/backend-as-cli`

OpenClaw `cli-runner.ts`/`cli-backends.ts`/`cli-runner/*` 의 Backend-as-CLI 패턴을 이식. `claude` CLI 를 child_process spawn + `clearEnv(ANTHROPIC_API_KEY)` 로 OAuth(구독) 인증 강제. dual-path provider (`anthropic-sdk` ↔ `claude-cli`) opt-in, 기본값 SDK 유지로 회귀 0.

---

## 1. 구현 사항 (TODO 일치도)

집계: ✅ 36 / ⚠️ 3 / ❌ 0. ⚠️ 3건은 모두 todo 에 범위 밖/audit-only 로 명시된 항목 (W1 영속, IT-1 테스트 위치, B2/G4 정당한 교정).

| 밀스톤   | 단계                                                                                | 상태  | 비고                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------- |
| P-1      | 디렉터리/의존                                                                       | ✅    | claude-cli 9 src + 9 test. 신규 workspace dep 0                                                                      |
| A        | A1 types · A2 backends · A3 test(9)                                                 | ✅    | clearEnv `['ANTHROPIC_API_KEY','ANTHROPIC_API_KEY_OLD']`, `--dangerously-skip-permissions`, fresh 0.6/resume 0.4     |
| B        | B1 reliability · B2 test(5)                                                         | ⚠️    | B2 cap 기대값 todo 6_000 → **9_000** 교정 (cap binding 정당, 알고리즘 일치)                                          |
| C        | C1 queue · C2 spawn · C3 test(5)                                                    | ✅    | no-output watchdog + SIGTERM→2s→SIGKILL + overall/abort 분리. spawn 테스트는 `node -e` 가짜 자식만                   |
| D        | D1 parsers · D2 test(5)                                                             | ✅    | pickText/pickSessionId/pickUsage(snake+camel)/mergeUsage                                                             |
| E        | E1 errors · E2 runCliAgent · E3 test(5)                                             | ✅    | **clearEnv 적용(runner.ts:55-58, ANTHROPIC_API_KEY delete)** + useResume args + 에러 분기(timeout 408)               |
| F        | F1 adapter · F2 factory · F3 catalog · F4 config · F5 barrel · F6 main · F7 test(6) | ✅    | providerId 'claude-cli', async generator, ProviderKind rename, top-level config, factory wiring                      |
| G        | G1 migration · G2 agent-runs · G3 auth fallback · G4 storage test(3) · G5 test(2)   | ⚠️    | G4 경로 `cli-session.migration.storage.test.ts` (storage glob 컨벤션, 정당). 영속 와이어링은 §아래                   |
| H        | H1 live test(3) · H2 prerequisite                                                   | ✅    | `*.live.test.ts` default 제외 + `describe.skipIf(!claudeAvailable)`                                                  |
| IT       | IT-1 전환 · IT-2 multi-turn · IT-3 auth fallback                                    | ⚠️/✅ | IT-1 factory 단위로 커버(main.test 부트 단언 미추가). IT-2 in-process. IT-3 adapter-level(Discord 알림은 W4 범위 밖) |
| 최종검증 | typecheck/build/lint/test/storage                                                   | ✅    | 전부 PASS, 회귀 0                                                                                                    |

### W1 영속 와이어링 — ⚠️ 의도된 partial (❌ 아님)

- `updateAgentRunCliSession`(agent-runs.ts:207), `AddAgentRunInput.cliSessionId`, conversations.metadata write — **production 호출처 0** (테스트만).
- 멀티턴 `--resume` 은 `CliProviderAdapter.#cliSessionId` in-memory 전역 멤버로 **프로세스 수명 내 동작**. DB 영속 없음 → **재시작 시 세션 소실**.
- todo W1 은 "영속 위치 = conversations.metadata" **결정만** 했고 write 와이어링은 범위 외. audit 인프라(G)는 빌드됐으나 dormant. → ⚠️ (범위 외 보류), 미구현(❌) 아님.

---

## 2. 자동화 검증 결과

| 명령                       | 결과                  | 비고                                                                               |
| -------------------------- | --------------------- | ---------------------------------------------------------------------------------- |
| `pnpm typecheck` (tsgo)    | ✅ PASS               | 0 에러                                                                             |
| `pnpm build` (tsc --build) | ✅ PASS               | typecheck 가 못 잡는 것 검출 → build-fix `a105b04` 반영, 잔여 0                    |
| `pnpm test`                | ✅ 1632 pass / 0 fail | 186 files, API 키 unset 상태                                                       |
| `pnpm test:storage`        | ✅ 147 pass / 0 fail  | 22 files, v10→v11 마이그레이션 + idempotency                                       |
| `pnpm lint`                | ✅ 0 / 0              | 557 files                                                                          |
| claude-cli 전용 유닛       | ✅ 37 pass            | 8 files (live 1 제외)                                                              |
| mock 격리                  | ✅ OK                 | `claude` 설치됐으나 유닛/storage 가 단 한 번도 실제 실행 안 함                     |
| live 격리                  | ✅ OK                 | `*.live.test.ts` vitest exclude. `pnpm test:live` 미실행 (실 Claude Max 호출 금지) |
| 회귀                       | ✅ 0                  | 기본 provider 미지정 → anthropic-sdk 경로 유지                                     |

**참고 (하네스 개선 후보):** `tsgo --noEmit`(밀스톤 typecheck)이 `tsc --build`(빌드 그래프)가 잡는 것을 못 잡음 — 본 phase 중 2건(resolver ENV_KEY_MAP exhaustive, branded AgentId). 향후 밀스톤 검증에 `pnpm build` 포함 권장.

---

## 3. 경계면 검증 (PASS 7/7, 불일치 0)

- **adapter ↔ ProviderAdapter**: `CliProviderAdapter implements ProviderAdapter`, `providerId`/`chatCompletion`/`streamCompletion` 3 시그니처 일치 ✅
- **streamCompletion ↔ Runner**: adapter 가 yield 하는 `text_delta`/`usage`/`done` 을 Runner(runner.ts:263 for await)가 정확히 소비. CLI 는 tool\_\* 미생성(text-only) — §4 P1-1 참조 ✅
- **factory ↔ main.ts**: `createProviderAdapter({kind})` → Runner provider 슬롯. summarizer 는 `sdkAdapter.summarize`(AnthropicAdapter 전용) 유지. 기본 kind 'anthropic-sdk' ✅
- **W2 auth fallback**: `yield* sdkFallback.streamCompletion(params)` 타입/스트림 호환 (cli-fallback.test 2 green) ✅
- **W5 ProviderId exhaustive**: 유일한 `Record<ProviderId,_>` = ENV_KEY_MAP 에 'claude-cli' 키 존재. breaker(Map string key) 무영향. build PASS 가 잔여 누락 0 입증 ✅
- **G 마이그레이션**: database v11 ↔ MIGRATIONS[11] ↔ SCHEMA_DDL ↔ agent-runs row/insert(18컬럼 정합) ↔ table_info 가드 idempotent ✅
- **config**: top-level `provider`(z.enum) ≠ `agents.defaults.provider`(z.string) 충돌 없음, strictObject 신규 키 정상 수용 (config 90 회귀 0) ✅

---

## 4. 리팩토링 사항

### P0 — 즉시 (병합 전)

**없음.** 빌드/타입/테스트/린트 green, 회귀 0, 경계 불일치 0.

### P1 — 권장 (다음 phase 안에)

1. **`claude-cli/adapter.ts:62-76` — CLI 모드에서 tool_use 가 조용히 비활성화 (가장 중요)**
   - `streamCompletion` 은 `text_delta→usage→done` 만 yield. Runner 의 도구 실행은 `tool_use_*` chunk 의존 → **`provider: 'claude-cli'` 전환 시 skills-finance 전체(가격/뉴스/포트폴리오)가 침묵 비활성화**.
   - plan 의 의도적 제약(CLI 자체 도구 비활성 + 시스템 프롬프트 "Tools disabled")이나, 원래 **런타임에 가시화되지 않았음**. 금융 비서에서 도구 없는 LLM = 환각 위험 (MEMORY "환각 방지·읽기 전용" 원칙과 긴장).
   - **처리됨 (본 PR)**: `main.ts` 부팅 시 `provider==='claude-cli'` + 등록 도구 > 0 이면 `logger.warn('provider.cli_tools_disabled', {toolCount,...})` 1회 emit (모든 도구 등록 직후). 운영자가 CLI 전환 시 도구 비활성을 부팅 로그에서 인지. per-request 경고는 노이즈 방지로 미적용.

2. **W1 audit 인프라 미연결 — 죽은 코드 아님, "준비된 미연결 인프라(단계화)"**
   - `updateAgentRunCliSession`/`cliSessionId` 입력 필드 production 호출처 0. adapter `#cliSessionId` 는 in-memory 전역만, DB/metadata 영속 0.
   - phase31 `applyToolResultGuard`(순수 고아)와 **다름**: DDL+마이그레이션+row+테스트 일관 + plan W1 이 두 트랙(audit 컬럼 / metadata 영속) 정의 + implementer-log 자가 보고 = 설계상 다음 단계 정의된 부분 구현.
   - 제안: **(A) 와이어링을 다음 phase 로 미루되 `updateAgentRunCliSession` 에 만료조건 주석 + review 명기 (권장 — DDL nullable 비파괴, 롤백 비용 큼).** **만료 조건: 다음 phase 에서 scheduler/rpc audit 기록을 연결하지 않으면 (B) 컬럼/함수/입력 필드 회수(YAGNI).**

3. **`claude-cli/backends.ts:56-70` — `resolveClaudeBackend` 프로덕션 미사용 (main.ts 가 인라인 우회)**
   - `main.ts:271-279` 가 `{ ...DEFAULT_CLAUDE_BACKEND, command, reliability }` 인라인 스프레드로 직접 조립 → `resolveClaudeBackend` 의 clearEnv union-merge 우회. 추상화는 만들었으나 프로덕션 미소비(테스트만).
   - 제안: main.ts 인라인을 `resolveClaudeBackend({command, reliability})` 호출로 교체(추상화 실소비 + clearEnv 일관). main.ts 수정이라 승인 후.

4. **`claude-cli/adapter.ts:48-58` — usage 매핑이 `totalTokens`/`estimatedCostUsd` 누락**
   - 파서는 `total`(parsers.ts:146)을 파싱하나 adapter 가 버림. 비용 0(구독)이 의도지만 토큰 audit(phase30 observability)엔 total 이 유효 신호 → 데드 데이터.
   - 제안: 의도(비용 0)면 parsers `pickUsage` 의 total 파싱 제거(데드 데이터 정리), audit 원하면 adapter 에서 total 보존. review 기록 후 결정.

### P2 — 선택 (선호 차이)

1. `errors.ts:7-8` `CliFailoverReason` 의 `format`/`model_not_found` 도달 불가 (classifyCliError 4종만 반환). 단순화 일관(union 축소) vs 충실도 보존(주석) — 선호 차이.
2. `spawn.ts:39-62` SIGKILL `setTimeout` 미 `.unref()` — 단명 타이머라 영향 미미. `.unref()` 1줄 권장.
3. `adapter.ts:79-86` `extractPrompt` multimodal content 무시(배열 → ''). `imageArg`/`imageMode` 타입 필드 소비처 0. → §6 "text-only" 명기.
4. `adapter.ts:26-29` `chatCompletion` 인터페이스 계약 충족용, 실사용 streamCompletion 만 (계약 필수라 보존).
5. `queue.ts` chained/tracked 이중 promise — OpenClaw 1:1 충실, 변경 금지.

---

## 5. 범위 밖 발견 (참고)

- **SCHEMA_VERSION bump 단언 5곳 수정** (database/agent-runs/transactions storage test) — CLAUDE.md §3 "자기변경 유발 불일치 정리"에 부합. scope creep 아님. rate-limit 헤더의 무관한 `'10'` 은 안 건드림(정확한 외과적 판단).
- **resolver.ts ENV_KEY_MAP `'claude-cli'` 추가** — W5 ProviderId 확장이 강제한 exhaustive 보정. CLI 는 OAuth 라 resolver 미경유(주석 정확).
- **getBreakerForProvider Map 에 claude-cli breaker 미초기화** — string key 라 무영향, CLI 는 breaker 밖(설계상). 버그 아님.

---

## 6. 알려진 제약 (사용자 인지 필요)

> CLI 모드(`provider: 'claude-cli'`) 활성 시의 제약. 기본 SDK 모드는 영향 없음.

1. **CLI 모드 = 도구 없음 (P1-1).** CLI 경로는 tool_use 를 yield 하지 않아 skills-finance(시장/뉴스/포트폴리오) 전체가 비활성. CLI 모드는 "도구 없는 순수 대화/추론"에만 적합. 라이브 금융 데이터가 필요한 작업은 SDK 모드 필수. **본 PR 에서 부팅 시 `provider.cli_tools_disabled` 경고로 가시화함** (운영자 인지용).
2. **멀티턴 세션은 프로세스 수명 내에서만 (Q1=A).** `#cliSessionId` in-memory 전역 → **재시작 시 세션 소실**, **다중 동시 대화 미격리**(스레드 간 세션 누수 가능). 현 스코프(1인 + 단일 동시 대화) 전제에서 정당. 영속/격리는 후속.
3. **멀티모달 미지원.** CLI adapter 는 text-only. 이미지 content 배열은 빈 prompt 로 유실.
4. **CLI 모드 usage total 누락.** 토큰 total/cost 추적 끊김 (비용 0 의도와 연결, P1-4).

---

## 7. 위험 신호

**P0/P1 차단 위험 없음.** 빌드/타입/테스트/린트 green, 외부 API 가 유닛에 미혼입, 회귀 0, OpenClaw 핵심 이식(clearEnv/no-output watchdog/watchdog ratio) 정확 보존.

유일한 운영 주의: CLI 모드 전환 시 도구 비활성(§6-1) — 사용자가 config 한 줄로 전환했을 때 라이브 데이터가 사라짐을 인지해야 함.

---

## 8. 다음 phase 후보 (제안)

- **W1 영속 와이어링** (또는 audit 인프라 회수) — P1-2 의 만료조건.
- ~~CLI 모드 tool 비활성 가시화 (P1-1)~~ — **본 PR 에서 처리됨** (부팅 경고).
- **resolveClaudeBackend 실소비** (P1-3), usage total 결정 (P1-4).
- IT-3 Discord 알림 (provider 전환/auth fallback) — 신규 이벤트 필요 (W4 보류분).
- Phase 33 트랙: KIS sync + news memorization (plans/phase33).

---

## 9. 측정값

- 변경 파일 수: 22 (claude-cli 9 src 신규 + factory + storage/config/types/server/catalog 수정 + 9 test)
- 변경 LOC: 약 +1587 / -18 (claude-cli src 819 LOC)
- 새 테스트 수: 37 claude-cli 유닛 + 3 storage 마이그레이션 + 3 live(tier 분리)
- 커밋: 9 (`3e36373` A · `cec53ce` B · `3ba885c` C · `026d614` D · `1ef9e5f` E · `810d4e1` F · `c784a3e` G · `08a328d` H · `a105b04` build-fix)
- OpenClaw 이식 충실도: backends 95% · reliability 100% · parsers 100% · queue 100% · runner 90% · errors 80% (위험 누락 0)
- review-draft 생성 일시: 2026-05-21

---

## 10. 권고 — 머지 가능 여부

**판정: ✅ 머지 가능**

- P0 0건. 자동화 6/6 PASS (build 포함). 경계면 7/7 일치. mock+live 격리 OK. ❌ 미구현 0건. 회귀 0.
- ⚠️ 3건은 todo 가 범위 밖/정당 교정으로 명시한 항목.
- OpenClaw Backend-as-CLI 핵심 메커니즘(clearEnv 의 ANTHROPIC_API_KEY delete) 정확 이식 — phase 목표(API 비용 0원 경로) 달성.
- **머지 후 인지/후속 권장**: §6 알려진 제약(특히 CLI 모드 도구 비활성), P1-2 W1 만료조건. 차단 사항 아님.
