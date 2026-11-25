# Phase 47 계획 — macOS 캐릭터 챗봇 "핀" + 먼저 알려주는(proactive) 알림

> 작성 2026-11-26 · base = main `566cde9` (PR #86 phase46 머지) · 브랜치 `feature/phase47-mac-character` · 선행: `plans/phase47/kickoff.md`
> 상태: **확정 — /goal 자율 모드에서 메인이 게이트 1·2 를 대행 승인 (2026-11-26). 사용자 사후 검토 대상.** 뒤집을 수 있는 결정(캐릭터 이름·디자인·말투 포함)은 §10 에 모았다.
> 설계 기준선: `_workspace/feature-research/mac-character/20-comparison-and-recommendation.md`(이하 **[20]**) 추천을 그대로 채택(synthesizer 수정 6건 포함). 근거 문서 표기: **[00]** 통합 계약 · **[L1]** 플로팅 창 · **[L23]** 로컬 스파이크 · **[L4]** 캐릭터 UX · **[R46]** `plans/phase46/review.md`.
> **[20] 은 phase46 _plan_ 을 전제로 썼다. 이 plan 은 phase46 _실제 코드_(`566cde9`)와 대조해 아래를 바로잡았다:**
>
> 1. ChatRegistry TTL 은 마지막 활동 기준 유휴 30분이고, 진행 중 run(`runs > 0`)은 만료하지 않는다(`gateway/src/registry.ts:106-112`). [20] R3·G2·Q10 의 "30분 경계가 run 을 끊는다" 는 **해소**됐다. 유휴 만료 뒤 `chat.start` 재호출만 필요하다.
> 2. `chat.stream.tool.name` 은 CLI 가 보고한 MCP 이름 그대로다(`mcp__finclaw__get_price` — `agent/test/runtime/fixtures/tool-call.ndjson` 실측). [20] G5 는 **해소**: 마지막 `__` 뒤로 조회한다.
> 3. Web·TUI 의 `chat.start` agentId 기본값은 `'default'` 다(`web/src/app.ts:157`, `server/src/cli/commands/tui.ts:13`). 로컬 토큰의 sessionKey 는 **`tui:local:default`** 다(`finclaw-partner` 는 schedule 폼 기본값일 뿐). 맥도 `'default'` 를 써서 같은 대화를 공유한다.
> 4. WS 는 HTTP 서버에 path 옵션 없이 붙는다(`gateway/src/server.ts:89-92` `new WebSocketServer({ server, maxPayload })`). 업그레이드 경로는 무엇이든 된다. 맥은 **`ws://127.0.0.1:3000/`** 을 쓴다.
> 5. `chat.send` 가 runId 를 서버에서 발급하면, 응답보다 먼저 도착한 즉시 실패 이벤트(lane 포화 등)를 클라이언트가 어느 run 의 것인지 알 수 없다. → phase46 이월 항목 중 **클라이언트 지정 runId 만 IN**(§2-3).
> 6. `chat.history` 응답에 timestamp 는 없다. `ConversationMessage` 에 시각 필드가 없다(`types/src/agent.ts:24-28`). `{role, text}` 만 돌려준다.
> 7. `finance.alert.delete` 는 `alert_history` 를 `ON DELETE CASCADE` 로 함께 지운다(`storage/src/database.ts:122`). 말풍선 버튼 이름은 "이 알림 끄기" 가 아니라 **"이 알림 삭제"** 로 하고 두 번 눌러야 지운다(§4-4).

---

## 0. 목표와 경계

**목표:** macOS 데스크톱에 떠 있는 캐릭터 "핀" 이 gateway 에 붙어 대화하고, 가격 알림·예약 브리핑을 먼저 알려준다. 성공 기준은 다음과 같다. **"서버를 켜면 핀이 15초 안에 깨어나고, 핀을 클릭해 질문하면 생각 → 도구 → 말하기 표정을 거쳐 Web 과 같은 최종 답을 말풍선에 보여주며, 알림 폼에서 만든 가격 알림이 조건을 넘으면 다른 앱의 포커스를 뺏지 않고 핀이 말풍선과 macOS 알림으로 알려준다."** §8-3 수동 스모크가 판정한다.

**경계:**

- **IN (phase47):** M1~M9 전부(§5). 서버 4개 밀스톤(알림 websocket · alert delete + chat.history + 클라이언트 runId · Discord DM 대상 · 페르소나) + Swift 4개 밀스톤(패키지·클라이언트·헤드리스 스모크·CI → 리듀서 → 창·캐릭터·말풍선·스냅샷 → proactive·폼·번들) + 문서.
- **OUT → phase48+:** §9 목록.
- **OUT (영구/보류):** Tauri·Electron·WKWebView 셸(K1 탈락 — [20] §2-1), Lottie·Rive·스프라이트 에셋(K1·에셋 파이프라인), 맥 앱의 LLM 직접 호출, 새 MCP 도구, 매매 UI, App Store·공증(notarization), App Sandbox, 구독(subscribe) RPC 부활, 알림 문구 LLM 재작성.

**불변식 (깨면 안 됨 — 각 밀스톤 테스트로 고정):**

| #   | 불변식                      | phase47 에서의 구체 제약                                                                                                                                                                         | 근거                 |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| M1  | read-only 도구, 변경은 사람 | 새 MCP 도구 0. 알림 생성·삭제는 앱 폼·버튼 → `finance.alert.create/delete` RPC. 페르소나는 "알림은 네가 만들거나 지울 수 없다" 를 명시                                                           | [00] M1, phase45     |
| M2  | proactive 문구 결정적       | 말풍선·시스템 알림 본문 = 서버가 만든 문자열(`evaluation.message`, schedule `output`) 그대로. 제목·안내는 클라이언트 고정 템플릿(`Copy`). "설명 물어보기" 는 입력창 **프리필만**, 자동 전송 없음 | [00] M2              |
| M3  | 화면 = 저장본               | 답 말풍선의 최종 텍스트는 `chat.stream.end.result.text` 로 교체. delta 는 임시                                                                                                                   | [R46] §7, phase46 Q9 |
| M4  | 1인 감사 가능 크기          | Swift `Sources/` 비어 있지 않은 줄 ≤ **1,200**, 외부 SPM 의존성 **0**(Foundation·SwiftUI·AppKit·UserNotifications·Testing). 서버 프로덕션 ≤ ~110 줄 순증. 전송 seam = 실 구현 1 + 테스트 fake 1  | [00] M4              |
| M5  | 구독 CLI 전용               | 맥 앱은 Anthropic API·SDK 를 쓰지 않는다. 새 npm 의존성 0                                                                                                                                        | [00] M5              |
| M6  | mock-only 테스트            | `swift test` = 순수 리듀서·코덱·fake 전송만. 실 gateway 접속은 `--smoke` 수동 실행(§8-2). 서버는 기존 vitest mock                                                                                | [00] M6              |
| M7  | Discord 는 선택             | Discord 토큰이 없어도 맥·알림·브리핑 전부 동작. 토큰이 있으면 기존 Discord 동작 그대로                                                                                                           | [00] M7, phase46 I8  |
| M8  | 로컬 보안 경계              | 토큰은 `~/.finclaw/gateway.token` 을 **접속 시도마다** 읽는다. `Authorization: Bearer` 헤더로만 보낸다(URL·로그·UI 노출 금지). App Sandbox 비적용. 기본 접속 대상 `ws://127.0.0.1:3000/`         | [00] M8              |
| M9  | 시스템 프롬프트 정적        | 페르소나는 프롬프트 파일의 고정 섹션. 채널별·턴별 프롬프트 없음                                                                                                                                  | phase46 I9           |
| M10 | 정확히 1 종료 소비          | 리듀서는 run 당 `end`/`error` 1회를 종료로 본다. `error{reason:'aborted'}` 는 error 표정이 아니라 idle                                                                                           | phase46 I11          |
| M11 | 포커스를 뺏지 않는다        | proactive 는 `orderFrontRegardless()` 만 하고 `makeKey` 하지 않는다. 패널은 nonactivating                                                                                                        | [20] §3-9 P1         |
| M12 | 커밋 규율                   | 밀스톤 = 1커밋, 단독 green. 서버 = `pnpm format && pnpm lint && pnpm typecheck && pnpm build && pnpm test`, Swift = `swift build && swift test` + `pnpm format && pnpm lint`                     | CONTRIBUTING         |

---

## 1. ★ 확정 아키텍처 — A: 네이티브 Swift 클라이언트(`apps/mac/`, 의존성 0) + 서버 최소 확장

### 1-1. 구조

```
┌─────────────── apps/mac → dist/FinClaw.app (LSUIElement, ad-hoc 서명, 비샌드박스) ───────────────┐
│  MenuBarExtra 5항목 ──┐                                                                           │
│  CharacterPanel (borderless nonactivating NSPanel, 전 Space, floating)                             │
│    └ NSHostingView ← CharacterView(TimelineView+Canvas) · BubbleView · ChatPanelView · AlertFormView │
│              ▲ CharacterState                     │ 사용자 액션 (send·abort·reset·history·alert.*)  │
│  AppModel (@MainActor @Observable) ── CharacterReducer.reduce(&state, event, now)  ── Notifier ──▶ UNUserNotificationCenter
│              ▲ ClientEvent                        │ call / send(runId) / abort / reset              │
│  GatewayClient (@MainActor) ── WebSocketConnection (URLSessionWebSocketTask | 테스트 fake)          │
│        └ 접속마다 ~/.finclaw/gateway.token 재읽기 · ping 25s · 백오프 0.8s×1.7ⁿ ≤15s              │
└────────────────────────────┬─────────────────────────────────────────────────────────────────────┘
        ws://127.0.0.1:3000/  ·  Authorization: Bearer <token>  ·  JSON-RPC 2.0 텍스트 프레임
┌────────────────────────────▼──────────── packages/server (단일 Node 프로세스) ─────────────────────┐
│ gateway RPC: chat.start · chat.send{runId?}[변경] · chat.abort · chat.reset · chat.history[신규]       │
│              finance.alert.create(channels 기본 변경) · finance.alert.list · finance.alert.delete[신규] │
│ broadcaster.send(conn, …)        → chat.stream.{delta,tool,end,error}        (호출한 연결에만)        │
│ broadcaster.broadcastToChannel() → notification.{alert.triggered[신규], schedule.completed, …} (구독 연결 전부) │
│ AgentRuntime → claude -p stream-json (phase46, 변경 없음 — 프롬프트 파일에 "핀" 섹션만 추가)        │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**proactive 경로:**

```
(a) 가격·뉴스 알림 (phase47 신규 경로)
alerts monitor 30s (또는 create 직후 evaluateOnce) → cooldown 15분 → evaluator.triggered
 → dispatcher: alert.channels 마다 핸들러 (Promise.allSettled)
     log       → logger.info
     websocket → [신규] getBroadcast()(AlertTriggeredData) → broadcastToChannel('alert.triggered')
                 바인딩 전이거나 받은 연결 0 이면 throw → alert_history 에 실패가 정직하게 남음
     discord   → users.fetch(DISCORD_ALERT_USER_ID ?? alert.userId).createDM().send   [M3 수정]
 → store.recordTrigger (성공/실패와 무관하게 cooldown 시작)
 → 맥: notification.alert.triggered → reducer(alert 표정 + 말풍선 또는 큐) + Notifier(.active 배너, identifier=alertId)

(b) 예약 브리핑 (서버 변경 없음)
scheduler oneShot run → deliveryHook → deliverScheduleResult(deliveryChannel 'web')
 → broadcastToChannel('schedule.completed', {scheduleId,name,runId,output,error?,completedAt})
 → 맥: reducer(alert 표정 + 말풍선 앞 6줄) + Notifier(.passive, identifier=scheduleId)

(c) 연결 상태 (서버 변경 없음)
close · system.shutdown · heartbeat terminate → offline 표정(10s 뒤 사유 말풍선) → 백오프 재연결
 → 토큰 재읽기 → chat.start 성공 = 온라인 → idle ("다시 연결됐어요")
```

### 1-2. 왜 이 선택인가 (조사 근거)

- **네이티브 Swift(A) 채택.** Tauri·Electron 은 K1(외부 툴체인·의존성 추가)에서 탈락했다. WKWebView 셸(D)은 K1 은 통과하지만 C3(Swift + Lit 두 상태 저장소)·C9(브리지 테스트 불가)·C11(토큰을 웹뷰로 넘겨야 함)에서 A 보다 나쁘다. 재사용 이점은 채팅 목록 하나(~45줄)뿐이다([20] §2-1). 캐릭터 앱의 핵심인 표정·말풍선·proactive 는 어차피 네이티브여야 한다.
- **SwiftPM 만으로 빌드·번들·서명이 된다(실측).** tools 6.0 / macOS 14, 콜드 빌드 10초, `.app` 조립 스크립트 ~25줄, ad-hoc 서명 `.app` 과 번들 없는 실행 파일 둘 다 `ws://127.0.0.1` JSON-RPC 왕복 성공, ATS 예외 불필요([L23]).
- **창 = nonactivating borderless `NSPanel` + `canBecomeKey` + `becomesKeyOnlyIfNeeded`.** TextField 를 클릭할 때만 key 가 되고 앱을 활성화하지 않는다. 실측 빌드 경고 0, layer 3([L1] §4). SwiftUI `Window` 의 창 수식어는 macOS 15+ 라 탈락했고, 일반 `NSWindow` 는 클릭하면 이전 앱의 포커스를 뺏는다([20] §2-3).
- **캐릭터 = `TimelineView` + `Canvas` 코드 벡터.** 외부 에셋 0, 상태 추가 비용이 파라미터 하나, `FaceParams` 단위 테스트와 `--snapshot` PNG 로 검증할 수 있다. Lottie·Rive 는 SPM 의존(K1)으로 탈락했고 스프라이트는 상태마다 그림이 필요하다([20] §2-2).
- **상태 = Core 의 순수 리듀서.** Hopet `SessionStateMachine` 의 "순수 전이 함수" 패턴만 빌린다(TCA 는 K1·예산 초과로 기각 — [20] §2-4).
- **서버는 붙일 자리만 연다.** 대화·스트림·인증·브리핑 broadcast 는 phase46 에 이미 있다. 새로 여는 것은 가격 알림을 WS 로 밀어주는 핸들러, 알림 삭제, 패널용 이력, 클라이언트 runId 다. 구독 RPC·재전달 큐·범용 NotificationSink 는 만들지 않는다([00] M4).
- **기각:** 범용 `JSONValue` enum(두 단계 `Decodable` 로 대체, −45줄), Swift `actor` GatewayClient(소비자가 전부 MainActor UI → `@MainActor final class` 가 continuation 이중 resume 을 구조적으로 막음 — [20] §3-2), `?token=` 쿼리 인증(토큰이 URL 로그에 남음), sessionId 기반 이벤트 필터(유휴 만료 뒤 재-start 로 sessionId 가 바뀜), SwiftUI `.contextMenu`(nonactivating 패널에서 불안정 — [L1] §3-2), `INFocusStatusCenter`(entitlement 필요), `sharingType = .none`(macOS 15+ 무효).

### 1-3. 검증된 전제 vs 남은 go/no-go

| #   | 전제                                                                                    | 상태                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —   | SwiftPM 전용 빌드, `.app` 번들, ad-hoc 서명, 평문 WS 왕복, `ImageRenderer` 헤드리스 PNG | **통과(실측)** [L23]                                                                                                                                                              |
| —   | nonactivating 패널 생성·autosave·layer 3                                                | **통과(실측)** [L1] §4 (키 입력·드래그는 G4)                                                                                                                                      |
| G2  | 유휴 TTL 이 진행 중 run 을 끊지 않음                                                    | **통과(코드)** `registry.ts:106-112` `runs === 0` 일 때만 `stopSession`. `stopSession` 호출처는 cleanup·dispose 뿐                                                                |
| G5  | `chat.stream.tool.name` 형식                                                            | **통과(실측 픽스처)** `mcp__finclaw__<tool>` → 마지막 `__` 뒤 조회                                                                                                                |
| —   | 업그레이드 경로·인증 우선순위·4001/1013/4008 close·서버 heartbeat 30s                   | **통과(코드)** `server.ts:89-92`, `auth/index.ts:13-57`, `ws/connection.ts:28-39`, `ws/heartbeat.ts:15-33`                                                                        |
| G6  | `Authorization` 헤더가 `URLSessionWebSocketTask` 업그레이드 요청에 실린다               | 구현 중 확인 — M5 `--smoke` (에이전트). no-go 면 `?token=` 쿼리로 바꾸고 서버 access log 에 토큰이 안 남는지 확인                                                                 |
| G7  | `URLSessionWebSocketTask` 가 서버 ping 에 자동 pong                                     | 구현 중 확인 — M5 `--smoke … --listen 100` (에이전트). 90s 넘게 연결이 유지돼야 함. no-go 면 25s 주기 `system.ping` RPC 로 대체                                                   |
| G9  | 서버 close 4001 을 `closeCode.rawValue == 4001` 로 읽을 수 있다                         | 구현 중 확인 — M5 `--smoke` + `-tokenPath <위조 토큰 파일>` (에이전트). no-go 면 `closeReason` 문자열로 판별, 그것도 안 되면 serverDown 으로 표시하고 문구에 "토큰" 안내를 덧붙임 |
| G3  | `macos-latest` 러너의 Swift ≥ 6.0 + Swift Testing                                       | 구현 중 확인 — M5 첫 push (메인이 PR 에서 확인). no-go 면 `mac.yml` **삭제** + review 기록(`continue-on-error` 금지)                                                              |
| G8  | `ImageRenderer` 로 `CharacterCanvas`·말풍선 렌더                                        | 구현 중 확인 — M7 `--snapshot` (에이전트가 PNG 육안 확인). no-go 면 스냅샷 경로만 `Path` 기반 `Shape` 조합으로                                                                    |
| G4  | nonactivating 패널의 TextField 키 입력·Enter 전송·포커스 복귀                           | 구현 중 확인 — M7 **사람**. no-go 면 입력창만 `MenuBarExtra(.window)` 팝오버로 이동, 캐릭터는 표시 전용                                                                           |
| G1  | ad-hoc `.app` 의 `UNUserNotificationCenter` 권한·배너                                   | 구현 중 확인 — M8 **사람**(첫 번들 실행). no-go 면 시스템 알림 없이 말풍선만 + review 기록. 재빌드마다 권한을 잃으면 README 에 안내                                               |

> phase46 의 최대 리스크([20] R1 인터페이스 drift)는 코드 대조로 **대부분 해소**됐다. 남은 go/no-go 는 전부 폴백이 수 줄~파일 1개 단위다. 에이전트가 확인할 수 없는 것은 G1·G4 둘이며 사람 스모크로 넘긴다.

---

## 2. 확정 결정

### 2-1. Q1~Q14 ([20] §4 그대로 채택)

| Q                        | 결정                                                                                                             | 근거 한 줄                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Q1 페르소나 범위         | **전 채널 공통** — `finclaw.system.ko.md` 에 `## 캐릭터 — 핀` 섹션(§4-7)                                         | sessionKey 공유 시 채널별 프롬프트는 I9 를 깬다          |
| Q2 이름·말투             | **"핀", 해요체, 이모지·감탄사·느낌표 없음.** 꾸밈은 클라이언트 고정 템플릿에서만                                 | [L4] Q5. 1음절, Fin = 지느러미 디자인과 연결             |
| Q3 sessionKey            | **공유** — `chat.start{agentId:'default'}` → `tui:local:default` (Web·TUI 와 같은 대화). 이벤트 필터는 **runId** | 맥이 못 본 Web 턴도 모델은 기억 → 패널 이력(Q5)으로 보완 |
| Q4 말로 알림 만들기      | **앱 폼 → RPC.** 캐릭터(모델)는 안내만                                                                           | M1. phase45 `set_alert` 삭제를 뒤집지 않음               |
| Q5 `chat.history`        | **IN** — `limit` 1..40, 기본 20 (U1)                                                                             | 공유 세션이라 패널에 이력이 없으면 대화가 맥락 없이 보임 |
| Q6 Discord DM 결함       | **IN, 별도 `fix(phase47)` 커밋(M3)** — `DISCORD_ALERT_USER_ID`                                                   | 프로덕션 ~12줄 + 테스트 2. 되돌리기 쉬운 단독 커밋       |
| Q7 놓친 알림 재전달      | **없음.** websocket 핸들러가 throw → `alert_history` 에 실패 기록, 가격 알림은 알림 센터에도 남음                | 재전달 큐는 M4 위반                                      |
| Q8 배포 타깃             | **macOS 14 / tools 6.0**                                                                                         | [L23] 실측, CI 러너 호환                                 |
| Q9 세션 만료 판별        | 클라이언트 `message.contains("session not found")` → `chat.start` 후 **1회** 재전송                              | 서버 변경 시 Web/TUI 영향. 픽스처 테스트로 고정          |
| Q10 TTL 이 run 을 끊는가 | **아니다 (G2 통과)** — 서버 변경 없음                                                                            | `registry.ts:109`                                        |
| Q11 Docker 서버          | 로컬 Node 서버 전제. README 안내만                                                                               | 컨테이너 토큰은 호스트 `~/.finclaw` 에 없음              |
| Q12 KRX                  | 범위 밖. 페르소나에도 국내 종목 단정 문구 없음                                                                   | 데이터 가용성 미확인                                     |
| Q13 도구 문구            | 맵(§4-6). 모르는 이름은 "도구 사용 중…", `get_current_datetime` 은 표시 안 함                                    | 원문 MCP 이름은 말풍선에서 읽기 어렵다                   |
| Q14 연결 시작            | 실행 즉시 접속, 백오프 0.8s × 1.7ⁿ / 최대 15s, `chat.start` 성공 시 초기화. offline 말풍선은 끊긴 지 10s 뒤부터  | 짧은 끊김에는 말하지 않음([L4])                          |

### 2-2. [20] §7 미결 9개 — 해소

| #   | 항목                                       | 결정 (확정 값)                                                                                                                                                                   | 근거                                                                                                                            |
| --- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| U1  | `chat.history` IN 여부                     | **IN** (M2)                                                                                                                                                                      | 서버 ~25줄. 재연결 후 `lostRun` 안내의 "자세히" 가 기댈 곳이 이것뿐이다(rebind 는 OUT)                                          |
| U2  | 브리핑 "자세히" 내용                       | **메모리에 보관한 `output` 전문**을 펼친 패널에 표시(앱 재시작 시 사라짐)                                                                                                        | Web 이 떠 있다는 보장이 없다. 영속 정본은 `agent_runs`(runId)                                                                   |
| U3  | `bundle.sh` 커밋 위치                      | **M8** (proactive 밀스톤과 같은 커밋)                                                                                                                                            | G1(알림 권한) 판정에 번들이 필요하다. 커밋되지 않은 임시 스크립트로 검증하면 검증한 것과 커밋한 것이 달라질 수 있다             |
| U4  | 가격 알림 시스템 배너 조건                 | **항상** `.active` 배너(기본 사운드). 브리핑은 항상 `.passive`                                                                                                                   | `.accessory` + nonactivating 패널이라 `NSApp.isActive` 가 사실상 항상 false — "비활성일 때만" 은 "항상" 과 같다. 자리 비움 대비 |
| U5  | 자동 닫힘 수치                             | 답 `clamp(4 + 글자수/8, 6, 25)`s · 가격/뉴스 알림 60s · 브리핑 30s · error 5s · 안내(notice) 3s(lostRun 안내 8s) · offline 말풍선 지연 10s · happy 1.2s. 전부 `Copy`/리듀서 상수 | [20] 표 그대로. config 키 없음(phase46 D8 원칙)                                                                                 |
| U6  | 테스트 프레임워크                          | **Swift Testing** (`import Testing`). G3 no-go 여도 XCTest 로 바꾸지 않고 워크플로를 뺀다                                                                                        | 로컬 툴체인(Swift 6.4) 지원. 러너 문제를 테스트 코드 재작성으로 풀지 않음                                                       |
| U7  | 0.18s 상태 보간·click-through·드래그 clamp | **phase47 에서 추가하지 않음**(phase48+). 스모크 #13 결과만 review 에 기록                                                                                                       | 보간은 이전 파라미터 보관으로 리듀서가 복잡해짐. click-through 는 30fps 폴링 비용                                               |
| U8  | Discord env 이름·문서 위치                 | **`DISCORD_ALERT_USER_ID`** — `.env.example`(M3) + README "선택 — Discord" 표(M9)                                                                                                | 기존 `DISCORD_BOT_TOKEN` 과 같은 접두. 사용자 식별자라 튜닝 상수가 아님                                                         |
| U9  | 앱 번들 이름·식별자                        | **`FinClaw.app`**, `CFBundleIdentifier = local.finclaw.mac`, 실행 파일 `FinClawMac`, `CFBundleShortVersionString 0.1.0`                                                          | 레포 이름과 일치. `local.` 접두는 배포 도메인이 없음을 드러냄. 캐릭터 이름(핀)이 바뀌어도 번들은 유지                           |

### 2-3. phase46 이월 항목 판단 ([R46] §7)

| 항목                                       | 판단           | 근거                                                                                                                                                                                                                                                              |
| ------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| alerts websocket + `alert.triggered`       | **IN (M1)**    | proactive 의 핵심                                                                                                                                                                                                                                                 |
| `chat.history`                             | **IN (M2)**    | U1                                                                                                                                                                                                                                                                |
| 클라이언트 지정 runId                      | **IN (M2)**    | `chat.send` 핸들러는 `void streamRun(...)` 뒤 `{runId}` 를 반환한다(`chat.ts`). 즉시 실패 이벤트가 응답보다 먼저 오면 서버 발급 runId 로는 짝을 지을 수 없어 핀이 thinking 에 갇힌다. 클라이언트가 UUID 를 먼저 정하면 리듀서가 전송 전에 runId 를 안다. 서버 3줄 |
| `end.result` 의 `captured`/`usedMemoryIds` | OUT (phase48+) | 맥 UI 에 표시할 곳이 없다(기억 꼬리표는 Discord 전용 UX)                                                                                                                                                                                                          |
| 재연결 rebind                              | OUT (phase48+) | 끊긴 동안의 run 은 서버에서 끝까지 돌아 저장된다(phase46 S9). 맥은 `lostRun` 안내 + `chat.history` 로 복구                                                                                                                                                        |
| 상주 CLI 프로세스(G6 p50 3.2s)             | OUT (phase48+) | 첫 토큰 지연은 thinking 표정이 덮는다. 체감이 나쁘면 그때 측정                                                                                                                                                                                                    |

### 2-4. plan 이 추가로 정한 것

| #   | 항목                             | 결정                                                                                                                                                                                                                                             | 근거                                                                                                  |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| D1  | 접속 대상·토큰 경로 바꾸기       | `UserDefaults.standard` 키 `gatewayURL`(기본 `ws://127.0.0.1:3000/`), `tokenPath`(기본 `~/.finclaw/gateway.token`). 인자 도메인 덕에 `FinClawMac -gatewayURL ws://127.0.0.1:3001/` 와 `defaults write local.finclaw.mac gatewayURL …` 둘 다 동작 | `GATEWAY_PORT` 가 있는데 맥만 3000 고정이면 안 된다. 헤드리스 스모크의 위조 토큰(G9)에도 씀. 코드 2줄 |
| D2  | 헤드리스 스모크                  | 실행 파일 모드 `FinClawMac --smoke "<질문>" [--listen <초>]` (§8-2). 화면·NSApplication 없이 Core `GatewayClient` 로 접속 → `chat.start → send → end` 를 한 줄씩 출력. 토큰은 출력하지 않음                                                      | 에이전트가 실 서버에 대한 Swift 경로(G6·G7·G9·프레임 디코드)를 직접 확인할 유일한 수단                |
| D3  | 시각 검증                        | 실행 파일 모드 `FinClawMac --snapshot <dir>` → 9 mood + 말풍선 4종 + 패널 2종 PNG(§8-1). 뷰는 `AppModel` 이 아니라 **상태 값 + 액션 클로저**를 받도록 짠다(스냅샷이 샘플 상태로 그대로 렌더)                                                     | `screencapture` 불가([L23]). 상태 값을 받는 뷰가 테스트·스냅샷 둘 다에 단순                           |
| D4  | run 중 입력                      | run 진행 중에는 입력창을 잠그고 중지(⌘.)만 제공. 큐잉 없음                                                                                                                                                                                       | Web 의 메시지 큐는 옮기지 않는다([00] §2-3). per-session lane 직렬화와 중복 방지                      |
| D5  | `finance.alert.create` 기본 채널 | `deps.alertChannels ?? ['log', 'websocket']`. main 이 Discord client **와** `DISCORD_ALERT_USER_ID` 가 둘 다 있을 때만 `['log','websocket','discord']` 주입                                                                                      | Discord 가 없을 때 항상 실패하는 채널을 기본에 두지 않는다                                            |
| D6  | 알림 제목                        | 알림 이름 `"{SYMBOL} {condition}"`(`finance.ts:282`)의 접미로 결정적 제목: `price_above`/`price_below` → "{SYMBOL} 가격 알림", `change_percent` → "{SYMBOL} 등락 알림", `news_match` → "{SYMBOL} 뉴스 알림", 그 외 → "알림"                      | [20] 의 고정 "가격 알림이에요" 는 뉴스 알림에도 붙는다                                                |
| D7  | 줄 수 측정                       | `find apps/mac/Sources -name '*.swift' -exec cat {} + \| grep -cv '^[[:space:]]*$'` ≤ 1,200 (주석 포함, 빈 줄 제외). 테스트·스크립트 제외. 초과 시 1순위로 스냅샷의 패널 2종, 2순위로 `--listen` 을 뺀다                                         | 측정 방법이 없으면 예산이 의미 없다                                                                   |
| D8  | 레포 통합                        | `.gitignore` 에 `apps/mac/.build/`·`apps/mac/.swiftpm/`, `.oxfmtrc.json` `ignorePatterns` 에 `apps/mac/.build/`. `oxlintrc.json` 은 M5 에서 `pnpm lint` 가 `apps/mac` 를 건드릴 때만 수정. `apps/mac/dist/` 는 기존 `dist/` 규칙으로 이미 무시   | lefthook glob 은 `*.swift` 를 보지 않는다. oxfmt 가 gitignore 를 따르는지 미확인 → 명시               |

---

## 3. 타입 / 인터페이스 확정안

### 3-1. `apps/mac/` 파일 트리 · 책임 · 줄 예산 (비어 있지 않은 줄, D7)

```
apps/mac/
  Package.swift                    // tools 6.0, .macOS(.v14), 의존성 0, 타깃 3
  Sources/FinClawMacCore/          // Foundation 만 (AppKit·SwiftUI import 금지) → swift test 대상
  Sources/FinClawMac/              // SwiftUI + AppKit + UserNotifications 실행 파일
  Tests/FinClawMacCoreTests/       // Swift Testing + Fixtures/frames.jsonl
  scripts/bundle.sh                // release 빌드 → dist/FinClaw.app → ad-hoc 서명
  README.md
```

```swift
// Package.swift
// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "FinClawMac",
  platforms: [.macOS(.v14)],
  targets: [
    .target(name: "FinClawMacCore"),
    .executableTarget(name: "FinClawMac", dependencies: ["FinClawMacCore"]),
    .testTarget(name: "FinClawMacCoreTests", dependencies: ["FinClawMacCore"],
                resources: [.copy("Fixtures")]),
  ]
)
```

| 타깃 | 파일                                                                                                  | 책임                                                                                                                                                                                                  | 줄                  | 밀스톤 |
| ---- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------ |
| Core | `Protocol.swift`                                                                                      | 요청 인코드, 수신 프레임 두 단계 디코드(§3-2), `ServerEvent`·페이로드 Codable, `RpcError`                                                                                                             | 100                 | M5     |
| Core | `Connection.swift`                                                                                    | `WebSocketConnection` 프로토콜 + `URLSessionWebSocketTask` 적합 extension, `readToken(at:)`                                                                                                           | 45                  | M5     |
| Core | `GatewayClient.swift`                                                                                 | `@MainActor final class`: 증가 정수 id, pending continuation, 요청 타임아웃 30s, 수신 루프, ping 25s, 백오프 재연결, 접속마다 토큰 재읽기 + `chat.start`, `session not found` → 재-start + 1회 재전송 | 175                 | M5     |
| Core | `CharacterReducer.swift`                                                                              | `Mood`·`CharacterState`·`CharacterEvent`·`Bubble`·`Proactive`·`reduce` (§4-2 표)                                                                                                                      | 135                 | M6     |
| Core | `FaceParams.swift`                                                                                    | `FaceParams.at(mood:since:now:lastDeltaAt:reduceMotion:)` 순수 함수 (§4-1 수식)                                                                                                                       | 60                  | M6     |
| Core | `Copy.swift`                                                                                          | 사용자 문구 전부: 도구 문구 맵, reason·offline 문구, 안내, proactive 제목(D6), 접근성 라벨, 버튼                                                                                                      | 50                  | M6     |
|      | **Core 소계**                                                                                         |                                                                                                                                                                                                       | **565**             |        |
| Mac  | `App.swift`                                                                                           | `@main enum Entry` — `--snapshot`/`--smoke` 분기, 아니면 `FinClawMacApp.main()`. `App` + `MenuBarExtra` 5항목(§4-5). `Delegate`: `.accessory`, 패널 생성, 화면 변경 시 `ensureOnScreen`               | 70                  | M5·M7  |
| Mac  | `Smoke.swift`                                                                                         | 헤드리스 스모크(§8-2) — `GatewayClient` 이벤트를 한 줄씩 출력, 종료 코드                                                                                                                              | 35                  | M5     |
| Mac  | `CharacterPanel.swift`                                                                                | [L1] §4 스니펫 + `FirstMouseHostingView` + 내용 크기 변경 시 우하단 기준 `setContentSize`                                                                                                             | 45                  | M7     |
| Mac  | `AppModel.swift`                                                                                      | `@MainActor @Observable`: `CharacterState` 보유, 클라이언트 이벤트 → `reduce`, 0.5s tick, Notifier 호출, 액션(send·abort·reset·history·alert create/list/delete), 펼침/상세 상태                      | 100                 | M7·M8  |
| Mac  | `CharacterView.swift`                                                                                 | `TimelineView(.animation(minimumInterval: 1/30, paused:))` + `CharacterCanvas(params:)`, 단일 `DragGesture(minimumDistance: 0)`(5px 이상 = 창 이동, 미만 = 탭), 접근성                                | 105                 | M7     |
| Mac  | `BubbleView.swift`                                                                                    | 말풍선(§4-3), 중지 버튼(⌘.), proactive 버튼("이 알림 삭제" 2단계·"설명 물어보기" 프리필), 큐 배지, 입력 `TextField`(`@FocusState`)                                                                    | 90                  | M7·M8  |
| Mac  | `Snapshot.swift`                                                                                      | `--snapshot <dir>`: 샘플 상태로 `ImageRenderer`(scale 2) → PNG 15장(§8-1)                                                                                                                             | 35                  | M7     |
| Mac  | `ChatPanelView.swift`                                                                                 | 펼친 패널 340×460pt, 상단 segmented "대화 \| 알림". 대화 = `chat.history{limit:20}` + 진행 중 스트림, 하단 자동 스크롤. 브리핑 상세(U2)는 같은 자리에 전문 + "닫기"                                   | 45                  | M8     |
| Mac  | `AlertFormView.swift`                                                                                 | 종목 TextField, 조건 segmented(이상/이하/등락률/뉴스), 값 또는 키워드, "만들기" → create. 목록(list) + 행마다 삭제(2단계). `provider_unavailable` 안내                                                | 70                  | M8     |
| Mac  | `Notifier.swift`                                                                                      | `Bundle.main.bundleIdentifier != nil` 일 때만 동작. 권한 요청 1회. identifier = alertId/scheduleId 교체 게시, interruptionLevel                                                                       | 25                  | M8     |
|      | **Mac 소계**                                                                                          |                                                                                                                                                                                                       | **620**             |        |
|      | **프로덕션 합계**                                                                                     |                                                                                                                                                                                                       | **1,185** (여유 15) |        |
| Test | `ProtocolTests` · `GatewayClientTests` · `ReducerTests` · `FaceParamsTests` + `Fixtures/frames.jsonl` | ~380 (예산 밖)                                                                                                                                                                                        |                     | M5·M6  |

[20] §3-1 대비: `Smoke.swift`(D2)·`Snapshot.swift`(D3) 를 별도 파일로 뺐고, `Copy` 에 알림 제목(D6)을 넣었다. 예산이 빠듯하므로 D7 의 절단 순서를 따른다.

### 3-2. Core 공개 타입 (`FinClawMacCore`)

```swift
// ── Protocol.swift ──
public struct RpcError: Error, Decodable, Equatable, Sendable { public let code: Int; public let message: String }
public enum ToolPhase: String, Decodable, Sendable { case start, end }

/// notification.alert.triggered params.data (서버 §3-4 AlertTriggeredData 와 1:1)
public struct AlertTriggered: Decodable, Equatable, Sendable {
  public let alertId: String, name: String, message: String, currentValue: String
  public let triggeredAt: Double                       // epoch ms
}
/// notification.schedule.completed params.data (server/src/automation/delivery.ts:95-102)
public struct ScheduleCompleted: Decodable, Equatable, Sendable {
  public let scheduleId: String, name: String
  public let runId: String?                            // agentRunId: string | null
  public let output: String
  public let error: String?                            // undefined 면 키 자체가 없음
  public let completedAt: Double
}

public enum ServerEvent: Equatable, Sendable {
  case delta(runId: String, text: String)                                        // chat.stream.delta
  case tool(runId: String, toolCallId: String, name: String, phase: ToolPhase, isError: Bool)
  case end(runId: String, text: String)                                          // result.text = 정본 (M3)
  case runError(runId: String, reason: String)                                   // AgentErrorReason 원문 문자열. error(raw) 는 UI 에 안 씀
  case alertTriggered(AlertTriggered)
  case scheduleCompleted(ScheduleCompleted)
  case shutdown                                                                  // system.shutdown
}
/// 텍스트 프레임 1개 → 응답(id 정수) 또는 이벤트. id 없고 모르는 method, id:null 파스 에러는 nil (무시).
public enum Frame: Equatable, Sendable { case response(id: Int, result: Result<Data, RpcError>), event(ServerEvent) }
public func decodeFrame(_ text: String) -> Frame?
public func encodeRequest(id: Int, method: String, params: some Encodable) throws -> String

// ── Connection.swift ──
public protocol WebSocketConnection: AnyObject, Sendable {   // 실 구현 1 (URLSessionWebSocketTask) + 테스트 fake 1
  func resume()
  func send(_ text: String) async throws
  func receive() async throws -> String                      // 텍스트 프레임만. binary 는 throw
  func sendPing() async throws                               // pongReceiveHandler 를 continuation 으로 감쌈
  func cancel()
  var closeCode: Int { get }                                 // G9: URLSessionWebSocketTask.closeCode.rawValue
}
public func readToken(at url: URL) -> String?                // trim, 빈 문자열 = nil

// ── GatewayClient.swift ──
public enum OfflineReason: Equatable, Sendable { case serverDown, noToken, badToken /* close 4001 */, shutdown }
public enum ClientEvent: Equatable, Sendable { case connecting, connected, disconnected(OfflineReason), server(ServerEvent) }

/// 재연결 지연: 0.8s × 1.7ⁿ, 최대 15s. 순수 함수라 테스트에서 직접 검증.
public func backoffDelay(attempt: Int) -> Duration

@MainActor public final class GatewayClient {
  public init(url: URL,
              tokenURL: URL,
              connect: @escaping (URLRequest) -> WebSocketConnection = { URLSession.shared.webSocketTask(with: $0) },
              sleep: @escaping (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
              requestTimeout: Duration = .seconds(30),
              onEvent: @escaping (ClientEvent) -> Void)
  public private(set) var sessionId: String?
  public func start()                                        // 즉시 접속, 실패하면 백오프 (Q14)
  public func reconnect()                                    // 메뉴바 "재연결" — 백오프 초기화 후 즉시
  public func call<R: Decodable>(_ method: String, _ params: some Encodable, as: R.Type) async throws -> R
  /// runId 는 호출자가 먼저 정한다(§2-3). "session not found" → chat.start + 1회 재전송.
  public func send(_ message: String, runId: String) async throws
  public func abort(runId: String) async throws
  public func reset() async throws
}
```

규칙(구현 노트):

- **두 단계 디코드.** 1단계 `Envelope { id: Int?; method: String?; error: RpcError? }` 로 분기한다. `id` 가 있으면 응답이고, 원문 `Data` 를 넘겨 호출자가 `R` 로 2단계 디코드한다. `method` 만 있으면 method 별 `params` 타입으로 디코드한다(`notification.*` 은 `params.data`). 범용 JSON enum 은 만들지 않는다.
- **온라인 = `chat.start` 성공.** 토큰 없이도 WS 는 열린다(level none, [00] §2-2 함정 1). `.connected` 는 `chat.start` 응답 뒤에만 낸다. 토큰 파일이 없으면 접속하지 않고 `.disconnected(.noToken)` 후 백오프.
- **헤더 인증.** `URLRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")`. 토큰은 접속 시도마다 다시 읽고, 로그·`print`·에러 문자열에 넣지 않는다.
- **continuation 규칙.** pending dict 에서 **먼저 꺼내고** resume 한다. 끊기면 남은 pending 을 전부 `RpcError(code: -1, message: "disconnected")` 로 끝낸다.
- **close 분류.** receive 실패 시 `closeCode == 4001` → `.badToken`, `system.shutdown` 을 받은 뒤면 `.shutdown`, 그 외 `.serverDown`. 4001 이면 백오프는 계속하되(서버 재시작으로 토큰이 바뀌면 복구) 최대 지연을 쓴다.
- **chat.start params:** `{agentId: "default"}` (model 생략). 접속마다 새로 호출해 `sessionId` 를 교체한다.
- **이벤트 필터는 리듀서가 runId 로.** 클라이언트는 sessionId 로 거르지 않는다.

### 3-3. 서버 — 신규·변경 RPC (zod 인라인, 기존 패턴)

| method                        | params                                                                  | result                                                    | 동작 / 에러                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chat.send` (변경)            | `{sessionId, message (1..20,000자), idempotencyKey?, runId?: z.uuid()}` | `{runId}` (즉시)                                          | `const runId = params.runId ?? randomUUID()`. `activeRuns.has(runId)` 면 `throw new Error('duplicate runId')`. 나머지 동작 불변                                                                                                                                                                                                                  |
| `chat.history` (신규)         | `{sessionId, limit?: z.number().int().min(1).max(40)}`                  | `{messages: {role: 'user'\|'assistant', text: string}[]}` | 세션 없음 → `throw new Error('session not found')`(send 와 같은 문자열 → 클라이언트 재-start 경로 재사용). `deps.storage` 없음 → `provider_unavailable: storage not initialized`. `getConversation(session.sessionKey)` 의 messages 중 role user/assistant 만, `content` 가 블록 배열이면 text 블록을 이어 붙여 `text` 로. 최근 `limit ?? 20` 개 |
| `finance.alert.delete` (신규) | `{alertId: z.string().min(1)}`                                          | `{deleted: boolean}`                                      | store 없음 → `provider_unavailable: alert store not initialized`. `deps.alertStore.delete(alertId)`. 없는 id 면 `{deleted:false}`. **`alert_history` 도 CASCADE 로 삭제됨**(§2 머리말 7)                                                                                                                                                         |
| `finance.alert.create` (변경) | 불변                                                                    | 불변                                                      | `channels: deps.alertChannels ?? ['log', 'websocket']` (D5)                                                                                                                                                                                                                                                                                      |

authLevel 전부 `'token'`. `types/src/gateway.ts` `RpcMethod` 에 `'finance.alert.delete' | 'chat.history'` 추가.

**의존성 주입 변경:**

```ts
// gateway/src/rpc/methods/chat.ts
export interface ChatMethodsDeps {
  // … 기존 그대로
  /** chat.history 용 (생략 시 provider_unavailable). */
  readonly storage?: Pick<StorageAdapter, 'getConversation'>;
}
// gateway/src/server.ts — GatewayServerDeps 에 같은 필드 1개, registerChatMethods 에 전달
readonly storage?: Pick<import('@finclaw/types').StorageAdapter, 'getConversation'>;

// gateway/src/rpc/methods/finance.ts — FinanceRpcDeps
/** create 시 채널 (생략 시 ['log','websocket']). main 이 Discord client + DISCORD_ALERT_USER_ID 일 때만 'discord' 추가 */
readonly alertChannels?: readonly DeliveryChannel[];
```

### 3-4. 서버 — notification · alerts

```ts
// packages/types/src/notification.ts (추가)
/** notification.alert.triggered params.data — 본문은 evaluator 가 만든 결정적 문자열 그대로 (M2). */
export interface AlertTriggeredData {
  readonly alertId: string;
  readonly name: string; // "{SYMBOL} {condition}" (finance.ts:282)
  readonly message: string; // evaluation.message
  readonly currentValue: string;
  readonly triggeredAt: number; // epoch ms
}

// packages/skills-finance/src/alerts/delivery.ts (추가 — 986f0e3 에서 지운 원본을 late-bind 로 복원)
export function createWebSocketDeliveryHandler(deps: {
  getBroadcast: () => ((data: AlertTriggeredData) => number) | undefined;
}): DeliveryHandler; // channel 'websocket'. 바인딩 전 → throw 'websocket broadcast not bound', 반환 0 → throw 'no websocket subscribers'

// 변경 — Q6
export function createDiscordDeliveryHandler(deps: {
  client: DiscordClientPort;
  userId?: string; // DISCORD_ALERT_USER_ID. 있으면 alert.userId 대신
}): DeliveryHandler; // users.fetch(deps.userId ?? alert.userId)

// packages/skills-finance/src/alerts/index.ts
export interface AlertSkillHandle {
  readonly monitor: AlertMonitor;
  readonly store: AlertStore;
  /** gateway 생성 뒤 main 이 호출 (scheduler setDeliveryHook 과 같은 패턴 — alerts 가 gateway 보다 먼저 생성됨). */
  setBroadcast(fn: (data: AlertTriggeredData) => number): void;
}
export interface AlertSkillConfig {
  // … 기존 그대로
  readonly discordUserId?: string; // M3
}
// registerAlertTools: let broadcast 가변 참조 1개. websocket 핸들러는 항상 등록, Discord 핸들러는 discordClient 있을 때만(현행)
```

```ts
// packages/gateway/src/ws/connection.ts:48
subscriptions: (new Set(['portfolio.changed', 'schedule.completed', 'alert.triggered']),
  // packages/server/src/main.ts (setDeliveryHook 바로 옆, gateway 생성 뒤)
  alertHandle?.setBroadcast((d) =>
    gateway.ctx.broadcaster.broadcastToChannel(gateway.ctx.connections, 'alert.triggered', d),
  ));
// createGatewayServer deps: storage (chat.history), financeDeps.alertChannels (M3)
```

Web(`app-chat.ts`)·TUI(`App.tsx`)의 notification `switch` 에는 default 가 없어 `notification.alert.triggered` 를 무시한다(phase46 D3 확인). 수정 없음.

### 3-5. env

| 변수                    | 기본   | 동작                                                                                                                                                                                                                                                         |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DISCORD_ALERT_USER_ID` | (없음) | 가격·뉴스 알림 Discord DM 수신자(Discord 사용자 id). `DISCORD_BOT_TOKEN` 과 함께 있을 때만 새 알림의 채널에 `'discord'` 가 붙고, Discord 핸들러가 이 id 로 DM 한다. **부수 효과:** 예전에 `['log','discord']` 로 만든 알림이 이때부터 실제로 Discord 로 간다 |

main 이 `process.env.DISCORD_ALERT_USER_ID || undefined` 를 한 번 읽어 `registerSkills` deps(`discordAlertUserId`)와 `alertChannels` 판단에 같이 쓴다(env 읽기 1곳). 맥 앱 쪽 env 는 없다(D1 은 UserDefaults).

---

## 4. 캐릭터 · UX 확정안

### 4-1. 캐릭터 "핀" — 그리기 수치 (구현자가 그대로 옮긴다)

**콘셉트:** 동그랗고 약간 납작한 민트색 모찌 몸에 등지느러미 하나. 이름 핀 = Fin(지느러미). 팔·다리·집게 없음([L4] (a)).

**좌표:** 논리 캔버스 100×100 unit, 원점 좌상단, y 아래로 증가. `s = min(w, h) / 100`. 표시 크기 96×96pt. 패널 안에서 캐릭터는 우하단, 말풍선은 그 위에 오른쪽 정렬.
**그리기 순서:** 등지느러미 → 몸 → 볼 → 눈 → 하이라이트 → 입 → 눈썹 → 소품.

| 파트       | 기하 (unit)                                                                                                        | 색                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| 몸         | RoundedRect x 14…86, y 28…90 (72×62), cornerRadius 30. 숨쉬기 스케일 기준점 (50, 90)                               | 채움 `#4CC3AE`, 외곽선 `#23786A` 2.0u (**필수**)      |
| 등지느러미 | `move(44,30)` → `quad(to: 57,9, control: 45,15)` → `quad(to: 68,31, control: 66,20)` → close. 회전 기준점 (56, 30) | 채움 `#2E9C89`, 외곽선 `#23786A` 2.0u                 |
| 눈 ×2      | 중심 (38, 56)·(62, 56), 타원 rx 5.5, ry 7.5 × `eyeOpen` × mood 배율                                                | `#16302C`                                             |
| 하이라이트 | 각 눈 중심 + (1.8, −2.8), 원 r 1.6 (감은 눈·∩ 눈에서는 생략)                                                       | 흰색 90%                                              |
| 볼 ×2      | 중심 (29, 66)·(71, 66), 타원 rx 5, ry 3                                                                            | `#FF8FA3` 35% (idle·talking), 55% (happy). 그 외 없음 |
| 입         | 기준점 (50, 71), 선 2.0u, round cap                                                                                | `#16302C`                                             |
| 눈썹       | 각 눈 위 y 45, 길이 8 (thinking·error 에서만)                                                                      | `#16302C` 2.0u                                        |
| 소품       | 몸 우상단 (84, 24) 기준                                                                                            | 아래 표                                               |

| mood         | 눈                                                  | 입                                         | 소품·몸                                                                                                                                              | 접근성 라벨            |
| ------------ | --------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| offline      | 감은 눈 ∪ (아래로 볼록한 호, 폭 10)                 | 없음                                       | 몸 채움 `#A7B0AE`, 소품 "z"(잉크색, 10pt), **애니메이션 정지**                                                                                       | "핀, 서버와 연결 끊김" |
| idle         | 기본, 깜빡임                                        | quad (45,69) → (55,69), control (50,74)    | 볼                                                                                                                                                   | "핀, 대기 중"          |
| listening    | ry ×1.1, 몸 전체 2° 기울임                          | quad (45,69) → (55,69), control (50,72)    | 지느러미 정지                                                                                                                                        | "핀, 입력 듣는 중"     |
| thinking     | ry ×0.75, 동공(눈 전체) (+2, −2) 이동               | 원 (53, 72) r 1.6                          | 오른 눈썹만 +3u 올림. 점 3개 (44/50/56, 18) r 1.8, 0.4s 간격 순차 opacity 0.3↔1                                                                      | "핀, 생각하는 중"      |
| working      | ry ×0.55, 눈 x 오프셋 `±2·sin(2π·0.8t)`             | 선 (46,71) → (54,71)                       | 270° 호 스피너 r 5 (1회전 / 1.2s, 선 2.0u 잉크색). 지느러미 ±4°                                                                                      | "핀, {도구 문구}"      |
| talking      | 기본, 깜빡임                                        | 타원 w 8, h `1.5 + 6·open`                 | 볼, 지느러미 ±4°                                                                                                                                     | "핀, 답하는 중"        |
| happy (1.2s) | 웃는 눈 ∩: 각 눈 (x−5, 57) → (x, 52) → (x+5, 57) 호 | quad (45,69) → (55,69), control (50,77)    | 볼 55%                                                                                                                                               | "핀, 대기 중"          |
| alert        | ry ×1.2                                             | 원 (50, 72) r 3.2                          | 앰버 `#F5A623` 원 r 6 + 잉크색 "!". 진입 후 p < 0.6s 동안 점프 `y −= 6·abs(sin(π·p/0.3))`(0.3s 짜리 2회). 진입 후 1.2s 동안 지느러미 ±10°·sin(2π·3t) | "핀, 새 알림: {title}" |
| error        | 걱정 눈썹(안쪽 끝 +2u), ry ×0.8                     | 물결 (45,72) → (50,70) → (55,72), quad 2개 | 앰버 원 r 6 + 잉크색 "?"                                                                                                                             | "핀, 문제가 생겼어요"  |

**움직임 수식 (t = 초, 전부 상수 — "노브"):**

- 숨쉬기: `scaleY = 1 + 0.025·sin(2πt/T)`, `scaleX = 1 − 0.012·sin(2πt/T)`, 기준점 (50, 90). T = 3.2s (working 1.6s). offline 은 1.
- 깜빡임: `k = floor(t / 4.2)`, 구간 시작점 `k·4.2 + (3.0 + 2.5·frac(hash(k)))` 부터 120ms 동안 `eyeOpen = 0.1`, 그 외 1. `hash(k)` = 결정적 정수 해시(예: `(k &* 2654435761) % 1000 / 1000`) — 테스트 가능.
- 입: `open = |sin(2π·4.5t)| · max(0, 1 − (now − lastDeltaAt)/0.45)`. delta 가 0.45s 끊기면 입이 닫힌다.
- 지느러미: 상태별 각도 진폭 × `sin(2π·1.2t)` (alert 진입 1.2s 동안은 3Hz).
- **Reduce Motion:** `paused: true` + t = 0 정지 얼굴(talking 은 `open = 0.5`), 점프·스피너 회전·점 순차 없음. 상태 전환 보간 없음(U7).

**색 규칙:** 빨강·파랑·초록을 상태색으로 쓰지 않는다(한국 시장에서 빨강 = 상승). 강조색은 앰버 `#F5A623` 하나다. 상태는 얼굴 모양 + 소품 + 라벨로 구분하고 색만으로 구분하지 않는다. 캐릭터 색은 라이트·다크 동일, 말풍선·패널은 시스템 material 과 `.primary` 텍스트.
**대비(계산값, [L4]):** 잉크 대 몸 6.5:1, 외곽선 대 흰 배경 5.3:1 · 다크 `#1E1E1E` 3.2:1. 몸 채움만으로는 흰 배경 2.2:1 이라 외곽선이 필수다.

### 4-2. 상태 전이 표 — 최종본 (`CharacterReducer.reduce(&state, event, now:)`)

```swift
public enum Mood: String, CaseIterable, Sendable { case offline, idle, listening, thinking, working, talking, happy, alert, error }

public struct Proactive: Equatable, Sendable {
  public enum Kind: Sendable { case alert, briefing }
  public let kind: Kind
  public let key: String        // alertId | scheduleId — 병합 키
  public let title: String      // Copy.alertTitle(name) (D6) | "브리핑 · {name}"
  public var body: String       // 서버 결정적 문자열: alert message / output 앞 6줄 / error 면 Copy.briefingFailed(name)
  public var detail: String?    // 브리핑 output 전문 (U2). alert 는 nil
  public var count = 1
}
public enum Bubble: Equatable, Sendable {
  case answer(text: String, closesAt: Date?)     // 스트리밍 중 nil
  case proactive(Proactive, closesAt: Date)
  case notice(String, closesAt: Date)            // 연결·유실·reset 안내 (클라이언트 고정 문구)
  case error(String, closesAt: Date)
}
public struct CharacterState: Equatable, Sendable {
  public var mood: Mood = .offline
  public var moodSince: Date
  public var runId: String?
  public var activeTools: [String: String] = [:]   // toolCallId → 문구 (문구 nil 인 도구는 넣지 않음)
  public var toolLabel: String?
  public var bubble: Bubble?
  public var queue: [Proactive] = []
  public var lastDeltaAt: Date?
  public var offlineSince: Date?
  public var offlineReason: OfflineReason?
  public var lostRun = false                        // run 도중 끊김
  public var inputFocused = false
  public var proactiveEnabled = true                // 메뉴바 "먼저 말 걸기"
  public init(now: Date)
}
public enum CharacterEvent: Equatable, Sendable {
  case client(ClientEvent)
  case sent(runId: String)         // chat.send RPC **전에** (§2-3)
  case requestFailed               // chat.send 등 RPC 실패
  case inputFocused(Bool)
  case dismiss                     // 말풍선 닫기 · 배지 클릭(다음 큐) 공용
  case setProactive(Bool)
  case notice(String)              // 3s 안내 (예: reset 완료)
  case tick(holdBubble: Bool)      // 0.5s. holdBubble = 호버 중이거나 패널 펼침 → 말풍선 닫힘만 보류
}
public enum CharacterReducer { public static func reduce(_ s: inout CharacterState, _ e: CharacterEvent, now: Date) }
```

mood 가 바뀔 때마다 `moodSince = now`.

| 이벤트                                                 | 조건                                                                           | 다음 mood                                                                            | 부수 효과                                                                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connecting` / `disconnected(r)` / `server(.shutdown)` | 항상 (최우선)                                                                  | **offline**                                                                          | `runId != nil` 이면 `lostRun = true`. `runId = nil`, `activeTools` 비움, `offlineSince` 는 처음 끊길 때만 설정, `offlineReason = r`(shutdown → `.shutdown`). 답 말풍선은 닫음 |
| `connected`                                            | offline                                                                        | idle                                                                                 | `offlineSince` 가 10s 를 넘었으면 notice "다시 연결됐어요" 3s. `lostRun` 이면 그 대신 notice `Copy.lostRun` 8s, `lostRun = false`. `offlineSince = nil`                       |
| `inputFocused(b)`                                      | idle ↔ listening                                                               | b ? listening : idle                                                                 | `inputFocused = b`. 다른 mood 에서는 플래그만 갱신                                                                                                                            |
| `sent(runId)`                                          | —                                                                              | thinking                                                                             | `runId` 설정, `bubble = .answer("", nil)`, `lastDeltaAt = nil`                                                                                                                |
| `server(.delta/.tool/.end/.runError)`                  | **runId 불일치** (`runId == nil` 포함)                                         | 그대로                                                                               | 무시                                                                                                                                                                          |
| `server(.delta)`                                       | runId 일치                                                                     | talking (working 중이면 그대로)                                                      | 텍스트 누적, `lastDeltaAt = now`                                                                                                                                              |
| `server(.tool start)`                                  | runId 일치, `Copy.toolLabel(name) != nil`                                      | working                                                                              | `activeTools[id] = 문구`, `toolLabel = 문구`                                                                                                                                  |
| `server(.tool start)`                                  | 문구 nil (`get_current_datetime`)                                              | 그대로                                                                               | 없음                                                                                                                                                                          |
| `server(.tool end)`                                    | runId 일치                                                                     | `activeTools` 가 비면 thinking, 남으면 working                                       | 그 항목 제거, `toolLabel` = 남은 것 중 최근 것. **`isError` 여도 error 로 가지 않음**                                                                                         |
| `server(.end(text))`                                   | runId 일치                                                                     | **happy**                                                                            | `bubble = .answer(text, now + clamp(4 + text.count/8, 6, 25)s)`, `runId = nil`, `activeTools` 비움                                                                            |
| `server(.runError("aborted"))`                         | runId 일치                                                                     | idle                                                                                 | 말풍선 닫음, `runId = nil`                                                                                                                                                    |
| `server(.runError(r))` / `requestFailed`               | runId 일치 / 항상                                                              | error                                                                                | `bubble = .error(Copy.reason(r) 또는 Copy.requestFailed, now + 5s)`, `runId = nil`, `activeTools` 비움                                                                        |
| `server(.alertTriggered / .scheduleCompleted)` → `p`   | 같은 `key` 가 큐나 화면 말풍선에 있음                                          | 그대로                                                                               | 그 항목 `count += 1`, `body`·`detail` 을 최신으로 교체                                                                                                                        |
| 〃                                                     | `runId != nil` · listening · answer/error 말풍선 표시 중 · `!proactiveEnabled` | 그대로                                                                               | `queue.append(p)` (배지 숫자)                                                                                                                                                 |
| 〃                                                     | 그 외                                                                          | alert                                                                                | `bubble = .proactive(p, now + (alert 60s / briefing 30s))`                                                                                                                    |
| `dismiss`                                              | —                                                                              | 큐가 있고 `proactiveEnabled` 면 alert(큐 앞 항목), 아니면 idle(offline 이면 offline) | 말풍선 닫음, 큐 앞에서 꺼냄                                                                                                                                                   |
| `notice(msg)`                                          | offline 아님                                                                   | 그대로                                                                               | `bubble = .notice(msg, now + 3s)` (answer·proactive 표시 중이면 무시)                                                                                                         |
| `tick(hold)`                                           | happy, `moodSince` + 1.2s 경과                                                 | talking (입은 `lastDeltaAt` 감쇠로 이미 닫혀 있음)                                   | —                                                                                                                                                                             |
| `tick(hold)`                                           | `!hold`, `closesAt` 경과                                                       | 큐가 있고 `proactiveEnabled` 면 alert(다음 항목), 아니면 idle                        | 말풍선 닫음. 만료된 proactive 는 **그냥 닫는다**(가격 알림은 알림 센터에 남음)                                                                                                |
| `tick(hold)`                                           | offline, `offlineSince + 10s` 경과, 말풍선 없음                                | offline                                                                              | `bubble = .notice(Copy.offline(r), .distantFuture)`                                                                                                                           |
| `setProactive(b)`                                      | —                                                                              | 그대로                                                                               | `proactiveEnabled = b`. true 로 바뀌고 idle 이면 큐 앞 항목을 alert 로                                                                                                        |

- **표시 우선순위:** offline > run 진행(working > thinking > talking/happy) > alert > error > listening > idle. run 중 proactive 는 큐로 간다.
- **회귀 테스트 필수 6종:** ① 도구 `isError` 뒤에도 error 아님 ② 다른 runId 의 delta·end 무시 ③ run 중 proactive → 큐 → end → 닫힘 tick 뒤 alert ④ 같은 key 2회 → 큐 길이 1, count 2 ⑤ 어느 mood 에서든 disconnected → offline (+ run 중이면 `lostRun`) ⑥ aborted 는 error 를 거치지 않고 idle.
- **추가 테스트:** `sent` 전 도착한 같은 runId 이벤트는 없다(클라이언트 runId 로 구조적으로 배제) — 대신 `sent` 직후 즉시 `runError` 가 와도 error 로 가는지 1건. `tick(holdBubble: true)` 는 닫지 않지만 happy→talking 은 진행.

### 4-3. 말풍선 규칙

| #   | 규칙                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | 최대 폭 300pt, 최대 6줄. 넘치면 앞부분 고정 + 아래 24pt 페이드 + "자세히 ▸"(→ 펼친 패널). 스트리밍 중 꼬리 따라 스크롤하지 않는다                                                                                                                                                                    |
| B2  | 타자 효과 없음. delta 를 그대로 붙인다(서버 150ms 배치). 입 움직임이 "말하는 중" 을 보여준다                                                                                                                                                                                                         |
| B3  | 마크다운: `try? AttributedString(markdown:, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))`, 실패하면 평문. 표·코드블록은 블록 서식 없이 패널에서 고정폭으로 보인다                                                                                                             |
| B4  | 자동 닫힘은 U5 수치. 마우스가 올라가 있거나 패널이 펼쳐져 있으면 닫지 않는다(`tick(holdBubble: true)`)                                                                                                                                                                                               |
| B5  | run 진행 중 말풍선 하단에 "중지" 버튼(`.keyboardShortcut(".", modifiers: .command)`) → `chat.abort{sessionId, runId}`                                                                                                                                                                                |
| B6  | proactive 말풍선: 제목(굵게) + 본문 + "×N"(count ≥ 2). alert 는 **"이 알림 삭제"**(첫 클릭 → 라벨 "한 번 더 누르면 기록까지 삭제돼요", 3s 안에 두 번째 클릭 → `finance.alert.delete`) + "설명 물어보기"(입력창 프리필 `이 알림 설명해줘: {body}`, 전송은 사용자가). 브리핑은 "자세히 ▸"(output 전문) |
| B7  | 큐 배지: 캐릭터 우상단 앰버 원 + 숫자. 클릭 → `dismiss`(다음 항목)                                                                                                                                                                                                                                   |
| B8  | 입력창: 캐릭터 탭 → `panel.makeKey()` + `@FocusState`, placeholder "핀에게 물어보기". Enter = 전송 후 `resignKey`, Esc = 닫기·`resignKey`. run 중에는 비활성(D4)                                                                                                                                     |
| B9  | 접근성: 캐릭터 `.accessibilityElement()` + §4-1 라벨 + hint "클릭하면 입력창이 열려요". `AccessibilityNotification.Announcement` 는 end(첫 문장)·alert(title + body) 에 각 1회, 가격 알림은 `.high`                                                                                                  |

### 4-4. proactive 규칙 — 최종본

| #   | 규칙                                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | 포커스를 뺏지 않는다. proactive 는 `orderFrontRegardless()` 만, `makeKey` 없음(M11)                                                                                                                                                                 |
| P2  | 시스템 알림: 가격·뉴스 알림은 **항상** `.active`(기본 사운드), 브리핑은 **항상** `.passive`(배너·소리 없이 알림 센터). identifier = alertId / scheduleId 로 교체 게시(쌓지 않음). 본문 = 서버 결정적 문자열. `timeSensitive`·`critical` 미사용 (U4) |
| P3  | 같은 key 는 하나만: 말풍선은 "×N", 시스템 알림은 identifier 교체                                                                                                                                                                                    |
| P4  | 대화 중이면 기다린다: run 진행·입력 중·답/에러 말풍선 표시 중이면 큐 + 배지                                                                                                                                                                         |
| P5  | 말풍선은 한 번에 하나. 배지 클릭 = 다음 항목. "최근 N개 목록" 없음(영속 기록 정본은 `get_alert_history`)                                                                                                                                            |
| P6  | 조용한 시간 설정 없음. OS 집중 모드가 시스템 알림을 거르고, 앱 말풍선은 메뉴바 "먼저 말 걸기" 토글이 끈다(off = 배지만, 시스템 알림은 계속)                                                                                                         |
| P7  | 먼저 말하는 내용은 결정적 문자열만. LLM 해설 자동 생성 금지. "설명 물어보기" 는 프리필만(M2)                                                                                                                                                        |
| P8  | 한 번에 끌 수 있어야 한다: 메뉴바 "먼저 말 걸기" · "캐릭터 숨기기" · 알림별 "이 알림 삭제"                                                                                                                                                          |

브리핑 `body` = `output` 앞 6줄. `error != nil` 이면 `Copy.briefingFailed(name)` = "브리핑 '{name}'을 만들지 못했어요"(raw error 미표시), `detail = nil`.

### 4-5. 창 · 메뉴바

- 패널은 [L1] §4 스니펫 그대로: borderless + nonactivating, `isFloatingPanel`, `becomesKeyOnlyIfNeeded`, `hidesOnDeactivate = false`, 투명, `hasShadow = false`, `isMovableByWindowBackground = true`, `collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]`, `canBecomeKey = true`, `canBecomeMain = false`, `setFrameAutosaveName("FinClawCharacter")` + `ensureOnScreen()`(`didChangeScreenParametersNotification` 에서도).
- 모드 2개: **접힘**(캐릭터 + 말풍선, 내용 크기) / **펼침**(340×460 `ChatPanelView`. 말풍선의 "자세히 ▸" 또는 입력창 오른쪽 "▸" 로 열고, 패널 상단 "접기" 로 닫는다). 크기 변경은 우하단 기준점 유지. 알림 폼은 펼친 패널의 "알림" 탭(별도 창·`Settings` 씬 없음 — macOS 26 빈 창 함정).
- **MenuBarExtra 5항목:** 캐릭터 보이기/숨기기 · 대화 새로 시작(`chat.reset` → notice "새 대화를 시작했어요") · 먼저 말 걸기(토글, `@AppStorage("proactiveEnabled")`) · 재연결 · 종료. 메뉴바 아이콘은 연결 상태(`face.smiling` / `zzz`). 우클릭 `.contextMenu` 는 쓰지 않는다.

### 4-6. 도구 문구 맵 · 사용자 문구 (`Copy`)

`Copy.toolLabel(name)` 은 `name` 의 마지막 `__` 뒤 부분으로 조회한다(`mcp__finclaw__route_task` → `route_task`).

| 도구                    | 문구                                         | working 진입 |
| ----------------------- | -------------------------------------------- | ------------ |
| `route_task`            | "알아보는 중…"                               | O            |
| `list_alerts`           | "알림 목록 보는 중…"                         | O            |
| `get_alert_history`     | "알림 기록 보는 중…"                         | O            |
| `get_current_datetime`  | `nil` (표시 안 함)                           | X            |
| 그 외 (외부 `mcp:*` 등) | "도구 사용 중…" (원문 이름은 `.help` 툴팁만) | O            |

여러 도구가 동시에 돌면 가장 최근에 시작한 도구의 문구. 문구 최소 유지 0.4s 는 뷰에서 처리.

| 키                             | 문구                                                                        |
| ------------------------------ | --------------------------------------------------------------------------- |
| reason `auth`                  | "Claude 로그인이 필요해요. 서버에서 `claude login` 을 실행해 주세요"        |
| reason `rate_limit`            | "Claude 사용 한도에 닿았어요. 잠시 후 다시 물어봐 주세요"                   |
| reason `timeout`               | "답이 너무 오래 걸려요. 질문을 나눠 주세요"                                 |
| reason 그 외                   | "답을 만드는 중에 문제가 생겼어요"                                          |
| `requestFailed`                | "요청을 보내지 못했어요. 잠시 후 다시 해 주세요"                            |
| offline `serverDown`           | "서버가 꺼져 있어요 (`pnpm start`)"                                         |
| offline `noToken`              | "토큰 파일이 없어요. 서버를 한 번 실행해 주세요"                            |
| offline `badToken`             | "토큰이 맞지 않아요. 서버를 다시 시작해 주세요"                             |
| offline `shutdown`             | "서버가 종료됐어요. 다시 켜지면 연결할게요"                                 |
| notice 재연결                  | "다시 연결됐어요"                                                           |
| notice `lostRun` (8s)          | "연결이 끊겨서 답을 못 받았어요. 자세히에서 확인해 주세요"                  |
| notice reset                   | "새 대화를 시작했어요"                                                      |
| 알림 폼 `provider_unavailable` | "알림 기능이 꺼져 있어요 — 시세·뉴스 API 키가 필요해요"                     |
| 알림 제목 (D6)                 | "{SYMBOL} 가격 알림" / "{SYMBOL} 등락 알림" / "{SYMBOL} 뉴스 알림" / "알림" |
| 브리핑 제목 / 실패             | "브리핑 · {name}" / "브리핑 '{name}'을 만들지 못했어요"                     |

클라이언트 문구에도 느낌표·이모지를 쓰지 않는다(페르소나와 같은 톤).

### 4-7. 페르소나 프롬프트 — 최종 문안 (M4, 전문)

**위치:** `packages/server/prompts/finclaw.system.ko.md` 의 `## 원칙` 목록(원칙 7 "실행 환경 정보 비공개") **바로 뒤**, `## 작업 위임 — \`route_task\`` **앞**. frontmatter(`id: finclaw-partner`, `name`)와 첫 줄 정체성 문장은 그대로 둔다(golden 테스트 `prompts/**tests**/identity.test.ts`가 frontmatter 를 고정). 원칙 6 의`<recent_conversation>`화자 라벨`FinClaw:` 도 그대로다(서비스 이름).

