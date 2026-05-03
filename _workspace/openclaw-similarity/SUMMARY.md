# FinClaw ↔ OpenClaw 구현 유사도 종합 보고서

생성: 2026-05-03
OpenClaw 기준: `main` / 마지막 커밋 `8897c9d53a` (v2026.2.23)
FinClaw 기준: `feature/automation` / 마지막 커밋 `8875470`

## 한 줄 결론

**전체 유사도 ≈ 52%** — Critical 코드 알고리즘(compaction 폴백, 컨텍스트 윈도우 가드, 하이브리드 검색, tool registry/policy 9-stage, JSON-RPC over WS gateway, 1분 cron 폴러)은 OpenClaw 코드를 거의 직접 이식할 정도로 **충실히 모방**했고, RAG 주입 깊이·11 패키지 분할·금융 도메인 합체 5건은 **OpenClaw 보다 우월**한 차별화. 그러나 **Multi-provider Critical missing**(Anthropic 단일 의존)과 **Misimplemented 6건**(흉내만 내고 효과 없음 — tool-loop-detection / compaction 배선 / 임베딩 차원 / Gateway 이벤트 타입 / OpenAI-compat 미연동 / 522줄 평탄 main) 이 신뢰성 위험으로 누적되어 있다.

## 통합 유사도 카드

| 영역                    | 유사도  | Faithful | Adapted | Diverged | Missing | Misimplemented |
| ----------------------- | ------- | -------- | ------- | -------- | ------- | -------------- |
| A. Architecture         | **56%** | 4        | 7       | 3        | 5       | 1              |
| B. Runtime & Tools      | **47%** | 9        | 6       | 3        | 8       | 1              |
| C. Memory & Knowledge   | **56%** | 4        | 6       | 5        | 4       | 2              |
| D. Interface & Channels | **51%** | 4        | 8       | 1        | 6       | 2              |
| **종합 (89 패턴)**      | **52%** | **21**   | **27**  | **12**   | **23**  | **6**          |

라벨 분포(%): Faithful 24% / Adapted 30% / Diverged 13% / Missing 26% / Misimplemented 7%.

## 잘 모방한 영역 Top 6 (Faithful · Critical/Important)

1. **Compaction 3단계 폴백** (Memory & Runtime) — `packages/agent/src/agents/context/compaction.ts:11-36` 의 `SAFETY_MARGIN=1.2`, `SUMMARIZATION_OVERHEAD_TOKENS=4096`, full→partial→truncate-oldest 폴백 사다리는 OpenClaw `src/agents/compaction.ts:208-274` 와 사실상 직접 이식 수준.
2. **Auto-reply 파이프라인 stage 분리** (Runtime) — `packages/server/src/auto-reply/pipeline.ts:78-319` 의 6+2 stage 명시화는 OpenClaw `src/auto-reply/` 100+ 파일에 분산된 stage 사상을 더 깔끔하게 형식화.
3. **Tool registry + 9-stage policy** (Runtime) — `packages/agent/src/agents/tools/registry.ts`, `policy.ts:215-227` 가 OpenClaw 의 분산된 tool-policy/tool-mutation/tool-loop-detection 을 단일 클래스로 통합. `finance-safety` stage 추가는 도메인 합체.
4. **JSON-RPC over WebSocket gateway** (Interface) — dispatcher/registry/auth 분리 + broadcaster.broadcastToChannel 패턴이 OpenClaw 와 동형. 오히려 `gateway/index.ts:40-58` 의 barrel export 가 OpenClaw 보다 정돈됨.
5. **Cron 1분 폴러 + lane 직렬화 + 자동 비활성** (Interface) — `packages/server/src/automation/scheduler.ts:69-351` 의 due-find → lane 직렬화 → onRunComplete delivery → 연속 실패 자동 disable 패턴이 OpenClaw `src/cron/service.ts` 와 골격 일치, 수정 시 더 명료.
6. **하이브리드 검색 + 신선도 가중** (Memory) — `mergeHybridResults` 가중합 0.7/0.3, `exp(-daysOld * LN2/halfLife)` 신선도, 컨텍스트 윈도우 가드 4-상태(safe/warning/critical/exceeded) 가 OpenClaw 알고리즘과 동등.

## 정당한 단순화 Top 5 (Adapted · 사용자 1인 + 금융 도메인 정당화)

