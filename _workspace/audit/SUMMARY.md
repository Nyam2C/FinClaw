# FinClaw 현대 AI 비서 성숙도 감사 — 종합 보고서

> 감사 일자: 2026-05-03 / 브랜치 `feature/automation` @ `30913d7`
> 대상: 11 패키지 / 462 TS 파일 / 56,195 LOC / 173 테스트 파일 (1,522 `it()`) / 29 phase plans / 206 commits
> 비교 기준: Anthropic Claude.ai (claude-agent-sdk + MCP), OpenAI ChatGPT/Assistants v2, Letta/MemGPT, Hermes/OpenDevin, MCP 표준
> 사용자 제약: 1인 전용 / 직접 학습 비대상 / 감사 가능성·환각 방지·읽기 전용 가중치 ↑

---

## 한 줄 결론

**FinClaw 는 현대 AI 비서 MVP 기준(3.0)을 분명히 통과했고 일부 영역에서 Production-grade(4.0) 직전이지만, "외부 도구 표준(MCP)" 과 "감사 가능성(RAG citation)" 두 축에서 Critical 갭이 있어 "OpenClaw/헤르메스급 비서" 라고 부르기에는 한 단계 부족하다.**

- **종합 평균 3.30 / 5** (MVP/Production-ready 구간)
- 차별화 강점: 거래 도메인 영속·prompt caching·9-단계 도구 정책·1분 cron 자동화 — 범용 비서가 갖지 않는 금융 특화 안전성
- Critical 5건은 모두 M(2-4주) 이내 해소 가능. **Phase 29 1 사이클로 Production-grade(3.7+) 진입 가능**

---

## 통합 점수 카드

| 영역                     | 점수 (0-5) | 등급                       | 현대 AI 비서 평균 (참조) |
| ------------------------ | ---------- | -------------------------- | ------------------------ |
| 1. Architecture          | **3.2**    | MVP+                       | 3.5                      |
| 2. Agent Runtime & Tools | **3.43**   | Production-grade 직전      | 3.6                      |
| 3. Memory & Knowledge    | **3.43**   | Production-grade 직전      | 3.4                      |
| 4. Interface & Channels  | **3.14**   | MVP+                       | 3.5                      |
| **종합 평균**            | **3.30**   | **MVP / Production-ready** | 3.5                      |

**축별 분포 (총 26 축):**

- 5점 (industry-leading): 0
- 4점 (production-grade): 7 — 모듈 분리, 빌드/타입, 도구 시스템, 에러 회복, 영속 스키마, 컨텍스트 관리, 채널 다양성, 실시간 UX, 자동화
- 3점대 (MVP 충족): 13
- 2점 이하 (갭): **3** — 런타임 토폴로지(2.0), 프로바이더 추상화(2.0), 외부 도구 연결/MCP(1.0)

---

## 강점 Top 5

### 1. **금융 특화 안전 정책 — 범용 비서가 갖지 않는 차별화**

9-단계 도구 정책 (deny→allow→user→channel→group→tool→finance→default) + `isTransactional → require-approval` + `FINANCIAL_REDACT_PATTERNS` + `ModelFloorExhaustedError` (분석 도구의 minModel=opus 보호) + per-provider `CircuitBreaker`. ChatGPT/Claude.ai 의 일반 도구 권한 모델보다 도메인 안전 가중치가 명확히 우월.

### 2. **인프라 over-engineered 수준의 안정성** (1인 사용자 프로젝트로서)

`@typescript/native-preview` (tsgo, 2026-04 기준 매우 이른 채택) + 4-tier vitest (unit / storage maxWorkers=1 / e2e / live) + multi-arch Docker (amd64+arm64) + GHA semver tagging + `pnpm.minimumReleaseAge: 10080` (공급망 7 일 윈도우) + multi-stage Dockerfile / non-root / `/healthz`. **Letta/MemGPT 와 동급 정적 경계 + Anthropic SDK 가 안 쓰는 캐시 정책까지 적용**.

### 3. **WebSocket 실시간 UX 가 4점급**