```markdown
## 캐릭터 — 핀

아래 말투 규칙은 위 `원칙`보다 우선순위가 낮다. 말투 때문에 도구 확인·출처·불확실성 표기를 줄이면 안 된다. 사용자의 돈이 걸린 답이기 때문이다.

- 사용자에게 보이는 너의 이름은 **핀**이다(FinClaw 는 서비스 이름이다). 사용자의 금융 정보를 조회·정리해 주는 비서다. 자기소개가 필요할 때만 이름을 말한다.
- **해요체**로 답한다("~예요", "~했어요"). 원칙과 아래 안내의 거절·안내 문구도 해요체로 바꿔 말한다("저는 조회·분석만 해요"). 이모지·감탄사·느낌표는 쓰지 않는다. 답은 작은 말풍선·채팅창·Discord 어디에든 표시될 수 있기 때문이다.
- **첫 문장(60자 이내)에 결론과 핵심 수치**를 쓴다. 상세 설명이 필요하면 빈 줄 다음에 이어 쓴다. 첫 문단에는 표·코드블록을 넣지 않는다.
- 확신을 과장하지 않는다. "지금이 기회", "곧 오를" 같은 표현 대신 근거와 범위를 말한다.
- 사고팔지를 묻는 질문에는 판단을 대신하지 않는다. 확인된 사실과 고려할 점만 정리한다.
- 가격·뉴스 알림은 네가 만들거나 지울 수 없다. 사용자가 알림 화면(맥 앱·웹)에서 직접 설정한다고 안내한다.

예시(중괄호는 자리표시다 — 실제 답에서는 반드시 도구로 확인한 값만 쓴다):

- 시세 → "애플은 지금 {가격}이에요({출처}, {시각} 기준). 전일 대비 {등락률}이에요."
- 확인 불가 → "{종목} 시세는 지금 확인할 수 없어요({원인})."
- 매매 권유 요청 → "사라 말라는 판단은 드리지 않아요. 대신 최근 실적과 뉴스를 정리해 드릴게요."
- 도구 오류 → "뉴스를 가져오지 못했어요({원인}). API 키 설정을 확인해 주세요."
```

