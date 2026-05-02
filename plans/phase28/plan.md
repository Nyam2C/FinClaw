# Phase 28 — 자동화 (Scheduled Agent Runs)

## Context

Phase 26 에서 FinClaw 는 **사용자 발화에 반응하는** 비서가 됐다. 발화가 없으면 동작하지 않는다. 사용자 결정·선호는 기억하지만 **시간 축으로 능동성이 없다**:

- "매일 12시에 내 포트폴리오 일일 보고" — 불가능
- "매주 월요일 9시에 watchlist 분석 리포트" — 불가능
- "장 마감 후 보유 종목 가격 변동 요약" — 불가능

현재 상태 (2026-05-03 기준):

1. **cron / scheduler 인프라 없음** — `grep -r "cron\|scheduler"` 결과 0건. 가까운 건 alert monitor 의 30초 폴링뿐 (정기 보고 X).
2. **agent.run 은 명시 호출만** — RPC `agent.run` 은 즉시 실행 1회. lifecycle 트리거 없음.
3. **결과 송출 채널 가용** — Discord adapter / Web WebSocket broadcast 가 동작 중. agent.run 결과를 사용자에게 도달시키는 경로는 이미 있음.
4. **agent_runs 영속화 가용 (Phase 26 D)** — 모든 agent.run 결과가 `agent_runs` 에 기록. 자동 트리거된 run 도 동일 테이블에 누적되면 감사 가능.

본 Phase 의 목표는 **시간 기반 능동 트리거** 를 더하는 것:

- **쓰는 것**: 사용자가 cron 표현으로 "언제 무엇을 실행할지" 등록
- **읽는 것**: scheduler 가 매 분 폴러로 cron 매칭 검사
- **실행하는 것**: agent.run 호출 → agent_runs 영속화 → 지정 채널로 결과 송출

읽기 전용 원칙은 **유지** — scheduler 가 자동으로 매매를 실행하지 않는다. 결과는 보고/분석 형태로만.

**사용자 결정 사항 (Phase 28 시작 전):**

- **cron 표현은 사용자 직접 입력** — 자연어 "매일 12시" → cron 변환은 LLM 사용 시 환각 위험. UI 에서 preset 제공하되 raw cron 도 허용.
- **5필드 cron** (분, 시, 일, 월, 요일). 초 미지원 — 개인 비서 정밀도 1분 충분.
- **트리거 = 1분 폴러** — 매 분 0초에 enabled schedules 순회 + cron 매칭 검사. 별도 wake-up 타이머 X (단순함).
- **실행 격리 = 전용 ConcurrencyLane(1)** — 동시 schedule 실행 1개로 제한. agent.run 큐잉 lane 과 별개로 schedule 전용. 1분 폴러가 다음 분에 트리거 시 이전이 안 끝났으면 skip + log.
- **결과 송출 채널 = Discord DM 또는 Web 알림 둘 중 하나** — schedule.create 시 명시. 둘 다는 불가 (단순함). 향후 확장 가능.
- **히스토리 = agent_runs 재사용** — 별도 `schedule_runs` 테이블 X. agent_runs 에 `schedule_id` 컬럼 추가 + source 식별.
- **읽기 전용 원칙 유지** — 자동 매매 / 자동 거래 등록 X. 분석 보고 / 알림만.

---

## 밀스톤 A — schedules 테이블 + storage CRUD

### 목표

cron 표현 + agent prompt + 송출 채널을 저장하는 `schedules` 테이블 신설. v5 → v6 마이그레이션.

### 전제

- `packages/storage/src/database.ts` SCHEMA_VERSION=5 (Phase 26 D 산출).
- `agent_runs` 테이블 가용 — `schedule_id` 컬럼 추가 필요.

### 작업

**파일**:

- `packages/storage/src/database.ts` (수정, ~50 LOC — v6 마이그레이션)
- `packages/storage/src/schedules.ts` (신설, ~120 LOC — CRUD + cron 매칭)
- `packages/storage/src/index.ts` (수정, re-export)
- `packages/types/src/automation.ts` (신설, ~30 LOC — Schedule 타입)

**스키마 v6 추가**:

```sql
CREATE TABLE schedules (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,                  -- 사용자 표시명 (예: "일일 포트폴리오 보고")
  cron            TEXT NOT NULL,                  -- 5필드 cron (예: '0 12 * * *')
  agent_id        TEXT NOT NULL,                  -- 실행할 에이전트
  prompt          TEXT NOT NULL,                  -- agent.run prompt
  delivery_channel TEXT NOT NULL CHECK (delivery_channel IN ('discord', 'web')),
  delivery_target TEXT NOT NULL,                  -- discord: user_id / channel_id, web: subscription_id
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_run_at     INTEGER,
  last_run_id     TEXT,                           -- agent_runs.id 링크 (FK ON DELETE SET NULL)
  next_run_at     INTEGER,                        -- 다음 트리거 예정 (cron 계산 결과)
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (last_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
);

CREATE INDEX idx_schedules_enabled_next ON schedules(enabled, next_run_at) WHERE enabled = 1;

-- agent_runs 에 schedule_id 컬럼 추가 (감사용)
ALTER TABLE agent_runs ADD COLUMN schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL;
CREATE INDEX idx_agent_runs_schedule ON agent_runs(schedule_id, created_at DESC) WHERE schedule_id IS NOT NULL;
```

**storage API**:

- `addSchedule(db, input) → Schedule`
- `getSchedule(db, id)`
- `listSchedules(db, opts: {enabled?, agentId?, limit?})`
- `updateSchedule(db, id, partial)` — cron 변경 시 next_run_at 재계산
- `deleteSchedule(db, id)` — agent_runs.schedule_id 는 SET NULL
- `findDueSchedules(db, now)` — `enabled=1 AND next_run_at <= now` 반환 (1분 폴러가 호출)
- `markScheduleRun(db, scheduleId, runId, nextRunAt)` — last_run_at/last_run_id/next_run_at 갱신

### 검증

- `addSchedule({cron: '0 12 * * *', ...})` → schedule 행 + next_run_at 계산
- 마이그레이션 v5 → v6: 기존 agent_runs 에 schedule_id NULL 컬럼 추가
- `findDueSchedules(now)` 가 enabled + next_run_at ≤ now 만 반환
- schedule 삭제 → agent_runs.schedule_id NULL (FK ON DELETE SET NULL)

---

## 밀스톤 B — SchedulerService + cron 파서 + 트리거

### 목표

매 분 0초에 폴러가 실행되어 `findDueSchedules` → 각 schedule 의 agent.run 트리거.

### 전제

- 밀스톤 A 완료 (schedules 테이블 + CRUD).
- agent.run 핸들러는 RPC 를 통해 호출 가능 — 직접 runner 호출도 가능.

### 작업

**파일**:

- `packages/server/src/automation/cron.ts` (신설, ~120 LOC — 5필드 cron 파서 + nextRunAt 계산)
- `packages/server/src/automation/scheduler.ts` (신설, ~180 LOC — SchedulerService 클래스, lifecycle 통합)
- `packages/server/src/main.ts` (수정, ~15 LOC — SchedulerService 인스턴스화 + lifecycle 등록)

**cron 파서** (`cron.ts`):

```ts
export interface CronExpression {
  minute: number[]; // 0-59 또는 [...]
  hour: number[]; // 0-23
  dayOfMonth: number[]; // 1-31
  month: number[]; // 1-12
  dayOfWeek: number[]; // 0-6 (0=일)
}

export function parseCron(expr: string): CronExpression;
export function nextRunAt(cron: CronExpression, fromMs: number): number;
export function matches(cron: CronExpression, dateMs: number): boolean;
```

지원 문법: `*`, `*/N`, `M-N`, `M,N,O` 단순 조합. 한 필드당 list[]. 정밀도 1분.

비지원: `L` (last day), `W` (weekday), `?` 등 cron 확장 — 개인 비서 용도 과잉.

**SchedulerService** (`scheduler.ts`):

```ts
class SchedulerService {
  constructor(deps: { db: DatabaseSync; runner: AgentRunner; logger; lane: ConcurrencyLane });
  start(): void; // 1분 폴러 시작
  stop(): Promise<void>; // 폴러 정지 + 진행 중 run 완료 대기
  async triggerNow(scheduleId: string): Promise<{ runId: string }>; // 수동 실행
}
```

내부:

