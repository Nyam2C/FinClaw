# Phase 19 TODO-2 구현 리뷰

## 1. 계획 대비 아키텍처 편차 (긍정적)

| 항목          | 계획 (todo-2.md)                                 | 실제 구현                                            | 평가           |
| ------------- | ------------------------------------------------ | ---------------------------------------------------- | -------------- |
| Gateway 패턴  | `initGatewayConnection(app)` — app 직접 mutation | `createAppGateway()` — 독립 팩토리, 이벤트 콜백      | ✅ 분리도 향상 |
| Chat 패턴     | `handleSendChat(app, msg)` — app에 결합          | `createAppChat(gateway, sessionId)` — 독립 상태 머신 | ✅ 테스트 용이 |
| Shadow DOM    | `createRenderRoot() { return this; }` (비사용)   | Lit 기본 Shadow DOM 사용 + scoped CSS                | ✅ 스타일 격리 |
| View 컴포넌트 | 전체 기능 구현 (시세 조회, 알림 CRUD 등)         | Placeholder — 구조만 scaffold                        | ⚠️ 의도적 축소 |

**결론**: 탈결합 팩토리 패턴이 계획의 결합 패턴보다 테스트/재사용성이 우수. 긍정적 편차.

## 2. 설정/의존성 편차

| 항목                       | 계획                        | 실제                                    | 심각도                            |
| -------------------------- | --------------------------- | --------------------------------------- | --------------------------------- |
| `@finclaw/types` 의존성    | `dependencies`에 포함       | **누락**                                | CRITICAL                          |
| `tsconfig.json` references | `[{ "path": "../types" }]`  | `[]` (빈 배열)                          | CRITICAL                          |
| build 스크립트             | `tsc --build && vite build` | `vite build` (tsc 생략)                 | MEDIUM                            |
| Vite 버전                  | `^8.0.0`                    | `^6.3.0`                                | LOW                               |
| tui.ts `--gateway` 옵션명  | `--gateway`                 | `--gateway-url`                         | LOW (program.ts 전역 옵션과 일관) |
| tui.ts 기본 URL            | `ws://localhost:3000/ws`    | `ws://127.0.0.1:3000` (`/ws` 경로 누락) | MEDIUM                            |

## 3. 보안 이슈

1. **markdown.ts — DOMPurify 화이트리스트 누락**
   - 계획: `ALLOWED_TAGS` 15개 + `ALLOWED_ATTR` 4개 명시
   - 실제: `DOMPurify.sanitize(raw)` — 기본값 사용 (더 넓은 태그 허용)
   - **권장**: 계획의 화이트리스트를 적용하여 방어 심층 강화

2. **auth URL 파싱 — host 하드코딩**
   - 계획: `new URL(req.url, 'http://${req.headers.host ?? "localhost"}')`
   - 실제: `new URL(url, 'http://localhost')` (host 무시)
   - 실제 영향 LOW (req.url은 절대 경로이므로 base는 무관)

## 4. 잠재적 버그

1. **app-gateway.ts — 연결 끊김 시 pending request 미정리**
   - `ws.close` 이벤트에서 `pendingRequests` Map을 정리하지 않음
   - 연결 중단 시 `send()` 반환 Promise가 영원히 pending
   - **수정**: close 핸들러에서 `pendingRequests.forEach(p => p.reject(new Error(...)))` 추가

2. **app-chat.ts — tool_end 매칭 로직**
   - `tools[tools.length - 1]`로 마지막 도구만 업데이트
   - 병렬 도구 호출 시 잘못된 도구에 결과가 할당될 수 있음
   - **수정**: tool name 또는 sequence ID로 매칭

3. **app-gateway.ts — 재연결 backoff 순서**
   - `scheduleReconnect()`에서 타이머 등록 후 backoff를 증가
   - 두 번째 재연결 시 첫 번째와 동일한 delay 사용됨
   - **수정**: backoff 증가를 setTimeout 콜백 앞으로 이동

## 5. 테스트 커버리지 누락

| 테스트 시나리오                         | 파일                | 상태      |
| --------------------------------------- | ------------------- | --------- |
| ?token= query param 인증 성공           | auth/index.test.ts  | ❌ 미작성 |
| ?token= + Bearer 둘 다 있을 때 우선순위 | auth/index.test.ts  | ❌ 미작성 |
| 연결 끊김 시 pending request reject     | app-gateway.test.ts | ❌ 미작성 |
| 재연결 backoff 증가 검증                | app-gateway.test.ts | ❌ 미작성 |
| 병렬 도구 호출 완료 순서                | app-chat.test.ts    | ❌ 미작성 |

## 6. 검증 결과

```
pnpm build           → ✅ 성공
pnpm test (1282)     → ✅ 전체 통과
pnpm lint            → ✅ 새 코드 0 errors (기존 tui 7건 pre-existing)
```

---

## 리팩토링 사항

아래 항목은 기능에는 영향 없지만 코드 품질/일관성/보안을 위해 별도 리팩토링으로 처리 권장:

1. **`@finclaw/types` 의존성 복원 + tsconfig references 추가** (`package.json`, `tsconfig.json`)
   - `app-chat.ts`에서 로컬 인터페이스(`ChatDeltaParams` 등) 대신 `@finclaw/types`에서 import
   - 이유: 공유 타입 원칙 위반, 타입 드리프트 위험

2. **markdown.ts에 ALLOWED_TAGS/ALLOWED_ATTR 화이트리스트 추가**
   - DOMPurify 기본값 대신 명시적 허용 목록으로 방어 심층 강화

3. **app-gateway.ts — close 핸들러에서 pendingRequests 정리**
   - 연결 끊김 시 모든 pending Promise를 reject하여 메모리 누수 방지

4. **app-gateway.ts — backoff 증가 순서 수정**
   - `scheduleReconnect()` 내 backoff 계산을 타이머 등록 전으로 이동

5. **app-chat.ts — tool_end 매칭을 name 기반으로 변경**
   - 배열 마지막이 아닌 `toolCall.name`으로 매칭하여 병렬 도구 안전성 확보

6. **auth ?token= 경로에 대한 테스트 추가** (`index.test.ts`)
   - 최소 2개: ?token= 인증 성공, Bearer vs ?token= 우선순위

7. **build 스크립트에 tsc 추가** (`package.json`)
   - `"build": "tsc --build && vite build"` — 타입 체크 + 번들링
