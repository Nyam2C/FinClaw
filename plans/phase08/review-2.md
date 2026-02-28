# Phase 8 TODO-2 코드 리뷰

> Part 2 스테이지 모듈 — 6단계 파이프라인의 각 스테이지 구현
>
> 소스 6개 + 테스트 4개 = 10 작업

---

## 1. 명세 일치 체크리스트

| Step | 설명                                                                      | 파일                        | 일치  |
| ---- | ------------------------------------------------------------------------- | --------------------------- | ----- |
| 1    | normalizeMessage — 멘션/URL 추출 + 공백 정규화, StageResult 반환          | `stages/normalize.ts:25-49` | ✅ \* |
| 2    | commandStage — 코드 펜스 감지 + CommandRegistry 조회 + 권한 검사 + 실행   | `stages/command.ts:20-50`   | ✅ \* |
| 3    | isInsideCodeFence — 코드 펜스 내부 명령어 무시                            | `stages/command.ts:53-60`   | ✅    |
| 4    | createTypingController — idle/active/sealed 3-상태 전이 + TTL 보호        | `stages/ack.ts:23-58`       | ✅    |
| 5    | ackStage — addReaction 호출 + TypingController 시작                       | `stages/ack.ts:70-92`       | ✅    |
| 6    | contextStage — enrichContext() 호출, abort 에러 처리                      | `stages/context.ts:14-39`   | ✅ \* |
| 7    | executeStage — ExecutionAdapter 위임 + 제어 토큰 후처리 + NO_REPLY skip   | `stages/execute.ts:19-41`   | ✅    |
| 8    | deliverResponse — SILENT_REPLY 처리 + 면책 조항 + 메시지 분할 + 직렬 전송 | `stages/deliver.ts:15-68`   | ✅    |

**결론: 모든 Step(1~8) 구현 완료, 코드 내용이 plan.md 명세(§5.2~5.6)와 일치.**

### 명세 대비 세부 차이 4건 (의도적 개선, 기능 동일)

1. **`normalize.ts:40-48`** — 명세 `StageResult.continue({...})` → 구현 `{ action: 'continue', data: {...} }`
   - plan.md §5.2는 `StageResult.continue()` 팩토리 헬퍼(pipeline.ts:134-136에 정의)를 사용하지만, 구현은 plain 객체 리터럴 `{ action: 'continue', data: ... }`를 직접 반환.
   - pipeline.ts에 `StageResult` 팩토리 헬퍼 자체가 구현되지 않았으므로(타입만 존재) 올바른 선택. 타입 일치는 동일.

2. **`normalize.ts:11-16`** — 명세 `NormalizedMessage`에 `ctx` 필드 없음 → 구현에 `readonly ctx: MsgContext` 포함
   - plan.md §5.2의 `NormalizedMessage`는 `normalizedBody`, `mentions`, `urls` 3개 필드만 정의.
   - 구현은 `ctx` 필드를 추가하여 후속 스테이지(command, context)에서 원본 MsgContext 접근 가능. pipeline.ts의 오케스트레이터가 `normalized.ctx` 대신 별도 변수로 ctx를 전달하므로 실제 사용에는 영향 없으나, 테스트(`normalize.test.ts:74`)에서 `result.data.ctx`를 검증.

3. **`command.ts:25`** — 명세 반환 타입 `StageResult<MsgContext | CommandResult>` → 구현 `StageResult<MsgContext>`
   - plan.md §5.3은 `StageResult<MsgContext | CommandResult>`를 반환 타입으로 명시하지만, 구현은 `StageResult<MsgContext>`만 반환.
   - 명령어 실행 시 `skip`을 반환하므로 `CommandResult`를 data로 전달할 필요가 없음. 더 정확한 타입.

4. **`command.ts:20-25`, `context.ts:14-19`, `execute.ts:19-23`, `deliver.ts:15-20`** — 명세의 모든 스테이지에서 `StageResult.continue()` / `StageResult.skip()` / `StageResult.abort()` 팩토리 헬퍼 → 구현은 plain 객체 리터럴
   - 차이 1번과 동일한 이유. pipeline.ts에 팩토리 헬퍼가 타입 정의에만 존재하고 런타임 구현이 없으므로, 모든 스테이지가 plain 객체 리터럴을 사용. 타입 호환성 동일.

---

## 2. 발견된 이슈 (3건)

