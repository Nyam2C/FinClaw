# Automation Deep-Dive (HIGH 신뢰도)

> 직접 읽은 OpenClaw 모듈: `cron/{service.ts, normalize.ts, parse.ts, schedule.ts, stagger.ts, validate-timestamp.ts, run-log.ts, session-reaper.ts, delivery.ts, legacy-delivery.ts, payload-migration.ts}` + `cron/service/{ops.ts, jobs.ts, timer.ts, state.ts, store.ts}` + `agents/tools/cron-tool.ts` + `gateway/server-methods/cron.ts`.
> 직접 읽은 FinClaw 모듈: `automation/{scheduler.ts, cron.ts, delivery.ts, scheduler.test.ts, cron.test.ts}` + `gateway/rpc/methods/schedule.ts` + `storage/schedules.ts` + `web/views/schedule-form.ts` + `server/main.ts:410-500` + `auto-reply/pipeline.ts`.

## 한 줄 결론

**시나리오 A(12시 정기 보고)는 FinClaw 에서 정상 동작한다 — 등록·발동·실행·전달·실패추적 5단계 모두 코드로 증명됨. 단 자연어 발화 → cron 등록(시나리오 B), 재시작 시 missed-job catch-up, top-of-hour stagger, error backoff, schedule 1초 자체 수정 가능성, run-log JSONL 등 OpenClaw 의 운영 회복력 8종이 부재하여 "조용히 잘못 동작할 위험" 은 남아 있다.**

---

## OpenClaw 자동화 시스템 라이프사이클 (직접 읽고 작성)

### 1. Schedule 등록 — 3 진입점

| 진입점           | 경로                                                           | 흐름                                                                                                                                                      |
| ---------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RPC**          | `gateway/server-methods/cron.ts:24` `cronHandlers["cron.add"]` | params → `validateCronAddParams` → `normalizeCronJobCreate` → `context.cron.add(input)`                                                                   |
| **Agent tool**   | `agents/tools/cron-tool.ts:31-47` (`CronToolSchema`)           | LLM 도구 호출 → `callGatewayTool("cron.add", ...)` → 위 RPC 와 동일 경로. **자연어 → tool call 변환은 LLM 본인이 수행, OpenClaw 가 별도 normalize 안 함** |
| **CLI / Config** | `cli/cron-cli/register.cron-add.ts`                            | 부팅 시 config 의 cron 정의 읽기                                                                                                                          |

**Normalize (`cron/normalize.ts:288-462`):**

- `unwrapJob` (data/job 래핑 해제, line 189-197)
- `coerceSchedule` (line 24-73): `kind` ∈ `{at, every, cron}` 추론, `atMs` ↔ ISO `at` 변환, `staggerMs` 정규화
- `coercePayload` (line 75-154): `agentTurn` / `systemEvent` 분기, legacy `provider` 필드 → `migrateLegacyCronPayload`
- `coerceDelivery` (line 156-187): `mode` ∈ `{announce, none, webhook}`, channel 소문자
- `applyDefaults`: `wakeMode='now'`, `enabled=true`, `at` 류는 `deleteAfterRun=true`, top-of-hour cron 은 자동 stagger 5분
- `validateScheduleTimestamp` (`validate-timestamp.ts:24-66`): `at` schedule 의 시각이 1분 이상 과거이면 reject, 10년 이상 미래면 reject

### 2. Cron 파서 + 정규화

- **expression parser**: `croner` 외부 라이브러리 (`schedule.ts:1`) — 5/6 필드 cron, timezone 지원
- **timezone**: `resolveCronTimezone(tz)` (line 5-11) — `schedule.tz` 우선, 없으면 `Intl.DateTimeFormat().resolvedOptions().timeZone`
- **same-second guard** (`schedule.ts:67-77`): croner 가 "지금" 또는 그 이전을 반환하면 다음 초 경계로 재계산 — 무한 재발동 방지

### 3. Polling + Stagger

- **timer 무장** (`service/timer.ts:253-292`): `armTimer(state)` 가 모든 enabled job 의 최소 `nextRunAtMs` 계산 → 시각까지 `setTimeout`. 단 `MAX_TIMER_DELAY_MS=60_000` 으로 clamp 하여 wall-clock 점프/일시정지 회복 보장.
- **due 검색** (`timer.ts:459-512`): `findDueJobs` → `collectRunnableJobs` → `isRunnableJob` (job.enabled, runningAtMs 비어 있음, nextRunAtMs ≤ now)
- **Stagger** (`stagger.ts` + `service/jobs.ts:30-64`): top-of-hour 정각(`0 * * * *` 류) cron 은 SHA-256(jobId) 기반 0~5분 안정 offset 분산. 여러 job 이 동시 실행되어 모델/네트워크 spike 일으키는 것을 회피.
- **concurrency** (`timer.ts:87-93, 382-398`): `cronConfig.maxConcurrentRuns` (기본 1) 만큼 worker 풀, 같은 tick 의 due job 들을 병렬 실행

### 4. 실행