자동 재연결 (지수 백오프) + 150ms delta 배치 + slow-consumer 보호 + heartbeat + `portfolio.changed`/`schedule.completed` 자동 구독. ChatGPT Web 의 streaming 보다 backend 단 견고성이 뚜렷.

### 4. **Phase 28 자동화 — 단순함 우선의 production-ready 결정**

5필드 cron + 1분 폴러 + 전용 lane(1) + 실패 자동-disable + agent_runs 링크 + Discord/Web 송출. ChatGPT Tasks 와 유사 사용 가치, 다중 채널 발송은 오히려 우월. (재시도/dead-letter 부재는 의도적 단순화)

### 5. **하이브리드 RAG + 컨텍스트 압축 4단계 폴백**

벡터(sqlite-vec) + FTS5 + 임계값(0.65) + 신선도 가중(exp(-d/90)) + 상한(3) + 거래 동시 주입 + window-guard 4단계 + 3단계 압축(full→partial→truncate) + system prompt 보존. 긴 대화 안정성에서 **현대 비서 평균 위**.

---

## 갭 우선순위 (Critical 순)

### Critical (5건) — 현대 AI 비서 자격 본질 결손

| #       | 갭                                                                                                                                                                            | 발견 audit         | 영향                                  | 작업량 | 코드 경로                                                                            |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| **C-1** | ProviderId='anthropic' 단일 union — 라우팅/폴백/카탈로그 인프라가 단일 벤더로 락                                                                                              | architecture       | 운영자 (Claude API 장애 시 우회 불가) | M      | `packages/agent/src/models/catalog.ts:4`, `providers/adapter.ts`, `auth/resolver.ts` |
| **C-2** | **RAG citation 부재** — system prompt 의 "사용자 배경지식" 섹션이 memoryId 미노출. 사용자 제약 "감사 가능성·환각 방지" 에 직격                                                | memory-knowledge   | 사용자 (출처 추적 약화), 운영자       | S-M    | `packages/server/src/auto-reply/stages/memory-retrieval.ts`, `prompts/`              |
| **C-3** | 임베딩 차원 silently broken — `vec0(float[1024])` 고정인데 `OpenAIEmbeddingProvider`(1536D) 가 런타임 가드 없이 등록 가능                                                     | memory-knowledge   | 운영자 (provider 전환 시 데이터 망실) | S      | `packages/storage/src/embeddings/openai.ts`, `tables/memory_chunks_vec`              |
| **C-4** | **MCP 클라이언트/서버 0건** + plugin 5-stage loader 가 main.ts 에 미배선 (dead module) — 외부 도구 표준 부재                                                                  | interface-channels | 사용자/생태계 (확장성 차단)           | M      | `packages/server/src/plugins/loader.ts`, `main.ts`                                   |
| **C-5** | gateway 운영성 모듈 dead — `RequestRateLimiter` / `createAccessLogger` / `createHotReloader` / `AuthRateLimiter` / `registerHealthChecker` 가 export 만 되고 main.ts 호출 0건 | interface-channels | 운영자 (운영 가시성/방어 약화)        | S      | `packages/server/src/gateway/{rate-limit,access-log,hot-reload}.ts`, `main.ts`       |

### Important (16건) — 사용성·신뢰성 손실

상위 6건만 발췌 (전체는 세부 보고서 참조):

- **I-1** (arch): 단일 Node 프로세스 — 스케줄러·임베딩 reindex·alert monitor 가 메인 이벤트 루프 공유 (워커 fleet 부재)
- **I-2** (mem): 거래 회계 무결성 — REAL float 정밀도, 음수 holdings 가드, dividend cash 영향 누락
- **I-3** (mem): mock 임베딩 부재 — 테스트가 외부 키 없을 때 hybrid 검증 불가 (FTS-only 회피)
- **I-4** (mem): 사용자 메모리 편집 UI 부재 (삭제만, ChatGPT Memory 와 격차)
- **I-5** (rt): vision / file 첨부 미구현 — `ContentBlock` 에 image 없음, 모델 capabilities.vision=true 와 어긋남
- **I-6** (if): Discord `/ask` 슬래시 placeholder 응답만 — 사용자 혼란 (`commands/ask.ts:19` TODO)
- **I-7** (if): OpenAI-호환 endpoint 가 stub 501 — 외부 클라이언트 통합 차단

