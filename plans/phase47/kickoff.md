# Phase 47 킥오프 — macOS 캐릭터 챗봇 "핀" + 먼저 알려주는(proactive) 알림

> 작성 2026-11-26 · base = main `566cde9` (PR #86 phase46 에이전트 코어 머지) · 브랜치 `feature/phase47-mac-character`
> 상태: **확정 — /goal 자율 모드에서 메인이 게이트 1·2 를 대행 승인 (2026-11-26). 사용자 사후 검토 대상.** 열린 질문의 해소는 `plan.md` §2.
> 선행 입력: `plans/phase46/review.md` §7(맥 클라이언트가 의존할 실측 인터페이스), `_workspace/feature-research/mac-character/`(통합 계약 00 · scout L1/L2L3/L4 · 비교·추천 20).

## 사용자 목표

> "1. 디코 가능은 가능하게 한데 이번에는 다르게 맥에서 챗봇? 알려주는 캐릭터 형식으로"

해석: Discord 는 **선택 채널로 유지**한다(phase46 M11 에서 토큰 없이 부팅 가능해짐). 주 인터페이스는 **macOS 데스크톱에 떠 있는 캐릭터형 챗봇**이다. 사용자는 캐릭터와 대화하고, 캐릭터는 가격 알림·예약 브리핑이 생기면 **먼저** 알려준다.

## 배경 — phase46 이후 상태 (코드 실측)

- 대화 표면은 이미 있다: `chat.start/send/abort/reset` + `chat.stream.{delta,tool,end,error}`(모두 runId, run 마다 종료 이벤트 정확히 1개), `~/.finclaw/gateway.token`(0600, 부팅마다 재기록), `127.0.0.1` 바인딩, Discord 없는 부팅. 맥 앱은 Web·TUI 다음의 **세 번째 gateway WebSocket 클라이언트**다.
- **가격 알림은 아무에게도 도달하지 않는다.** `finance.alert.create` 가 channels 를 `['log','discord']`, userId 를 `'default'` 로 하드코딩한다(`gateway/src/rpc/methods/finance.ts:281,284`). Discord 핸들러는 `users.fetch(alert.userId)` 라 `'default'` 로는 항상 실패한다(`skills-finance/src/alerts/delivery.ts:49`). websocket 핸들러는 phase45 에서 소비자가 없어 삭제됐다(`986f0e3`). 실제로 남는 건 log 뿐이다.
- 예약 브리핑은 `deliveryChannel:'web'` 이면 이미 `notification.schedule.completed` 로 모든 연결에 broadcast 된다(`server/src/automation/delivery.ts:87-102`). 맥은 서버 변경 없이 받을 수 있다.
- ChatRegistry 세션은 **마지막 활동 기준 유휴 30분**에만 만료되고 진행 중 run 이 있으면 만료되지 않는다(`gateway/src/registry.ts:106-112`, 리뷰 수정 `9ac4da5`). 상주 앱은 유휴 만료 뒤 `chat.start` 를 다시 호출하기만 하면 된다.
- 시스템 프롬프트(`packages/server/prompts/finclaw.system.ko.md`)는 정적이고 모든 채널이 같은 sessionKey(`tui:local:default`)를 공유한다. 페르소나는 맥 전용이 아니라 **전 채널 공통**이어야 한다(채널별 프롬프트를 두면 같은 CLI 세션에서 프롬프트가 바뀐다 — phase46 I9).

## 범위 요약

- **IN:** 서버 — alerts websocket 전달 + `alert.triggered` 기본 구독, `finance.alert.delete`, `chat.history`, `chat.send` 클라이언트 지정 runId, Discord 알림 DM 대상 수정(`DISCORD_ALERT_USER_ID`), 페르소나 "핀" 프롬프트 섹션. 맥 — `apps/mac/` SwiftPM 패키지(의존성 0, Core 라이브러리 + 실행 파일): gateway 클라이언트, 캐릭터 상태 리듀서, 플로팅 패널·캐릭터·말풍선·메뉴바, proactive 말풍선 + macOS 알림, 대화 이력·알림 폼, `--snapshot`·`--smoke` 개발 모드, `.app` 번들 스크립트, `mac.yml` CI, 문서.
- **OUT (phase48+):** 클릭 통과(click-through), MarkdownUI, 음성, 스킨·다중 캐릭터, 자동 실행, 놓친 알림 재전달, 말로 알림 만들기(LLM 제안 + 확인), 상주 CLI 프로세스, 재연결 rebind, `end.result` 의 `captured`/`usedMemoryIds`, 서버 자동 기동, 시스템 알림 클릭 처리, Docker 서버용 토큰 입력 UI.
- **불변:** 맥 앱은 LLM 을 직접 부르지 않는다(구독 CLI 전용) · 새 MCP 도구 0, 알림 생성·삭제는 사람이 UI 로 · proactive 문구는 서버가 만든 결정적 문자열 그대로 · 화면 = 저장본(`end.result.text`) · Swift 외부 의존성 0, 프로덕션 ≤ 1,200 줄 · 새 npm 의존성 0 · mock-only 테스트 · Discord 는 선택.

## 선행 조사

| 문서                                                                            | 내용                                                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `_workspace/feature-research/mac-character/00-integration-contract.md`          | 불변식 M1~M11, 서버 표면 실측(프레임·인증·세션 수명·하트비트), proactive 경로, 열린 질문    |
| `_workspace/feature-research/mac-character/10-scout-L1-floating-companion.md`   | 플로팅 패널 OSS(Hopet·agentpet·coucou 등) 패턴, nonactivating NSPanel 스니펫 실측 빌드      |
| `_workspace/feature-research/mac-character/10-scout-L2L3-local-spike.md`        | SwiftPM 전용 빌드·`.app` 번들·ad-hoc 서명·평문 WS·`ImageRenderer` 스냅샷 로컬 실측          |
| `_workspace/feature-research/mac-character/10-scout-L4-character-ux.md`         | 캐릭터 "핀" 디자인 수치, 상태 머신, 말풍선 UX, proactive 원칙, 페르소나 초안, 접근성        |
| `_workspace/feature-research/mac-character/20-comparison-and-recommendation.md` | **설계 기준선** — 비교 매트릭스, 추천 아키텍처, Q1~Q14, M0~M9, 리스크, go/no-go, 미결 U1~U9 |
| `plans/phase46/review.md` §7                                                    | phase46 실측 인터페이스와 이월 항목                                                         |

## plan.md 가 반드시 결정할 것

1. **클라이언트 기술** — 네이티브 Swift / Tauri / Electron / WKWebView 셸.
2. **캐릭터 렌더** — 코드 벡터(Canvas) / 스프라이트 / Lottie·Rive. 캐릭터 이름·디자인·말투.
3. **창 방식** — nonactivating NSPanel / SwiftUI Window / MenuBarExtra 팝오버. 포커스·입력·위치 기억.
4. **서버 변경 범위** — alerts websocket·late-bind, alert 삭제, 대화 이력, Discord DM 결함(Q6) 포함 여부.
5. **페르소나 범위** — 맥 전용 / 전 채널 공통, 시스템 프롬프트 어디에.
6. **세션** — 맥이 Web/TUI 와 sessionKey 를 공유하는가, 이벤트 필터 기준(sessionId / runId), 유휴 만료·재연결 처리.
7. **proactive 규칙** — 말풍선 vs 시스템 알림, 대화 중 큐잉, 중복 병합, 끄는 방법, 문구의 결정성.
8. **알림 만들기 경로** — LLM 도구 / 앱 폼 → RPC.
9. **검증** — `swift test` 범위, 시각 검증(에이전트가 화면을 볼 수 없음), 실 서버 대상 헤드리스 스모크, CI 러너.
10. **phase46 이월분** — 클라이언트 지정 runId, `end.result` 확장, 재연결 rebind 중 맥에 실제로 필요한 것.
11. synthesizer §7 미결 9개(U1~U9): `chat.history` IN 여부, 브리핑 "자세히" 내용, `bundle.sh` 커밋 위치, 가격 알림 배너 조건, 자동 닫힘 수치, 테스트 프레임워크, 보간·click-through 추가 여부, Discord env 이름, 앱 번들 이름·식별자.

## 산출물

이 kickoff + `plan.md` → (자율 모드: 메인 대행 승인) → `todo.md` 분해(`finclaw-phase-execute`) → 밀스톤 M1~M9 구현(밀스톤당 1커밋, M0 은 커밋 없는 사전 캡처) → `review.md`.
