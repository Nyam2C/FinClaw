# Phase 22 Plan 2 — 미사용 코드 활성화 (Zero-Discard)

## Context

코드베이스 전수조사(2026-04-23) 결과, 11개 패키지(types/config/storage/agent/channel-discord/skills-finance/skills-general/infra/server/tui/web) 전반에 걸쳐 **현재 어디에서도 import되지 않거나 내부에만 쓰이는 export ~45건**을 확인했다.

`plan.md`의 A~D 밀스톤은 **신규 작업 중심**(시스템 프롬프트, 뉴스·알림 배선, 감사·부채 청산)인 반면, 본 문서는 **기존 자산 활성화 중심**이다. 두 계획은 겹치는 지점이 많고, plan_2는 plan.md의 빈자리를 채우면서 "버리는 코드 없이 가자"는 대원칙을 구현한다.

**전제** (사용자 지시 2026-04-23):

- 발견된 미사용 코드는 전부 **의도적으로 짜인 것**으로 간주한다
- 삭제 대신 활용 경로 확보가 목표
- phase22 범위에 안 들어가는 항목은 phase23+ 후보로 보존

---

## 분류 체계

조사된 45건을 활용 난이도·경로별로 네 범주로 나눈다.

| 범주                            | 의미                                              | 건수(대략) | 이번 phase 대응                  |
| ------------------------------- | ------------------------------------------------- | ---------- | -------------------------------- |
| **C1. Wire-up 누락**            | 구현 완성, 부팅 경로에만 연결하면 동작            | ~10        | 본 phase에서 대부분 처리         |
| **C2. Backbone 대기**           | 인프라 완성, 다른 기능이 소비자로 붙어야 의미     | ~12        | 일부 phase22, 나머지 phase23+    |
| **C3. 내부 사용 · export 과잉** | 실제는 내부 호출됨. index.ts에서 외부 노출만 과잉 | ~15        | index.ts 정리                    |
| **C4. 테스트 격리 유틸**        | beforeEach 리셋용. 프로덕션 미호출이 의도         | ~8         | 유지(내부 경로 노출로 전환 고려) |

---

## Category 1 — Wire-up 누락 (즉시 활성화 대상)

### 1.1 ChannelDock 자동 등록 (server/src/channels)

**대상 심볼**

- `registerChannelDock`, `getChannelDock`, `hasChannelDock`, `getAllChannelDocks` (`registry.ts`)
- `createChannelDock` (`dock.ts:22`)
- `normalizeChatType`, `isDirect`, `isMultiUser` (`chat-type.ts`)

**현재 상태**

- `registry.ts` 주석 TODO: _"CORE_DOCKS(dock.ts)를 부팅 시 자동 등록하는 코드 필요. initChannels() 등에서 호출."_
- 레지스트리·헬퍼는 전부 구현됨. 부팅 시 **어디에서도 호출 안 함**.

**활성화 경로** (plan.md D2 · 본 plan_2)

1. `packages/server/src/channels/index.ts`에 `initChannels()` 신규 함수 추가 — `registerChannelDock(DISCORD_DOCK)`, `registerChannelDock(HTTP_WEBHOOK_DOCK)` 순차 호출
2. `main.ts` 부팅 시퀀스(`applyConfig()` 이후, 도구 등록 이전)에서 `initChannels()` 호출
3. `commands/status.ts`(plan.md D2)에서 `getAllChannelDocks()`로 "지원 채널 목록" 출력
4. `deliverResponse`에서 `getChannelDock(ctx.channelId)`로 해당 채널의 `maxChunkLength` 조회 → 현재 하드코딩(2000)된 값을 대체
5. `chat-type.ts` 3종은 `contextStage`의 `ChatType` 분류에 사용 → enrichContext에서 직접 호출

**검증**

- `!finclaw status` 응답에 "지원 채널: discord, http-webhook" 포함
- 등록된 도크 없이 send 시도 시 명확한 에러

### 1.2 감사 메타(C1·C2) 배선 — 실은 반쯤 준비됨

**대상 심볼**

- `ToolCallRecord` (`execution-adapter.ts`) — 이미 정의됨, 주석에 _"Phase 22: 도구 호출 감사용 메타데이터"_
- `formatSourceFooter` (`deliver.ts`) — 이미 존재 (agent 보고상)
- `collectToolCalls` (`execution-adapter.ts:279-308`) — 메시지 페어링 로직 있음

**현재 상태**

