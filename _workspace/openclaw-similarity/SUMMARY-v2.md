# FinClaw ↔ OpenClaw 구현 유사도 v2 — Deep-Dive 통합 보고서

생성: 2026-05-04
대상: 사용자 컨텍스트 = **Claude (Anthropic) 단일 + Discord 단일 채널 + 1인 + 모바일 비대상**
v1 보고서(`SUMMARY.md`) 의 MEDIUM 신뢰도 항목을 메모리·자동화 코드를 직접 읽어 HIGH 로 끌어올린 결과.

## v1 → v2 핵심 변경 (3건)

| 영역                     | v1 (MEDIUM)                              | v2 (HIGH 직접 검증)                                                                                                                                                                                                     |
| ------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **메모리 capture**       | "OpenClaw 가 LLM 자율 추출" 추측         | **OpenClaw 는 자동 추출 자체 부재.** `manager.ts`/`qmd-manager.ts` 에 `writeMemory`/`recordMemory` 없음. read-only 인덱서임. → FinClaw 의 명시적 capture + eager 주입은 **OpenClaw 보다 적극적**.                       |
| **MMR / temporal-decay** | "OpenClaw 는 사용 / FinClaw 는 누락"     | OpenClaw 도 **기본값 disabled** (`memory-search.ts:96,98` `DEFAULT_MMR_ENABLED=false`, `DEFAULT_TEMPORAL_DECAY_ENABLED=false`). 사용자 config opt-in. → FinClaw 의 temporal-decay 강제 적용은 **OpenClaw 보다 적극적**. |
| **자동화 12시 보고**     | "Faithful 골격" 만 평가, 시나리오 미검증 | **시나리오 A 종단 동작 ✅, 시나리오 B (자연어 등록) 부재, 시나리오 C 8중 5 누락** (error backoff/stagger/timezone/에러 가시성/자연어 도구). 자동화 영역 51% → **66%** 로 상향.                                          |

추가 정정: query-expansion 은 LLM 다중 재작성이 아니라 **7-언어 stop-word 토큰 필터** (`query-expansion.ts:723-754`). cache-trace stage 8 → 7. 임베딩 캐시 양쪽 모두 존재 (이전 "OpenClaw 부재" 오류).

## 통합 유사도 카드 (v2 갱신)

| 영역                  | v1 %            | **v2 %** | 변경 사유                                                               |
| --------------------- | --------------- | -------- | ----------------------------------------------------------------------- |
| Architecture          | 56%             | **56%**  | (deep-dive 미실시, 유지)                                                |
| Runtime & Tools       | 47%             | **47%**  | (deep-dive 미실시, 유지)                                                |
| Memory & Knowledge    | 56%             | **62%**  | OpenClaw 자동 추출 부재 정정 + 임베딩 캐시 동급으로 FinClaw 적극성 인정 |
| Interface & Channels  | 51%             | **51%**  | (자동화는 별도 영역으로 분리)                                           |
| **Automation (신설)** | (51% 안에 포함) | **66%**  | 시나리오 종단 검증 결과                                                 |
| **종합 가중평균**     | **52%**         | **≈55%** | Memory + Automation 상향 반영                                           |

## 메모리 시스템 비교 — 정정된 그림

### OpenClaw 메모리 (실제 모습)

- **사용자가 `MEMORY.md` / `memory/YYYY-MM-DD.md` 를 직접 편집** — chokidar FSWatcher 가 변경 감지 → 인덱싱 (`manager.ts:86`).
- LLM 은 **read-only**: `memory_search` (검색) + `memory_get` (line range 인용) 두 도구만 (`memory-tool.ts:50-99`). 도구 description 에 "Mandatory recall step" 강제하지만 호출은 LLM 결정.
- 기본값: `DEFAULT_MAX_RESULTS=6`, `DEFAULT_MIN_SCORE=0.35`, hybrid 0.7/0.3, **MMR/temporal-decay disabled**.

### FinClaw 메모리 (재평가)

- 정규식 5종 명시 capture (`memory-capture.ts:26-35`) — "기억해", "내 원칙은", `!finclaw remember`.
- sqlite single-source. memories 테이블 + embedding_cache (양쪽 동등).
- voyage-finance-2 1024D 단일.
- **stage 자동 주입** — system prompt "사용자 배경지식" + 거래 이력 동시 (`memory-retrieval.ts:171-318`). top-3, threshold 0.65, **temporal-decay 항상 적용** (exp(-days/90)).

