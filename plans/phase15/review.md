# Phase 15: Support Services — 리뷰

## 1. Todo vs 구현 정합성

| Todo                            | 파일                                                    | 정합성    | 비고                                         |
| ------------------------------- | ------------------------------------------------------- | --------- | -------------------------------------------- |
| 1. hooks/types.ts               | hooks/types.ts                                          | 100% 일치 | —                                            |
| 2. hooks/registry.ts + test     | hooks/registry.ts, registry.test.ts                     | 100% 일치 | —                                            |
| 3. hooks/runner.ts + test       | hooks/runner.ts, runner.test.ts                         | 개선됨    | runParallel에 sync throw 방어 try/catch 추가 |
| 4. hooks/bridge.ts              | hooks/bridge.ts                                         | 100% 일치 | —                                            |
| 5. security/redaction.ts + test | security/redaction.ts, redaction.test.ts                | 개선됨    | 패턴 순서를 구체적→범용으로 재배치           |
| 6. security/audit.ts + test     | security/audit.ts, audit.test.ts                        | 100% 일치 | —                                            |
| 7. cron/scheduler.ts + test     | cron/scheduler.ts, scheduler.test.ts                    | 100% 일치 | —                                            |
| 8. cron/jobs/\*.ts              | cron/jobs/alert-check.ts, cleanup.ts, market-refresh.ts | **일탈**  | Storage 기존 함수 미재사용 (아래 상세)       |
| 9. daemon/systemd.ts            | daemon/systemd.ts                                       | 100% 일치 | —                                            |
| 10. services/index.ts           | index.ts                                                | 100% 일치 | —                                            |

구현 파일 총 17개 (소스 11 + 테스트 6). Todo 10개 항목 중 8개 100% 일치, 2개 개선, 1개 일탈.

## 2. 발견된 이슈 (6건)

**[I-1] cron/jobs가 @finclaw/storage 기존 함수를 재사용하지 않음** (중요)

- todo.md가 명시적으로 "Storage 기존 함수 재사용" 지시
- `alert-check.ts`: raw SQL `JOIN` 직접 작성. `getActiveAlerts()`, `updateAlertTrigger()` 미사용
- `cleanup.ts`: `DELETE FROM market_cache` 직접 실행. `purgeExpiredCache()` 미사용
- `market-refresh.ts`: raw SQL `SELECT DISTINCT symbol FROM alerts` 직접 실행
- 위치: `packages/server/src/services/cron/jobs/`

**[I-2] trigger/collectHandlers 중복 실행 가능성**

- `registry.ts:trigger()`와 `runner.ts:collectHandlers()` 모두 `type` + `type:action` 핸들러를 합산
- 같은 훅이 `events: ['agent', 'agent:bootstrap']`로 등록 시, `trigger(makeEvent('agent','bootstrap'))`에서 **2회 호출**
- `listAll()`은 중복 제거하지만 `trigger()`는 하지 않음

**[I-3] `list()`가 `InternalJob` 내부 필드 노출**

- `scheduler.ts:163`: `Array.from(jobs.values())` → `_cron`, `_timer` 필드가 반환 객체에 포함
- `CronJob` 인터페이스에는 없지만 런타임에 존재 → 외부에서 접근 가능

**[I-4] bridge.ts에서 `registry.trigger()` Promise 미대기**

- `bridge.ts:33`: listener 내 `registry.trigger()`가 `await` 없이 호출
- fire-and-forget이 의도일 수 있으나, 에러가 unhandled rejection으로 전파될 위험

**[I-5] `redactObject()` 순환 참조 방어 없음**

- `redaction.ts:127`: 재귀적 객체 순회 시 `WeakSet` 등 순환 참조 체크 없음
- 순환 참조 객체 입력 시 stack overflow

**[I-6] `executeJob` lastRunAt 타이밍**

- `scheduler.ts:110`: `state.lastRunAt = Date.now()` 가 `lanes.acquire()` **이전**에 설정
- acquire가 큐에서 대기할 경우 lastRunAt이 실제 실행 시점과 불일치

## 3. 긍정적 변경 (todo 대비 개선)

- **redaction.ts 패턴 순서**: 구체적 패턴(PEM, JWT, Anthropic)을 범용 패턴(generic_api_key) 앞으로 재배치. 오탐 방지에 효과적
- **runner.ts runParallel sync throw 방어**: `h.handler(event)` 호출 시 sync throw를 try/catch로 감싸 `Promise.reject()`로 변환. `Promise.allSettled`가 모든 케이스를 처리

## 4. 리팩토링 사항

**[R-1] cron/jobs에서 @finclaw/storage 함수 재사용** (I-1 해소)

- `cleanup.ts`: `purgeExpiredCache(db)` 호출로 대체
- `alert-check.ts`: JOIN 쿼리는 storage에 없으므로 유지하되, `updateAlertTrigger(db, alert.id, now as Timestamp)` 호출로 UPDATE 대체
- `market-refresh.ts`: `getActiveAlerts(db).map(a => a.symbol)` + `[...new Set()]`로 대체 가능하나, 현재 방식이 DB 레벨 DISTINCT로 더 효율적 → 유지

**[R-2] trigger() 중복 실행 방지** (I-2 해소)

- `registry.ts:trigger()` 내 allHandlers에 id 기반 중복 제거 추가
- `runner.ts:collectHandlers()` 에도 동일 적용

**[R-3] list() 반환 타입 정리** (I-3 해소)

- `{ id, name, schedule, handler, enabled, lastRunAt, lastStatus, nextRunAt }` 만 추출하여 반환
- 또는 `InternalJob` 타입에서 `_cron`, `_timer`를 별도 Map으로 분리

**[R-4] bridge listener에 void operator 또는 .catch() 추가** (I-4 해소)

- `void registry.trigger({...})` 또는 `.catch(err => console.error(...))`

**[R-5] redactObject에 순환 참조 방어** (I-5 해소)

- `WeakSet<object>` 파라미터 추가, 이미 방문한 객체는 `'[Circular]'` 반환

**[R-6] executeJob lastRunAt을 acquire 후로 이동** (I-6 해소)

- `lanes.acquire()` 호출 후 `state.lastRunAt = Date.now()` 설정