### Nice-to-have (10건+) — 차별화 요소

- Letta 식 working/archival/recall 3계층 메모리 (의도적 단순화로 추정)
- 메모리 자동 추출 옵션 (ChatGPT Memory 식, 사용자 결정으로 명시 선언만 채택)
- re-ranking, 메모리 그래프
- planner-executor 분리 / 자기-반성 루프
- Canvas/Artifacts 같은 협업 산출물 영역
- Turbo/Nx 캐시 레이어
- trace ID/span tree 표준 (OpenTelemetry/Langfuse)

---

## 현대 비서 비교 매트릭스

| 기능                              | Claude.ai            | ChatGPT               | Letta/MemGPT | Hermes/OpenDevin | **FinClaw**                        |
| --------------------------------- | -------------------- | --------------------- | ------------ | ---------------- | ---------------------------------- |
| **에이전트 루프 (ReAct)**         | ✓                    | ✓                     | ✓            | ✓                | ✓ (max_turns=10, abort, retry)     |
| **Prompt caching**                | ✓                    | ✓                     | -            | -                | ✓ (`cache_control: ephemeral`)     |
| **Parallel tool calls**           | ✓                    | ✓                     | ✓            | ✓                | ✓ (`Promise.all` 병렬)             |
| **다중 프로바이더**               | Bedrock/Vertex 분기  | n/a                   | LiteLLM 50+  | LiteLLM 50+      | ✗ (anthropic 단일) **C-1**         |
| **MCP 호환**                      | ✓ (clients + server) | (예정)                | -            | -                | ✗ **C-4**                          |
| **Vision**                        | ✓                    | ✓                     | -            | -                | ✗ (capabilities flag 만)           |
| **File 첨부**                     | ✓                    | ✓                     | ✓            | ✓                | ✗                                  |
| **Code interpreter**              | (사이드)             | ✓                     | ✓            | ✓                | ✗ (의도적 — 읽기 전용 원칙)        |
| **Computer use**                  | ✓                    | -                     | -            | ✓                | ✗ (의도적 제외 가능)               |
| **메모리 자동 추출**              | -                    | ✓                     | ✓            | n/a              | ✗ (의도 — 명시 선언만)             |
| **메모리 사용자 가시**            | -                    | ✓                     | ✓            | n/a              | △ (settings 삭제만, 편집 X)        |
| **메모리 출처/citation**          | (Projects)           | ✓                     | ✓            | n/a              | ✗ **C-2**                          |
| **컨텍스트 압축**                 | -                    | -                     | ✓ (3 계층)   | (한정적)         | △ (3단계 압축, 계층 X)             |
| **다채널**                        | web/Desktop          | web/iOS/Desktop/Slack | API 만       | n/a              | **Discord/TUI/Web**                |
| **Tasks/스케줄**                  | (limited)            | ✓ Tasks               | -            | -                | **✓** (cron + lane + 자동 disable) |
| **외부 OAuth (Gmail/Cal/Notion)** | (limited)            | (Plugins)             | n/a          | n/a              | ✗                                  |
| **Canvas/Artifacts**              | Artifacts            | Canvas                | -            | -                | ✗                                  |
| **WebSocket 슬로우 컨슈머 보호**  | -                    | -                     | -            | -                | **✓** (FinClaw 차별화)             |
| **금융 특화 안전 정책**           | n/a                  | n/a                   | n/a          | n/a              | **✓** (FinClaw 차별화)             |
| **거래 도메인 영속**              | n/a                  | n/a                   | n/a          | n/a              | **✓** (FinClaw 차별화)             |
| **trace ID / span tree**          | (Langsmith 식)       | (limited)             | ✓            | (limited)        | △ (`agent_runs` 1행 + EventBus)    |

**해석:** "현대 비서급 일반 어시스턴트" 의 보편 표준 (MCP, vision, file, citation) 이 부족하지만 **금융 도메인 특화 축에서는 일반 비서를 능가**. "헤르메스 (general-purpose AI assistant)" 보다 "Bloomberg Terminal × Cursor (전문 도메인 + 안전한 자동화)" 형태에 가깝다.