### 비교 결론 — FinClaw 가 더 적극적인 영역

1. **Capture** — OpenClaw 부재 vs FinClaw 정규식 5종 명시 추출 ✓
2. **RAG 주입** — OpenClaw lazy(LLM 결정) vs FinClaw eager(stage 자동) ✓
3. **Temporal decay** — OpenClaw opt-in 기본 off vs FinClaw 강제 적용 ✓
4. **거래 이력 동시 주입** — OpenClaw 부재 (도메인 외) ✓
5. **agent_runs 명시 이력** — OpenClaw 의 session transcript 보다 explicit ✓

### 비교 결론 — FinClaw 의 진짜 갭 (좁아진 후)

1. **Compaction 미배선 (Critical)** — `compactContext` export 만, server import 0 (재확인). long-conversation 보호 부재.
2. **Markdown 1차 source 부재** — 사용자가 메모리를 git 추적·외부 편집·grep 으로 사용할 길 없음. 의도된 차별화로 보이지만 plans 명시 근거 약함.
3. **session-tool-result-guard 부재** — OpenClaw `session-tool-result-guard.ts:24-32` 가 oversized text block 을 자동 truncate. **FinClaw 가 시세/뉴스 raw bytes 를 그대로 transcript 에 넣으면 토큰 폭발 위험** — Important.

### 메모리 deep-dive 결론

직접 읽어보니 메모리는 **FinClaw 의 강점**. 진짜 위험은 (1) compaction + (2) tool-result-guard 둘.

## 자동화 / 12시 보고 — 시나리오 검증

### 시나리오 A: "매일 12시 포트폴리오 보고를 Discord 로" — ✅ 정상 동작

종단 추적: `schedule.create` (`schedule.ts:121-144`) → `parseCron` 검증 → `addSchedule` (`storage/schedules.ts:92-119`) → `scheduler.ts:78-94` 매분 폴러 → `findDueSchedules` → `runOne` lane 직렬화 → `agent.run` → `addAgentRun` → `markScheduleRun` → `delivery.ts:52-109` Discord DM 또는 web broadcast → 3회 연속 실패 시 `enabled=false` (`scheduler.ts:300-317`) → `agent_runs` history 조회 (`schedule.ts:265-308`). 회귀 테스트 4개.

### 시나리오 B: "사용자 발화로 자동화 등록" — ❌ 부재

사용자가 Discord 에서 "매일 12시에 포트폴리오 보고해줘" 라고 해도 등록 못 함. agent 가 `schedule.create` 를 호출할 도구가 없다 (`schedule-tool.ts` 신설 필요). **비서 정체성에 정면 위배.**

### 시나리오 C: 운영 회복력 8종 — 3/8 존재, 5 누락

- ✅ 1분 폴러, ✅ lane 직렬화, ✅ 3회 실패 auto-disable
- ❌ **error backoff [30s/1m/5m/15m/60m]** — `* * * * *` 매분 실패 시 retry storm + Claude API 비용 즉각 위험
- ❌ **top-of-hour stagger** — 정각 동시 큐잉 → 마지막 schedule 5분 지연 + rate limit
- ❌ schedule-compute 에러 가시성
- ❌ 자연어 등록 도구
- ❌ timezone (UTC 고정)

자동화 압축률 16% (OpenClaw 5,500 LOC vs FinClaw 883 LOC).

## OpenClaw 의 기술적 특별 요소 (★★★★ 이상 5개 — HIGH 신뢰도)