- `setInterval(this.tick, 60_000)` — 다음 분 경계까지 보정 후 시작
- `tick()`: `findDueSchedules(db, Date.now())` → 각 schedule 마다 lane.acquire → agent.run 트리거 → markScheduleRun
- 트리거 실패 (timeout / runner error) → `agent_runs.error` 채워서 저장 + warn 로그
- 동일 schedule 동시 실행 방지: lane(1) — 이전이 안 끝났으면 skip + log

**main.ts 통합**:

- `SchedulerService` 인스턴스 생성, `lifecycle.register(() => scheduler.stop())` 으로 graceful shutdown
- routerHelper / agentDeps 와 동일한 runner 공유

### 검증

- `parseCron('*/5 * * * *')` → minute=[0,5,10,...,55]
- `nextRunAt(cron, 2026-05-03T11:00:00)` → `2026-05-03T11:05:00`
- 수동 fixture: schedule 1건 (cron='\* \* \* \* \*', prompt='hello'), `tick()` 1회 실행 → agent.run 호출 + agent_runs 저장 + last_run_id 갱신
- 같은 schedule 1분 안에 2회 트리거 시 두 번째는 lane skip
- `stop()` 호출 시 진행 중 agent.run 완료 대기 후 종료

---

## 밀스톤 C — RPC + 결과 송출

### 목표

사용자가 schedule 을 등록·관리할 수 있는 RPC. agent.run 결과를 지정 채널로 송출.

### 전제

- 밀스톤 A/B 완료. schedules CRUD + scheduler 동작.
- Discord adapter (`channel-discord`) 이미 동작.
- WebSocket broadcaster 이미 동작 (Phase 26 portfolio.changed 패턴).

### 작업

**파일**:

- `packages/server/src/gateway/rpc/methods/schedule.ts` (신설, ~150 LOC)
- `packages/server/src/automation/delivery.ts` (신설, ~80 LOC — discord/web 송출)
- `packages/server/src/automation/scheduler.ts` (수정, ~20 LOC — delivery 호출)
- `packages/types/src/gateway.ts` (수정, ~5 LOC — RpcMethod union)

**RPC 추가**:

| 메서드             | 파라미터                                                         | 응답                                               |
| ------------------ | ---------------------------------------------------------------- | -------------------------------------------------- |
| `schedule.create`  | `{name, cron, agentId, prompt, deliveryChannel, deliveryTarget}` | `{scheduleId, nextRunAt}`                          |
| `schedule.list`    | `{enabled?, limit?}`                                             | `{schedules: Schedule[]}`                          |
| `schedule.update`  | `{scheduleId, ...partial}`                                       | `{schedule}`                                       |
| `schedule.delete`  | `{scheduleId}`                                                   | `{deleted}`                                        |
| `schedule.runNow`  | `{scheduleId}`                                                   | `{runId}` — 수동 즉시 실행                         |
| `schedule.history` | `{scheduleId, limit?}`                                           | `{runs: AgentRun[]}` — agent_runs.schedule_id 필터 |

**송출** (`delivery.ts`):

```ts
interface DeliveryService {
  deliver(schedule: Schedule, run: AgentRun): Promise<{ success: boolean; error?: string }>;
}
```

- `deliveryChannel='discord'` → DM 송출 (`discordAdapter.sendDM(deliveryTarget, formattedMessage)`)
- `deliveryChannel='web'` → WebSocket broadcast (`broadcaster.broadcastToChannel(connections, 'schedule.completed', {scheduleId, runId, output, name})`)
- 송출 실패 → warn 로그 + agent_runs 보존 (재시도 X — 단순함). 사용자가 Settings 에서 history 로 확인 가능.

**메시지 포맷** (Discord):

```
**[일일 포트폴리오 보고]**

(agent.run output 본문)

_2026-05-04 12:00 자동 실행 · #abc12345_
```

### 검증

- `schedule.create` → 다음 분 tick 시 자동 실행
- `schedule.runNow` → 즉시 실행 + Discord DM 도달
- `schedule.delete` → 다음 tick 에서 trigger X
- Discord 송출 실패 (offline) → agent_runs 보존, warn 로그
- WebSocket 송출 → Web Settings 의 알림 영역에 push

---

## 밀스톤 D — Web UI Settings 자동화 섹션

### 목표

Settings 뷰에 schedule 등록·관리 UI. agent.run 이력 (이미 있는 섹션) 과 통합.

### 전제