- **per-tick 흐름** (`timer.ts:305-457` `onTimer`):
  1. `state.running` true 면 `armRunningRecheckTimer` (지속 실행 중에도 watchdog 유지) — issue #12025
  2. `findDueJobs` → 각 job 의 `runningAtMs=now` 표시 + persist (다른 timer tick 의 중복 실행 방지)
  3. `executeJobCoreWithTimeout` (job 별 timeout, 기본 10분)
  4. `executeJobCore` (line 605-771): `sessionTarget==='main'` 이면 enqueueSystemEvent + heartbeat, `'isolated'` 면 `runIsolatedAgentJob`
  5. heartbeat busy 처리: `wakeNowHeartbeatBusyMaxWaitMs` (기본 2분) 까지 retry, 그 후 `requestHeartbeatNow` fire-and-forget
  6. 결과를 `applyOutcomeToStoredJob` 으로 저장
- **lane 직렬화**: 별도 `ConcurrencyLane` 추상화 없음 — `state.running` flag + per-job `runningAtMs` 로 단순 직렬화

### 5. Delivery

- **plan 결정** (`cron/delivery.ts:30-79` `resolveCronDeliveryPlan`):
  - `mode` ∈ `{announce, webhook, none}`
  - `channel` 우선순위: `delivery.channel` → `payload.channel` → `'last'` (마지막 사용 채널)
  - `to` 우선순위: `delivery.to` → `payload.to`
  - legacy `payload.deliver=true/false` + `to` 만으로도 announce 추론
