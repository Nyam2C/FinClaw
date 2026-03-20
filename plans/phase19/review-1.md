# Phase 19 TODO-1 구현 리뷰

> 대상: todo-1.md (Day 1-3: 공유 타입 + TUI)
> 리뷰어: Claude
> 날짜: 2026-03-20

---

## 1. 체크리스트 대조

| #   | 파일                                                | todo-1                  | 구현 | 일치 | 비고                             |
| --- | --------------------------------------------------- | ----------------------- | ---- | ---- | -------------------------------- |
| 1   | `packages/types/src/notification.ts`                | 신규                    | ✅   | ✅   | 내용 100% 일치                   |
| 2   | `packages/types/src/index.ts` 수정                  | re-export 추가          | ✅   | ✅   | `export type *` 정확             |
| 3   | `packages/server/src/gateway/rpc/types.ts` 수정     | 인라인 삭제 + re-export | ✅   | ✅   |                                  |
| 4   | `packages/tui/package.json`                         | 신규                    | ✅   | ✅   | ink-text-input도 포함 (3.6 반영) |
| 5   | `packages/tui/tsconfig.json`                        | 신규                    | ✅   | ✅   |                                  |
| 6   | 루트 `tsconfig.json` 수정                           | tui 참조 추가           | ✅   | ✅   |                                  |
| 7   | `pnpm install`                                      | 실행                    | ✅   | ✅   | pnpm-lock.yaml 변경 확인         |
| 8   | `packages/tui/src/gateway-client.ts`                | 신규                    | ✅   | ✅   |                                  |
| 9   | `packages/tui/src/__tests__/gateway-client.test.ts` | 신규                    | ✅   | ⚠️   | 아래 참조                        |
| 10  | `packages/tui/src/StatusBar.tsx`                    | 신규                    | ✅   | ✅   |                                  |
| 11  | `packages/tui/src/ChatView.tsx`                     | 신규                    | ✅   | ✅   |                                  |
| 12  | `packages/tui/src/DashboardView.tsx`                | 신규                    | ✅   | ✅   |                                  |
| 13  | `packages/tui/src/App.tsx`                          | 신규                    | ✅   | ⚠️   | 버그 1건 발견                    |
| 14  | `packages/tui/src/index.ts`                         | 신규                    | ✅   | ✅   |                                  |
| 15  | `packages/tui/src/__tests__/chat.test.ts`           | 신규                    | ✅   | ⚠️   | todo-1 대비 수정 확인            |

**결과: 15/15 파일 생성 완료, 3개 파일에 이슈 발견**

---

## 2. 발견 사항

### 2.1 [BUG] App.tsx `chat.stream.end` — stale closure로 빈 문자열 저장

**파일:** `packages/tui/src/App.tsx:76-85`

```tsx
case 'chat.stream.end':
  setStreamText('');
  setMessages((prev) => [
    ...prev,
    {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: streamText, // ← 문제: 클로저가 캡처한 streamText는 항상 '' (초기값)
    },
  ]);
  break;
```

**문제:** `onNotification` 콜백은 `useEffect([], [])`에서 한 번만 등록된다. 이 시점에 캡처된 `streamText`는 초기값 `''`이므로, `chat.stream.end` 수신 시 항상 빈 문자열이 messages에 추가된다. `setStreamText`는 함수형 업데이트(`prev => prev + delta`)를 사용하여 최신값을 반영하지만, `streamText` 변수 자체를 직접 읽는 `chat.stream.end` 핸들러에는 최신값이 전달되지 않는다.

**수정안:** React state를 ref로 동기화하거나, `setStreamText`/`setMessages`를 모두 함수형 업데이트로 조합:

```tsx
case 'chat.stream.end':
  setStreamText((currentStream) => {
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: currentStream, // 함수형 업데이트 안에서 최신 streamText 접근
      },
    ]);
    return '';
  });
  break;
```

**심각도:** 높음 — 이 버그가 있으면 모든 스트리밍 응답이 빈 메시지로 확정됨.

---

### 2.2 [WARN] gateway-client.test.ts — 빈 테스트 바디 3건

**파일:** `packages/tui/src/__tests__/gateway-client.test.ts`

다음 테스트들은 `it()` 바디에 실제 assertion이 없고 주석만 있다:

