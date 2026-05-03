# Phase 28 Review — 자동화 (Scheduled Agent Runs)

> 산출물: 6개 커밋 (`06df988..d7ea682`), 신규 파일 11개, 변경 파일 9개. 1488 unit + 119 storage tests 통과. typecheck/lint/format/build clean.

## 1. 구현 사항 (Implementation)

### 1.1 스키마 (밀스톤 A)

| 항목                          | 위치                                                             |
| ----------------------------- | ---------------------------------------------------------------- |
| `Schedule` 도메인 타입        | `packages/types/src/automation.ts`                               |
| `schedules` 테이블 + 인덱스   | `packages/storage/src/database.ts` (SCHEMA_DDL + MIGRATIONS[6])  |
| `agent_runs.schedule_id` 컬럼 | 동상 (FK ON DELETE SET NULL)                                     |
| CRUD                          | `packages/storage/src/schedules.ts` (add/get/list/update/delete) |
| 폴러 진단                     | `findDueSchedules`, `markScheduleRun`                            |
| 마이그레이션 v5→v6            | function-based migration + idempotent column-existence guard     |

스키마 컬럼 16개: `id, name, cron, agent_id, prompt, delivery_channel(CHECK), delivery_target, enabled, timeout_ms, status(CHECK 'active|failing|disabled'), consecutive_failures, last_run_at, last_run_id, next_run_at, created_at, updated_at`. 인덱스 `idx_schedules_enabled_next ON (enabled, next_run_at) WHERE enabled = 1` 로 폴러 쿼리 가속.

### 1.2 cron 파서 + SchedulerService (밀스톤 B)

| 항목             | 위치                                          |
| ---------------- | --------------------------------------------- |
| 5필드 cron 파서  | `packages/server/src/automation/cron.ts`      |
| SchedulerService | `packages/server/src/automation/scheduler.ts` |

cron 지원 문법: `*` / `*/N` / `M-N` / `M,N,O` 조합. POSIX 의미 (`dayOfMonth` / `dayOfWeek` 모두 비-`*` 일 때 OR). 비지원: `L` `W` `?`. `nextRunAt` 은 분 경계로 올림 후 1년 brute-force.

SchedulerService 핵심:

- 다음 분 경계까지 보정 후 `setInterval(60_000)` 시작.
- `tick()` → `findDueSchedules(now)` → 각 schedule 마다 `runOne` (lane 직렬화, 동시 1개).
- 같은 schedule 이 다음 tick 까지 미완료면 skip + `markScheduleRun(nextRunAt 만 미루기)`.
- agent.run 호출 후 `addAgentRun` + `UPDATE agent_runs SET schedule_id = ?` 로 링크.
- 모델 fallback chain (`runWithModelFallback` + DEFAULT_FALLBACK_TRIGGERS) 활성.
- 연속 실패 추적: 임계 도달 시 `status='disabled' + enabled=false`, 성공 시 0 으로 리셋.
- Graceful shutdown: 진행 중 run 들 완료 대기 (60초 강제 timeout).

### 1.3 RPC + 송출 (밀스톤 C)

| 메서드              | 동작                                                                    |
| ------------------- | ----------------------------------------------------------------------- |
| `schedule.create`   | parseCron 검증 + nextRunAt 계산 + addSchedule                           |
| `schedule.list`     | enabled 필터, limit ≤ 200                                               |
| `schedule.update`   | partial; cron 변경 시 nextRunAt 재계산; enable=true 시 status reset     |
| `schedule.delete`   | `agent_runs.schedule_id` SET NULL                                       |
| `schedule.runNow`   | scheduler.triggerNow → lane 통과 후 즉시 실행                           |
| `schedule.history`  | `agent_runs WHERE schedule_id = ?` (truncate prompt 200, output 500)    |
| `schedule.disable`  | enabled=false                                                           |
| `schedule.enable`   | enabled=true + status=active + consecutiveFailures=0 + nextRunAt 재계산 |
| `schedule.testCron` | 등록 전 미리보기, sampleCount ≤ 20                                      |

송출 (`automation/delivery.ts`):

- `discord`: `DiscordClientPort` (port 패턴, discord.js 직접 의존 회피) → `users.fetch` → `createDM` → `send`. 2000자 초과 시 본문 truncate.
- `web`: `broadcaster.broadcastToChannel('schedule.completed', payload)`. WS 자동 구독 (`ws/connection.ts` 의 default subscriptions 에 추가).
- 송출 실패 시 warn 로그 + agent_runs 보존, 재시도 X.