1. **다중 채널 7→1 (Discord 단독)** — channels/registry 추상화는 유지(`packages/server/src/channels/registry.ts:7-30`)해 확장 여지 보존. CLAUDE.md / project_use_case.md 의 "사용자 1인 비대상" 명시 근거.
2. **RPC 메서드 카탈로그 90→37** — chat/agent/session/config/health 핵심 보존, node.pair/device.pair/talk/voicewake/skills 누락. 모바일·멀티 디바이스 비대상.
3. **인증 10+ files → 4 files** — device-auth/credential precedence/role-policy 깊이를 bearer/?token/X-API-Key 3방식으로 축소. 1인용에 정당.
4. **TUI/CLI/Terminal 3분할 → 단일 ink TUI** — OpenClaw 의 browser-cli/acp-cli/clawbot-cli 다중 진입점 누락. 1인 환경 가치 낮음.
5. **임베딩 프로바이더 5종 → 2종**, **vitest 5-tier → 4-tier**, **GitHub Actions 8→3**, **scripts 78→9** — 모두 사용자 1인 운영 부담 절감.

## 의도적 차별화 (Diverged · 금융 도메인 합체 + OpenClaw 결함 보정)

1. **11 패키지 분할 (vs OpenClaw 모놀리식 src 27 MB)** — `tsconfig.json` references 가 컴파일러 단에서 단방향 의존을 강제. **OpenClaw 의 결함을 의도적으로 고친 영역**. README "한 사람이 읽고 수정할 수 있는 크기" 의도와 정합.
2. **명시적 capture only** — `auto-reply/stages/memory-capture.ts:26-35` 의 정규식 5종("기억해", "내 원칙은", `!finclaw remember` 등)으로 LLM 자율 추출 거부. 환각·오저장 방지. project_use_case.md "감사가능성·환각 방지" 직접 근거.
3. **RAG 주입을 도구가 아닌 stage로** — OpenClaw 는 lazy(LLM 결정), FinClaw 는 eager(stage 자동 system prompt 주입 + "사용자 배경지식" 섹션). 결정성·재현성 ↑.
4. **거래 이력 동시 주입 + transactions 테이블** — `auto-reply/stages/memory-retrieval.ts:301-318` 가 발화 심볼 추출 → `listTransactions(symbol, limit=3)` 동반 주입. OpenClaw 에 없는 금융 가치.
5. **agent_runs 명시적 실행 이력** — `storage/src/agent-runs.ts` + memory_id/schedule_id FK. OpenClaw 의 session transcript 보다 explicit·queryable. 감사 가능성 우선 설계.
6. **FINANCIAL_REDACT_PATTERNS** — 결과 가드에서 계좌·주민·카드 자동 마스킹. 도메인 합체.
7. **임베딩 캐시 테이블** — `embedding_cache` (provider+model+sha256 PK)로 동일 텍스트 재임베딩 방지. API 비용 절감.

## 위험 신호 — 즉시 보완 권장 (Critical Missing + Misimplemented)