- **L82-92**: `notification 수신 시 등록된 핸들러를 호출한다` — MockWebSocket 인스턴스에 접근하여 `message` 이벤트를 발생시키는 로직이 없음. assertion 없음.
- **L109-120**: `연결 끊김 시 지수 백오프로 재연결을 시도한다` — 연결 끊김 시뮬레이션이 없음. `expect(client.isConnected).toBe(true)`만으로 재연결 검증 불가.
- **L122-129**: `응답 프레임의 id로 올바른 pending request를 resolve한다` — assertion 완전 부재.
- **L144-153**: `sessionId 획득 흐름` — assertion 완전 부재.

todo-1.md에도 동일하게 주석만 있었으므로 todo 자체의 한계이지만, 이 테스트들은 실질적으로 검증하는 것이 없다. 빈 테스트는 false confidence를 줄 수 있다.

**심각도:** 중간 — 통과는 하지만 실질 검증 0.

---

### 2.3 [OK] chat.test.ts — todo-1 대비 수정 사항 확인

todo-1.md의 `전체 스트리밍 흐름` 테스트(L1336-1365)에서는:

- `expect(state.messages).toHaveLength(4)` + `messages[2]!.role === 'tool'` + `messages[3]!.role === 'assistant'`

구현체에서는:

- `expect(state.messages).toHaveLength(3)` + `messages[1]!.role === 'tool'` + `messages[2]!.role === 'assistant'`

**분석:** 구현체가 올바름. 해당 흐름에서 메시지는 `tool_start(system) + tool_end(tool) + end(assistant)` = 3개. todo-1의 4개는 오류였고 구현 시 수정됨. 적절한 수정.

---

### 2.4 [OK] todo-1 대비 코드 품질 개선

todo-1에서 `vi.mock('ws', ...)` 시 `EventEmitter`를 모듈 스코프에서 직접 import했으나, 구현체는 `vi.hoisted()`로 호이스팅 문제를 해결. Vitest의 mock 호이스팅 특성을 고려한 올바른 수정.

---

### 2.5 [OK] 서버 타입 호환성

- `JsonRpcNotification<T = Record<string, unknown>>` — generic default가 기존 `JsonRpcNotification` (params: `Record<string, unknown>`) 과 호환.
- `broadcaster.ts:108` (`const notification: JsonRpcNotification`) — generic 없이 사용 시 default 적용으로 기존 동작 유지.
- `broadcaster.ts:129` (`satisfies JsonRpcNotification`) — 동일.
- `WsOutboundMessage = RpcResponse | JsonRpcNotification` (L92) — 호환.

---

### 2.6 [INFO] import 정렬

구현체에서 import 정렬이 todo-1과 다름 (타입 import 우선, 알파벳 순). 포맷터(`oxfmt`)가 자동 정렬한 결과로 보이며 문제 없음.

---

## 3. 빌드/테스트 상태

- `dist/` 디렉토리 존재 + `tsconfig.tsbuildinfo` 존재 → `tsc --build` 성공한 것으로 판단
- 테스트 실행 결과는 별도 확인 필요 (`pnpm --filter @finclaw/tui vitest run`)

---

## 4. 종합 판정

| 항목            | 판정                                                          |
| --------------- | ------------------------------------------------------------- |
| 파일 완성도     | 15/15 (100%)                                                  |
| todo-1 일치도   | 높음 — 의도적 수정 2건 (테스트 수정, mock 호이스팅) 모두 적절 |
| 버그            | 1건 (stale closure — 심각)                                    |
| 테스트 커버리지 | 중간 — 빈 테스트 4건으로 실질 검증 부족                       |

---

## 5. 리팩토링 발견

| #   | 대상                     | 유형            | 설명                                                                                                                                                                                                                                                                |
| --- | ------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `App.tsx:76-85`          | **버그 수정**   | `chat.stream.end` stale closure — `setStreamText` 함수형 업데이트 내에서 `setMessages` 호출로 변경                                                                                                                                                                  |
| R2  | `gateway-client.test.ts` | **테스트 보강** | 빈 테스트 4건에 실제 assertion 추가: (1) MockWebSocket에 message 이벤트 주입으로 notification 핸들러 검증, (2) close 이벤트 발생 + 800ms 타이머 후 reconnect 확인, (3) 응답 프레임 주입으로 pending request resolve 검증, (4) chat.start → sessionId 응답 매칭 검증 |
| R3  | `gateway-client.ts:69`   | **개선**        | `scheduleReconnect()` 내 `setTimeout(async () => {...})` — async 에러가 silent failure됨. reconnect 실패 시 에러 로깅 추가 권장 (현 단계에서는 낮은 우선순위)                                                                                                       |