### 1.4 Web UI (밀스톤 D)

| 컴포넌트             | 위치                                      |
| -------------------- | ----------------------------------------- |
| ScheduleClient       | `packages/web/src/app-gateway.ts`         |
| 등록 모달            | `packages/web/src/views/schedule-form.ts` |
| Settings 자동화 섹션 | `packages/web/src/views/settings-view.ts` |

UX:

- 자동화 추가 모달: cron preset 4개 (매시간 정각 / 매일 9시 / 매일 12시 / 매주 월 9시) + 250ms-debounced `testCron` 라이브 미리보기.
- 등록 후 테이블 즉시 갱신.
- `notification.schedule.completed` 수신 → 토스트 (3.5초 자동 소멸) + 테이블/실행이력 자동 갱신.
- 즉시 실행 / 활성·비활성 / 삭제 액션 행별 제공.

### 1.5 운영성 (밀스톤 E)

| 항목                   | 처리                                                              |
| ---------------------- | ----------------------------------------------------------------- |
| schedule timeout       | `Schedule.timeoutMs` 우선, 미설정 시 `defaultTimeoutMs ?? 60_000` |
| 연속 실패 자동 disable | env `AUTOMATION_MAX_CONSECUTIVE_FAILURES` (기본 3)                |
| 잘못된 cron 입력       | `schedule.create / update / testCron` 모두 `invalid_params`       |
| shutdown 중 실행       | `lifecycle.register(scheduler.stop)` + 60초 강제 timeout          |
| 시스템 시계 변경       | 매 트리거마다 `nextRunAt` 재계산하므로 자연 복구                  |
| schedule_id 정합성     | 삭제 시 `agent_runs.schedule_id` SET NULL (FK CASCADE 정책)       |

## 2. 리팩토링 사항 (Refactoring)

### 2.1 마이그레이션 시스템 함수형 확장

기존 `MIGRATIONS: Record<number, string>` 만 지원했던 구조를 `Record<number, string | (db) => void>` 로 확장. v6 가 첫 함수형 마이그레이션이며, **column-existence guard (PRAGMA table_info)** 를 통해 fresh DB / v3-DB / v5-DB 모두에서 안전하게 동작.

배경:

- SCHEMA_DDL 은 cumulative (현재 스키마의 truth) — fresh DB 가 한 번에 생성하는 경로.
- 기존 v5 DB 는 SCHEMA_DDL 의 `CREATE TABLE IF NOT EXISTS agent_runs (... schedule_id ...)` 를 no-op 으로 처리하므로 컬럼이 추가되지 않음 → 마이그레이션의 `ALTER TABLE` 이 필요.
- 반면 v3 → v6 점프 시 SCHEMA_DDL 이 `agent_runs` 를 `schedule_id` 포함해서 생성하므로, 마이그레이션 v6 가 무조건 ALTER 하면 `duplicate column` 에러.

해결: 함수형 마이그레이션이 `PRAGMA table_info('agent_runs')` 로 컬럼 존재 여부를 확인 후 조건부 ALTER. 인덱스 (`idx_agent_runs_schedule`) 는 `ensurePostMigrationSchema` 단계에서 idempotent 하게 생성 — 이는 SCHEMA_DDL 에 두면 v5-DB 의 SCHEMA_DDL 단계에서 "no such column: schedule_id" 로 실패하기 때문 (인덱스 정의 시점에 컬럼 존재 검증). fresh DB 도 누락 없이 인덱스 보장.

### 2.2 main.ts wireup 패턴 — lateinit delivery hook

scheduler 는 main.ts 초반부에 인스턴스화되어야 하지만 (`lifecycle.register` 등록 위해), delivery 는 `gateway.ctx.broadcaster` 와 `connections` 를 필요로 하는데 이는 `createGatewayServer` 호출 후에야 존재. 따라서 lateinit closure 패턴:

```ts
let deliveryHook: ((args: …) => Promise<void>) | null = null;
const scheduler = new SchedulerService({
  ...,
  onRunComplete: async (args) => { if (deliveryHook) await deliveryHook(args); },
});
const gateway = createGatewayServer(...);
deliveryHook = (args) => deliverScheduleResult({ broadcaster: gateway.ctx.broadcaster, ... }, args);
```

scheduler.start() 가 gateway.start() 후 호출되므로 첫 tick 시점엔 hook 이 항상 활성. 단순함을 위해 EventEmitter 나 별도 wiring 추상화 도입 X.

### 2.3 DiscordClientPort 재사용 가능한 패턴