- 구조는 이미 phase22 요구에 맞게 선제적으로 구현됨
- 빠진 연결: (a) `timestamp`·`durationMs` 실측 수집 (b) `messages.tool_calls` JSON 컬럼에 저장

**활성화 경로** (plan.md C1·C2 본편과 동일, 여기선 재진술)

- `collectToolCalls`가 `fallbackTimestamp`만 넣는 부분을 `Date.now()` 실측 + execute 시작·종료 시각 측정으로 확장
- `storage/src/tables/messages.ts`의 `saveMessage`에서 `toolCalls` 파라미터 수용 → JSON 직렬화
- `storage` 레이어에 `getToolCallHistory(conversationId)` 헬퍼 신규

### 1.3 Discord Command 프레임워크 마무리

**대상 심볼**

- `commandStage` (`stages/command.ts`) — pipeline 내부 사용 중이나 TODO 남음: _"권한 시스템 구현 시 사용자 역할과 requiredRoles 비교"_

**현재 상태**

- Stage 자체는 작동. `!finclaw status`·`!finclaw reset` 명령어 구현체만 없음 (plan.md D2)

**활성화 경로** (plan.md D2)

- `packages/server/src/auto-reply/commands/status.ts`, `commands/reset.ts` 신규
- `registerBuiltInCommands()`에 추가
- 권한 TODO는 phase23으로 연기 (본 phase는 사용자 단일 가정)

---

## Category 2 — Backbone 대기 (소비자 배선 필요)

### 2.1 Model Fallback & Catalog (packages/agent/src/models)

**대상 심볼**

- `InMemoryModelCatalog` (`catalog.ts`) — 중복 등록 throw, vision·streaming 필터 지원
- `buildModelAliasIndex` (`alias-index.ts`) — 별칭→모델 맵, 대소문자 무시
- `DEFAULT_FALLBACK_CHAIN` (`catalog-data.ts`) — Opus→Sonnet→Haiku→GPT-4o→GPT-4o-mini
- `runWithModelFallback` (`fallback.ts`) — Circuit breaker 연동, AbortError 즉시 전파, `model:fallback`·`model:exhausted` 이벤트

**현재 상태**

- 완전한 폴백 인프라가 있음. 하지만 Anthropic 호출 경로(agent의 `provider-anthropic.ts` 어딘가)가 이걸 쓰지 않고 단일 모델로 직접 호출 중으로 추정
- `registerChannelDock`와 같은 패턴: 구현 완성 + 소비자 부재

**활성화 경로**

- **phase22 내 (선택)**: `main.ts`에서 `InMemoryModelCatalog` 인스턴스 생성 + `config.models.definitions`의 모델 등록 + `buildModelAliasIndex` 호출
- **phase22 내 (핵심)**: Anthropic 오류(rate-limit, overloaded) 발생 시 `runWithModelFallback`로 감싸서 자동 재시도. 현재 **Opus 단일 의존** → 429 한 방에 봇 무응답 리스크 제거
- **소비자 위치**: `packages/agent/src/provider-anthropic.ts`의 `createMessage()` 호출 감싸기 (존재 여부 확인 후)
- **phase23+ 멀티프로바이더**: 본래 카탈로그에 GPT-4o·GPT-4o-mini까지 등록 시 멀티프로바이더 전환을 상정했으나, **phase22 scope narrowing으로 d2a67d9에서 OpenAI 어댑터·normalizers·3개 openai 모델·openai 의존성을 삭제**했다. phase23에서 멀티프로바이더가 필요하면 어댑터를 재구현해야 한다 (구 구현은 git history로 복원 가능).

**의존성 주의**

- `DEFAULT_FALLBACK_CHAIN`의 `'claude-opus-4-6'`은 현재 `'claude-opus-4-7'`로 갱신 필요 (모델 ID 변경됨)

### 2.2 Auth Profile 다중화 (packages/agent/src/auth)

**대상 심볼**

- `InMemoryAuthProfileStore` (`profiles.ts`) — CRUD + 라운드로빈 `selectNext`
- `ProfileHealthMonitor` (`health.ts`) — 5분 슬라이딩 윈도우, healthy/degraded/unhealthy/disabled 상태 머신
- `CooldownTracker` (`cooldown.ts`) — rate-limit 1분, billing 24h, server-error 5분, 지수 백오프

**현재 상태**

- 단일 키 기반 현재 설계엔 쓰이지 않는 "다중 키 failover" backbone
- 주석 TODO 다수: 타입 안전성·readonly 전환

