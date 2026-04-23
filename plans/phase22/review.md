# Phase 22 구현 리뷰

## 개요

Phase 22는 두 개의 계획 문서로 구성됐다.

- `plan.md` — 신규 작업 (페르소나·News/Alerts 배선·감사·부채 청산) 4 밀스톤 / Todo 10개
- `plan_2.md` — "Zero-Discard" 미사용 코드 활성화 / Todo 8개

브랜치 `feature/finance-partner`는 main 대비 **20 커밋 앞서있고**, 작업 트리 clean, origin 동기화 완료. 최종 dead-code 정리 1건(`d2a67d9`) 포함.

---

## Todo별 구현 일치도 — plan.md

| Todo | 항목                                      | 상태 | 비고                                              |
| ---- | ----------------------------------------- | ---- | ------------------------------------------------- |
| 1    | A. 시스템 프롬프트 (금융 파트너 페르소나) | OK   | 커밋 `df69817` — `main.ts:79-101` 5원칙 명시      |
| 2    | B1. `registerMarketTools` 반환값 확장     | OK   | 커밋 `7200862` — `MarketSkillHandle` 노출         |
| 3    | B2. `main.ts` news/alerts 배선            | OK   | 커밋 `0dcd2fe` — 키 가용성별 그레이스풀 스킵 포함 |
| 4    | B3. skills-finance re-export + .env       | OK   | 커밋 `7200862` (2+4 묶음)                         |
| 5    | C1. `execution-adapter` 도구 메타 노출    | OK   | 커밋 `0408d68` — `ToolCallRecord` 구조            |
| 6    | C2. DeliverStage 출처 footer              | OK   | 커밋 `a95d9f0` — `📊 tool(src) @ KST` 포맷        |
| 7    | C3. `tool_calls` JSON 확장 + history 헬퍼 | OK   | 커밋 `5de03ee` — 구·신 포맷 호환                  |
| 8    | D1. `MsgContext.chatId` 근본 수정         | OK   | 커밋 `4feb10f` — Phase 21의 DM fallback 부채 청산 |
| 9    | D2. `!finclaw status` / `reset`           | OK   | 커밋 `7781873` — 실 storage 연결                  |
| 10   | D3. Web healthcheck override              | OK   | 커밋 `05c3f0e` — compose `disable: true`          |

## Todo별 구현 일치도 — plan_2.md

| Todo | 항목                                | 상태 | 비고                                                                  |
| ---- | ----------------------------------- | ---- | --------------------------------------------------------------------- |
| 1    | `validateConfigStrict` 부팅 전환    | OK   | 커밋 `6ed0fc2` (1+2 묶음) — 과도기 최소 경로로 gateway 검증만         |
| 2    | Port 점유 진단 UX                   | OK   | 커밋 `6ed0fc2` — `inspectPortOccupant` 연결, lsof/netstat 소프트 fail |
| 3    | ChannelDock 자동 등록               | OK   | 커밋 `049b273` — `initChannels()` 신규, CORE_DOCKS 2개                |
| 4    | `auto-reply` barrel 공개 범위 축소  | OK   | 커밋 `76443a6` — 내부 스테이지는 stage 직접 경로로                    |
| 5    | `runWithModelFallback` 래핑         | OK   | 커밋 `41dd175` (5+6 묶음) — Anthropic 체인 재시도                     |
| 6    | `ProfileHealthMonitor` 단일 키 기록 | OK   | 커밋 `41dd175` — `auth:health:change` 이벤트 발행                     |
| 7    | 테스트 격리 유틸 `@internal` 문서화 | OK   | 커밋 `eb108c3` — 동작 변경 없음                                       |
| 8    | `!finclaw status` 출력 확장         | OK   | 커밋 `ab19050` — 채널/모델/에러율 3줄 추가                            |

## 계획 외 추가 작업

| 항목                                     | 커밋      | 성격                                                                    |
| ---------------------------------------- | --------- | ----------------------------------------------------------------------- |
| Dead-code 제거 (7건, 31 파일, −1391 LOC) | `d2a67d9` | 계획 밖 + **plan_2 "zero-discard" 원칙과 2건 충돌** (아래 발견 사항 §1) |

---

## 상세 리뷰