[20] §3-7 초안 대비: "FinClaw 의 비서다" 를 "보이는 이름은 핀(FinClaw 는 서비스 이름)" 으로 바꿔 첫 줄 정체성 문장("너는 … FinClaw다")과 충돌하지 않게 했다. "가격 알림" 을 "가격·뉴스 알림" 으로 넓혔다(뉴스 조건 알림이 있다). 국내 종목 단정 문구는 [20] 대로 넣지 않는다(Q12).
**반영 시점:** CLI 는 세션 첫 요청에서 시스템 프롬프트를 snapshot 한다([R46] §5). 기존 대화에는 6시간 유휴 회전 또는 `chat.reset`/`!finclaw reset` 뒤에 적용된다. 수동 스모크는 reset 뒤에 본다.

---

## 5. 마일스톤 (각 = 게이트 green + 1커밋, ASCII subject, scope `phase47`)

**게이트:** 서버 밀스톤 = `pnpm format && pnpm lint && pnpm typecheck && pnpm build && pnpm test`. Swift 밀스톤 = `swift build --package-path apps/mac && swift test --package-path apps/mac && pnpm format && pnpm lint`(repo 전체 포맷 검사가 `apps/mac/README.md` 등을 본다) + D7 줄 수 확인.
**의존:** M0 → **M1 → M2 → M3 → M4**(서버) → **M5 → M6 → M7 → M8**(Swift) → **M9**. M3·M4 는 M1 이후 아무 데나 둬도 되고 Swift 와 독립이다. M5 는 alert 픽스처 shape 만 M1 에 의존한다. 브랜치 1개·1인 리뷰라 직렬로 진행한다.