| #   | 패턴                                                                                                         | 별점  | Claude+Discord 도입 가치 | LOC                           | 권장 Phase               |
| --- | ------------------------------------------------------------------------------------------------------------ | ----- | ------------------------ | ----------------------------- | ------------------------ |
| 1   | **Backend-as-CLI** (`claude` CLI 를 backend 로 spawn, ANTHROPIC_API_KEY clear 후 Claude Code 구독 인증 사용) | ★★★★★ | ★★★★★ (조건부)           | ~650                          | 30+ 별도 트랙            |
| 2   | **Tool-Loop 4-Detector** (sha256 hash 기반 generic_repeat / poll_no_progress / circuit_breaker / ping_pong)  | ★★★★★ | ★★★★☆                    | 180 (2-detector) ~ 450 (전체) | **29 (즉시)**            |
| 3   | **Top-of-Hour Stagger** (`"0 * * * *"` 자동 0~5분 random 분산)                                               | ★★★★  | **★★★★★**                | 47                            | **29 (즉시)**            |
| 4   | **FailoverError 양방향 매핑** (reason↔HTTP status, timeout 정규식, cause 보존)                               | ★★★★  | ★★★★                     | 240                           | 30 (multi-provider 전제) |
| 5   | **Cache Trace 8-stage Fingerprint** (sha256 messagesDigest 비교로 cache miss 위치 식별)                      | ★★★★  | ★★★                      | 350                           | 30+                      |

추가 ★★★ 급: CLI Watchdog Ratio (Backend-as-CLI 의존), Auth-Profile Cooldown-aware Round Robin (multi-provider 의존), Anthropic Payload Logger sha256 audit.

**화려한 외피지만 사용자 환경에서 ★ 이하**: ACP 프로토콜 (Cursor/Zed 통합 — 1인+Discord 가치 낮음), Canvas-Host (multi-channel A2UI — Discord 단일에서 의미 적음), Plugin-SDK (38 extensions — 1인용에 과함), Multi-modal 8 provider (Claude 단일이면 1개로 충분), Markdown 채널 변환 (WhatsApp/iMessage 부재 시 무용).

## 위험 신호 — Claude/Discord 컨텍스트로 재라벨

| #   | v1 위험                         | v2 재평가                                            | 권장                                                       |
| --- | ------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| 1   | Multi-provider Critical missing | **삭제** — Claude 단일이 사용자 의도                 | ProviderAdapter 추상화도 1인용에 과한 것일 수 있음         |
| 2   | Compaction 배선 누락            | **유지 Critical**                                    | Phase 29 #1 — runner 또는 context stage 에 1군데 호출 추가 |
| 3   | 임베딩 차원 hard-code           | **격하** — voyage 단일이면 정상. NOTE 만 정확히 갱신 | (선택)                                                     |
| 4   | Tool loop detection misimpl     | **유지 Important** + 우선순위 ↑                      | Phase 29 #3 — generic_repeat + circuit_breaker 2-detector  |
| 5   | Gateway 이벤트 카탈로그 불일치  | **유지 Important**                                   | Phase 29 #4 — type union 확장 또는 GATEWAY_EVENTS 카탈로그 |
| 6   | OpenAI-compat 미연동            | **삭제 권고** — Claude-only 면 endpoint 비공개       | 미연동 stub 유지가 더 위험                                 |
| 7   | Cache trace 부재                | **격하 Nice**                                        | Phase 30+                                                  |
| 8   | 521줄 main()                    | **유지 Important**                                   | Phase 30                                                   |

**신규 위험 (deep-dive 발굴):**

