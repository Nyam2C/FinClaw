# Phase 47 Review: macOS 캐릭터 챗봇 "핀" + 먼저 알려주는 알림

> todo.md 기반 구현 코드 리뷰. 구현 완료 상태, 검증 결과, 리팩토링 사항을 기록한다.
> 상태: **확정 — /goal 자율 모드에서 메인이 게이트 3 을 대행 승인 (2026-11-26). 사용자 사후 검토 대상.**
> 검토: phase-qa-engineer + phase-refactor-expert 병렬(각자 독립 보고) → 메인 통합. P0 1건 · P1 6건은 같은 브랜치에서 수정 커밋으로 반영.

base SHA: `566cde9` ↔ HEAD: 본 커밋 (54 파일, +6,629 / −41 · 서버 TS 프로덕션 약 +110 · Swift 프로덕션 1,725 비공백 줄 · Swift 테스트 89)

---

## 0. 한 문단 결론

macOS 데스크톱에 떠 있는 캐릭터 "핀"이 생겼다. 네이티브 Swift(SwiftUI + AppKit) 앱이 gateway WebSocket 의 세 번째 클라이언트로 붙어 대화(실제 스트리밍 · 도구 진행 표시 · 중지 · 새 대화 · 이력)하고, 가격 알림과 예약 브리핑을 **먼저** 말풍선과 macOS 알림으로 알려준다. Discord 는 선택 채널로 남는다. **자동 검증은 전부 통과했지만, 실제 창의 동작(타이핑 · 포커스 · 드래그 · 투명도 · 알림 권한)은 에이전트 환경에서 확인할 수 없었다 — §6 의 체크리스트는 사람이 직접 봐야 한다.** merge 가능.

## 1. 구현 사항 (TODO 일치도)

대조 40행: ✅ 28 · ⚠️ 11 · ❌ 1. ⚠️ 는 구현 로그·TQ 답에 기록된 의도된 차이, ❌ 1건은 아래 P0(리뷰에서 수정). 페르소나 문안은 plan §4-7 과 글자 단위로 일치.

| 밀스톤   | 내용                                                                                                                    | 커밋      |
| -------- | ----------------------------------------------------------------------------------------------------------------------- | --------- |
| M0       | 실 서버 WS 프레임 캡처 → Swift 테스트 픽스처 (메인 수행, 커밋 없음)                                                     | —         |
| M1       | 가격 알림을 websocket 클라이언트로 (`notification.alert.triggered`, 기본 구독, 새 알림 기본 채널 `['log','websocket']`) | `619b71a` |
| M2       | `finance.alert.delete` · `chat.history` · `chat.send` 의 클라이언트 지정 `runId`                                        | `19c7cd9` |
| M3       | `DISCORD_ALERT_USER_ID` — RPC 로 만든 알림의 Discord DM 이 항상 실패하던 결함                                           | `4c166ad` |
| M4       | 페르소나 "핀"(해요체, 전 채널 공통, 정확성·환각 방지가 말투보다 우선)                                                   | `503425e` |
| M5       | `apps/mac/` SwiftPM 패키지 · 프레임 코덱 · `GatewayClient` · 헤드리스 `--smoke` · `mac.yml`                             | `5d49779` |
| M6       | 캐릭터 상태 리듀서 · face 파라미터 · 사용자 문구                                                                        | `09f968c` |
| M7       | 플로팅 패널 · 캐릭터(Canvas) · 말풍선 · 메뉴바 5항목 · `--snapshot`                                                     | `aa77598` |
| M8       | proactive 말풍선 + macOS 알림 · 대화 패널 · 알림 폼 · `bundle.sh`                                                       | `27aefe0` |
| (다듬기) | 짧은 말풍선 최소 폭, 스냅샷 샘플을 실제 능력에 맞게(가짜 수치·"말로 알림 생성" 제거)                                    | `d834163` |
| M9       | README · `apps/mac/README.md`(스크린샷 4장) · CONTRIBUTING scope                                                        | `d16edca` |

## 2. 자동화 검증 결과