### M0 — 실 프레임 캡처 (커밋 없음)

- **목적:** Swift 픽스처를 가공 없이 실측 프레임으로 만든다.
- **방법:** 서버 실행(`pnpm build && node packages/server/dist/main.js`) 후 `ws` 패키지(gateway 의존성)로 일회성 `node -e` 스크립트(레포에 커밋 안 함 — phase46 관례). `Authorization: Bearer $(cat ~/.finclaw/gateway.token)` 로 접속해 아래 원문을 한 줄씩 `_workspace/phase47/frames.jsonl` 에 저장:
  `chat.start` 응답 · `chat.send` 응답 · `chat.stream.delta` · `chat.stream.tool` start/end(`route_task` 를 부르는 질문, 시세 키가 없으면 `get_current_datetime`) · `chat.stream.end` · `chat.abort` 후 `chat.stream.error{reason:'aborted'}` · 없는 sessionId 로 `chat.send` → `-32603 "session not found"` · 토큰 없이 `chat.start` → `-32001` · `schedule.create{deliveryChannel:'web', deliveryTarget:'broadcast'}` + `schedule.runNow` → `notification.schedule.completed` · SIGTERM → `system.shutdown`.
- **개인정보(레포 PUBLIC):** M5 에서 픽스처로 옮길 때 토큰·이메일·홈 경로가 없는지 `grep` 으로 확인. UUID·모델 텍스트는 그대로 둔다.
- **검증:** 프레임 11종이 다 모였는가. 모자라면 M5 착수 전에 다시 캡처.