| #   | 패턴                               | 영역              | 라벨                          | OpenClaw 의 가치                                     | FinClaw 의 현재 상태                                                                                                                                | 보완 추정                                                                           |
| --- | ---------------------------------- | ----------------- | ----------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | **Multi-provider 구현체**          | Runtime           | **Missing(Critical)**         | 가용성·가격 폴백                                     | `ProviderAdapter` 인터페이스만 있고 Anthropic 1개. `classifyFallbackError`의 model-unavailable이 사실상 무용지물                                    | OpenAI/Google adapter 1~2개 추가로 점프                                             |
| 2   | **Compaction 배선 누락**           | Memory            | **Misimplemented(Critical)**  | long-conversation 자동 보호                          | `compactContext`/`evaluateContextWindow` 가 export 되지만 server/auto-reply 어디서도 호출 안 됨 — dead code                                         | runner 또는 context stage 에 배선 1군데 추가                                        |
| 3   | **임베딩 차원 hard-coding**        | Memory            | **Misimplemented(Important)** | provider 자유 폴백                                   | `database.ts:76-79` `vec0(float[1024])` 고정 → OpenAI 1536D 폴백 작동 안 함. `provider.ts:22-23` NOTE 자기 인정                                     | provider별 차원 메타 + 동적 vec0 dim 또는 1536 통일                                 |
| 4   | **Tool loop detection**            | Runtime           | **Misimplemented(Important)** | 무한 루프·반복 차단 (project_use_case "감사 가능성") | `registry.ts:295-297` console.warn 만 출력하고 계속 실행. "force require-approval" 코멘트만 있고 실제 차단 없음                                     | 4-detector(generic_repeat/poll-no-progress/circuit-breaker/ping-pong) 중 1~2개 도입 |
| 5   | **Gateway 이벤트 카탈로그 불일치** | Interface         | **Misimplemented(Important)** | 송출 가능 이벤트의 단일 출처                         | `BroadcastChannel = 4개` 타입 선언 vs `'portfolio.changed'`/`'schedule.completed'` 등 5+ ad-hoc 사용 (`finance.ts:96`, `delivery.ts:96`)            | type union 확장 또는 GATEWAY_EVENTS 카탈로그 신설                                   |
| 6   | **OpenAI-compat router 미연동**    | Interface         | **Misimplemented(Important)** | 외부 OpenAI 클라이언트 호환                          | `openai-compat/router.ts:62-72` stream에서 `data: [DONE]` 즉시 송출, `// TODO(Phase 12+)`. non-stream 501                                           | runner.execute 연결 또는 endpoint 비공개                                            |
| 7   | **Cache trace 부재**               | Runtime           | **Missing(Important, 우발)**  | prompt caching hit/miss 비용 audit                   | 캐싱 자체는 동작(`anthropic.ts:114-138`)하나 stage별 추적·sha256 fingerprint·JSONL 큐 부재. project_use_case "감사 로그 SQLite 영구 저장" 원칙 위반 | OpenClaw `src/agents/cache-trace.ts:11-18` 8-stage 모델 이식                        |
| 8   | **522줄 단일 `main()`**            | Architecture      | **Misimplemented(Important)** | 부트 단계별 fail-fast + 부분 테스트 가능성           | `packages/server/src/main.ts:135-504` 한 함수에 env→Anthropic→Discord→Storage→Embedding→Skills→Lanes→Pipeline→Gateway→Scheduler 평탄 배선           | OpenClaw `entry.ts(129)`+`index.ts(93)`+`run-main.ts` 3단 분리 모방                 |
| 9   | **Wizard / 첫 부팅 UX**            | Interface         | **Missing(Important, 우발)**  | onboarding 과정에서 API key/profile 설정             | 부재 — config 파일 직접 편집 의존                                                                                                                   | OpenClaw `src/wizard/onboarding.ts` 패턴 일부 도입                                  |
| 10  | **MCP 클라이언트**                 | Runtime/Interface | **Missing(Important, 우발)**  | 2026 표준, 외부 도구 통합                            | 양쪽 모두 부분적, OpenClaw 가 더 진척                                                                                                               | plans/phase29 에 검토                                                               |

## 두고 봐도 되는 갭 (Adapted/Diverged · 1인 제약)

- **모바일 앱 부재 (apps/{ios,android,macos})** — 명시 비대상.
- **80+ 외부 도메인 skill 부재 (1password/github/notion 등)** — project_use_case.md "엔터프라이즈 기능... 죽은 무게" 명시.
- **Bash exec / Sandbox / Docker.sandbox** — plans/phase20 명시 비대상. 금융 비서 도메인.
- **Apply-patch 자기-편집** — 코딩 에이전트 도구. 도메인 차이로 정당.
- **Subagent / Pairing / 다중 backend OAuth flow** — 1인 환경 정당.
- **Fly + Render 배포 매니페스트** — 자가호스팅 정책 명시.

## 금융 도메인 통합 품질

**평가: A (강한 도메인 합체)**

- **통합 지점 7건**: transactions 테이블 + portfolio_holdings 재계산 + RAG 거래 동시 주입 + symbol 기반 검색 + financial_redact 패턴 + finance-safety policy stage + skills-finance(market/news/alerts) 도메인 패키지.
- **OpenClaw generic 패턴을 깨지 않고 확장**: 명시적 capture, eager RAG stage, agent_runs 모두 OpenClaw 가 잡지 못한 "감사 가능성" 가치를 도메인 합체와 함께 강화.
- **회수율 의문**: plugin-sdk 골격 9 파일 + 0 플러그인은 CLAUDE.md §2 "한 번만 쓰는 코드에 추상화 만들지 말 것" 위반 의심. 금융 도메인 한정에서 plugin 시스템이 진짜 필요한지 재검토 권장.

## 거시 측정값 비교

| 메트릭                       | OpenClaw                                                                         | FinClaw           | 비율  |
| ---------------------------- | -------------------------------------------------------------------------------- | ----------------- | ----- |
| TS 파일 (test 제외, src+ext) | 2,704                                                                            | 682               | 25%   |
| 테스트 파일                  | 1,503                                                                            | 173               | 12%   |
| 핵심 코드 크기 (디스크)      | 33.7 MB (src+ext+ui)                                                             | 9.1 MB (packages) | 27%   |
| 워크스페이스 패키지          | 42 (root + ui + 38 ext + 2 packages)                                             | 11                | 26%   |
| 채널 디렉토리                | 8                                                                                | 1                 | 12.5% |
| RPC 메서드                   | ~90                                                                              | 37                | 41%   |
| 임베딩 프로바이더            | 5                                                                                | 2                 | 40%   |
| Gateway 이벤트 (선언)        | 19                                                                               | 4 (+ 1+ ad-hoc)   | ≤30%  |
| Dockerfile                   | 4                                                                                | 1                 | 25%   |
| 배포 매니페스트              | 3 (fly+render+compose)                                                           | 1                 | 33%   |
| GitHub Actions workflow      | 8                                                                                | 3                 | 37.5% |
| `package.json` scripts       | 80+                                                                              | 12                | 15%   |
| Plugin 실 사용               | 38 extensions                                                                    | 0                 | 0%    |
| Multi-modal 인덱싱 provider  | 8                                                                                | 0                 | 0%    |
| Multi-LLM provider 구현      | 8+ (anthropic+gemini+byteplus+chutes+cloudflare+bedrock+huggingface+minimax+...) | 1 (anthropic)     | 12.5% |