| 명령                                        | 결과                  | 비고                                                      |
| ------------------------------------------- | --------------------- | --------------------------------------------------------- |
| `pnpm build` (dist 삭제 후) · typecheck     | ✅ PASS               |                                                           |
| `pnpm lint` · `pnpm format`                 | ✅ 0 warnings / PASS  | `apps/mac` 은 `.gitignore` 만으로 lint·format 대상 밖     |
| `pnpm test`                                 | ✅ 1031 pass / 0 fail | 133 files (기준선 1007 → +24)                             |
| `pnpm test:storage` · `test:ci` · web build | ✅ 141 pass / PASS    |                                                           |
| `swift build -c release`                    | ✅ 경고 0             | Swift 6.4 로컬                                            |
| `swift test`                                | ✅ 89 pass            | 3회 반복 flaky 0. fake transport + 가상 시간(mock-only)   |
| CI `mac` (macos-latest, Swift 6.3.3)        | ✅ success (34초)     | 러너 Swift 버전 호환 확인                                 |
| `bundle.sh` → `FinClaw.app`                 | ✅                    | ad-hoc 서명, bundle id `local.finclaw.mac`, plist lint OK |
| `--snapshot`                                | ✅ 15장               | 메인이 직접 열어 확인(§3)                                 |

**실 서버 스모크 (헤드리스 `--smoke`, Discord 없음, API 키 없음)**

| 시나리오                             | 결과                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| 헤더 인증 + chat 왕복                | ✅ `tool start/end get_current_datetime` → delta → end, 해요체 답변              |
| keepalive 100초                      | ✅ 끊김 없음                                                                     |
| 위조 토큰 / 토큰 없음 / 서버 꺼짐    | ✅ `offline badToken`(4001) · `offline noToken` · `offline serverDown`           |
| 서버 SIGTERM                         | ✅ `offline shutdown` 후 재시도마다 `serverDown`                                 |
| 예약 `runNow` 수신                   | ✅ `schedule.completed` 수신                                                     |
| 가격 알림 수신 · 알림 생성/삭제 성공 | ⛔ **미실행 — 이 기기에 시세 API 키가 없다.** 단위 테스트·합성 프레임으로만 검증 |

서버 쪽 M2 스모크: 클라이언트 지정 runId 가 응답·스트림에 그대로, 진행 중 중복 → `-32603 duplicate runId`, `chat.history` 는 컨텍스트 블록 없는 사용자 원문 반환.

## 3. 시각 검증 (스냅샷)

에이전트 터미널은 화면 기록 권한이 없어 `screencapture` 를 쓸 수 없다. 대신 `--snapshot` 이 SwiftUI 뷰를 화면 없이 PNG 로 렌더한다(밝은/어두운 배경 병치). 메인이 13장을 직접 열어 확인했다.

- 9개 표정이 서로 구분된다: idle(큰 눈·볼터치) · listening · thinking(눈썹 + 점 3개) · working(반쯤 감은 눈 + 스피너) · talking · happy(웃는 눈) · alert(놀란 눈 + amber `!`) · error(걱정 눈썹 + amber `?`) · offline(회색, 감은 눈 + `z`).
- 상태색에 빨강·파랑·초록을 쓰지 않는다(한국에선 빨강이 상승). 경고는 amber 만.
- 긴 답은 6줄에서 흐려지며 "자세히 ▸", 가격 알림 말풍선은 서버 고정 문구 + "이 알림 삭제 / 설명 물어보기".
- 구현 중 스냅샷으로 잡아 고친 것: 볼터치가 회색으로 보임 · thinking 점이 지느러미와 겹침 · 어두운 배경에서 소품이 안 보임 · 좁은 말풍선 · 브리핑의 "자세히" 중복.
- **렌더러 한계(실제 창에서 확인 필요):** 네이티브 텍스트 필드는 노란 placeholder 로 찍힌다. 밝은 배경에서 material 위 primary/secondary 텍스트 농도가 뒤바뀌어 보인다(단색 배경으로 바꾸면 정상 — 렌더러 문제로 판단).

대표 4장은 `apps/mac/docs/` 에 커밋돼 `apps/mac/README.md` 에 실려 있다.

## 4. 경계면 검증 (Swift 클라이언트 ↔ TS 서버)