### M1 — 가격 알림을 websocket 클라이언트로

- **목적:** 알림이 맥(과 모든 WS 연결)에 실제로 도달하는 첫 경로를 연다.
- **파일:** EDIT `packages/types/src/notification.ts`(`AlertTriggeredData`) · EDIT `packages/skills-finance/src/alerts/delivery.ts`(`createWebSocketDeliveryHandler`) · EDIT `packages/skills-finance/src/alerts/index.ts`(가변 `broadcast` 참조 + `setBroadcast` + websocket 핸들러 항상 등록) · EDIT `packages/gateway/src/ws/connection.ts:48`(기본 구독 `alert.triggered`) · EDIT `packages/gateway/src/rpc/methods/finance.ts`(`FinanceRpcDeps.alertChannels?`, create 기본 `['log','websocket']`) · EDIT `packages/server/src/main.ts`(`alertHandle?.setBroadcast(...)`, `setDeliveryHook` 옆) · EDIT 테스트 `skills-finance/src/alerts/__tests__/delivery.test.ts`, `gateway/src/ws/connection.test.ts`, `gateway/src/rpc/methods/finance.test.ts`.
- **구현 노트:** §3-4. 핸들러 data = `{alertId: alert.id, name: alert.name, message: evaluation.message, currentValue: evaluation.currentValue, triggeredAt: Date.now()}`(`userId`·`type` 필드는 넣지 않는다 — 1인·채널명으로 충분). `DeliveryChannel` 타입은 `@finclaw/skills-finance` 가 이미 export 한다. 범용 추상(BroadcasterPort 부활 등) 금지.
- **검증:** `pnpm vitest run packages/skills-finance/src/alerts packages/gateway/src/ws packages/gateway/src/rpc/methods/finance.test.ts` — 케이스: websocket 핸들러가 바인딩된 함수에 위 shape 로 호출 · 반환 0 → reject · 바인딩 전 → reject · dispatcher 결과에 websocket 실패가 `success:false` 로 남음 · 기본 구독에 `alert.triggered` · create 기본 channels = `['log','websocket']` · `alertChannels` 주입 시 그 값. 게이트 green.
- **커밋:** `feat(phase47): push price alerts to websocket clients`