### 밀스톤 A — 페르소나

- `DEFAULT_SYSTEM_PROMPT`(`main.ts:79-101`)가 단일 상수로 5원칙(읽기 전용·환각 금지·출처 명시·불확실성 수치화·간결한 한국어)을 명시.
- **실측 검증 통과** — 2026-04-23 새벽 Discord DM 기록에서 매매 권유 0건, 모든 응답에 도구 호출 출처 첨부 확인.
- 아쉬운 점: 페르소나 전환 후에도 "오늘 상승세네요" 같은 **약한 예측성 어휘**가 새어나오는 케이스 관찰. 원칙 강제는 프롬프트만으로 불충분 — 후속 phase에서 deliver stage 검출 고려 여지.

### 밀스톤 B — 도구 3종 배선

- market → news → alerts 선형 의존 체인이 **키 가용성별 그레이스풀 스킵**으로 배선됨 (`main.ts:164-209`).
- `MarketSkillHandle`/`NewsSkillHandle`로 내부 상태(ProviderRegistry, MarketCache, NewsAggregator)를 외부 노출 → 다운스트림 배선이 깔끔.
- `alertMonitor` 수명주기를 `lifecycle.register`에 등록 → graceful shutdown 순서 보장.

### 밀스톤 C — 감사·출처

- `collectToolCalls`의 tool_use ↔ tool_result 페어링 로직이 단순 슬라이스 기반(`slice(i+1).find(...)`). 단일 응답 내 도구 1~3개 호출 시나리오에서는 충분하나, **동일 이름 도구 병렬 호출 시 오매칭 가능성** 있음 → `toolUseId`로 정확 매칭하므로 실제로는 안전 (코드 확인).
- `tool_calls` JSON 스키마 확장을 **DB 마이그레이션 없이** 처리 — `normalizeToolCallRecord`로 구 포맷(name만)과 신 포맷(full record) 양쪽 수용. 하위 호환 설계 우수.
- `getToolCallHistory` 헬퍼는 손상된 JSON을 `continue`로 스킵 — 금융 감사 관점에서는 경고 로그 발행이 더 낫다는 의견 가능 (phase23 개선 여지).

### 밀스톤 D — 부채 청산

- **D1 (`chatId` 근본 수정)** — Phase 21의 "DM 폴백으로 임시 우회"를 정면 해결. `MsgContext.chatId?` 필드 추가 + router에서 `msg.metadata.discordChannelId` 복사. `sender.ts`의 10003 fallback 정식 제거.
  - 단, `pipeline.ts:136`·`deliver.ts`의 `ctx.chatId ?? ctx.senderId` 패턴은 여전히 잔존 — **v1 호환**을 위한 의도적 fallback이므로 수용 가능. `chatId` 필수화는 다음 phase에서 타입 변경과 함께.
- **D2 (`!finclaw status`/`reset`)** — Phase 21-D에서 이관된 과제를 완료. `status`는 plan_2 Todo 8에서 추가 확장됨.
- **D3 (web healthcheck)** — `disable: true`로 최소 변경. 근본적으로는 web 전용 엔드포인트 추가가 더 깨끗하나, 스코프상 적절.

### plan_2 — Zero-Discard 활성화

- **ChannelDock 자동 등록** (`049b273`) — 레지스트리만 있고 부팅 호출이 없던 `CORE_DOCKS`(discord, http-webhook)가 정식 활성화. `initChannels()` 신규 한 함수로 주석 TODO 해소.
- **모델 폴백 체인** (`41dd175`) — 현재까지 가장 기술적 기여가 큰 변경. `runWithModelFallback`이 Anthropic 429/503/timeout을 자동 우회, `ProfileHealthMonitor`가 5분 슬라이딩 윈도우로 상태 기록. 단일 키 환경에서도 **"언제부터 API가 불안정했는지"** 관측 가능.
- **Port 점유 진단** (`6ed0fc2`) — 개발자 UX 개선. `lsof/netstat` fallback이 권한/바이너리 부재 시 `undefined` 반환 → 파이프라인 단절 없음. 적절히 방어적.
- **`auto-reply` barrel 축소** (`76443a6`) — 외부 소비 심볼만 남기고 스테이지 내부 함수는 상호 import 경로로 이전. 공개 API 표면이 깔끔해짐.