- Phase 26 E 의 settings-view 가 이미 "내 기억 / 에이전트 실행 이력 / 라우팅 통계" 3 섹션.
- 본 Phase 에서 4번째 섹션 "자동화" 추가.

### 작업

**파일**:

- `packages/web/src/views/settings-view.ts` (수정, ~150 LOC — 자동화 섹션 추가)
- `packages/web/src/views/schedule-form.ts` (신설, ~150 LOC — 등록 모달)
- `packages/web/src/app-gateway.ts` (수정, ~30 LOC — ScheduleClient + WebSocket 'schedule.completed' 라우팅)
- `packages/server/src/gateway/ws/connection.ts` (수정, 1줄 — `schedule.completed` 자동 구독 추가)

**Settings 자동화 섹션**:

- 테이블: 이름 / cron / agent / 다음 실행 / 상태 (enabled 토글) / 작업 (수동 실행 / 삭제)
- "자동화 추가" 버튼 → schedule-form 모달
- 각 행 클릭 → expand 하여 history (agent.runs.list filter by schedule_id) 표시
- WebSocket `schedule.completed` 수신 시 토스트 + 해당 행 자동 갱신

**schedule-form 모달**:

- 이름 (text)
- cron (text + preset 버튼: "매시간 정각" / "매일 9시" / "매일 12시" / "매주 월 9시")
- agent (select, agent.list 응답 사용)
- prompt (textarea, max 2000)
- 송출 채널 (radio: Discord DM / Web 알림)
- 송출 대상 (Discord 선택 시 자동으로 본인 user_id, Web 선택 시 자동)
- 클라이언트 검증: cron 형식 (정규식 1차), prompt 비어있지 않음, name 유일성 (서버 2차)

### 검증

- 자동화 등록 → 테이블 즉시 추가
- preset 버튼 클릭 → cron 필드 자동 채움
- 수동 실행 → 토스트 + history 에 새 행
- 다른 클라이언트에서 schedule.completed 수신 → 토스트 + 자동 갱신
- 삭제 → confirm 후 테이블에서 제거

---

## 밀스톤 E — 격리·실패 처리·운영성

### 목표

scheduler 가 운영 중 발생할 수 있는 장애 시나리오 대응.

### 전제

- 밀스톤 A~D 동작.

### 작업

**파일**:

- `packages/server/src/automation/scheduler.ts` (수정, ~30 LOC — 실패 알림)
- `packages/server/src/automation/cron.ts` (수정, ~10 LOC — 잘못된 cron 검증)
- `packages/types/src/automation.ts` (수정, ~5 LOC — ScheduleStatus enum)

**시나리오 대응**:

1. **agent.run timeout**: 60초 기본 + schedule.timeoutMs 옵션. 초과 시 abort + agent_runs.error 저장.
2. **runner 자체 실패** (모델 floor exhausted 등): warn 로그 + 다음 tick 정상 진행. schedule disable 안 함.
3. **연속 실패 알림**: 같은 schedule 이 3회 연속 실패 시 Discord DM 으로 알림 + schedule.disabled 자동 토글 (옵션, env flag).
4. **잘못된 cron 입력**: schedule.create RPC 가 parseCron 검증, 실패 시 INVALID_PARAMS.
5. **시스템 시계 변경** (DST 또는 수동 변경): nextRunAt 재계산은 매 트리거마다 수행하므로 자연 복구. 단, 큰 점프 (시계 1시간 전진) 시 그 사이 schedule 들이 연속 트리거됨 — log 만 남김 (무시 정책).
6. **shutdown 중 실행 중인 schedule**: lifecycle 의 graceful shutdown 이 lane.drain() 호출 → 현재 run 완료 후 종료. 60초 timeout 강제.

**RPC 추가**:

- `schedule.disable {scheduleId, reason?}` / `schedule.enable {scheduleId}` (update 의 별칭, UI 편의)
- `schedule.testCron {expr, sampleCount?}` → `{nextRunsAt: number[]}` (등록 전 미리보기)

### 검증

- timeoutMs 60초 schedule 이 100초 prompt → abort + error 기록
- 3회 연속 실패 → Discord DM 알림 + auto-disable
- `schedule.testCron` 으로 다음 5회 실행 시각 미리보기
- shutdown 중 trigger → 진행 중 run 완료 후 종료

---

## 완료 조건 (Phase 28 Done When)