- **다중 채널 fanout**: announce 결과를 `summaryText` 로 main session 에 enqueue (`timer.ts:738-758`) → 사용자가 어느 채널에서든 결과 수신
- **delivery suppress** (line 740-742): isolated job 이 이미 `delivered=true` (자체 도구 호출로 송출 완료) 면 main 에 또 enqueue 하지 않음 — duplicate 방지 (issue #15692)
- **per-channel validation**: telegram URL 형식 검증 (`service/jobs.ts:86-101`), webhook URL `http(s)://` 강제 (`service/jobs.ts:107-114`)

### 6. 실패 처리

- **연속 실패 백오프** (`timer.ts:108-119, 188-204`):
  ```
  ERROR_BACKOFF_SCHEDULE_MS = [30s, 1m, 5m, 15m, 60m]
  ```
  연속 에러 N회 → `Math.max(naturalNext, endedAt + backoff)` — 정상 다음 실행과 백오프 중 더 늦은 쪽
- **schedule compute 에러** (`service/jobs.ts:181-210`): cron 자체 계산이 실패하면 `scheduleErrorCount++`, 3회 → `enabled=false` 자동 비활성. 일반 실행 에러와는 별개 카운터
- **one-shot 자동 disable** (`timer.ts:170-187`): `kind='at'` job 은 어떤 status 든 종료 후 항상 disable (tight-loop 방지, issue #11452)
- **min refire gap** (`timer.ts:30, 211-214`): cron job 이 같은 초에 재발동 못 하도록 2초 강제 gap (issue #17821)
- **stuck running marker** (`service/jobs.ts:236-244`): `runningAtMs` 가 2시간 이상 지나면 stale 로 간주, 클리어 + 다음 tick 재시도
- **startup interrupted** (`service/ops.ts:95-110`): 부팅 시 `runningAtMs` 가 남아있으면 프로세스 비정상 종료로 간주, 클리어
- **runMissedJobs** (`timer.ts:514-592`): 부팅 후 즉시 과거 due job 을 catch-up 실행 (단 one-shot 은 lastStatus 있으면 skip)

### 7. Session-reaper

- **목적** (`session-reaper.ts:1-7`): cron isolated run 이 만든 임시 session (`...:cron:<jobId>:run:<uuid>`) 을 retention 후 prune. base session (`...:cron:<jobId>`) 은 보존
- **실행 주기**: timer tick 에 piggyback (`timer.ts:421-452`), `MIN_SWEEP_INTERVAL_MS=5분` 자체 throttle
- **retention**: `cronConfig.sessionRetention` (기본 24시간), `false` 면 prune 비활성
- **lock 순서**: cron service 의 `locked()` 밖에서 호출 — lock-order inversion 방지

### 8. Run history

- **JSONL append-only** (`run-log.ts:98-123` `appendCronRunLog`):
  - 경로: `runs/<jobId>.jsonl`
  - per-path serialization (`writesByPath` Map) — 동시 append 충돌 방지
  - prune: 2MB 초과 시 마지막 2000줄만 유지 (line 80-96 `pruneIfNeeded`)
- **paginated read** (`run-log.ts:281-324`): status 필터(`ok/error/skipped`), deliveryStatus 필터, query, sort, offset/limit
- **cross-job aggregation** (`run-log.ts:326-399` `readCronRunLogEntriesPageAll`): `runs/` 폴더 모든 `.jsonl` 합쳐 정렬

---

## FinClaw 자동화 시스템 라이프사이클 (직접 읽고 작성)

### 1. Schedule 등록 — 1 진입점

| 진입점           | 경로                                                                                                                          | 흐름                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **RPC**          | `packages/server/src/gateway/rpc/methods/schedule.ts:107-145` `schedule.create`                                               | Zod 검증 → `parseCron(params.cron)` (선검증) → `computeNextRunAt` → `addSchedule(db, ...)` |
| ~~Agent tool~~   | **부재** — `cron-tool.ts` 에 해당하는 LLM 도구 없음. 사용자가 발화로 "매일 12시에 보고해줘" 라 해도 agent 가 호출할 수단 없음 |
| ~~CLI / Config~~ | **부재** — config 파일에 schedule 정의를 직접 읽는 부팅 경로 없음                                                             |

**Normalize** — **부재** (Misimplemented):

- Zod schema (line 111-120) 가 시각 형식·channel·target 만 검증
- legacy field 호환·자동 stagger·`at` vs `every` vs `cron` kind 분기 없음. FinClaw 는 5필드 cron 만 지원하기 때문 (단순화 정당하나 `at`/`every` 부재가 사용자 가치 손실)
- `validateScheduleTimestamp` 류 시각 sanity 검증 없음 (cron 만 지원하므로 불필요, 단 cron 표현식 자체의 sanity 는 `parseCron` 에서 throw)

### 2. Cron 파서 + 정규화

- **자체 구현** (`automation/cron.ts:43-100` `expandField` + `parseCron`): `*`, `*/N`, `M-N`, `M,N` 만. **`L`, `W`, `?`, alias(`@daily`), 6필드 (초 포함), timezone 비지원** (line 4)
- **timezone** = 항상 시스템 local TZ. `Intl.DateTimeFormat().resolvedOptions().timeZone` 같은 명시적 처리 부재
- **POSIX dom-OR-dow rule** (line 128-142): OpenClaw `croner` 가 처리하는 것을 직접 구현
- **same-second guard 부재**: `nextRunAt` 가 분 경계로 올림 후 +1분 (line 148-150) 하므로 cron 발동 시점에 자체 호출은 발생 안 함, 안전 — 단 future cron 표현식 변경 시 보장 약함

### 3. Polling + Stagger

- **`SchedulerService.start`** (`scheduler.ts:78-94`): 다음 분 0초 경계까지 대기 → 첫 tick → `setInterval(60_000)` 로 매 분 폴링
- **Stagger 부재**: 같은 시각에 발동되는 모든 schedule 이 같은 tick 에 lane queue 에 enqueue. `lane.maxConcurrent=1` 이므로 자동 직렬화되지만, **사용자가 `0 9 * * *` schedule 5개 등록하면 9시 0분에 5개 모두 동시에 큐 → 순차 실행되어 마지막 schedule 결과는 5분 이상 지연** (Claude API 한 번당 ~30~60초)
- **concurrency**: `ConcurrencyLane` 추상화로 1로 제한 (`main.ts:423` `scheduleLane`). OpenClaw 의 `maxConcurrentRuns` 와 같은 사용자-튜닝 가능 설정은 없음

### 4. 실행

- **`runOne`** (`scheduler.ts:163-350`):
  1. `active.add(s.id)` (per-schedule 중복 lock)
  2. `lane.acquire(s.id)` 로 전역 직렬화
  3. session key 생성, agent dispatcher 빌드 (`buildDispatcher`)
  4. AbortController + per-schedule timeout (기본 60s, OpenClaw 는 10분)
  5. `runWithModelFallback` (model floor + alias) — Phase 25 모델 fallback 사용
  6. `addAgentRun(db, ...)` 로 agent_runs 영속화 + `schedule_id` 갱신 (line 247-259)
  7. 실패 시도 동일 경로로 row 저장하되 `error` 필드만 (line 268-278)
  8. `markScheduleRun(db, s.id, runId, now, nextMs)` (line 297)
  9. 연속 실패 카운팅 + 임계 도달 시 disable (line 300-317)
  10. `onRunComplete(args)` 콜백 (line 329-344) — main.ts 에서 `deliverScheduleResult` 주입

- **tick 중복 방지** (`scheduler.ts:144-158`): 같은 schedule 이 다음 tick 까지 안 끝났으면 skip + `markScheduleRun` 으로 next 만 갱신
- **lane vs active set 이중 보호** (line 164, 167): `active.has(s.id)` 빠른 반환 + `lane.acquire` 로 큐잉

### 5. Delivery

- **`deliverScheduleResult`** (`automation/delivery.ts:52-109`):
  - `deliveryChannel === 'discord'` 분기 → `discordClient.users.fetch(target).createDM().send(text)`
  - `'web'` 분기 → `broadcaster.broadcastToChannel(connections, 'schedule.completed', payload)`
- **format** (line 33-50 `formatDiscord`):
  - 헤더 `**[name]**`, 본문 (또는 `_⚠️ 실행 실패: <error>_`), 푸터 `_<ts> 자동 실행 · #<8자>_`
  - 2000자 초과 시 본문 truncate + `…(잘림)` 마커
- **재시도 X** (line 3): 단일 시도 후 실패하면 warn 로그 + agent_runs 만 보존
- **suppress 로직 부재**: agent 가 자체 도구로 이미 송출했더라도 schedule.completed 가 또 발사됨 — OpenClaw 의 issue #15692 패턴 미구현 (단 FinClaw 는 도구로 채널 송출하는 시나리오가 없으므로 현재는 무해)

### 6. 실패 처리

- **연속 실패 카운터 + auto-disable** (`scheduler.ts:300-317`): N회 연속 실패 → `status='failing'`, 임계(`maxConsecutiveFailures` 기본 3) 도달 → `enabled=false, status='disabled'`. 성공 시 0 으로 reset (line 312-317)
- **백오프 부재**: 실패해도 다음 cron 시각에 다시 시도. OpenClaw 의 exponential backoff [30s,1m,5m,15m,60m] 같은 보호 없음 — 매분 cron `* * * * *` 이 매번 실패하면 1분마다 즉시 재시도
- **schedule compute 분리 부재**: cron 표현식 자체가 깨져도 별도 카운터 없음. `scheduler.ts:286-296` 가 cron parse 에러를 swallow 후 `markScheduleRun(... null)` — `next_run_at = NULL` 이 되어 `findDueSchedules` 의 `next_run_at IS NOT NULL` 조건에 의해 자동 정지 (조용한 비활성, 사용자에게 가시성 없음)
- **stuck running 회복 부재**: scheduler 가 비정상 종료되어 `active` Set 이 in-memory 만 남아있는 상황은 process restart 로 해결됨 (Set 은 휘발). 단 `markScheduleRun` 미호출 상태로 종료되면 `next_run_at` 이 갱신되지 않아 다시 due 가 되므로 자체 catch-up — **이는 OpenClaw 의 `runMissedJobs` 와 비슷한 효과를 우연히 만들어내고 있음**
- **stop 시 graceful drain** (`scheduler.ts:96-116`): 60초까지 active.size==0 대기 후 강제 종료

### 7. Session-reaper

**부재.** FinClaw 의 schedule 실행은 매번 `randomUUID()` 로 새 sessionKey 생성 (`scheduler.ts:174`) 후 chat 컨텍스트를 영속화하지 않음 — agent_runs 테이블에만 행이 추가될 뿐, openclaw 의 sessions.json 같은 별도 저장소가 없음. 따라서 reaper 가 필요 없음 (정당한 단순화).

### 8. Run history

- **agent_runs SQL 직접 조회** (`schedule.ts:265-308` `schedule.history`):
  - schedule_id 필터 + `created_at DESC LIMIT N` (max 200)
  - prompt/output 200/500자 truncate
- **JSONL 회전 부재**: SQLite 이므로 RDBMS 스타일. 파일 회전·prune 불필요. 단 무한히 누적되어 디스크 사용 추적 부재 — Phase 28 plan 에 cleanup job 언급 있는지 확인은 별도 (`packages/server/dist/services/cron/jobs/cleanup.js` 가 있다는 것은 빌드 산출물에 보임 — 별도 cleanup 경로 존재 가능성)

---

## 시나리오 A 종단 추적 (12시 포트폴리오 보고)

| 단계                    | OpenClaw                                                                                                                                                                                                                                                               | FinClaw                                                                                                                                                                                                                       | 차이                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **등록**                | 사용자가 LLM 에 발화 → agent 가 `cron-tool.ts` 호출 → `cronHandlers["cron.add"]` (`gateway/server-methods/cron.ts:24`) → `normalizeCronJobCreate` (`normalize.ts:464`) → `createJob` (`service/jobs.ts:345-399`) → `staggerMs` 자동 5분 적용 → DB persist → `armTimer` | Web UI 모달(`schedule-form.ts:218-294`) → `schedule.create` RPC (`schedule.ts:121-144`) → `parseCron` 선검증 → `addSchedule` (`storage/schedules.ts:92-119`) → DB INSERT. **agent 가 자기 발화로 등록할 수단 없음 (Missing)** | FinClaw: 자연어 등록 경로 부재                                                                                  |
| **발동**                | `armTimer` 가 정확히 12:00:00 - offset 시점에 `setTimeout` → `onTimer` (`timer.ts:305`) → `findDueJobs` → 5분 stagger 로 12:00~12:05 사이 분산                                                                                                                         | 매분 0초 폴링 → 12:00 첫 tick 에 due 검출 → `runOne` (`scheduler.ts:163`). **stagger 없음 — 같은 12시 schedule 5개면 lane 직렬 5분 지연**                                                                                     | FinClaw: top-of-hour spike 보호 부재                                                                            |
| **실행**                | `executeJobCore` → isolated agent run (`runIsolatedAgentJob`) → 도구 호출 → `summary` 반환. `wakeMode=now` 면 heartbeat 즉시 트리거 (busy retry up to 2분)                                                                                                             | runner.execute (Phase 25 model fallback 포함) → `extractAssistantText` → tool calls 수집 → 60초 timeout (default)                                                                                                             | 둘 다 abort + timeout 보장. FinClaw 의 60초 default 가 LLM long-thinking 에는 부족 가능 (OpenClaw 10분 default) |
| **결과 저장**           | `applyJobResult` (`timer.ts:136-224`) → store 파일에 next_run_at 갱신 + lastStatus + JSONL `appendCronRunLog` (`run-log.ts:98`)                                                                                                                                        | `addAgentRun` → `agent_runs` row + `schedule_id` link, `markScheduleRun` → `schedules.last_run_at/last_run_id/next_run_at` UPDATE                                                                                             | FinClaw 가 SQLite RDBMS 라 join 가능, OpenClaw 는 store + JSONL 분리                                            |
| **Delivery**            | `resolveCronDeliveryPlan` → announce 라면 main session 에 enqueue → main agent 가 깨어나 사용자 채널로 송출 (간접)                                                                                                                                                     | `onRunComplete` 콜백 → `deliverScheduleResult` → `deliveryChannel==='discord'` 면 `users.fetch(id).createDM().send(text)` 직접 송출. `'web'` 이면 `broadcastToChannel('schedule.completed', payload)` (직접)                  | FinClaw 가 더 직접적·단순. OpenClaw 는 main agent 깨우는 추가 hop                                               |
| **실패 시**             | exponential backoff + 3회 schedule 에러 시 자동 disable + 운영 가시성 (lastError, deliveryError 분리)                                                                                                                                                                  | 3회 연속 실패 시 `enabled=false, status='disabled'`. 백오프 없이 다음 cron 시각 그대로 재시도                                                                                                                                 | OpenClaw 의 backoff [30s,1m,5m,15m,60m] 부재로 `* * * * *` 매분 실패 시 retry storm 가능                        |
| **1주 후 history 조회** | `gateway/server-methods/cron.ts` 의 `cron.runs` → `readCronRunLogEntriesPage` JSONL 파싱 + status/delivery 필터 + paginate                                                                                                                                             | `schedule.history` RPC (line 265) → `agent_runs` 직접 SQL `WHERE schedule_id = ? ORDER BY created_at DESC LIMIT 200`. 필터 단순                                                                                               | FinClaw 는 SQL 인덱스 활용 가능 (1주 = ~7행), OpenClaw 는 JSONL 라인 스캔. 양쪽 다 사용자 가시성 충분           |

**시나리오 A 결론**: **FinClaw 에서 정상 동작 (Y)**. 12시 0분에 정확히 발동 → agent 실행 → discord/web 송출 → 실패 시 재시도 → 3회 실패 시 disable → history 조회까지 모두 코드로 검증됨 (`scheduler.test.ts` 의 3 시나리오 + `cron.test.ts` 의 nextRunAt). 단 **stagger 부재** 와 **백오프 부재** 가 운영 안정성 차이를 만든다.

---

## 시나리오 B 종단 추적 (자연어 → cron 등록)

| 단계                | OpenClaw                                                                                                                                                                         | FinClaw                                                                                                                    | 차이                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **사용자 발화**     | "매주 월요일 9시에 알림 보내줘" → main agent 의 LLM 이 직접 `cron-tool` 호출                                                                                                     | 같은 발화 → main agent 의 LLM 이 호출할 도구 부재 → **자유 발화로 schedule 등록 불가능**                                   | FinClaw: **Missing**                                                                                                                                   |
| **LLM → cron 변환** | LLM 이 자체적으로 `expr: "0 9 * * 1"` 결정 후 `cron.add({schedule:{kind:"cron", expr:"0 9 * * 1"}, ...})` 호출. OpenClaw 측 normalize 는 LLM 이 만든 형식적 입력을 검증·정규화만 | (해당 경로 부재)                                                                                                           | FinClaw 사용자는 web UI 의 cron 필드를 직접 편집하거나 preset 4개(`schedule-form.ts:13-18`) 선택만 가능. "매주 월 9시" preset 은 있으나 자유 발화 불가 |
| **timezone 처리**   | `schedule.tz` 명시 또는 시스템 TZ. 사용자 "한국시간 9시" 같은 자연어를 LLM 이 IANA TZ로 변환 가능                                                                                | 항상 시스템 local TZ (cron.ts 가 `new Date(ms).getHours()` 사용) — 서버가 UTC 환경이면 사용자가 의도한 시각과 다를 수 있음 | FinClaw: TZ 명시 옵션 부재                                                                                                                             |

**시나리오 B 결론**: **FinClaw 에서 부재 (N)**. 자연어 → schedule 등록은 web UI 폼 입력으로만 가능. 사용자가 발화로 자동화를 요청하는 시나리오는 코드 경로가 없다. **즉시 개선 후보 #1**.

---

## 시나리오 C (실패 / stagger / reaper)

| 메커니즘                           | OpenClaw                                                                                               | FinClaw                                                                                                                                                                                                                       | 라벨           | 가치 (Claude+Discord 환경)                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **연속 실패 auto-disable**         | `consecutiveErrors` 3회 → 비활성 (`service/jobs.ts:181-210`, schedule-compute) + 별도 일반 실행 카운터 | `consecutiveFailures` 3회 → `enabled=false, status='disabled'` (`scheduler.ts:300-317`)                                                                                                                                       | Faithful       | 둘 다 폭주 방지 충분                                                                                                              |
| **Exponential backoff**            | `[30s, 1m, 5m, 15m, 60m]` (`timer.ts:108-119`)                                                         | **부재** — 다음 cron 시각에 그대로 재시도                                                                                                                                                                                     | Missing        | Critical+++. `* * * * *` 매분 실패 schedule 이 Claude API 무한 호출 → 비용/요금 위험. 사용자 1인 환경에서 즉각적 재정 영향        |
| **Top-of-hour stagger**            | 5분 SHA-256 기반 분산 (`stagger.ts`)                                                                   | **부재** — 모든 매시간 schedule 이 정각에 동시 큐잉 → lane 직렬화                                                                                                                                                             | Missing        | Important. Claude API rate limit (분당 토큰) 에 빠르게 도달, schedule 5개면 마지막은 ~5분 후 발동                                 |
| **Stuck-running 회복**             | `runningAtMs` 2시간 초과 → 클리어 + 재시도 (`service/jobs.ts:236-244`)                                 | scheduler restart 로 in-memory `active` Set 휘발하면 우연히 회복. **DB 에 running flag 없음**                                                                                                                                 | Adapted        | 메모리만 사용하므로 정당. 단 DB 마커 없으면 process 가 동일 schedule 두 번 동시 실행할 가능성 (1인 환경 = 1 process 가정 시 무해) |
| **Startup catch-up (missed jobs)** | `runMissedJobs` (`timer.ts:514-592`) — 부팅 시 과거 due job 즉시 실행                                  | scheduler.start 가 다음 분 경계까지 대기 후 시작. 그 사이 `next_run_at <= now` 인 row 가 첫 tick 에서 detect 되어 자동 catch-up. **One-shot 같은 케이스를 명시적으로 다루지 않음** (FinClaw 는 one-shot schedule 자체가 없음) | Adapted        | FinClaw 가 cron-only 라 부재 정당. 단 **장시간 process down → 다음 분 첫 tick 에 다 같이 due 로 잡혀 stagger 없이 폭주** 가능성   |
| **Schedule compute 에러 분리**     | `scheduleErrorCount` 별도 카운터 + 3회 → disable                                                       | `parseCron` 실패 시 swallow → `next_run_at=NULL` → `findDueSchedules` 가 자동 skip. 사용자에게 알림 없음                                                                                                                      | Misimplemented | "조용한 비활성" — 사용자가 schedule 가 안 도는 이유를 모름. log 만 warn                                                           |
| **Min refire gap (2초)**           | `MIN_REFIRE_GAP_MS=2000` (`timer.ts:31, 211-214`)                                                      | 분 단위 폴링이라 자체적으로 1분 gap 보장                                                                                                                                                                                      | Adapted        | FinClaw 는 분 단위라 불필요                                                                                                       |
| **Session-reaper**                 | 24시간 retention, 5분 throttle, base session 보존                                                      | **부재** (해당 저장소 없음)                                                                                                                                                                                                   | Adapted        | FinClaw 는 schedule 마다 sessionKey 영속화 안 함 — 정당                                                                           |
| **Run-log JSONL + prune**          | 2MB 회전 + 2000라인 유지 + per-path serialization                                                      | `agent_runs` SQLite, 무한 누적 (cleanup job 별도 dist 에 보임 — Phase 미상)                                                                                                                                                   | Adapted        | SQLite 면 디스크 사용량 모니터링/VACUUM 정책이 필요. 단 사용자 1인 schedule 5개 × 매일 × 1년 ≈ 1825 row 미만이라 실용적 무한      |
| **Heartbeat busy retry**           | wakeMode=now 시 2분까지 busy retry → 그 후 fire-and-forget                                             | 해당 개념 없음 (FinClaw 는 schedule = 직접 agent.run 호출, heartbeat 사이클 부재)                                                                                                                                             | Diverged       | 아키텍처 차이 — FinClaw 는 main session 을 깨우는 모델이 아님                                                                     |

---

## 매핑 매트릭스 (자동화 영역)

| OpenClaw 모듈                     | OpenClaw 경로                                                       | FinClaw 대응                                                                      | FinClaw 경로                              | 라벨           | 본질성        | 비고                                                                                      |
| --------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------- | -------------- | ------------- | ----------------------------------------------------------------------------------------- |
| Cron service core                 | `cron/service.ts` + `service/{ops,timer,state,jobs,store}.ts`       | SchedulerService                                                                  | `automation/scheduler.ts:69-351`          | Faithful       | Critical      | 골격 동일, OpenClaw 가 더 정교                                                            |
| Cron parser                       | `croner` 외부 lib + `schedule.ts:13-77`                             | 자체 5필드 parser                                                                 | `automation/cron.ts:43-160`               | Adapted        | Critical      | `at`/`every`/`L`/`W`/timezone 비지원. 단순화 정당                                         |
| Normalize                         | `cron/normalize.ts:288-462` (legacy 변환 + defaults)                | Zod schema 직접 검증                                                              | `gateway/rpc/methods/schedule.ts:111-120` | Misimplemented | Important     | legacy 호환·defaults 적용 부재. 단 FinClaw 는 v1 이라 legacy 자체가 없음 — 라벨 재고 가능 |
| Validate timestamp                | `validate-timestamp.ts:24-66` (1분 과거/10년 미래 reject)           | 부재 (cron only)                                                                  | —                                         | Adapted        | Nice-to-have  | `at` schedule 부재라 무의미                                                               |
| Stagger                           | `stagger.ts` + `service/jobs.ts:30-64` (SHA-256 offset)             | 부재                                                                              | —                                         | Missing        | Important     | top-of-hour spike 보호                                                                    |
| Schedule compute                  | `schedule.ts:13-77` (`croner.nextRun`)                              | `automation/cron.ts:146-160` (60s loop, 1년 limit)                                | —                                         | Faithful       | Critical      | 양쪽 모두 작동. FinClaw 는 분 단위로 simplified                                           |
| Service polling                   | `armTimer` + `setTimeout(nextWakeAtMs)` clamp 60s                   | `setInterval(60_000)` 정각 폴러                                                   | `scheduler.ts:78-94`                      | Adapted        | Critical      | OpenClaw 가 더 정밀(다음 due 까지 정확히), FinClaw 는 단순 1분                            |
| Concurrency                       | `cronConfig.maxConcurrentRuns` 병렬                                 | `ConcurrencyLane(maxConcurrent:1)`                                                | `main.ts:423`                             | Adapted        | Important     | 1인 환경 단일 직렬화 정당                                                                 |
| Per-job timeout                   | 기본 10분 (`DEFAULT_JOB_TIMEOUT_MS`)                                | 기본 60초 (`defaultTimeoutMs`)                                                    | `scheduler.ts:184`                        | Adapted        | Important     | LLM thinking 60초는 빠듯 — Claude Sonnet 4.6 long thinking 시 timeout                     |
| Error backoff                     | `[30s,1m,5m,15m,60m]` (`timer.ts:108-119`)                          | 부재                                                                              | —                                         | **Missing**    | **Critical**  | retry storm 위험                                                                          |
| Auto-disable on N failures        | `MAX_SCHEDULE_ERRORS=3` schedule + 일반 실행 별도                   | `maxConsecutiveFailures=3` 단일 카운터                                            | `scheduler.ts:300-317`                    | Faithful       | Critical      | OpenClaw 가 별도 카운터로 더 정밀                                                         |
| Stuck running 회복                | 2h timeout marker clear                                             | 부재 (in-memory Set)                                                              | —                                         | Adapted        | Nice-to-have  | 1 process 환경 정당                                                                       |
| Startup catch-up                  | `runMissedJobs` 명시적                                              | 첫 tick 에서 우연히 catch-up                                                      | —                                         | Adapted        | Important     | 정확히 동등하지 않음 (one-shot 처리 부재)                                                 |
| Delivery plan resolver            | `cron/delivery.ts:30-79` (mode/channel/to 우선순위)                 | discord/web 단순 분기                                                             | `automation/delivery.ts:62-103`           | Adapted        | Important     | 채널 2개라 단순화 정당                                                                    |
| Multi-channel fanout              | main session enqueue → main agent 가 채널 결정                      | discord 직접 send 또는 web broadcast                                              | —                                         | Diverged       | Important     | FinClaw 가 더 직접적                                                                      |
| Discord 2000자 처리               | per-channel formatter 라이브러리                                    | `formatDiscord` ad-hoc truncate                                                   | `automation/delivery.ts:33-50`            | Adapted        | Nice-to-have  | 단순                                                                                      |
| Run log JSONL                     | append + 2MB rotate + paginated read                                | SQLite `agent_runs` + `schedule.history` SQL                                      | —                                         | Adapted        | Important     | RDBMS 가 더 우월, prune 정책만 필요                                                       |
| Session-reaper                    | 24h retention, 5분 throttle                                         | 부재                                                                              | —                                         | Adapted        | Nice-to-have  | 해당 저장소 없음                                                                          |
| Cron RPC 카탈로그                 | `cron.{add,list,update,remove,run,runs,status,wake}` 8개            | `schedule.{create,list,update,delete,runNow,history,disable,enable,testCron}` 9개 | `schedule.ts:386-394`                     | Faithful       | Critical      | FinClaw 가 disable/enable/testCron 추가 — UX 우월                                         |
| Agent tool (자연어 등록)          | `agents/tools/cron-tool.ts`                                         | **부재**                                                                          | —                                         | **Missing**    | **Important** | 시나리오 B 가 동작 안 하는 핵심 원인                                                      |
| Web UI form                       | 부재                                                                | `web/views/schedule-form.ts` (preset + cron preview)                              | `schedule-form.ts:218-294`                | Faithful+      | Important     | FinClaw 가 우월 — testCron preview UI                                                     |
| Timezone                          | `schedule.tz` IANA 명시 가능                                        | 항상 시스템 local TZ                                                              | —                                         | Missing        | Important     | 서버 deploy TZ 와 사용자 의도 어긋날 위험                                                 |
| Hot-reload (config 기반 schedule) | `cli/cron-cli/register.cron-add.ts` 부팅 시 config 의 schedule 로드 | 부재                                                                              | —                                         | Missing        | Nice-to-have  | 1인 환경 + UI 등록으로 우회 가능                                                          |

총 23 패턴. 라벨 분포: Faithful 5, Adapted 11, Diverged 1, Missing 5, Misimplemented 1.

가중점수 계산 (Critical=3, Important=2, Nice=1; Faithful=100, Adapted=75, Diverged=50, Missing=25, Misimplemented=10):

| 라벨                                                                    | 본질성 가중점수 합산 |
| ----------------------------------------------------------------------- | -------------------- |
| Faithful 5 (3×Critical=900, 2×Important=400)                            | 1300                 |
| Adapted 11 (3×Critical=675, 5×Important=750, 3×Nice=225)                | 1650                 |
| Diverged 1 (Important=100)                                              | 100                  |
| Missing 5 (Critical=75[error backoff] + Important=50×3 + Nice=25 = 250) | 250                  |
| Misimplemented 1 (Important=20)                                         | 20                   |

가중치 합 = 3×4 + 2×11 + 1×3 + 3×1+2×3+1+2×1 추정 ≈ 50.
가중점수 합 ≈ 3,320.
**자동화 영역 가중평균 ≈ 66%** — 핵심 골격은 양호, 운영 회복력 5건이 결정적 누락.

---

## FinClaw 자동화의 즉시 개선 후보 (Claude+Discord 컨텍스트 우선)

### 1. **에러 backoff 추가** — Critical, ROI 최고

**왜 가장 중요한가**: `* * * * *` 매분 schedule + Claude API 일시 장애 = 분당 1회 실패 호출. 3회로 disable 되기 전까지 3분 동안 retry storm. 사용자 1인이지만 **Claude API 토큰 비용은 즉각적**.

**구현 (소량)**:

```typescript
// scheduler.ts:289 의 nextMs 계산 후, error 분기 추가
const BACKOFF_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
if (error && fresh) {
  const idx = Math.min(fresh.consecutiveFailures, BACKOFF_MS.length - 1);
  const backoffNext = Date.now() + BACKOFF_MS[idx];
  nextMs = nextMs ? Math.max(nextMs, backoffNext) : backoffNext;
}
```

- 추가 ≈ 8줄. 새 의존성 0.

### 2. **Top-of-hour stagger** — Important

**왜**: 사용자가 매시간/매일 12시 schedule 여러 개 등록하면 모두 정각에 lane 큐 → 마지막 schedule 이 ~수 분 지연 + Claude API rate limit 도달 가능.

**구현**:

- `schedule.id` 의 SHA-256 hash 로 0~5분 offset 계산 (`stagger.ts` 의 `resolveStableCronOffsetMs` 패턴)
- `nextRunAt` 계산 시 `expr` 가 `0 * * * *` 또는 `0 H * * *` 같은 정각 cron 이면 offset 적용
- 추가 ≈ 30줄. 새 의존성 0. OpenClaw `stagger.ts` 직접 참조 가능.

### 3. **자연어 등록 agent tool** — Important (시나리오 B 직접 해결)

**왜**: 사용자가 "매일 12시에 포트폴리오 보고해줘" 라고 발화해도 등록 못 하는 것이 가장 큰 사용자 가치 손실. CLAUDE.md 의 "비서" 정체성에 정면 위배.

**구현 (중간)**:

- `packages/agent/src/agents/tools/` 에 `schedule-tool.ts` 신설
- input: `name, cron, prompt, deliveryChannel='web'|'discord', deliveryTarget` (LLM 이 자연어 → cron 표현식 변환은 LLM 책임)
- LLM 이 cron 직접 못 만들면 보조 helper 추가: `naturalLanguageToCron("매일 12시")` — 단 Claude 4.6 은 충분히 cron 변환 가능, 별도 helper 불필요 가능
- gateway 의 `schedule.create` RPC 직접 호출
- 추가 ≈ 50~80줄

### 추가 (Top 4-5)

4. **Schedule compute 에러 가시성**: `parseCron` 실패 시 swallow → log+`status='disabled'` 로 명시적 표시. 사용자가 schedule 가 안 도는 이유를 web UI 에서 확인 가능. 추가 ≈ 5줄.
5. **Per-schedule timezone**: `schedules.tz` 컬럼 + `nextRunAt` 계산 시 IANA TZ 적용. 서버 deploy TZ 와 사용자 의도 분리. 추가 ≈ 20~30줄 (`Intl.DateTimeFormat({ timeZone })` 활용).

---

## 신뢰도 등급

- **HIGH** (대부분): 양쪽 코드 직접 비교, 함수 호출 그래프 추적 완료
- **MED** (1건): 매핑 매트릭스의 "Run log prune 정책" — FinClaw 의 `dist/services/cron/jobs/cleanup.js` 가 빌드 산출물에만 보임. src 검색은 cleanup 관련 없음 — cleanup 정책의 정확한 존부는 별도 확인 필요. **본 리포트는 보수적으로 "정책 명시 부재" 로 기록**.
- **LOW** 0건.

---

## 반환

- **산출물 경로**: `/mnt/c/Users/박/Desktop/hi/FinClaw/_workspace/openclaw-similarity/deep-automation.md`
- **한 줄 결론**: 시나리오 A 정상 동작(Y), 시나리오 B 부재(N), 시나리오 C 의 운영 회복력 8종 중 5종 누락 — 핵심은 error backoff + stagger + 자연어 등록 도구.
- **시나리오 A FinClaw 정상 동작**: **Y** (코드로 검증). `scheduler.test.ts` 의 3 테스트 + `cron.test.ts` + `schedules.storage.test.ts` 가 등록·발동·실패누적·history 모두 커버.
- **즉시 개선 후보 Top 3**:
  1. Error backoff `[30s, 1m, 5m, 15m, 60m]` — `scheduler.ts:289` 부근 8줄. Critical (비용 위험).
  2. Top-of-hour stagger — SHA-256(scheduleId) 기반 0~5분 offset, `cron.ts:nextRunAt` 후처리 ~30줄. Important.
  3. `schedule-tool.ts` agent 도구 신설 — 자연어 발화로 schedule 등록 가능, ~50~80줄. Important (CLAUDE.md 비서 정체성 정면).