### 이슈 1: command.ts — 권한 검사가 실제 사용자 역할을 확인하지 않음 (중간)

**위치:** `stages/command.ts:42-44`

```typescript
// 권한 검사
if (command.definition.requiredRoles?.length) {
  return { action: 'skip', reason: `Insufficient permissions for command: ${parsed.name}` };
}
```

`requiredRoles`가 존재하기만 하면 무조건 권한 부족으로 skip한다. 사용자의 실제 역할(ctx에서 조회 가능)과 비교하지 않으므로, requiredRoles가 설정된 명령어는 어떤 사용자도 실행할 수 없다.

plan.md §5.3(line 698-702)도 동일한 코드이므로 명세와 일치하지만, 기능적으로 의도된 동작인지 검토 필요. Phase 8 범위에서는 권한 시스템이 미구현이므로 "항상 거부"가 의도적 placeholder일 수 있다.

**심각도:** 중간 (기능 제한 — requiredRoles 사용 명령어 실행 불가)

---

### 이슈 2: ack.ts — startTyping 함수의 실제 의존성 미검증 (낮음)

**위치:** `stages/ack.ts:4,41`

```typescript
import { startTyping, type TypingHandle } from '../../channels/typing.js';
// ...
handle = startTyping(channel, channelId, chatId, intervalMs);
```

`createTypingController`는 `startTyping`을 `../../channels/typing.js`에서 임포트하여 호출한다. 이 모듈이 실제로 존재하고 기대하는 시그니처(`(channel, channelId, chatId, intervalMs) => TypingHandle`)를 제공하는지는 타입체크(`pnpm typecheck`)가 통과했으므로 확인되었으나, 런타임 동작은 해당 모듈의 구현에 의존한다.

**심각도:** 낮음 (타입체크 통과, 런타임 검증은 통합 테스트 범위)

---

### 이슈 3: deliver.ts — channelCapabilities 옵셔널 체이닝과 PipelineMsgContext 타입 불일치 (낮음)

**위치:** `stages/deliver.ts:37`

```typescript
const parts = splitMessage(content, ctx.channelCapabilities?.maxMessageLength ?? 2000);
```

`PipelineMsgContext.channelCapabilities`는 plan.md §4.2(line 239)에서 `readonly channelCapabilities: ChannelCapabilities`로 정의되어 optional이 아니다. 그러나 구현에서는 `?.`(옵셔널 체이닝)을 사용한다.

`PipelineMsgContext`는 `MsgContext`를 extends하고, `enrichContext()`를 거치면 반드시 `channelCapabilities`가 설정되므로 `?.`는 불필요한 방어 코드이다. 기능적으로는 문제 없음(2000 기본값 fallback).

**심각도:** 낮음 (방어적 코딩, 기능 정확)

---

## 3. 테스트 커버리지 요약

| 테스트 파일         | 테스트 수 | 커버 대상                                                                                                                                              |
| ------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `normalize.test.ts` | 5         | 공백 정규화, 멘션 추출, URL 추출, 빈 메시지, ctx 보존                                                                                                  |
| `command.test.ts`   | 12        | commandStage 6건 (비명령어/등록명령어/미등록/코드펜스/별칭/권한부족) + InMemoryCommandRegistry 6건 (등록조회/별칭조회/해제/카테고리필터/파싱/비접두사) |
| `ack.test.ts`       | 7         | createTypingController 4건 (상태전이/sealed재시작/중복start/TTL보호) + ackStage 3건 (ACK활성화/비활성화/실패시계속)                                    |
| `deliver.test.ts`   | 6         | 일반전송/SILENT_REPLY/면책조항/메시지분할/개별실패격리/send없는채널                                                                                    |

총 30개 테스트. 6개 스테이지 중 context, execute 스테이지는 별도 단위 테스트 파일이 없으나, pipeline.test.ts 통합 테스트에서 커버됨.

---

## 4. 종합 판정

**구현 상태: 완료 ✅**

- 명세 8개 Step 전부 구현, 코드 품질 양호
- 발견 이슈 3건 중 실제 버그는 없으나, 이슈 1(권한 검사 placeholder)은 향후 권한 시스템 구현 시 수정 필요
- 명세 대비 차이 4건은 모두 의도적 개선이며, StageResult 팩토리 헬퍼 미사용은 pipeline.ts에 런타임 구현이 없는 것과 일관됨
- TODO-3 진행에 차단 요소 없음