---

## 발견 사항

### 1. `d2a67d9`의 "dead code 제거"가 plan_2 원칙과 일부 충돌

plan_2.md는 **"다 의도되고 짜여진 코드들 버리는거 없이 가는게 목표"** (line 306)를 대원칙으로 선언하고, phase23+로 보존할 backbone을 명시 표로 제시했다. `d2a67d9`의 7건 삭제 중:

| 삭제 항목                                                                                         | plan_2 언급                                | 판정                       |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------- |
| `channel-discord` discordAdapter singleton                                                        | 없음                                       | OK                         |
| `config/test-helpers.ts`                                                                          | C4 범주에 누락                             | 경미 (테스트 유틸)         |
| `agent/InMemorySkillManager` (Phase 7 stub)                                                       | 없음                                       | OK                         |
| **`agent` OpenAI 어댑터 전면 제거**                                                               | plan_2 §2.1 "phase23+ 멀티프로바이더 전환" | ⚠️ **원칙 위반**           |
| **`response-formatter.ts`에서 `formatResponse`·`formatFinancialNumber` 제거** (splitMessage 유지) | plan_2 §3·§phase23+ 보존 명시              | ⚠️ **원칙 위반**           |
| `server/channels/gating/` 전체                                                                    | 없음                                       | OK (chatId 정상화 후 무용) |
| `server/services/cron/` + croner 의존성                                                           | 없음                                       | OK (setInterval/TTL 대체)  |

- 테스트 수 **1316 → 1284** (32개 감소).
- OpenAI 어댑터 제거는 "phase 22를 금융 파트너 스코프로 좁히는" 합리적 결정으로 해석 가능하나, **plan_2가 명시적으로 '보존'으로 지정한 항목을 삭제**한 것은 문서·코드 정합성 위반.
- `formatFinancialNumber`는 커밋 메시지의 `deliver stage already formats inline` 근거로 제거됐으나, **실측 확인 결과 deliver.ts는 면책 조항·출처 footer만 인라인 처리하며 금융 수치 포매팅은 수행하지 않는다**(`deliver.ts:16-75`). 즉 "인라인 대체됨"은 부정확하고, 실제 상태는 "해당 backbone이 미배선인 채로 삭제됨".

**채택 조치 — 옵션 B (문서를 코드에 맞춤)**:

- **2026-04-24 해소 완료** — `plan_2.md` §2.1에 "phase22 scope narrowing으로 d2a67d9에서 OpenAI 어댑터 삭제" 근거 추가, §3 `formatFinancialNumber` 보류 항목을 삭제 후 취소선 + 갱신 주석 처리, phase23+ 보존 backbone 표에서 `formatFinancialNumber` 행 제거 후 별도 "d2a67d9에서 삭제된 backbone" 표로 분리 명시.
- 옵션 A(revert) 미채택 — `d2a67d9`의 scope narrowing은 금융 파트너 범위 확정이라는 phase22 실질 의도와 합치. 대신 문서가 이 결정을 반영.

### 2. End-to-end 검증 시나리오 부분 실행

`plan.md` + `todo.md` + `todo_2.md` 말미에 공통으로 정의된 **9단계 Discord DM 검증**:

| #   | 시나리오                         | 실측 확인               |
| --- | -------------------------------- | ----------------------- |
| 1   | 자기소개 → 금융 파트너 페르소나  | 미확인                  |
| 2   | "AAPL 주가" → footer 첨부        | ✅ (Oracle/MSFT로 실측) |
| 3   | "최근 뉴스" → Alpha Vantage News | ✅ (MSFT/4-22 시장)     |
| 4   | "150달러 되면 알림"              | 미확인                  |
| 5   | "내 알림 목록"                   | 미확인                  |
| 6   | `!finclaw status`                | 미확인                  |
| 7   | `!finclaw reset`                 | 미확인                  |
| 8   | "다음 주 주가" → 예측 거절       | 미확인                  |
| 9   | "매수해줘" → 읽기 전용 거절      | 미확인                  |

- 2/9 부분 확인. **머지 전 나머지 6건 DM 실측 권장** — 특히 4/5(알림 flow)와 8/9(원칙 준수)는 Phase 22의 정체성 검증.