- **A. Schedule error backoff 부재** Critical — `* * * * *` 실패 시 Claude API 비용 폭발 즉각 위험 (Automation #1)
- **B. Top-of-hour stagger 부재** Important — 정각 thundering herd
- **C. session-tool-result-guard 부재** Important — 시세/뉴스 raw bytes 토큰 폭발
- **D. schedule-tool agent 도구 부재** Important — 자연어 자동화 등록 불가 (시나리오 B)

## Phase 29 권고 — 작업량 순 (작은 것부터)

| #   | 작업                                                                 | LOC  | 시간   | 영역       | 가치      |
| --- | -------------------------------------------------------------------- | ---- | ------ | ---------- | --------- |
| 1   | **Top-of-hour stagger 이식**                                         | 47   | 1h     | Automation | ★★★★★     |
| 2   | **Compaction 배선** (runner 1군데 호출 추가)                         | ~10  | 30m    | Memory     | Critical  |
| 3   | **Schedule error backoff** [30s/1m/5m/15m/60m]                       | ~8   | 30m    | Automation | Critical  |
| 4   | **Gateway 이벤트 카탈로그 정정** (type union 확장 또는 상수화)       | ~20  | 1h     | Interface  | Important |
| 5   | **Tool-loop 2-detector** (generic_repeat + circuit_breaker)          | ~180 | 반나절 | Runtime    | Important |
| 6   | **session-tool-result-guard** (oversized text block 자동 truncate)   | ~50  | 1h     | Memory     | Important |
| 7   | **schedule-tool.ts agent 도구** (자연어 자동화 등록 시나리오 B 해결) | ~80  | 반나절 | Automation | Important |
| 8   | **OpenAI-compat router 비공개 처리** (stub 제거)                     | ~10  | 30m    | Interface  | 정리      |

**총 합산: 약 405 LOC, 1.5~2일 작업.** Critical 3건(#2/#3/#1) 이 합 ~65 LOC 라 가장 시급. 사용자가 12시 정기 보고 같은 자동화를 적극 사용한다면 #1+#3 (stagger + backoff) 가 즉각 효용.

## Phase 30+ 후보

- **Tool-loop 4-detector 전체** (ping-pong + known-poll 추가)
- **FailoverError 패턴 도입** (multi-provider 추가의 전제)
- **Cache Trace 8-stage** (audit 강화 의도 있을 때만)
- **Backend-as-CLI** (Claude Pro 구독 활용 — 별도 트랙)
- **Markdown 1차 source** (사용자가 메모리 직접 편집·git 추적 원할 때)
- **main.ts 522줄 분해** (entry/bootstrap/wire 3 함수)
- **Schedule timezone 지원** (UTC 고정 → 사용자 timezone)

## 두고 봐도 되는 갭 (정당한 단순화)

- Multi-provider — Claude 단일이 사용자 의도
- Multi-channel — Discord 단일 명시
- 모바일 앱 / 80+ 외부 skill / sandbox bash exec / Apply-patch / Subagent — plans/CLAUDE.md/use_case 명시 비대상
- ACP / Canvas-Host / Pairing / Wizard / Multi-modal / Plugin-SDK / 38 extensions — 1인+Discord 환경에서 가치 ★ 이하

## OpenClaw 의 약점 (균형 평가)

deep-dive 중 발견한 OpenClaw 측 결함:

1. **tool-loop-detection 기본값 disabled** — 만든 사람조차 default off. OpenClaw 사용자 대다수가 효용 미수령 의심.
2. **MMR / temporal-decay 기본 off** — 메모리의 정교함이 default 에서 빠져있음.
3. **system-prompt.ts 695줄 평탄 builder** — FinClaw `main.ts:521` 와 같은 종류의 평탄성.
4. **`validateScriptFileForShellBleed`** 같은 코미디성 휴리스틱 — bash exec 의 hardening 이 정규식으로 짜여진 부분.
5. **plugin 38개 extensions / 80+ skill 의 회수율** — 사용자 1명이 실제로 몇 개 쓰는지 측정 부재.
6. **22 콘솔 옵션 / 18 모델 / 8 multi-modal provider** — feature creep 누적.

→ FinClaw 가 OpenClaw 의 _결함을 그대로 모방하지 않은_ 영역도 있다는 뜻.

## 신뢰도 등급

- **HIGH (코드 직접 인용 + 양쪽 비교)**: 전체 매핑의 약 60% (Memory deep-dive 30건 + Automation 시나리오 A/B/C + Uniqueness 8개 + 위험신호 8건 검증)
- **MEDIUM (한쪽만 직접 읽고 다른 쪽 디렉토리/카운트)**: 약 30%
- **LOW (양쪽 모두 디렉토리 listing 기반)**: 약 10% (Architecture/Runtime 의 일부 Adapted/Missing 항목)

전반적 결론은 **HIGH 신뢰도** 로 받아도 무방. 단 v2 가 다루지 않은 Architecture·Runtime 영역의 일부 항목은 v1 의 MEDIUM 신뢰도로 남아있음 (필요하면 추가 deep-dive).

## 부록

- [Architecture v1](architecture.md) — 56%
- [Runtime & Tools v1](runtime-tools.md) — 47%
- [Memory & Knowledge v1](memory-knowledge.md) — 56% → v2 62%
- [Interface & Channels v1](interface-channels.md) — 51%
- [Memory Deep-Dive v2](deep-memory.md) — HIGH 신뢰도 30건
- [Automation Deep-Dive v2](deep-automation.md) — 시나리오 A/B/C
- [OpenClaw Uniqueness](openclaw-uniqueness.md) — 8 특별 요소
- [SUMMARY v1](SUMMARY.md) — 초기 종합 보고서