**활성화 경로**

- **phase22 내**: **ProfileHealthMonitor만 부분 활성화** — 단일 키라도 건강 상태 기록 → `!finclaw status`에서 "최근 API 에러율" 노출
- **phase22 내 선택**: `CooldownTracker` 연동 — Alpha Vantage 레이트 리밋(5/min) 초과 시 `setCooldown('rate-limit')` 호출로 도구를 자동 스킵
- **phase23+**: 다중 `ANTHROPIC_API_KEY_1..N` env 지원 시 `InMemoryAuthProfileStore.selectNext`로 로드밸런싱. `plan.md` 범위 밖이나 backbone 보존

**주의**

- 이 backbone은 "언젠가 쓸 것"이므로 **삭제하면 phase23에서 재작성 비용 발생**. 유지가 정답.

### 2.3 Port Conflict 진단 UX (packages/infra)

**대상 심볼**

- `findAvailablePort` (`ports.ts`) — startPort부터 순차 탐색
- `inspectPortOccupant` (`ports-inspect.ts:19`) — lsof/netstat로 PID·명령어 조회
- `formatPortOccupant` (`ports-inspect.ts:73`) — 사람 친화적 에러 메시지

**현재 상태**

- 현재 gateway는 `assertPortAvailable` 하나만 쓰고, 충돌 시 단순 throw
- 개발자 UX 저하 (어느 프로세스가 점유 중인지 불명)

**활성화 경로**

- `packages/server/src/gateway/server.ts` 부팅 시, `assertPortAvailable` 실패를 catch → `inspectPortOccupant(port)` 호출 → `formatPortOccupant`로 에러 메시지 보강
- **선택**: 개발 모드(`NODE_ENV !== 'production'`)에서 `findAvailablePort`로 자동 대체 포트 배정 + 경고 로그
- **phase**: plan.md 범위 밖이나 20줄 미만 변경. D3(web healthcheck)와 묶어 **"부팅·진단 UX 개선"** 서브 밀스톤으로 추가

### 2.4 Storage Search 헬퍼 (packages/storage)

**대상 심볼**

- `buildFtsQuery`, `bm25RankToScore` (`search/fts.ts`)
- `cosineSimilarity` (`search/vector.ts`)

**현재 상태**

- `searchFts`·`searchVector` 내부에서 호출됨 (Category 3도 해당)
- 테스트에서 직접 import하여 하이브리드 검색 로직 검증

**활성화 경로**

- **phase22 범위 밖**: Search 기능 자체의 소비자가 아직 없음 (대화 이력 검색 UI·명령어 미구현)
- **phase23+ 후보**: `!finclaw search <키워드>` 명령어 — `messages` 테이블 FTS + 임베딩 벡터 하이브리드 검색으로 과거 대화 재참조
- **지금 할 일**: 없음. backbone 보존.

---

## Category 3 — 내부 사용 중 · Export 과잉 (정리)

이들은 모두 pipeline/stage 내부에서 **실제로 쓰이고 있다**. 단지 `index.ts`나 파일 최상단에서 외부 API처럼 export된 게 쓰이지 않을 뿐이다.

**대상 심볼** (server/auto-reply)

- `enrichContext` (pipeline-context.ts) → `contextStage`에서 사용
- `normalizeMessage` (stages/normalize.ts) → `pipeline`에서 사용
- `commandStage`, `ackStage`, `contextStage`, `executeStage`, `deliverResponse` (stages/\*) → `pipeline.ts`에서 사용
- `createTypingController` (stages/ack.ts) → `ackStage`에서 사용
- `CONTROL_TOKENS`, `extractControlTokens` (control-tokens.ts) → `executeStage`에서 사용
- `formatFinancialNumber`, `splitMessage` (response-formatter.ts) → `splitMessage`는 `deliverResponse`에서 사용

**활성화 경로** = 정리

- `packages/server/src/auto-reply/index.ts`를 열어, 외부가 실제로 소비하는 심볼만 남긴다
  - **외부 소비자가 쓰는 것**: `AutoReplyPipeline`, `CommandRegistry`, `ExecutionAdapter`, `RunnerExecutionAdapter`, 관련 타입
  - **내부 전용으로 되돌릴 것**: stage 함수들, `enrichContext`, `CONTROL_TOKENS`, `createTypingController` 등