### M2 — alert delete · chat.history · 클라이언트 runId

- **목적:** 맥 UI 가 쓸 RPC 3개(삭제, 패널 이력, runId 선지정)를 연다.
- **파일:** EDIT `packages/gateway/src/rpc/methods/finance.ts`(`finance.alert.delete`) · EDIT `packages/gateway/src/rpc/methods/chat.ts`(`chat.history`, `ChatMethodsDeps.storage?`, `chat.send` 의 `runId?`) · EDIT `packages/gateway/src/server.ts`(`GatewayServerDeps.storage?` → chat deps) · EDIT `packages/types/src/gateway.ts`(`RpcMethod` 2개) · EDIT `packages/server/src/main.ts`(`createGatewayServer` deps 에 `storage`) · EDIT 테스트 `gateway/src/rpc/methods/{finance,chat}.test.ts`.
- **구현 노트:** §3-3 표 그대로. history 의 content 평탄화는 `typeof c === 'string' ? c : c.filter((b) => b.type === 'text').map((b) => b.text).join('')`. `duplicate runId` 는 `activeRuns` 키 검사 1줄. zod 는 기존 import(`zod/v4`)의 `z.uuid()`.
- **검증:** delete(있음 → `{deleted:true}` + store 에서 사라짐 · 없음 → false · store 없음 → `provider_unavailable`) · history(최근 N 개, 기본 20, 블록 content 평탄화, system/tool role 제외, 없는 세션 → `session not found`, storage 없음 → `provider_unavailable`, `limit` 0·41 → `-32602`) · send(`runId` 지정 → 응답·스트림 이벤트가 그 값, 진행 중 같은 runId → reject, 비-UUID → `-32602`, 생략 시 현행). 게이트 green.
- **커밋:** `feat(phase47): add alert delete, chat history and client run ids`

### M3 — Discord 알림 DM 수신자 (Q6, 결함 수정 단독 커밋)

- **목적:** RPC 로 만든 알림의 Discord DM 이 `users.fetch('default')` 로 항상 실패하던 결함을 닫는다.
- **파일:** EDIT `packages/skills-finance/src/alerts/delivery.ts`(Discord 핸들러 `userId?`) · EDIT `packages/skills-finance/src/alerts/index.ts`(`AlertSkillConfig.discordUserId?` 전달) · EDIT `packages/server/src/composition/skills.ts`(`RegisterSkillsDeps.discordAlertUserId?` → `registerAlertTools`) · EDIT `packages/server/src/main.ts`(env 1회 읽기 → skills deps + `financeDeps.alertChannels`) · EDIT `.env.example`(`DISCORD_ALERT_USER_ID=` + 설명 1줄) · EDIT `skills-finance/src/alerts/__tests__/delivery.test.ts`.
- **구현 노트:** §3-5. `alertChannels = discordAdapter && discordAlertUserId ? ['log','websocket','discord'] : undefined`. 스케줄 Discord 전달(`deliveryTarget` 사용)은 건드리지 않는다.
- **검증:** Discord 핸들러가 `userId` 가 있으면 그 값으로, 없으면 `alert.userId` 로 fetch(2건). 게이트 green.
- **커밋:** `fix(phase47): deliver Discord alert DMs to the configured user`

### M4 — 페르소나 "핀"

- **목적:** 전 채널 공통 말투 섹션 추가.
- **파일:** EDIT `packages/server/prompts/finclaw.system.ko.md`(§4-7 전문을 원칙 7 뒤에) · EDIT `packages/server/src/prompts/__tests__/identity.test.ts`(키워드 목록에 `'## 캐릭터 — 핀'`, `'해요체'` 추가).
- **구현 노트:** 프롬프트 파일은 oxfmt `**/prompts/` 무시 대상이다(포맷 훅은 `0cdcf32` 로 통과). 다른 섹션은 한 글자도 바꾸지 않는다.
- **검증:** `pnpm vitest run packages/server/src/prompts` green + 게이트 green. 실제 말투는 §8-3 #2(reset 뒤)에서 본다.
- **커밋:** `feat(phase47): give the assistant the Pin persona`

### M5 — 맥 패키지 · gateway 클라이언트 · 헤드리스 스모크 · CI

- **목적:** Swift 패키지 골격과 프로토콜 계층을 만들고, 화면 없이 실 서버와 왕복해 G6·G7·G9 를 판정한다. CI 러너(G3)도 여기서 판정.
- **파일:** CREATE `apps/mac/Package.swift` · CREATE `apps/mac/Sources/FinClawMacCore/{Protocol,Connection,GatewayClient}.swift` · CREATE `apps/mac/Sources/FinClawMac/{App,Smoke}.swift`(이 밀스톤의 `App.swift` 는 `Entry` 만: `--smoke` 면 스모크, 아니면 사용법 출력 후 exit 64 — GUI 는 M7) · CREATE `apps/mac/Tests/FinClawMacCoreTests/{ProtocolTests,GatewayClientTests}.swift` + `Fixtures/frames.jsonl`(M0 캡처본 + M1 테스트의 alert 페이로드 1줄) · CREATE `.github/workflows/mac.yml` · EDIT `.gitignore` · EDIT `.oxfmtrc.json`(D8).
- **구현 노트:** §3-2 규칙 전부. fake 전송은 `@unchecked Sendable final class` 에 보낸 프레임 배열과 수신 큐(`AsyncStream`)를 둔다. 시간은 `sleep` 주입으로 즉시 진행. `mac.yml`:

  ```yaml
  name: mac
  on:
    push:
      branches: [main, 'feature/*']
      paths: ['apps/mac/**', '.github/workflows/mac.yml']
    pull_request:
      branches: [main]
      paths: ['apps/mac/**', '.github/workflows/mac.yml']
  concurrency: { group: mac-${{ github.ref }}, cancel-in-progress: true }
  jobs:
    swift:
      runs-on: macos-latest
      timeout-minutes: 15
      steps:
        - uses: actions/checkout@v6
        - run: swift --version
        - run: swift build --package-path apps/mac
        - run: swift test --package-path apps/mac
  ```

- **검증 (자동):** `swift test` — Protocol: 픽스처 11종 + alert 1종이 기대 `Frame` 으로 디코드 · 모르는 method → nil · `id:null` 파스 에러 → nil · `-32603 "session not found"`·`-32001` 이 `RpcError` 로 · `encodeRequest` 왕복. GatewayClient(fake): 접속 요청에 `Authorization: Bearer <파일 토큰>` 헤더, URL 쿼리에 토큰 없음 · 토큰 파일 없음 → 접속 시도 없이 `.disconnected(.noToken)` · open 직후가 아니라 `chat.start` 응답 뒤에만 `.connected` · id 별 응답 매칭(역순 도착) · 30s 타임아웃 → throw · 끊김 → pending 전부 throw · closeCode 4001 → `.badToken` · `system.shutdown` 뒤 끊김 → `.shutdown` · `send` 가 `{sessionId, message, runId}` 를 보냄 · "session not found" → `chat.start` → 같은 runId 로 1회 재전송, 두 번째 실패는 throw · `backoffDelay` 수열 0.8, 1.36, 2.31, … ≤ 15 · `chat.start` 성공 시 백오프 초기화 · 접속마다 토큰 재읽기. 줄 수(D7) 기록.
- **검증 (실 서버, 에이전트):** §8-2 스모크 S1~S5 → G6·G7·G9 판정을 review 용 메모로 남긴다. G3 은 첫 push 후 메인이 Actions 에서 확인(no-go 면 `mac.yml` 삭제 커밋 + review 기록).
- **커밋:** `feat(phase47): add mac app package with gateway client`

### M6 — 상태 리듀서 · 얼굴 파라미터 · 문구