### 3. 잔존 TODO

- `packages/server/src/auto-reply/stages/command.ts:41` — 권한 시스템 (사용자 역할 vs `requiredRoles` 비교). plan_2에서 phase23 이관 명시.
- `packages/storage/src/database.ts:70` — `memory_chunks.hash` nullable 유지, 차후 NOT NULL 마이그레이션 예정.
- `packages/server/src/channels/dock.ts:5` — `Partial<ChannelCapabilities>` + defaults 병합 재도입 권장.

모두 phase22 범위 밖으로 의도된 TODO. 문서화 상태 양호.

### 4. 리팩토링 후보 (즉시 불필요)

1. **`RunnerExecutionAdapter`의 DI 표면 과대화** — `storage`, `toolRegistry`, `logger`, `modelCatalog`, `modelAliasIndex`, `fallbackChain`, `profileHealth`, `profileId`, `systemPrompt`, `defaultModel` 10개 필드. phase22 요구로 자연스럽게 커졌으나, phase23에서 "AgentContext"류로 묶어낼 여지.
2. **`collectToolCalls`가 slice + find로 O(n²)** — 현재 턴 수 ≤ 10이라 실측 영향 없음. 프로덕션에서 대화 길어지면 Map 기반 인덱싱 고려.
3. **`main.ts`의 하드코딩 상수** — `DEFAULT_MODEL`, `DEFAULT_SYSTEM_PROMPT`, `defaultConfig`(gateway)가 모두 `main.ts`에 있음. `config` 패키지 전면 도입이 다음 phase의 자연스러운 후속.

---

## 측정값

| 지표                | 값                                           |
| ------------------- | -------------------------------------------- |
| 커밋 수 (main 대비) | 20                                           |
| Todo 완료           | plan.md 10/10 · plan_2.md 8/8                |
| 계획 외 커밋        | 1건 (`d2a67d9` dead-code 정리)               |
| 테스트 수           | 1316 → 1284 (−32, 삭제된 모듈 연쇄)          |
| DB 마이그레이션     | 없음 (JSON 컬럼 내부만 확장)                 |
| 신규 외부 의존성    | 없음                                         |
| 제거된 외부 의존성  | `croner` (cron 제거), `openai` (어댑터 제거) |
| 작업 트리           | clean                                        |
| 원격 동기화         | origin/feature/finance-partner 일치          |

---

## 권고 — 머지 가능 여부

**조건부 YES.** 머지 전 점검 체크리스트:

| #   | 항목                                                           | 상태                                                                          |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | plan_2.md 문서-코드 정합 (§1 옵션 B)                           | ✅ 2026-04-24 완료 (§2.1 근거 추가, §3 보류 항목 갱신, phase23+ 보존 표 분리) |
| 2   | review.md의 "response-formatter.ts 전체 삭제" 부정확 표현 수정 | ✅ 2026-04-24 완료                                                            |
| 3   | 검증 시나리오 4 — 알림 설정 (`set_alert`) DM 실측              | ⏳ 사용자 확인 대기                                                           |
| 4   | 검증 시나리오 5 — 알림 조회 (`list_alerts`) DM 실측            | ⏳ 사용자 확인 대기                                                           |
| 5   | 검증 시나리오 9 — 매매 요청 거절 (읽기 전용 원칙) DM 실측      | ⏳ 사용자 확인 대기                                                           |
| 6   | `feature/finance-partner` → `main` 머지                        | ⏳ 3·4·5 통과 후                                                              |

**Phase 23 자연스러운 후속** (plan_2에서 넘어온 backbone + 신규):

- (a) 권한 시스템 — `commandStage`의 TODO, `requiredRoles` 대응
- (b) 다중 API 키 — `InMemoryAuthProfileStore.selectNext` 배선
- (c) 대화 검색 — `!finclaw search`, `storage/search/` FTS + vector
- (d) config 패키지 전면 도입 — `DEFAULT_MODEL`·`DEFAULT_SYSTEM_PROMPT`·gateway 상수를 `main.ts`에서 이관
- (e) (선택) 멀티프로바이더 복귀 — d2a67d9에서 삭제된 OpenAI 어댑터 재구현 여부 결정