- 이벤트·응답 shape, `isError`/`costUsd` 옵셔널, `reason` 값, notification method 문자열, 도구 이름(`mcp__finclaw__*`) 일치.
- 알림 폼이 보내는 `condition` 4종·필드명이 서버 zod 스키마와 일치(테스트로 고정).
- 에러 문자열 의존(`session not found`, `provider_unavailable`), Bearer 인증 + close code 4001, 토큰 경로 일치.
- 테스트 픽스처는 실측 프레임 원문. 합성은 `alert.triggered` 1건과 `finance.alert.*` 응답 4건(서버 반환 shape 기준, `synthetic:` 표시).
- Web/TUI 는 새 기본 구독 `alert.triggered` 를 무시하고 깨지지 않는다.

## 5. 리팩토링 사항

### P0 — 반영 완료

- **`finance.alert.list` 디코딩이 항상 실패** — 앱이 응답을 `[String: [AlertRow]]` 로 읽었는데 서버 응답에 숫자 `total` 이 있어 0건이어도 실패했다. 시세 키가 있는 환경에서는 알림 탭이 항상 "요청을 보내지 못했어요" 였을 것이다(이 기기엔 키가 없어 스모크에서 안 드러남). 두 리뷰가 독립적으로 발견. 원인은 wire 타입이 App 타깃에 있어 `swift test` 가 못 본 것 → 타입을 Core 로 옮기고 실측·합성 픽스처 디코딩 테스트 추가. `359c702`

### P1 — 반영 완료

| 항목                                                                                                                         | 커밋      |
| ---------------------------------------------------------------------------------------------------------------------------- | --------- |
| `chat.history` 도 같은 디코딩 + 실패를 삼킴 → 명시 struct, 실패는 패널에 표시. RPC 모델·폼 검증을 Core 로 이동 + 테스트      | `359c702` |
| reset 실패가 진행 중 run 을 지워 늦게 온 답을 버림 → notice 만                                                               | `97c97cf` |
| offline 에서도 전송돼 입력이 사라지고 얼굴이 idle 로 감 → 보내지 않고 입력 유지 + 안내, 20,000자 초과도 동일                 | `97c97cf` |
| 중지가 무효(`aborted:false`)면 thinking 에 갇힘 → 로컬 run 정리                                                              | `97c97cf` |
| 펼친 패널에서 보낸 질문·답이 run 종료 후 사라짐 → 즉시 반영 + 종료 시 재로드                                                 | `97c97cf` |
| 입력 중 말풍선이 닫히면 큐 알림이 끼어듦 → 입력 포커스 중엔 대기. 세션 만료 뒤 이력 패널이 비는 것 → 재시작 후 1회 재시도    | `97c97cf` |
| 줄 수를 맞추려 한 줄에 여러 문장을 이어 붙인 것(120자 초과 35줄, `;` 연결 67줄) → 전부 풀기. 동작 변경 0(스냅샷 바이트 동일) | `3f51695` |

### P2 — 후속 (미반영)

1. 첫 시스템 알림이 권한 승인 전이라 알림 센터에 안 남을 수 있다(말풍선은 표시) — 사람 확인 항목.
2. `connected` 가 말풍선을 무조건 지워, 끊기기 전 표시 중이던 proactive 가 사라진다. 재연결 직후 큐는 배지만.
3. pinger 가 hung 서버를 감지하지 못한다(문서 기준, 미시험) — 유지.
4. idle 에서도 30fps 로 그린다(전력). 눈 깜빡임 주기만 깨우도록.
5. 말풍선의 마크다운 링크가 클릭 가능 — 서버(LLM) 텍스트의 URL 이 열린다.
6. `gatewayURL` override 가 비-루프백 호스트를 허용 — 그 호스트로 토큰이 간다.
7. 완료된 runId 를 재사용하면 `agent_runs` 행이 조용히 유실된다(PK 충돌).
8. websocket 알림의 "수신 0 = 실패" 판정이 Web/TUI 연결도 수신자로 세어 약해졌다.
9. "session not found" 재전송 중에 중지를 누르면 핀은 idle 이지만 서버 run 은 계속된다(답은 이력에 저장).
10. 빠진 테스트: `connecting` 전이, 서버 `setBroadcast`·`alertChannels` 배선.
11. `⌘.` 중지 단축키는 전송 후 패널이 포커스를 내려놓아, 답변 중 핀을 다시 클릭해야 동작한다(문서에 반영).