- **목적:** UI 없이 테스트되는 핀의 두뇌.
- **파일:** CREATE `apps/mac/Sources/FinClawMacCore/{CharacterReducer,FaceParams,Copy}.swift` · CREATE `apps/mac/Tests/FinClawMacCoreTests/{ReducerTests,FaceParamsTests}.swift`.
- **구현 노트:** §4-2 표가 곧 명세다(행마다 테스트 1개 이상). `FaceParams` 는 mood·시각만으로 정해지는 값 타입(`eyeOpen`, `eyeScaleY`, `eyeOffset`, `mouth`(enum), `breathScale`, `finAngle`, `jumpY`, `cheekOpacity`, `prop`(enum: none/dots/spinner/bang/question/z), `bodyColor`(enum: normal/gray)). 색 hex 는 Mac 타깃이 아니라 여기 상수로(스냅샷과 테스트가 같은 값).
- **검증:** `swift test` — 전이 표 전 행 · 회귀 6종 · `tick(holdBubble:)` 2건 · `sent` 직후 runError · 큐/병합/토글. FaceParams: 깜빡임 구간(결정적 hash)에서만 `eyeOpen 0.1` · 입 `open` 이 `lastDeltaAt` + 0.45s 뒤 0 · reduceMotion 이면 t 무관 동일 · offline 은 breath 1·prop z · alert 진입 0.6s 안에서만 jumpY ≠ 0 · working 스피너 각도 1.2s 주기. `Copy.toolLabel("mcp__finclaw__route_task") == "알아보는 중…"`, `get_current_datetime` → nil, 미지 → "도구 사용 중…", `Copy.alertTitle` 4종. 줄 수(D7).
- **커밋:** `feat(phase47): add character state reducer and face params`

### M7 — 플로팅 핀 · 말풍선 · 메뉴바 · 스냅샷 (G4·G8)