---

## 다음 단계 로드맵 (3-6 개월)

### Phase 29 — Critical 5건 해소 (1-2 개월)

| 작업                                                                                                    | 우선순위 | 추정                                    |
| ------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------- |
| C-1: `providers/openai.ts` 추가, `ProviderId` union 확장, `BUILT_IN_MODELS` 카탈로그 확장, ENV 매핑     | P0       | 2주                                     |
| C-2: `formatBackgroundSection` 에 memoryId 인용 + `[mem:abc123]` 형식 + system prompt 에 인용 규칙 명시 | P0       | 1주                                     |
| C-3: `embeddings/registry` 에 dimension guard + provider 전환 시 reindex 강제 + 마이그레이션 스크립트   | P0       | 1주                                     |
| C-4-1: MCP 클라이언트 (`@modelcontextprotocol/sdk` 통합) — plugin loader 에 MCP transport 추가          | P0       | 2-3주                                   |
| C-4-2: plugin loader 를 `main.ts` 에 배선 — 부트 시 외부 plugin 디렉터리 스캔                           | P1       | 3일                                     |
| C-5: gateway 운영성 모듈 4종 `main.ts` 배선 (rate-limit, access-log, hot-reload, auth-rate-limit)       | P0       | 3일                                     |
| **Phase 29 종료 후 예상 점수**                                                                          |          | **3.7-3.8 / 5** (Production-grade 진입) |

### Phase 30 — 멀티 모달 + 관찰성 (2-3 개월)

- Vision / file 첨부: `ContentBlock.image` 추가, Discord/Web 첨부 파이프라인, 이미지 OCR 도구 (의도적 vs 결손 결정 후)
- structured output 강제: 분석 도구에 `tool_use` 강제 호출 + JSON schema 출력 검증
- OpenTelemetry trace ID 도입 — `agent_runs` row 에 trace_id, span tree → Langfuse 또는 자체 web view
- OpenAI-호환 endpoint stub 완성 (외부 클라이언트 통합 가능)

### Phase 31 — 메모리 진화 + UX 풍부도 (3 개월)

- 메모리 자동 추출 옵션 (사용자 toggle, ChatGPT Memory 식)
- 메모리 편집 UI (settings-view 확장, edit 모달)
- Letta 식 archival 자동 승격 (대화 요약 → archival memory)
- Discord `/ask` 슬래시 정상 동작
- Web Canvas/Artifacts 영역 (마크다운 협업 산출물)

### 의도적 비대상 (감사 가중치 낮음)

- 직접 학습 (RLHF / fine-tuning) — 사용자 요청에 따라 평가 제외
- 멀티 테넌시 / OAuth / RBAC — 1인 사용자 한정
- 음성 / mobile / Computer use — 도메인 (개인 금융) 적합도 낮음

---

## 부록: 4개 세부 보고서

| 영역                 | 점수     | 보고서                                         |
| -------------------- | -------- | ---------------------------------------------- |
| Architecture         | 3.2 / 5  | [architecture.md](architecture.md)             |
| Runtime & Tools      | 3.43 / 5 | [runtime-tools.md](runtime-tools.md)           |
| Memory & Knowledge   | 3.43 / 5 | [memory-knowledge.md](memory-knowledge.md)     |
| Interface & Channels | 3.14 / 5 | [interface-channels.md](interface-channels.md) |

---

## 감사 메타데이터

- 감사 팀: `architecture-auditor`, `runtime-tools-auditor`, `memory-knowledge-auditor`, `interface-channels-auditor` (모두 opus 모델, general-purpose 베이스)
- Lead synthesizer: 메인 (오케스트레이터 직접 수행)
- 룰릭: `/.claude/skills/finclaw-maturity-audit/references/rubric.md`
- 실행 시간: ~5-8분 (4 audit 병렬)
- 4 audit 모두 정상 완료, Critical 합 5건 / Important 16건 / Nice-to-have 10건+