`automation/delivery.ts` 가 `discord.js` 직접 의존을 피하기 위해 `DiscordClientPort` 인터페이스 (`users.fetch().createDM().send()`) 를 자체 정의. 이는 `skills-finance/alerts/delivery.ts` 의 동일 패턴과 일관 — 향후 공용 위치 (예: `@finclaw/types` 또는 `@finclaw/infra/discord-port.ts`) 로 추출 가능. 본 phase 에선 의도적으로 중복 (Phase 29+ 통합 후보).

### 2.4 ConcurrencyLane 재활용

기존 `ConcurrencyLane` (Phase 22 부터 사용) 을 schedule 전용 인스턴스로 신규 (`scheduleLane`, maxConcurrent=1, queueSize=50, waitTimeoutMs=5min). agent.run 큐잉 lane 과 격리되므로 사용자 대화·schedule 자동 실행이 서로 막지 않음. 새 lane 추상화 도입 X.

## 3. 사용자 테스트 사항 (User Testing)

### 3.1 자동 회귀 (CI 통과 필수)

```sh
pnpm typecheck            # 0 errors
pnpm lint                 # 0 warnings, 0 errors
pnpm format               # All matched files use the correct format
pnpm test                 # 1488 passed (cron + scheduler 단위 포함)
pnpm test:storage         # 119 passed (schedules CRUD + v5→v6 마이그레이션 포함)
pnpm build                # tsc --build 통과
```

### 3.2 수동 시나리오

준비 (개발 DB 백업):

```sh
DEV_DB="${HOME}/.finclaw/db.sqlite"
[ -f "$DEV_DB" ] && cp "$DEV_DB" "${DEV_DB}.pre-phase28.bak"
```

서버 기동:

```sh
pnpm dev   # 또는 pnpm --filter @finclaw/server dev
```

기대 로그:

- `Process lifecycle initialized`
- `Gateway listening on 0.0.0.0:3000`
- `scheduler.started` (event=scheduler.started, firstTickInMs=<60000 미만의 분 경계 보정 값>)

#### 시나리오 A — `schedule.testCron` 미리보기 (RPC 단독)

```sh
# JWT 또는 API 키 헤더 사용
curl -s -X POST http://localhost:3000/rpc \
  -H "x-api-key: $FINCLAW_API_KEY" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"schedule.testCron","params":{"expr":"*/5 * * * *","sampleCount":3}}' | jq
```

기대: `{ "result": { "nextRunsAt": [<ms1>, <ms2>, <ms3>] } }`, 모두 5분 단위 간격.

잘못된 cron:

```sh
curl ... -d '{"jsonrpc":"2.0","id":2,"method":"schedule.testCron","params":{"expr":"99 * * * *"}}'
```

기대: `error.message` 가 `invalid_params: cron parse error in minute: ...`.

#### 시나리오 B — Web UI 에서 자동화 등록 → 즉시 실행 → 토스트

1. 브라우저로 Web 클라이언트 접속 (`pnpm --filter @finclaw/web dev` 또는 정적 빌드 호스팅).
2. Settings 진입 → "자동화" 섹션 확인 (빈 테이블 + "+ 자동화 추가" 버튼).
3. "+ 자동화 추가" 클릭 → 모달.
4. preset "매일 12시" 클릭 → cron 필드가 `0 12 * * *` 로 자동 채워지고 "다음 실행: 2026-05-04 12:00:00 · ..." 형태 미리보기 표시.
5. 이름 "일일 보고", prompt "오늘 시장 한줄 요약", 송출 채널 "Web 알림" → 저장.
6. 테이블 즉시 갱신 + 행 1개 (status=active, 다음 실행=2026-05-04 12:00:00).
7. "즉시 실행" 클릭 → 토스트 "일일 보고: 즉시 실행 요청됨".
8. 1~2초 후 토스트 "자동화 완료: 일일 보고" 표시 (notification.schedule.completed 자동 수신).
9. "에이전트 실행 이력" 섹션 새로고침 → 새 row (output 부분 보임).
10. 행 클릭 → 상세 펼침 (prompt/output/metadata).

#### 시나리오 C — 비활성화 → 자동 트리거 스킵 확인

1. 시나리오 B 의 schedule 의 "비활성" 클릭 → 상태 badge 가 `disabled` (빨강).
2. cron 의 다음 분 경계 (예: 분 단위 schedule 이라면) 까지 대기.
3. 서버 로그에 해당 schedule 트리거 이벤트 없음 (findDueSchedules WHERE enabled = 1).