- 개별 파일의 `export` 키워드는 유지 (같은 패키지 내 상호 import 필요)
- **원칙**: 삭제가 아니라 "public surface area 축소". 코드는 그대로 살아있음

**보류 항목**

- ~~`formatFinancialNumber` (response-formatter.ts): 현재 호출처 없음. plan.md 시스템 프롬프트의 "불확실성 수치화" 원칙과 자연스럽게 엮임 → `deliverResponse`에서 도구 응답 후처리로 호출 검토. phase22에서는 플래그만 세우고 phase23에서 실제 배선.~~
  - **갱신 (d2a67d9 이후)**: phase22 scope narrowing 과정에서 `formatResponse`·`formatFinancialNumber`가 0 refs 상태로 삭제됨 (`splitMessage`는 유지). deliver 스테이지는 면책 조항·출처 footer만 인라인 처리하며 **금융 수치 포매팅은 수행하지 않는다**. phase23에서 "도구 응답 후처리"가 필요하면 재작성 (~80 LOC, 구 구현은 git history로 복원 가능).

---

## Category 4 — 테스트 격리 유틸 (유지)

이 심볼들은 **프로덕션 미호출이 의도**다. `beforeEach`에서 모듈 수준 상태(map·set)를 리셋하기 위해 만들어진다. 삭제하면 테스트가 서로 간섭한다.

**대상 심볼**

- `_resetPendingApprovals` (channel-discord/buttons.ts) — 이미 `_` 접두사로 internal 표기
- `resetWarnings` (infra/warnings.ts)
- `resetHealthCheckers` (server/gateway/health.ts)
- `unsetOverride`, `getOverrideCount` (config/runtime-overrides.ts)
- `getDefaults`, `validateConfigStrict` (config) — 테스트에서 불변성·엄격 검증 확인용
- `buildFtsQuery`, `bm25RankToScore`, `cosineSimilarity` (storage/search) — 내부 호출 + 테스트 단위 검증 이중 용도
- `sanitizePath` (server/gateway/access-log.ts) — 내부 호출 + 회귀 테스트
- `MissingEnvError`, `requireEnv` (server/main.ts) — `main()` 내부 호출 + 부팅 실패 테스트

**활성화 경로** = 유지 + 문서화

- **유지**: 전부 그대로
- **문서 보강**: 각 심볼 파일 상단에 `@internal` JSDoc 태그 또는 이름에 `_` 접두사 추가 고려 (일관성)
- **예외**: `validateConfigStrict`는 테스트 전용이 아니라 **부팅 경로에서 쓸 수 있는 실용 함수**. main.ts 기동 시 `validateConfig` 대신 `validateConfigStrict`로 전환하면 "설정 오류 시 묵묵히 기본값으로 폴백" 대신 "명시적 실패"가 된다 → 금융 파트너 신뢰성 원칙과 부합. **phase22 내 A 밀스톤에 묶어서 전환 추천**.

---

## 통합 Roadmap (plan.md와의 합류)

plan.md의 A~D 밀스톤에 plan_2 항목을 합친 최종 작업 순서:

| 순서 | 출처        | 작업                                                  | 추정 LOC |
| ---- | ----------- | ----------------------------------------------------- | -------- |
| 1    | plan.md A   | 시스템 프롬프트 재작성                                | ~40      |
| 1'   | plan_2 2.4  | `validateConfig` → `validateConfigStrict` 전환        | ~5       |
| 2    | plan.md B   | News/Alerts 도구 배선                                 | ~150     |
| 3    | plan_2 1.1  | `initChannels()` 신규 + 부팅 시 호출                  | ~30      |
| 4    | plan_2 2.3  | Port conflict 진단 메시지 보강                        | ~20      |
| 5    | plan.md C1  | DeliverStage 출처 footer (이미 반쯤 완성)             | ~50      |
| 6    | plan.md C2  | tool_calls JSON 저장 + `getToolCallHistory`           | ~70      |
| 7    | plan_2 2.1  | `runWithModelFallback`로 Anthropic 호출 감싸기        | ~60      |
| 8    | plan_2 2.2a | `ProfileHealthMonitor` 단일 키 기록 연결              | ~30      |
| 9    | plan.md D1  | chatId 근본 수정                                      | ~120     |
| 10   | plan.md D2  | `!finclaw status/reset` 구현                          | ~80      |
| 10'  | plan_2 1.1  | `!finclaw status` 출력에 채널/도구/모델 카탈로그 포함 | +20      |
| 11   | plan.md D3  | web healthcheck disable                               | ~3       |
| 12   | plan_2 C3   | auto-reply/index.ts 외부 노출 축소                    | ~30      |