- 밀스톤 A/B/C/D/E 전부 완료.
- 스키마 v5 → v6 마이그레이션 무결성 검증.
- `pnpm test` 전체 통과 (cron parser 단위, scheduler tick, RPC 통합 테스트 포함).
- 전체 시나리오 수동 검증:
  1. `schedule.create` 로 "매분 hello" 등록 → 다음 분 자동 실행 + Discord DM 도달
  2. `schedule.runNow` → 즉시 실행 + 결과 송출
  3. cron 변경 → next_run_at 재계산 + 다음 트리거 반영
  4. 비활성화 → 트리거 스킵
  5. 동시 실행 (cron='\* \* \* \* \*' 2개 동시 등록) → lane(1) 으로 직렬 처리
  6. 서버 재시작 → 진행 중 run 완료 후 종료, 재기동 시 누락 없이 다음 트리거
- `tsgo --noEmit`, `pnpm lint` 통과.
- 감사 로그: `event: 'schedule.triggered'` / `'schedule.delivered'` / `'schedule.failed'` JSON 한 줄/이벤트.

---

## 범위 외 (Phase 29+)

- **자연어 cron 변환**: "매일 12시" → '0 12 \* \* \*' (LLM 사용 시 환각 위험. 향후 사용자 승인 필요한 형태로 별도 설계).
- **워크플로우** (schedule A 결과를 schedule B 입력으로 사용): scheduler 가 단일 agent.run 호출만 처리. multi-step 은 Phase 29+.
- **외부 트리거** (webhook, 이벤트 기반): cron 만 지원. webhook 트리거는 별도 Phase.
- **시간대별 스케줄**: 현재 서버 시간대 기준. 사용자별 timezone 설정은 범위 외.
- **재시도 정책**: 실패 시 자동 재시도 X. 사용자가 schedule.runNow 로 수동 재실행.
- **자동 매매·자동 거래 등록**: 읽기 전용 원칙 위배. 영구 범위 외.

---

## 오픈 질문 (Phase 28 진행 중 확정)

1. **Discord DM vs 채널 송출** — 현재 plan 은 DM 만. 사용자가 공유 채널에 정기 보고를 원하면? 기본 "DM 만 지원, 채널 송출은 사용자 명시 채널 ID 입력 시 추가" 제안.
2. **schedule.update 시 즉시 trigger** — cron 을 "지금 1분 뒤" 로 바꾸면 즉시 트리거? 기본 "next_run_at 재계산 후 다음 polling tick 에 자연 트리거" 제안 (특수 처리 X).
3. **agent.run prompt 의 동적 부분** — "오늘 날짜" / "포트폴리오 현재 값" 같은 변수 치환? 기본 "범위 외 — prompt 는 정적 문자열. agent 가 발화 시점에 도구로 조회" 제안.
4. **schedule 별 timeoutMs 커스텀** — 기본 60초 vs schedule.timeoutMs 필드 추가? 기본 "추가 — 분석성 schedule 은 120초 필요" 제안.
5. **결과 메시지 길이 제한** — Discord DM 2000자 제한 vs agent.run output 길이? 기본 "초과 시 truncate + agent.runs.get 링크 (Web URL) 첨부" 제안. 단, Web URL 발급은 별도 인프라.
6. **연속 실패 자동 disable 임계** — 3회 vs 5회 vs env config? 기본 "3회 + env flag (`AUTOMATION_MAX_CONSECUTIVE_FAILURES`)" 제안.
7. **schedule 등록 limit** — 사용자당 최대 몇 개? 기본 "20개 — 1분 폴러가 모든 schedule 순회. 100개 넘으면 폴러 부담" 제안.

---

## 참고 (Phase 28 후속 확장 아이디어)

- **schedule preset 라이브러리**: "장 시작 1시간 전 watchlist 분석", "주말 위클리 뉴스 요약" 같은 템플릿. UI 에서 1클릭 등록.
- **schedule chain**: A 의 output 을 B 의 prompt 로 (간단한 워크플로우).
- **사용자 timezone**: 한국/미국 양쪽 시장 고려 시 timezone 별 cron 필요.
- **알림 silence window**: 새벽 시간대 실행 결과는 익일 아침에 묶어서 송출 (do-not-disturb).
- **schedule budget**: 각 schedule 의 모델 비용 추정·실측 합산. 월 예산 초과 시 disable.
