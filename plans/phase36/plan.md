# Phase 36 — server 패키지 분할 / 비대한 composition root 해소 (설계 초안)

> ⚠️ **본 plan 은 설계 결정 대기 초안이다.** server 분할은 "어떻게 쪼개느냐"(경계 설계)가 핵심이고, 그 결정 전엔 코드 단위 todo 로 분해할 수 없다. 아래 옵션 A/B/C 중 하나를 **plan 승인자(사용자)가 확정**해야 밀스톤이 구체화된다.

## 동기

- `@finclaw/server` 가 단일 최대 패키지: 비테스트 **14,033 LOC**, 11 패키지 중 압도적. wiring·gateway·pipeline·automation·cli·plugins·observability 가 한 패키지에 응집.
- `main()` 이 **898 줄** (핸드오프 시점 706 → phase 누적으로 증가). 매 phase 가 wiring 을 뒤에 append — Phase 24/26/28/29/30/31/32/33/34 의 초기화 코드가 한 함수에 직선 나열.
- "전체 코드를 한 사람이 읽고 수정할 수 있는 크기" 라는 프로젝트 표방과 가장 큰 긴장 지점.
- **단, 급하지 않음**: 핸드오프·`project_known_limitations.md` 둘 다 "스코프 내 수용, 압력 생기면" 으로 분류. 본 phase 는 **구체적 드라이버(예: main() 유지보수 한계, 새 기능이 경계를 요구)가 생겼을 때** 착수.

## 현황 (코드 실측, 2026-05-25)

server/src 비테스트 파일 분포:

| 디렉터리         | 파일 수 | 역할                                                                 |
| ---------------- | ------- | -------------------------------------------------------------------- |
| `gateway/`       | 35      | JSON-RPC + WebSocket 표면, rpc/methods, ws, router                   |
| `auto-reply/`    | 23      | 8단계 파이프라인 + stages + execution-adapter                        |
| `cli/`           | 20      | commander 기반 CLI (start/health/status/agent/market/news/alert/tui) |
| `plugins/`       | 11      | plugin loader + MCP 연결                                             |
| `services/`      | 10      | 횡단 서비스                                                          |
| `process/`       | 10      | message-router (Discord inbound → dedupe → queue → lane → pipeline)  |
| `channels/`      | 6       | Discord 채널 어댑터 연결                                             |
| `automation/`    | 4       | cron scheduler                                                       |
| `observability/` | 2       | OTel tracer + SQL span exporter                                      |
| `prompts/`       | 1       | system prompt                                                        |
| `main.ts`        | 1       | composition root (898줄)                                             |

`main()` 의 wiring 순서 (각 Phase 가 추가한 블록):
env → memory services → router helper → embedding provider → dual-path provider → LLM router → ScheduleRpc → KIS tool → MCP/plugin loader → OTel tracer → memory capture/retrieval/attach → reranker → token counter/summarizer → scheduler lane + SchedulerService → news-brief memory → access-log purge → hot reload → gateway + delivery hooks.

## 설계 옵션 (택1 — 승인자 결정 필요)

### 옵션 A — 내부 모듈화 (패키지 분리 X, 최소 리스크)

- `@finclaw/server` 는 한 패키지 유지. `main()` 898줄을 **composition 모듈**(`src/composition/{memory,providers,tools,automation,gateway}.ts`)의 빌더 함수로 분해. `main()` 은 빌더 호출 + 조립만.
- 큰 서브디렉터리(gateway 35, auto-reply 23)는 내부 재정리만.
- **장점**: 의존 그래프·tsconfig references 불변. blast radius 최소. main() 가독성 즉시 개선.
- **단점**: "패키지 경계" 자체는 안 생김 — 여전히 한 패키지가 14K LOC.

### 옵션 B — 패키지 추출 (경계 신설, 큰 blast radius)

- `gateway/` → `@finclaw/gateway`, `auto-reply/`(+process/channels) → `@finclaw/pipeline`, `automation/` → `@finclaw/automation` 등 신규 워크스페이스 패키지로 추출. server 는 composition root + cli 만.
- **장점**: 진짜 패키지 경계 + 개별 감사 단위. 11 → 14 패키지.
- **단점**: import 경로 전면 재작성, tsconfig project references 재구성, 순환 의존 위험, build 파이프라인 영향. phase 한 번으로 닫기엔 큰 작업.

### 옵션 C — 하이브리드 (가장 깨끗한 한 seam 만 추출 + main 모듈화)

- 가장 응집·독립적인 **`gateway/` 만 `@finclaw/gateway` 로 추출** + `main()` composition 모듈화(옵션 A).
- **장점**: 가장 큰 단일 덩어리(35파일)를 경계로 빼내 server 감량 + main() 개선. 리스크는 1개 패키지 추출로 한정.
- **단점**: 나머지는 여전히 server 내부.

**추천: 옵션 C** — "1인 감사" 가치(경계 신설)와 리스크(1개 패키지 한정)의 균형. 단 gateway 가 server 내부 상태(broadcaster/connections/serverCtx)에 얼마나 결합돼 있는지부터 측정해야 추출 비용 확정. (phase35 항목 3 RPC 레지스트리 격리가 선행되면 gateway 추출이 쉬워짐 — 의존 관계 있음.)

## 미결 결정 (승인자가 답해야 todo 분해 가능)

1. **옵션 A / B / C 중 무엇?** (추천 C)
2. 옵션 B·C 라면 **새 패키지명·경계** 확정 (`@finclaw/gateway`? pipeline 도?)
3. phase35 항목 3(RPC 레지스트리 인스턴스 격리) 완료를 **선행 전제**로 둘지 (gateway 추출과 결합).

## 잠정 밀스톤 (옵션 C 가정 — 확정 후 재작성)

- **A. main() composition 모듈화** — wiring 블록을 빌더 함수로 추출. 동작 불변, 순수 구조 변경. typecheck/test green 유지.
- **B. gateway 결합도 측정 + 경계 정의** — gateway 가 참조하는 server 내부 심볼 목록화, 인터페이스로 역전.
- **C. `@finclaw/gateway` 패키지 추출** — 파일 이동 + tsconfig references + import 재작성. build·typecheck·test green.

## 의도적 비대상

- 기능 변경 일체 — 순수 구조 리팩토링. 동작·API·테스트 결과 불변이 성공 기준.
- cli 분리 (별도 필요시 후속).
- 옵션 B 의 전면 추출 (리스크 큼 — 드라이버 명확해지면 재검토).

## 전제 / 리스크

- **착수 전제**: 구체적 드라이버 발생 OR 사용자가 명시적으로 우선순위 상향. 현재는 로드맵 등재 상태.
- **리스크**: 순수 리팩토링이라 "동작 불변" 검증이 생명. 회귀 안전망 = 기존 unit/storage/e2e 테스트 + typecheck. 테스트 커버리지 빈 곳은 추출 전 보강 필요.
- phase35(특히 항목 3) 와 gateway 경계가 맞닿음 → phase35 → phase36 순서가 자연스러움.