**총 추가 LOC (plan_2 기여분)**: 약 +195 LOC  
**plan.md 원 추정 LOC**: ~600 → 수정 후 ~795

---

## phase23+로 보존할 backbone

이번 phase에서 활성화하지 않지만 **버리지 않고** 다음 phase 후보로 남길 것:

| 심볼                                     | 위치                            | 다음 활성화 시점                             |
| ---------------------------------------- | ------------------------------- | -------------------------------------------- |
| `InMemoryAuthProfileStore.selectNext`    | agent/src/auth/profiles.ts      | phase23: 다중 API 키 지원                    |
| `CooldownTracker` 외부 노출              | agent/src/auth/cooldown.ts      | phase23: Alpha Vantage 레이트 리밋 자동 관리 |
| 전체 Storage Search (`buildFtsQuery` 등) | storage/src/search              | phase23+: `!finclaw search` 명령어           |
| `DefaultPipelineObserver`                | auto-reply/observer.ts          | phase23: 메트릭 대시보드                     |
| `MockExecutionAdapter`                   | auto-reply/execution-adapter.ts | 영구 유지 (테스트용)                         |

**d2a67d9에서 scope narrowing으로 삭제된 backbone** (phase23에서 필요 시 재작성):

| 심볼                                        | 구 위치                          | 삭제 근거                                                  |
| ------------------------------------------- | -------------------------------- | ---------------------------------------------------------- |
| `formatFinancialNumber`, `formatResponse`   | auto-reply/response-formatter.ts | 0 refs, deliver가 포매팅하지 않음 (수치 원본 전달)         |
| OpenAI 어댑터 + normalizers + 3 openai 모델 | agent/providers/openai.ts 등     | phase22를 Anthropic-only로 확정, 멀티프로바이더는 phase23+ |

---

## 검증 (plan_2 추가분)

plan.md의 검증 시나리오에 아래 4개 추가:

1. **ChannelDock 자동 등록**
   - 서버 기동 로그에 `channels: registered 2 docks (discord, http-webhook)` 라인
   - `!finclaw status` 응답에 "지원 채널: …" 포함

2. **설정 strict 검증**
   - `.env`에 잘못된 타입(`GATEWAY_PORT=abc`) 주입 → 부팅 시 명확한 `ConfigValidationError` 출력 후 종료

3. **모델 폴백**
   - Anthropic API를 일시 차단(잘못된 키) → 부팅은 되고, DM 시도 시 `runWithModelFallback`가 exhausted까지 로그. 단일 키 환경에선 `auth:health:change` 이벤트 발행 확인만 가능
   - `!finclaw status`에 "최근 API 에러율 X%" 노출

4. **Port 진단**
   - 다른 프로세스가 GATEWAY_PORT 점유 중인 상태로 기동 → stderr에 `port 8787 occupied by PID 12345 (node ...)` 출력

---

## 마이그레이션 / 호환성

- **DB**: 영향 없음 (plan.md와 동일)
- **env**: 신규 필수 변수 없음. 기존 변수의 strict 검증으로 전환만
- **테스트**: Category 3의 `auto-reply/index.ts` 외부 노출 축소 시, 테스트가 직접 stage 함수를 import하는 경우가 있을 수 있음 → `packages/server/src/auto-reply/stages/xxx` 직접 경로로 전환
- **Downgrade**: 각 wire-up을 독립적으로 revert 가능 (`initChannels()` 호출만 제거, `runWithModelFallback` 래핑만 제거 등)

---

## 원칙 재확인

> "다 의도되고 짜여진 코드들 버리는거 없이 가는게 목표"

- **삭제 0건**: 위 4개 범주 모두 유지
- **공개 범위 정리**: Category 3의 `index.ts` 노출만 축소 (코드는 살아있음)
- **backbone 보존**: Category 2.2·2.4는 phase23 후보로 명시 기록
- **문서화**: 테스트 전용 유틸(C4)에 `@internal` 태그 보강

이렇게 하면 현재 "미사용"으로 나오는 45건이 모두 **활성 경로** 또는 **명시적 보존** 상태가 된다. 다음 phase에서 "이 함수 뭐지, 지워도 되나"라는 질문을 반복하지 않도록 plan_2 본 문서가 레퍼런스로 기능한다.