#### 시나리오 D — Discord DM 송출 (선택 — Discord 토큰 가용 시)

1. 새 schedule 등록: 송출 채널 = "Discord DM", 송출 대상 = 본인 Discord user_id.
2. 즉시 실행 → DM 도착 확인:

```
**[일일 보고]**

(agent.run output)

_2026-05-03 04:30:00 자동 실행 · #abc12345_
```

3. Discord 클라이언트 닫고 즉시 실행 → 서버 로그 `schedule.delivery.discord_failed` warn + agent_runs 는 보존됨 (`schedule.history` RPC 로 조회 가능).

#### 시나리오 E — 연속 실패 자동 disable

```sh
# AUTOMATION_MAX_CONSECUTIVE_FAILURES=3 (기본) 또는 환경변수로 1 설정 후 빠른 검증.
AUTOMATION_MAX_CONSECUTIVE_FAILURES=1 pnpm dev
```

prompt 를 `agent.run` 이 실패하도록 강제하는 형태로 등록 (예: 아주 큰 timeout 0 → 사실상 즉시 abort 는 timeoutMs 검증으로 차단되므로, 실제 검증은 `scheduler.test.ts` 의 mock runner 단위 테스트로 대체. 통합 환경에선 alert agent 가 사용 불가능한 toolset 을 강제하는 식으로 유도).

`pnpm test packages/server/src/automation/scheduler.test.ts` 가 본 시나리오의 단위 회귀 가드.

#### 시나리오 F — 서버 재시작 후 누락 없는 트리거

1. 시나리오 B 의 cron 을 `*/2 * * * *` 로 변경 (`schedule.update` RPC 또는 Settings 편집).
2. 서버 정지 (Ctrl+C, lifecycle.shutdown 호출).
3. 서버 로그 `scheduler.stopped` 확인.
4. 재기동.
5. 다음 짝수 분에 트리거 발생 (next_run_at 이 DB 에 영속화되어 있으므로 누락 없음).

### 3.3 마이그레이션 시뮬레이션

dev DB 가 v5 라면 자동으로 v6 마이그레이션 발생. 백업본으로 직접 검증:

```sh
DEV_DB_BAK="${HOME}/.finclaw/db.sqlite.pre-phase28.bak"
TMP=$(mktemp).sqlite
cp "$DEV_DB_BAK" "$TMP"
node -e "
const { openDatabase } = await import('./packages/storage/dist/database.js');
const d = openDatabase({ path: process.argv[1], enableWAL: false });
console.log('post-migration version:', d.schemaVersion);
const cols = d.db.prepare(\"PRAGMA table_info('agent_runs')\").all();
console.log('agent_runs.schedule_id:', cols.find(c => c.name === 'schedule_id') ? 'present' : 'MISSING');
const tbl = d.db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='schedules'\").get();
console.log('schedules table:', tbl ? 'present' : 'MISSING');
d.close();
" "$TMP"
rm -f "$TMP"
```

기대:

```
post-migration version: 6
agent_runs.schedule_id: present
schedules table: present
```

## 4. 알려진 한계 / 후속 (Phase 29+)

| 한계                    | 사유                   | 후속 안                                  |
| ----------------------- | ---------------------- | ---------------------------------------- |
| 자연어 cron 변환 X      | LLM 환각 위험          | 사용자 승인 필요한 변환 UI 별도 phase    |
| schedule 체인 X         | 단일 agent.run 만 지원 | 워크플로우 엔진은 별도 phase             |
| webhook 트리거 X        | cron 만 지원           | webhook trigger 별도 phase               |
| timezone 미지원         | 서버 시간대 기준       | 사용자별 timezone 설정 + per-schedule TZ |
| 자동 매매 X             | 읽기 전용 원칙         | 영구 범위 외                             |
| 송출 재시도 X           | 단순함 우선            | exponential backoff 옵션                 |
| Discord 메시지 truncate | 2000자 제한            | Web URL 첨부 (별도 인프라 필요)          |

## 5. 커밋 트레일

```
06df988 docs(phase28): add executable todo from plan.md
0d43196 feat(storage): add schedules table + CRUD with v6 migration (Phase 28 A)
39badd4 feat(server/automation): add cron parser + SchedulerService (Phase 28 B)
51483f2 feat(server/rpc): add schedule.* RPC + delivery + scheduler wiring (Phase 28 C)
f1f6958 feat(web): add automation Settings section + schedule form modal (Phase 28 D)
d7ea682 test(server/automation): add scheduler failure-handling regression (Phase 28 E)
```