- **목적:** 보이는 핀. 대화(send·abort·reset·스트리밍)까지 배선.
- **파일:** CREATE `apps/mac/Sources/FinClawMac/{CharacterPanel,AppModel,CharacterView,BubbleView,Snapshot}.swift` · EDIT `apps/mac/Sources/FinClawMac/App.swift`(GUI 진입 + `--snapshot` 분기 + MenuBarExtra 5항목 + Delegate).
- **구현 노트:** 패널 §4-5. 뷰는 `CharacterState` 값 + 액션 클로저만 받는다(D3). `AppModel`: `GatewayClient(url: D1, tokenURL: D1)` 생성·`start()`, 이벤트 → `reduce`, `Timer` 0.5s → `.tick(holdBubble: hovering || expanded)`, send = `let id = UUID().uuidString.lowercased()` → `.sent(runId: id)` → `client.send(msg, runId: id)`(실패 → `.requestFailed`). 캐릭터 제스처는 단일 `DragGesture(minimumDistance: 0)`(`onTapGesture` 금지 — agentpet #55). 스냅샷은 `TimelineView` 를 거치지 않고 `CharacterCanvas(params: FaceParams.at(... now: 고정))` 를 직접 렌더(G8). 이 밀스톤에는 proactive·패널·폼이 없다(M8).
- **검증 (자동):** `swift build` 경고 0 · `swift test` green · `swift run --package-path apps/mac FinClawMac --snapshot <scratch>/snap` → PNG 15장 생성(§8-1), **메인이 Read 로 육안 확인**: 9 mood 가 서로 구분되고 §4-1 소품·색이 맞는지, 말풍선 6줄 페이드·"자세히 ▸"·중지 버튼 위치. 줄 수(D7).
- **검증 (사람, review 로 이월):** G4 와 §8-3 #1~#5, #10~#14.
- **커밋:** `feat(phase47): show the floating Pin character with chat bubbles`

### M8 — proactive · 알림 센터 · 대화 이력 · 알림 폼 · 번들 (G1)

- **목적:** 핀이 먼저 말한다. 알림을 만들고 지운다. `.app` 으로 실행한다.
- **파일:** CREATE `apps/mac/Sources/FinClawMac/{Notifier,ChatPanelView,AlertFormView}.swift` · CREATE `apps/mac/scripts/bundle.sh`(U3) · EDIT `apps/mac/Sources/FinClawMac/{AppModel,BubbleView,Snapshot}.swift`(proactive 액션·삭제 2단계·프리필, 패널 펼침, 스냅샷 패널 2종).
- **구현 노트:** §4-3 B6·B7, §4-4 전부. `AppModel` 은 `alertTriggered`/`scheduleCompleted` 를 리듀서에 넣는 것과 별개로 **항상** `Notifier.post`(P2·P6). 펼칠 때 `chat.history{limit:20}` 1회 + 진행 중 run 텍스트. 알림 탭은 열 때 `finance.alert.list`, 만들기·삭제 뒤 다시 list. 조건 segmented 값 → `{symbol, condition: price_above|price_below|change_percent|news_match, threshold?, keyword?}`(서버 enum 그대로). `bundle.sh`:

  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  cd "$(dirname "$0")/.."
  swift build -c release
  APP=dist/FinClaw.app
  rm -rf "$APP" && mkdir -p "$APP/Contents/MacOS"
  cp .build/release/FinClawMac "$APP/Contents/MacOS/FinClawMac"
  cat > "$APP/Contents/Info.plist" <<PLIST
  …CFBundleIdentifier local.finclaw.mac · CFBundleName FinClaw · CFBundleExecutable FinClawMac
   · CFBundlePackageType APPL · CFBundleShortVersionString 0.1.0 · LSMinimumSystemVersion 14.0 · LSUIElement true…
  PLIST
  codesign --force --sign - "$APP"
  echo "$APP"
  ```

- **검증 (자동):** `swift test` green · `bash apps/mac/scripts/bundle.sh` 성공 · `plutil -lint apps/mac/dist/FinClaw.app/Contents/Info.plist` · `codesign -dv apps/mac/dist/FinClaw.app`(Signature=adhoc, Identifier=local.finclaw.mac) · `--snapshot` 에 proactive 말풍선(×2 배지, 삭제·설명 버튼)·패널 2종 추가 확인 · §8-2 스모크 S6·S7(실 서버에서 `alert.triggered`·`schedule.completed` 수신). 에이전트는 `.app` GUI 를 실행하지 않는다(사용자 부재 중 알림 권한 대화상자를 띄우지 않기 위해 — [L23]).
- **검증 (사람):** G1 과 §8-3 #6~#9, #15.
- **커밋:** `feat(phase47): notify alerts and briefings from the mac app`

### M9 — 문서

- **목적:** 빌드·실행·번들·토큰·알림 권한을 사람이 따라 할 수 있게.
- **파일:** CREATE `apps/mac/README.md` · EDIT `README.md`(① 상단 채널 소개에 맥 앱 ② "운영 인터페이스" 에 맥 캐릭터 앱 절 ③ "선택 — Discord" 표에 `DISCORD_ALERT_USER_ID` ④ "패키지 구조" 에 `apps/mac/` ⑤ Gateway JSON-RPC 메서드 수·목록 갱신(`chat.history`, `finance.alert.delete`)) · EDIT `CONTRIBUTING.md`(scope 예시 목록에 `mac`).
- **내용 (맥 앱 절):** 요구사항(macOS 14+, Swift 6 툴체인 — Xcode 또는 Command Line Tools) · 서버를 먼저 실행(`pnpm start`) · `bash apps/mac/scripts/bundle.sh && open apps/mac/dist/FinClaw.app` · 토큰은 `~/.finclaw/gateway.token` 을 자동으로 읽음(Docker 서버는 호스트에 토큰이 없어 미지원) · 포트를 바꿨으면 `defaults write local.finclaw.mac gatewayURL ws://127.0.0.1:<port>/` · 첫 실행 알림 권한 허용, 재빌드 후 권한을 다시 물을 수 있음(G1 결과 반영) · 기존 알림은 맥으로 오지 않으니 다시 만들기(channels 가 `['log','discord']`) · 브리핑은 `deliveryChannel: web` 만 맥으로 옴 · 페르소나는 기존 대화에 `대화 새로 시작` 뒤 적용 · 개발 모드 `--snapshot`·`--smoke`.
- **검증:** `pnpm format && pnpm lint` green(README 는 oxfmt 대상). 문서의 명령을 에이전트가 한 번씩 실행해 경로·이름이 맞는지 확인.
- **커밋:** `docs(phase47): document the mac character app`

---

## 6. 변경 규모 (추정)

| 영역                        | 파일                                                                                                                                  | 프로덕션 줄              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| M1 alerts websocket         | `types/notification.ts` +8 · `alerts/delivery.ts` +18 · `alerts/index.ts` +9 · `ws/connection.ts` ±1 · `finance.ts` +3 · `main.ts` +3 | +42                      |
| M2 delete · history · runId | `finance.ts` +17 · `chat.ts` +32 · `server.ts` +3 · `types/gateway.ts` +2 · `main.ts` +1                                              | +55                      |
| M3 Discord DM               | `alerts/delivery.ts` +2 · `alerts/index.ts` +2 · `composition/skills.ts` +2 · `main.ts` +5 · `.env.example` +2                        | +13                      |
| M4 페르소나                 | `finclaw.system.ko.md` +19줄 (프롬프트)                                                                                               | 0 (코드)                 |
| **서버 소계**               |                                                                                                                                       | **~+110**                |
| 서버 테스트                 | delivery · connection · finance · chat · identity                                                                                     | ~+130                    |
| Swift 프로덕션              | §3-1                                                                                                                                  | **≤ 1,200** (계획 1,185) |
| Swift 테스트 + 픽스처       | §3-1                                                                                                                                  | ~+380                    |
| 기타                        | `mac.yml` ~20 · `bundle.sh` ~30 · `.gitignore` +2 · `.oxfmtrc.json` ±1 · README·CONTRIBUTING·`apps/mac/README.md` 문서                | —                        |

삭제 없음. 마이그레이션 0(SCHEMA_VERSION 12 유지) — `alerts.channels` 는 JSON 컬럼이라 `'websocket'` 값에 스키마 변경이 필요 없다.

---

## 7. 리스크 · 완화 · 되돌리기

| #   | 리스크                                                                                                                               | 완화 / 폴백                                                                                                                                                                                     | 되돌리기                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| R1  | **창 UX 를 에이전트가 볼 수 없다** — 키 입력(G4), 투명 여백 클릭, 풀스크린 위 표시, 포커스 유지, 알림 권한(G1)을 자동 검증할 수 없다 | `--snapshot` PNG 로 표정·말풍선 레이아웃을, `--smoke` 로 프로토콜 경로를 에이전트가 확인한다. 나머지는 §8-3 의 "사람" 항목으로 review 에 남긴다. G4 no-go → 입력창을 `MenuBarExtra(.window)` 로 | 입력 UI 파일 1개 교체                                                          |
| R2  | **두 번째 언어·툴체인** — Swift 버전 변화, macOS 러너 비용, 1인 감사 부담                                                            | 의존성 0, 프로덕션 ≤ 1,200 줄(D7 측정·절단 순서), Core 를 UI 와 분리해 `swift test`, 경로 필터 워크플로. G3 no-go → 워크플로 삭제(테스트는 로컬 게이트로 유지)                                  | `mac.yml` 삭제 1커밋. `apps/mac/` 는 서버와 결합 0 — 통째로 삭제 가능          |
| R3  | **Clippy 효과 · 반복 알림** — 조건이 계속 참이면 15분 쿨다운마다 재발화. 캐릭터가 거슬리면 앱을 끈다                                 | 같은 key 병합(×N)·identifier 교체, 대화 중 큐잉, "먼저 말 걸기" 토글, 알림별 삭제, LLM 해설 자동 생성 금지(P1~P8)                                                                               | 토글 기본값을 off 로 (상수 1개)                                                |
| R4  | **공유 세션의 부작용** — 맥의 "대화 새로 시작" 이 Web·TUI 대화도 지운다. Web 과 맥에서 동시에 보내면 직렬 대기                       | 1인 사용자 전제(Q3). per-session lane 이 직렬화(phase46 D6). README 에 "reset 은 모든 클라이언트 공통" 명시                                                                                     | 맥 agentId 를 `'mac'` 으로 바꾸면 대화 분리(상수 1개 — 단 Web 턴을 기억 못 함) |
| R5  | **알림 삭제 = 기록 삭제** — `alert_history` CASCADE 로 감사 기록이 사라진다                                                          | 버튼 이름을 "이 알림 삭제" 로 정직하게, 2단계 확인(B6). 영속 비활성화(`setEnabled`)는 RPC 를 하나 더 늘려 보류                                                                                  | phase48+ 에서 `finance.alert.setEnabled` 추가                                  |
| R6  | **`DISCORD_ALERT_USER_ID` 부수 효과** — 설정하는 순간 예전 `['log','discord']` 알림이 Discord 로 가기 시작                           | `.env.example`·README 에 명시. 별도 `fix` 커밋(M3)                                                                                                                                              | M3 `git revert`                                                                |
| R7  | **proactive 가 화면 공유에 노출** — 말풍선에 보유 종목·가격이 뜬다                                                                   | 메뉴바 "캐릭터 숨기기"(`sharingType` 은 macOS 15+ 무효라 쓰지 않음)                                                                                                                             | —                                                                              |
| R8  | **페르소나가 기존 원칙을 흐린다** — 말투 규칙이 출처·불확실성 표기를 줄일 수 있다                                                    | 섹션 첫 문장에 "원칙보다 우선순위가 낮다" 명시. golden 테스트가 원칙 키워드를 계속 고정. 스모크 #2 에서 출처 표기 확인                                                                          | M4 `git revert` (프롬프트 1파일)                                               |
| R9  | **알림 경로의 키 의존** — alerts 는 시세 키 + 뉴스 키가 둘 다 있어야 켜진다(`composition/skills.ts:127`)                             | 폼이 `provider_unavailable` 을 안내. 브리핑·대화는 키 없이도 동작                                                                                                                               | —                                                                              |
| R10 | **헤드리스 스모크가 실제 `~/.finclaw` 와 사용자 대화를 건드린다** — 스모크 질문이 `tui:local:default` 대화에 남는다                  | 스모크 질문은 무해한 한 줄("지금 몇 시인지 한 줄로 알려줘")로 고정, review 에 기록. phase46 스모크와 같은 관례                                                                                  | 끝나고 `chat.reset` 1회(선택)                                                  |

소셜·외부 신호를 새로 붙이지 않는다. 환각 리스크는 proactive 문구에서만 새로 생길 수 있는데, 서버 결정적 문자열만 쓰고 LLM 재작성을 금지해(M2·P7) read-only·감사 가능 불변식과 양립시킨다.

---

## 8. 테스트 전략 · 검증

**단위 — 서버 (mock-only, `pnpm test`):** 기존 vitest 패턴. delivery 는 spy 함수, finance·chat 은 메서드 핸들러 직접 호출 + fake store/storage, connection 은 기존 테스트의 가짜 ws.
**단위 — Swift (mock-only, `swift test`):** Core 만 대상. 코덱 = 실측 픽스처, `GatewayClient` = fake `WebSocketConnection` + 주입 `sleep`, 리듀서·`FaceParams` = 순수 함수(시각은 인자). 실 네트워크·파일은 임시 디렉터리 토큰 파일만.

### 8-1. 스냅샷 (에이전트 확인, M7·M8)

`swift run --package-path apps/mac FinClawMac --snapshot <dir>` → `ImageRenderer`(scale 2) 로 아래 15장. 메인이 Read 로 본다.

| 파일                                                                               | 내용                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `mood-{offline,idle,listening,thinking,working,talking,happy,alert,error}.png` (9) | 캐릭터 96pt, 각 mood 대표 시각(alert 은 진입 0.15s — 점프 중) |
| `bubble-answer-long.png`                                                           | 10줄 답 → 6줄 + 페이드 + "자세히 ▸", happy 캐릭터             |
| `bubble-streaming.png`                                                             | 스트리밍 중 + "중지" 버튼 + working "알아보는 중…"            |
| `bubble-alert.png`                                                                 | 가격 알림 ×2 + 배지 1 + "이 알림 삭제"·"설명 물어보기"        |
| `bubble-offline.png`                                                               | offline + "서버가 꺼져 있어요 (`pnpm start`)"                 |
| `panel-chat.png` · `panel-alerts.png` (M8)                                         | 펼친 패널 대화 탭(샘플 이력 4턴) · 알림 탭(목록 2개 + 폼)     |

### 8-2. 헤드리스 스모크 (에이전트 확인, 실 서버 — M5·M8)

```
FinClawMac --smoke "<질문>" [--listen <초>] [-gatewayURL <url>] [-tokenPath <path>]
```

화면·`NSApplication` 없이 `Entry` 가 `Task { @MainActor in … }` + `dispatchMain()` 으로 Core `GatewayClient` 를 돌린다. 출력은 한 줄씩(토큰·sessionId 미출력):

```
connecting ws://127.0.0.1:3000/
connected
sent run=<uuid>
tool start route_task
tool end route_task error=false
delta x12 chars=340
end chars=352 text="애플은 지금 …(앞 120자)"
event alert.triggered alertId=<id> title="AAPL 가격 알림"      ← --listen 중에만
event schedule.completed scheduleId=<id> error=false
offline shutdown
```

종료 코드: 0 = end(그리고 `--listen` 시간 경과) · 1 = run error(`reason=` 출력) · 2 = 10s 안에 온라인이 못 됨(`offline <reason>` 출력) · 3 = 330s 안에 end/error 없음.

| #   | 시나리오                                                                                                     | 기대                                                                       | 판정               |
| --- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------ |
| S1  | 서버 실행 후 `--smoke "지금 몇 시인지 한 줄로 알려줘"`                                                       | `connected` → `end`, exit 0                                                | **G6** (헤더 인증) |
| S2  | 시세 키가 있으면 `--smoke "애플 주가 알려줘"`                                                                | `tool start route_task` / `tool end`, end 텍스트가 해요체(M4 후, reset 뒤) | 도구 이벤트 디코드 |
| S3  | `--smoke "…" --listen 100` (end 뒤 100s 유휴)                                                                | 끝까지 `offline` 줄 없음                                                   | **G7** (자동 pong) |
| S4  | `-tokenPath <임시 위조 토큰 파일>`                                                                           | `offline badToken`, exit 2                                                 | **G9** (4001)      |
| S5  | 서버 없이 실행 / `-tokenPath <없는 경로>`                                                                    | `offline serverDown` / `offline noToken`, exit 2                           | 사유 분류          |
| S6  | `--listen 60` 중 다른 셸에서 `curl … finance.alert.create`(현재가보다 낮은 `price_above`, 시세·뉴스 키 필요) | `event alert.triggered …`(create 직후 evaluateOnce 로 즉시)                | M1 종단 경로       |
| S7  | `--listen 120` 중 `schedule.create{deliveryChannel:'web'}` + `schedule.runNow`                               | `event schedule.completed …`                                               | 브리핑 경로        |
| S8  | `--listen 30` 중 서버 SIGTERM                                                                                | `offline shutdown`                                                         | shutdown 분류      |

키가 없어 S2·S6 을 못 하면 "키 없음으로 미실행" 을 review 에 기록한다(실패가 아님). 스모크 뒤 `chat.reset` 은 선택(R10).

### 8-3. 수동 스모크 체크리스트 (review.md 에 결과 기록)

| #   | 항목                                                                                                                                                | 확인 주체                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | 서버 전에 앱 실행 → offline 표정, 10s 뒤 "서버가 꺼져 있어요". 서버 실행 → 15s 안에 idle + "다시 연결됐어요"                                        | 프로토콜: **에이전트**(S5→S1) · 화면: **사람**                |
| 2   | 핀 클릭 → 입력 → "애플 주가 알려줘" → thinking → working("알아보는 중…") → talking → happy → 자동 닫힘. 최종 텍스트 = Web 같은 턴. 해요체·출처 표기 | 이벤트 순서: **에이전트**(S2) · 표정·입력: **사람**           |
| 3   | 긴 질문 → ⌘. 또는 "중지" → 2s 안에 idle (error 표정 안 거침)                                                                                        | 리듀서: **에이전트**(단위) · 실동작: **사람**                 |
| 4   | 메뉴바 "대화 새로 시작" → 이전 대화를 기억하지 못함 + "새 대화를 시작했어요"                                                                        | **사람**                                                      |
| 5   | "자세히 ▸" → 패널에 최근 이력(Web 에서 한 턴 포함)                                                                                                  | 레이아웃: **에이전트**(panel-chat.png) · 실데이터: **사람**   |
| 6   | 알림 탭 → AAPL 이상(현재가보다 낮게) 만들기 → 즉시 alert 표정 + 말풍선 + 시스템 배너(소리). "이 알림 삭제" 2번 → 목록에서 사라짐                    | 서버 경로: **에이전트**(S6) · UI·배너: **사람**               |
| 7   | run 중에 알림 → 배지만, 답 말풍선이 닫힌 뒤 알림 말풍선                                                                                             | 리듀서: **에이전트**(회귀 ③) · 실동작: **사람**               |
| 8   | Web 에서 `deliveryChannel: web` 브리핑 `runNow` → 말풍선 + 알림 센터에만(배너 없음)                                                                 | 수신: **에이전트**(S7) · 알림 센터: **사람**                  |
| 9   | 메뉴바 "먼저 말 걸기" 끄기 → 알림이 와도 배지만(시스템 알림은 계속)                                                                                 | **사람**                                                      |
| 10  | 다른 앱에서 타이핑하는 중에 알림이 와도 그 앱의 포커스 유지 (M11)                                                                                   | **사람**                                                      |
| 11  | 드래그 후 재실행 → 위치 복원. 외부 모니터 분리 → 화면 안으로 복귀                                                                                   | **사람**                                                      |
| 12  | 풀스크린 앱 위·다른 Space 에서도 보임. Mission Control 에서 움직이지 않음                                                                           | **사람**                                                      |
| 13  | 캐릭터 바깥 투명 여백 클릭이 뒤 앱으로 가는가 (26.x 회귀 확인 — 거슬리면 click-through 를 phase48+)                                                 | **사람**                                                      |
| 14  | 메뉴바 숨기기/보이기·재연결·종료. 메뉴바 아이콘이 연결 상태를 따라감. VoiceOver 가 "핀, 대기 중" 을 읽음                                            | **사람**                                                      |
| 15  | (선택) `DISCORD_ALERT_USER_ID` 설정 + 서버 재시작 → 같은 알림이 Discord DM 으로도 옴                                                                | **사람** (Discord 계정 필요)                                  |
| 16  | 서버를 31분 넘게 유휴로 둔 뒤 질문 → 정상 응답(재-start + 1회 재전송이 투명)                                                                        | 로직: **에이전트**(GatewayClient 단위) · 실측: **사람**(선택) |
| 17  | `bundle.sh` → `plutil -lint`·`codesign -dv` 통과, `.app` 첫 실행 시 알림 권한 대화상자 → 허용 → 재빌드 후에도 유지되는가(G1)                        | 빌드·서명: **에이전트** · 권한: **사람**                      |

**에이전트만으로 닫히는 것:** 단위 테스트 전부, §8-1 스냅샷, §8-2 S1~S8, 17 의 빌드·서명. **사람만 닫을 수 있는 것:** G1·G4 와 4·9~14, 그리고 표의 "화면/실동작" 부분. review 는 사람 항목을 "사람 확인 필요" 로 남긴다.

---

## 9. phase48+ 로 넘기는 것

- 클릭 통과(coucou 식 `isOverBody` + 30fps 폴링) · 상태 전환 0.18s 보간 · 드래그 clamp·가장자리 스냅(U7).
- MarkdownUI(블록 마크다운) · 음성 · 스킨·다중 캐릭터(스프라이트 폴백 포함).
- 자동 실행(`SMAppService`) · 서버 자동 기동 · Docker 서버용 토큰 입력 UI.
- 놓친 알림 재전달(`finance.alert.history{since}`) · 시스템 알림 클릭 처리(`UNUserNotificationCenterDelegate`) · 알림 비활성화 RPC(`setEnabled`, R5).
- 말로 알림 만들기(LLM 제안 + 확인 버튼) · `route_task` intent 를 tool 이벤트에 싣기.
- phase46 이월 잔여: 재연결 rebind · `end.result` 의 `captured`/`usedMemoryIds` · 상주 CLI 프로세스 · `search_memory` · messageId 세그먼트.
- 공증(notarization)·Developer ID 서명(배포가 필요해질 때).

---

## 10. 사용자 사후 검토 대상 결정 (자율 모드 — 뒤집을 수 있음)

| #   | 결정                                                                                             | 뒤집으면                                                                              |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| S1  | **캐릭터 이름 "핀"** (Fin = 지느러미)                                                            | 프롬프트 1줄 + `Copy` 라벨 문자열. 번들 이름(`FinClaw.app`)은 그대로                  |
| S2  | **디자인: 민트 모찌 + 등지느러미, 코드 벡터, 8상태 + happy, 경고색은 앰버 하나**                 | `FaceParams`·`CharacterCanvas` 수정. 손그림 품질이 필요하면 스프라이트 스킨(phase48+) |
| S3  | **말투: 해요체, 이모지·감탄사·느낌표 없음, 첫 문장에 결론 — 전 채널 공통(Discord·Web·TUI 포함)** | 프롬프트 섹션 수정·삭제(M4 revert)                                                    |
| S4  | 네이티브 Swift(SwiftPM, 의존성 0), macOS 14+, ad-hoc 서명·비샌드박스                             | —                                                                                     |
| S5  | 맥이 Web·TUI 와 같은 대화(`tui:local:default`)를 공유 — reset 도 공통                            | agentId 를 `'mac'` 으로(R4)                                                           |
| S6  | 새 알림 기본 채널 `['log','websocket']`(Discord 는 env 가 있을 때만)                             | `alertChannels` 기본값                                                                |
| S7  | `DISCORD_ALERT_USER_ID` 신설 — 설정 시 예전 알림도 Discord 로 감                                 | env 미설정 = 현행                                                                     |
| S8  | 가격·뉴스 알림은 **항상** 시스템 배너+소리, 브리핑은 알림 센터에만                               | `Notifier` interruptionLevel 2줄                                                      |
| S9  | "먼저 말 걸기" 기본 **켜짐**, 조용한 시간 설정 없음                                              | `@AppStorage` 기본값                                                                  |
| S10 | 말풍선의 알림 버튼은 "이 알림 삭제"(기록까지 삭제, 2단계 확인) — 비활성화가 아니다               | `setEnabled` RPC 추가(phase48+)                                                       |
| S11 | run 중 입력 잠금(큐잉 없음), 말풍선 자동 닫힘 수치(U5)                                           | 상수                                                                                  |
| S12 | 말로 알림 만들기 없음 — 폼으로만                                                                 | phase48+ "LLM 제안 + 확인"                                                            |
| S13 | `chat.send` 가 클라이언트 runId 를 받음, `chat.history` 상한 40                                  | 필드 무시 / 상수                                                                      |
| S14 | 자동 실행·서버 자동 기동 없음 — 서버를 먼저 켜야 함                                              | phase48+                                                                              |
| S15 | macOS CI(`mac.yml`, 경로 필터)를 별도 워크플로로 추가 — 러너 분 단가 발생                        | 워크플로 삭제                                                                         |

---

## 11. 컨벤션

- **테스트 baseline ([R46] §2):** unit **1007 pass** (133 files) · storage **141 pass** (22 files). phase47 종료 시 회귀 0 + 신규(delivery·connection·finance·chat·identity). Swift 는 신규 기준선 — 테스트 수를 review 에 기록.
- **mock-only:** vitest·`swift test` 모두 실 네트워크·실 gateway 금지. 실 서버 확인은 §8-2 `--smoke`(수동, 결과는 review). 픽스처는 실측 프레임 그대로(개인정보만 확인).
- **외과적 변경 (CLAUDE.md §3):** 각 밀스톤이 나열한 파일만. Web·TUI 는 건드리지 않는다. 변경으로 고아가 된 import 만 제거. 무관한 dead code 는 review 에 언급만.
- **커밋 (CONTRIBUTING):** 밀스톤당 1커밋, `type(phase47): <ASCII subject>`, 본문은 "왜", `Co-Authored-By` 트레일러, `--no-verify` 금지. M3 은 `fix` 단독 커밋. PR 은 merge commit.
- **게이트:** 서버 `pnpm format && pnpm lint && pnpm typecheck && pnpm build && pnpm test`(storage 미변경이라 `test:storage` 는 PR 전 1회). Swift `swift build && swift test` + `pnpm format && pnpm lint` + D7 줄 수. PR 전 `pnpm test:ci`.
- **상수 원칙:** §2-2 U5·§4-1 수치는 코드 상수(Swift `Copy`/리듀서, TS 핸들러). config 키·설정 화면을 새로 만들지 않는다(UserDefaults 키 2개는 접속 대상 지정용 — D1). 단순화로 상한이 있는 곳은 `// ponytail:` 주석.
- **go/no-go 기록:** `plans/phase47/review.md` §검증에 G1·G3·G4·G6·G7·G8·G9 표(결과·폴백 적용 여부) + §8-2 S1~S8 출력 요약 + §8-3 항목별 "에이전트 확인 / 사람 확인 필요".
