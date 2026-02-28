# Phase 8 TODO-1 코드 리뷰

> Part 1 기반 모듈 (타입, 에러, 유틸리티, 인터페이스)
>
> 소스 7개 + events.ts 수정 = 8 작업

---

## 1. 명세 일치 체크리스트

| Step | 설명                                                                  | 파일                                      | 일치  |
| ---- | --------------------------------------------------------------------- | ----------------------------------------- | ----- |
| 1    | PipelineError + PipelineErrorCode 5종                                 | `auto-reply/errors.ts:1-25`               | ✅    |
| 2    | CONTROL_TOKENS 6종 상수                                               | `auto-reply/control-tokens.ts:9-27`       | ✅    |
| 3    | ControlTokenResult 인터페이스 + extractControlTokens()                | `auto-reply/control-tokens.ts:31-73`      | ✅    |
| 4    | PipelineMsgContext extends MsgContext (정규화+채널+사용자+금융)       | `auto-reply/pipeline-context.ts:16-38`    | ✅    |
| 5    | MarketSession 인터페이스                                              | `auto-reply/pipeline-context.ts:41-46`    | ✅    |
| 6    | FinanceContextProvider 인터페이스 (5메서드)                           | `auto-reply/pipeline-context.ts:53-59`    | ✅    |
| 7    | EnrichContextDeps + enrichContext() 구현                              | `auto-reply/pipeline-context.ts:61-104`   | ✅ \* |
| 8    | ExecutionAdapter 인터페이스 + ExecutionResult                         | `auto-reply/execution-adapter.ts:9-16`    | ✅    |
| 9    | MockExecutionAdapter 클래스                                           | `auto-reply/execution-adapter.ts:22-31`   | ✅    |
| 10   | FormatOptions, FormattedResponse, ResponsePart 타입                   | `auto-reply/response-formatter.ts:5-29`   | ✅    |
| 11   | formatResponse() + splitMessage() + formatFinancialNumber()           | `auto-reply/response-formatter.ts:39-147` | ✅    |
| 12   | CommandDefinition, CommandExecutor, CommandResult, ParsedCommand 타입 | `auto-reply/commands/registry.ts:4-31`    | ✅    |
| 13   | CommandRegistry 인터페이스 (7메서드)                                  | `auto-reply/commands/registry.ts:34-42`   | ✅    |
| 14   | InMemoryCommandRegistry 구현                                          | `auto-reply/commands/registry.ts:50-112`  | ✅    |
| 15   | registerBuiltInCommands() — /help, /reset, /price, /portfolio, /alert | `auto-reply/commands/built-in.ts:5-107`   | ✅    |
| 16   | FinClawEventMap에 pipeline:\* 이벤트 3종 추가                         | `infra/events.ts:91-101`                  | ✅    |

**결론: 모든 Step(1~16) 구현 완료, 코드 내용이 plan.md 명세와 일치.**

### 명세 대비 세부 차이 2건 (의도적 개선, 기능 동일)

1. **`pipeline-context.ts:81-86`** — 명세 `Promise.allSettled` 3개 → 구현 4개
   - 명세(plan.md §5.4 코드블록)에서는 `getActiveAlerts`, `getPortfolio`, `getRecentNews` 3개만 병렬 호출하나, 구현에서는 `getWatchlist`도 포함하여 4개를 병렬 호출한다.
   - `FinanceContextProvider` 인터페이스에 `getWatchlist`가 정의되어 있고, `PipelineMsgContext`에 `watchlist` 필드가 있으므로 enrichContext에서 로딩하는 것이 올바른 구현. 명세 코드블록이 불완전했던 것.

2. **`pipeline-context.ts:85`** — `getWatchlist`에 `financeSignal` 미전달
   - 다른 3개 메서드(`getActiveAlerts`, `getPortfolio`, `getRecentNews`)는 `financeSignal`(3초 타임아웃)을 전달하지만, `getWatchlist`는 signal 없이 `senderId`만 전달한다.
   - 이는 `FinanceContextProvider` 인터페이스(line 58)에서 `getWatchlist(senderId: string): Promise<readonly string[]>`로 signal 파라미터가 없는 것과 일치. 명세 인터페이스를 정확히 따른 것.

---

## 2. 발견된 이슈 (3건)

### 이슈 1: pipeline-context.ts — enrichContext()에서 mentions/urls가 항상 빈 배열 (낮음)

**위치:** `pipeline-context.ts:93-94`

```typescript
return {
  ...ctx,
  normalizedBody: ctx.body.trim().replace(/\s+/g, ' '),
  mentions: [], // ← 항상 빈 배열
  urls: [], // ← 항상 빈 배열
  channelCapabilities: deps.channelCapabilities,
  userRoles: [],
  isAdmin: false,
  // ...
};
```

**문제:** `enrichContext()`가 `normalizedBody`를 자체적으로 생성하면서 `mentions`와 `urls`를 항상 빈 배열로 고정한다. plan.md §5.4(Stage 4: Context)에서는 `contextStage()`가 `enrichContext()` 결과에 normalize 단계의 `NormalizedMessage`를 합치도록 설계되어 있으므로, enrichContext 내부에서 이 필드들을 빈 배열로 설정하는 것은 contextStage에서 덮어쓰여질 값이다. 기능적으로 문제는 없으나, `enrichContext()`를 단독으로 호출하면 mentions/urls가 항상 빈 배열이 되어 혼란 가능.

**심각도:** 낮음 (Part 2의 contextStage에서 덮어쓰므로 런타임 영향 없음)