압축률 종합: 약 **25% (1/4)**, 모바일/extensions/외부 skill 제외 시 약 **40%**. README "한 사람이 전부 읽을 수 있는 크기" 의도 정합.

## 결론

### 잘한 점 (3줄)

1. OpenClaw 의 **모놀리식 src 결함을 의도적으로 고친 11 패키지 분할** — 컴파일러 단 단방향 의존 강제, 한 사람이 읽기 가능한 25% 규모.
2. Critical 알고리즘(**compaction · context guard · tool registry/policy · cron scheduler · 하이브리드 검색**) 은 OpenClaw 코드를 거의 직접 이식할 정도로 충실, 일부는 더 깔끔하게 재정리.
3. **금융 도메인 합체 7건**(명시적 capture / eager RAG / 거래 동시 주입 / agent_runs / financial_redact / finance-safety stage / 임베딩 캐시) 이 OpenClaw 에 없는 가치를 정당하게 더함 — project_use_case.md 의 "감사 가능성·환각 방지·읽기 전용" 원칙과 정합.

### 즉시 보완 권장 — Phase 29/30 후보 (위험 순)

1. **Compaction 배선** (Memory Misimplemented Critical) — runner 또는 context stage 에 `compactContext` 1줄 호출 추가. dead code → live.
2. **임베딩 차원 동적화** (Memory Misimplemented Important) — vec0 차원을 provider 메타에서 받거나 1536D 통일. fallback 자기 모순 해소.
3. **Tool loop detection 실효화** (Runtime Misimplemented Important) — generic_repeat + circuit-breaker 2 detector 도입, console.warn → 실제 차단.
4. **Gateway 이벤트 카탈로그** (Interface Misimplemented Important) — `BroadcastChannel` union 확장 또는 `GATEWAY_EVENTS` 상수화로 타입과 실 사용 일치.
5. **OpenAI-compat 결정** (Interface Misimplemented Important) — runner 연동 또는 router 비공개 처리. 미연동 stub 유지는 위험.
6. **Multi-provider 1~2개 추가** (Runtime Critical Missing) — OpenAI 또는 Google adapter 1개. failover/cooldown 모델은 이미 있으므로 작은 작업.
7. **Cache trace 도입** (Runtime Missing Important) — `cache-trace.ts` 모델 이식. prompt caching 비용 audit 회복.
8. **`main()` 분해** (Architecture Misimplemented) — entry/bootstrap/wire 3 함수로 분리. 부트 단계 테스트 가능성 회복.

### 두고 봐도 되는 갭

- 모바일 / 80+ 외부 skill / sandbox bash exec / multi-channel 추가 — 모두 사용자 1인·금융 도메인 한정으로 명시 정당.

### 금융 도메인 통합의 다음 단계

- transactions↔agent_runs↔memory의 cross-reference query (감사 추적의 깊이 강화)
- 결산서 PDF/차트 이미지 입력 — channel capabilities 의 `supportsImages=true` 선언만 있고 실 처리 부재 (`pipeline.ts:185`). 금융 도메인 활용 여지.
- query expansion 도입 — "그거 어떻게 됐어?" 류 짧은 발화의 recall 한계 보완.

## 부록: 4개 세부 보고서

- [Architecture](architecture.md) — 56% (Faithful 4 / Adapted 7 / Diverged 3 / Missing 5 / Misimpl 1)
- [Runtime & Tools](runtime-tools.md) — 47% (Faithful 9 / Adapted 6 / Diverged 3 / Missing 8 / Misimpl 1)
- [Memory & Knowledge](memory-knowledge.md) — 56% (Faithful 4 / Adapted 6 / Diverged 5 / Missing 4 / Misimpl 2)
- [Interface & Channels](interface-channels.md) — 51% (Faithful 4 / Adapted 8 / Diverged 1 / Missing 6 / Misimpl 2)