## 6. 사람이 직접 확인해야 하는 것

에이전트 환경에서 **검증하지 못했다.** `apps/mac/README.md` 에 같은 목록이 있다.

- [ ] 알림 권한 대화상자(첫 알림/브리핑 수신 시점에 뜬다)와 실제 배너 — 가격 알림은 소리 있음, 브리핑은 알림 센터만
- [ ] 패널의 텍스트 입력: 타이핑, Enter 전송, Esc, 전송 후 이전 앱으로 포커스 복귀
- [ ] 핀 드래그 이동 vs 클릭(5pt 임계), 위치 기억, 화면 밖 복구
- [ ] 투명 배경, 항상 위, Spaces 이동, 풀스크린 앱 위 표시
- [ ] 메뉴바 아이콘과 5항목(보이기/숨기기 · 대화 새로 시작 · 먼저 말 걸기 · 재연결 · 종료)
- [ ] 말풍선 hover 유지, 패널 펼침/접기·스크롤
- [ ] **알림 생성/삭제 성공 경로와 실제 가격 알림 수신 (시세 API 키 필요)**
- [ ] VoiceOver, Reduce Motion, material 위 텍스트 색
- [ ] 화면 공유 시 말풍선에 보유 종목·알림이 보인다 → 메뉴의 "숨기기" 로 가린다

실행: `pnpm dev` 로 서버를 띄운 뒤 `cd apps/mac && swift run`(또는 `bash scripts/bundle.sh && open dist/FinClaw.app`).

## 7. 사용자 사후 검토 대상 (자율 모드에서 메인이 정한 것)

plan §10 의 S1~S15 가 유효하다. 특히:

- **캐릭터:** 이름 "핀", 민트 모찌 + 등지느러미 디자인, 해요체. 페르소나는 맥 한정이 아니라 **Discord·Web·TUI 에도 적용**된다(같은 CLI 세션을 공유하므로). 기존 세션에는 6시간 유휴 회전 또는 "대화 새로 시작" 뒤에 반영.
- **공유 대화:** 맥·Web·TUI 가 `tui:local:default` 를 공유한다. 한쪽의 "새로 시작"이 모두를 지운다.
- **알림 기본 채널이 `['log','websocket']` 로 바뀜.** `DISCORD_ALERT_USER_ID` 를 설정하면 새 알림에 Discord 가 추가된다.
- **핀은 말로 알림을 만들 수 없다**(도구 read-only). 알림은 앱의 알림 탭 폼에서 사람이 만든다. 알림 삭제는 발동 이력도 함께 지운다(2번 클릭).
- **가격 알림은 항상 배너 + 소리**, "먼저 말 걸기" 기본 켬.
- **Swift 코드 1,725줄** — plan 예산 1,200(이후 1,300)을 넘겼다. 리뷰가 "줄 수를 맞추려 한 줄에 문장을 이어 붙였다"고 지적해, 메인이 가독성을 상한보다 우선하도록 결정했다. 이 중 개발 도구(`Smoke` 67 + `Snapshot` 107)가 174줄.
- **macOS CI 잡 추가**(`apps/mac/**` 변경 시에만 실행).
- 스모크가 사용자의 실제 `~/.finclaw/gateway.{secret,token}` 을 사용/재기록했다(제품의 정상 동작). 구현 중 앱 창이 화면에 몇 초씩 떴다 닫혔다.

## 8. 범위 밖 / 다음 후보

- 투명 영역 클릭 통과, 본격 마크다운(표·코드블록), 음성, 로그인 시 자동 실행, 놓친 알림 재전달, 알림 클릭 처리, "말로 알림 만들기"(LLM 제안 + 확인 버튼), 재연결 rebind, 공증(notarization).
- phase46 에서 넘어온 것: lane 대기 abort, 종료 시간 예산 충돌, 자식 env allowlist, 상주 CLI 프로세스(resume 첫 delta p50 3.2초).
- `claude` CLI 가 대화에 붙이는 `# userEmail` 블록은 여전히 프롬프트 규칙으로만 완화된다.