---

### 이슈 2: response-formatter.ts — formatResponse()에서 면책 조항 위치가 분할 전 (낮음)

**위치:** `response-formatter.ts:47-51, 61`

```typescript
// 면책 조항 첨부
if (controlTokens.needsDisclaimer) {
  formatted +=
    '\n\n---\n' +
    '_본 정보는 투자 조언이 아니며, 투자 결정은 본인의 판단과 책임 하에 이루어져야 합니다._';
}

// ...
const chunks = splitMessage(formatted, options.maxLength);
```

**문제:** 면책 조항이 메시지 분할 전에 첨부된다. 긴 응답이 분할될 경우 면책 조항이 마지막 파트에만 존재하게 되는데, 이것이 의도된 동작인지 불확실하다. plan.md §5.6(Stage 6: Deliver)에서도 동일한 순서(면책 조항 → 분할)로 작성되어 있으므로 명세와는 일치하나, 금융 규제 관점에서 모든 파트에 면책 조항이 필요할 수 있다.

한편, `formatResponse()`와 `deliverResponse()`(plan.md §5.6) 양쪽 모두에서 면책 조항을 첨부하는 코드가 존재한다. Part 2/3에서 deliver 스테이지 구현 시 중복 첨부가 발생하지 않는지 확인이 필요하다.

**심각도:** 낮음 (명세와 일치하며, 향후 deliver 스테이지 구현 시 조율 필요)

---

### 이슈 3: response-formatter.ts — markdown 제거 정규식이 중첩 마크다운에 취약 (낮음)

**위치:** `response-formatter.ts:55-57`

```typescript
formatted = formatted.replace(/\*\*(.*?)\*\*/g, '$1');
formatted = formatted.replace(/_(.*?)_/g, '$1');
formatted = formatted.replace(/`(.*?)`/g, '$1');
```

**문제:** 비탐욕 매칭(`*?`)을 사용하지만, 순차 적용이므로 예상치 못한 결과가 발생할 수 있다:

1. `**_bold italic_**` → 1단계: `_bold italic_` → 2단계: `bold italic` (정상)
2. `_**italic bold**_` → 1단계: `_italic bold_` → 2단계: `italic bold` (정상)
3. `_underscore_value_` → `underscore_value` (의도하지 않은 제거 가능)

특히 금융 데이터에서 `ticker_symbol`이나 `2024_Q1` 같은 밑줄 포함 텍스트가 잘못 변환될 수 있다. 다만 이 코드는 markdown 미지원 채널에서만 실행되므로 실질적 영향은 미미하다.

**심각도:** 낮음 (edge case, markdown 미지원 채널에서만 발동)

---

## 3. 리팩토링 제안 (1건)

### 제안 1: enrichContext()의 normalizedBody 생성 제거

`enrichContext()`가 자체적으로 `normalizedBody`를 생성하고 `mentions`/`urls`를 빈 배열로 설정하는 것은, contextStage에서 normalize 결과로 덮어쓰이기 때문에 불필요한 중간 값이다. 두 가지 선택지가 있다:

**A안:** `enrichContext()`에서 `normalizedBody`, `mentions`, `urls` 필드를 제거하고, contextStage에서 합치는 현재 plan.md §5.4 설계를 유지.

**B안:** 현재 구현을 유지하되, 단독 호출 시 빈 배열이 반환된다는 점을 JSDoc에 명시.

Part 2에서 contextStage 구현 시 결정하면 충분하다.

---

## 4. 테스트 커버리지 요약

| 테스트 파일                 | 테스트 수 | 커버 대상                                                                                                        |
| --------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| `control-tokens.test.ts`    | 8         | 토큰 미포함, NO_REPLY/SILENT_REPLY/HEARTBEAT_OK/ATTACH_DISCLAIMER/ATTACH_QUOTE 개별 추출, 복합 토큰, 줄바꿈 정리 |
| `pipeline-context.test.ts`  | 3         | MsgContext→PipelineMsgContext 확장, 개별 실패 시 degraded, 병렬 호출 확인                                        |
| `execution-adapter.test.ts` | 2         | MockExecutionAdapter 기본 응답, 커스텀 응답                                                                      |

총 13개 테스트. Part 1 기반 모듈의 핵심 동작 커버됨.

미커버 영역:

- `errors.ts` — PipelineError 생성/상속 테스트 없음 (Part 2/3 통합 테스트에서 간접 검증 예상)
- `response-formatter.ts` — formatResponse(), splitMessage(), formatFinancialNumber() 전용 테스트 없음 (Part 2/3에서 추가 예상)
- `commands/registry.ts` — InMemoryCommandRegistry CRUD 테스트 없음 (Part 2 command.test.ts에서 커버 예상)
- `commands/built-in.ts` — 내장 명령어 등록/실행 테스트 없음 (Part 2 command.test.ts에서 커버 예상)

---

## 5. 종합 판정

**구현 상태: 완료 ✅**

- 명세 16개 Step 전부 구현, 코드 품질 양호
- 발견 이슈 3건 모두 낮음 심각도이며 실제 버그는 없음
- enrichContext()의 mentions/urls 빈 배열은 Part 2의 contextStage 구현에서 자연스럽게 해소될 예정
- 면책 조항 중복 첨부 가능성(formatResponse vs deliverResponse)은 Part 2/3 구현 시 확인 필요
- Part 1 전용 테스트 13개로 핵심 로직 커버, errors/formatter/commands 테스트는 Part 2/3에서 보충 예상
