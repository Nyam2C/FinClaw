# 현대 AI 비서 성숙도 룰릭 (FinClaw 감사용)

## 사용법

각 audit 에이전트는 자신의 영역 섹션을 읽고, 0-5 점 척도로 채점한다. 이 룰릭은 **Claude.ai (claude-agent-sdk + MCP)**, **OpenAI Assistants API v2 / ChatGPT (Memory + Tasks + Canvas)**, **Letta/MemGPT** (자기 편집 가능 메모리), **Hermes 류 어시스턴트형 모델 + 오픈소스 OpenDevin/AutoGen**, **MS Copilot**, **MCP** 표준을 비교 기준으로 삼는다.

## 사용자 제약 (감사 시 가중치 조정)

- FinClaw 는 **사용자 본인 1명 전용** 의 개인 금융 파트너 — 멀티 사용자/멀티 테넌시 결손은 우선순위 낮춤
- **ML 학습 인프라(fine-tuning/RLHF/online learning) 비대상** — 해당 인프라 결손은 평가에서 제외
- **사용자 학습 동기 인정** — 1인이 현대 AI 비서 아키텍처를 학습·구현하는 것이 명시적 동기. 학습/craftsmanship 가치는 ROI 평가 시 가산. "1인 효용 대비 인프라 과잉" 판단 시 학습 가치를 반대 무게추로 고려
- **외부 공유 가능성 열려있음** — 프로덕트화는 비대상이지만 README/Docker/배포 인프라 결손은 정당한 갭으로 인정
- **감사 가능성·환각 방지·읽기 전용** 원칙 우선 — 관련 갭은 가중치 ↑

## 점수 척도 (모든 축 공통)

| 점수  | 의미                                                  |
| ----- | ----------------------------------------------------- |
| **0** | 부재. 같은 등급의 현대 비서가 모두 갖춘 기능이 전무.  |
| **1** | 흔적/플레이스홀더. stub 또는 미완성.                  |
| **2** | 기초 동작. 단일 happy path 만 작동.                   |
| **3** | **현대 AI 비서 최소 기준 충족** (MVP 등급).           |
| **4** | Production-grade. 엣지 케이스 + 관찰성 + 테스트 포함. |
| **5** | Industry-leading. 현대 비서 평균을 능가하는 차별화.   |

> 평가 시 "3점이 현대 AI 비서 최소 기준" 임을 항상 의식한다. 2점 이하는 갭, 4점 이상은 강점.

---

## 1. Architecture (architecture-auditor)

### 1.1 모듈 분리 / 단방향 의존

- **3점 기준:** types/storage/agent/skills/server/UI 가 분리되어 있고 순환 의존 없음
- **5점 기준:** Anthropic claude-agent-sdk 처럼 plugin 시스템 + 외부 패키지 published
- 비교: ChatGPT 백엔드는 모놀리식이지만 SDK 는 명확히 분리; Letta/MemGPT 는 server/agent/memory/tools 분리

### 1.2 런타임 토폴로지

- **3점:** 단일 Node 프로세스 + 채널/게이트웨이/스케줄러가 같은 이벤트 루프에서 동작
- **4점:** 무거운 작업(임베딩 재인덱스)이 백그라운드 큐로 분리
- **5점:** 워커/스케줄러/추론이 별도 프로세스, 큐 기반

### 1.3 확장성

- **3점:** 새 채널, 새 스킬, 새 모델 추가가 < 1일
- **5점:** 외부 plugin/MCP 클라이언트로 런타임 등록 가능

### 1.4 빌드/타입 안전성

- **3점:** project references, 빠른 typecheck, lint, test
- **5점:** 모노레포 캐시(turbo/nx) + remote cache + CI 매트릭스

### 1.5 배포 모델

- **3점:** 단일 Node 부트로 reproducible
- **4점:** Docker / 단일 바이너리 / systemd unit 제공
- **5점:** containerized + health/readiness probe + 무중단 hot-reload

### 비교 표

| 기능          | Claude.ai  | ChatGPT    | Letta | FinClaw 목표 |
| ------------- | ---------- | ---------- | ----- | ------------ |
| 모노레포 분리 | ✓ (closed) | ✓          | ✓     | ✓            |
| Plugin 등록   | MCP        | Custom GPT | Tool  | ?            |
| Hot-reload    | -          | -          | ✓     | ✓            |

---

## 2. Agent Runtime & Tools (runtime-tools-auditor)

### 2.1 Agent loop

- **3점:** ReAct 루프, 도구 결과 → 다음 추론, max_turns 가드
- **4점:** parallel tool calls, structured output, prompt caching
- **5점:** 자기-반성(self-reflect), 계획 수정, computer use, vision

### 2.2 도구/스킬 시스템

- **3점:** JSON schema 도구 정의 + 디스커버리
- **4점:** 동적 등록, 권한 분리, 입력 검증
- **5점:** MCP 호환, plugin 패키지로 외부 배포

### 2.3 프로바이더 추상화

- **3점:** Anthropic + 1개 이상 OpenAI/Gemini 통일 어댑터
- **5점:** 로컬 모델(llama.cpp, vLLM) + 라우팅 정책

### 2.4 스트리밍 UX

- **3점:** 토큰 단위 SSE/WebSocket, 도구 입력 부분 버퍼
- **5점:** 응답 중 사용자 인터럽트, 부분 취소

### 2.5 관찰성 (Trace/Audit)

- **3점:** agent_runs 테이블에 모델/입력/출력/도구사용/토큰/지연 기록
- **4점:** trace ID 기반 span tree, 재실행
- **5점:** Langfuse/Helicone/OpenTelemetry 표준 호환

### 2.6 프롬프트 엔지니어링

- **3점:** system prompt 모듈화, RAG 주입 위치 일관, control tokens
- **5점:** prompt caching 적용, few-shot, output schema 강제

### 2.7 에러 회복

- **3점:** 도구 실패 분류 + 재시도/백오프
- **5점:** 우회 도구 자동 선택, 부분 결과 복구

### 비교 표

| 기능                | Claude.ai | ChatGPT | OpenDevin | FinClaw 목표   |
| ------------------- | --------- | ------- | --------- | -------------- |
| Parallel tool calls | ✓         | ✓       | ✓         | ✓              |
| Vision              | ✓         | ✓       | -         | ?              |
| Computer use        | ✓         | -       | ✓         | (의도적 제외?) |
| File 업로드         | ✓         | ✓       | ✓         | ?              |
| Code interpreter    | (사이드)  | ✓       | ✓         | ?              |

---

## 3. Memory & Knowledge (memory-knowledge-auditor)

### 3.1 영속 스키마

- **3점:** SQLite + 마이그레이션 + FK + 인덱스
- **5점:** 사용자 가시 메모리 그래프 + 시계열 분리

### 3.2 메모리 캡처

- **3점:** 명시적 선언 감지("기억해", "내 원칙은")
- **4점:** 자동 추출 + 사용자 승인 + 중복 제거
- **5점:** 대화 요약 → archival memory 자동 승격 (MemGPT 식)

### 3.3 RAG 회수

- **3점:** 벡터 + FTS 하이브리드 + 임계값 + 상한
- **4점:** 신선도 가중치 + 출처 인용
- **5점:** re-ranking + 인용 가능 + 불확실성 표기

### 3.4 임베딩 파이프라인

- **3점:** 외부 API + reindex
- **4점:** mock fallback (테스트가 키 없이 통과)
- **5점:** 다중 임베딩 모델 + 차원 마이그레이션

### 3.5 에이전트 실행 이력

- **3점:** model/input/output/tool_calls/tokens/latency 저장
- **5점:** 재실행 / diff / 비교

### 3.6 거래/도메인 영속

- **3점:** transactions + portfolio_holdings 동기화
- **5점:** 회계적 무결성 + 감사 trail

### 3.7 컨텍스트 관리 (긴 대화)

- **3점:** 토큰 한계 근접 시 잘라내기
- **4점:** 요약 / sliding window
- **5점:** Letta 식 working/archival/recall 3 계층

### 비교 표

| 기능        | ChatGPT Memory | Claude.ai Projects | Letta | Mem0 | FinClaw 목표 |
| ----------- | -------------- | ------------------ | ----- | ---- | ------------ |
| 명시적 추출 | ✓              | ✓                  | ✓     | ✓    | ✓            |
| 자동 추출   | ✓              | -                  | ✓     | ✓    | ?            |
| 사용자 가시 | ✓              | -                  | ✓     | ✓    | ?            |
| 임베딩 검색 | -              | (RAG)              | ✓     | ✓    | ✓            |
| 시간 가중   | -              | -                  | ✓     | ✓    | ✓            |
| 자기 편집   | -              | -                  | ✓     | -    | ?            |

---

## 4. Interface & Channels (interface-channels-auditor)

### 4.1 채널 다양성

- **3점:** 2개 이상 채널 (예: web + 1)
- **4점:** Discord + TUI + Web 일관 UX
- **5점:** mobile/voice + push notification

### 4.2 게이트웨이 프로토콜

- **3점:** JSON-RPC + WebSocket + 인증 + rate limit
- **4점:** OpenAI 호환 엔드포인트 + access log
- **5점:** MCP 서버 노출 + REST + GraphQL

### 4.3 인증·권한

- **3점:** API key 또는 token 기반
- **4점:** 채널-사용자 매핑, RBAC
- **5점:** OAuth + scopes + audit log

### 4.4 실시간 UX

- **3점:** WebSocket broadcast + reconnect
- **5점:** 다중 디바이스 상태 동기화

### 4.5 자동화 / proactive

- **3점:** cron 스케줄러 + 등록 RPC + delivery
- **4점:** 실패 재시도 / dead letter / 이력 조회
- **5점:** 알림 채널 라우팅 + 사용자 승인 흐름

### 4.6 외부 도구 연결 (MCP / plugin)

- **3점:** plugin 인터페이스 존재
- **4점:** MCP 클라이언트로 외부 서버 연결
- **5점:** MCP 서버로 자기 노출, OAuth 외부 통합

### 4.7 UI 풍부도

- **3점:** 기본 대시보드 + 입력 폼
- **4점:** 실시간 차트 + 모달 폼 + 상세 뷰
- **5점:** Canvas/Artifacts 같은 협업 산출물 영역

### 비교 표

| 기능             | ChatGPT         | Claude.ai   | Slack/Discord 봇 표준 | FinClaw 목표    |
| ---------------- | --------------- | ----------- | --------------------- | --------------- |
| 다채널           | web/iOS/Desktop | web/Desktop | Slack/Teams           | Discord/TUI/Web |
| Tasks/스케줄     | ✓               | (limited)   | bot scheduler         | ✓               |
| Canvas/Artifacts | Canvas          | Artifacts   | -                     | ?               |
| MCP              | (예정)          | ✓           | -                     | ?               |
| 음성             | ✓               | (limited)   | -                     | (의도적 제외?)  |

---

## 5. 가로지르는 축 (synthesizer 통합)

### 5.1 Observability & Audit

- agent_runs + access_log + memory.injected 감사 + 비결정성 추적

### 5.2 Safety & Guardrails

- 입력 검증 (Zod), 도구 권한, 비밀 보호, prompt injection 방어, output 필터

### 5.3 Testability

- 4-tier (unit/storage/e2e/live), mock-only 외부 API, 마이그레이션 시뮬레이션

### 5.4 Documentation

- plans/phase\*, prompts/, README, agent/skill 정의 가독성

---

## 점수 종합 (synthesizer 작성)

총점 = (Architecture 5축 + Runtime 7축 + Memory 7축 + Interface 7축 + 가로축 4축) 평균

| 등급                   | 평균 점수 | 의미                |
| ---------------------- | --------- | ------------------- |
| Beta                   | < 2.5     | 데모 수준           |
| MVP / Production-ready | 2.5 ~ 3.5 | 현대 비서 최소 기준 |
| Production-grade       | 3.5 ~ 4.2 | 안정적 운용 가능    |
| Industry-leading       | > 4.2     | 차별화된 강점       |

---

## 갭 라벨 정의

- **Critical**: 현대 비서로서 작동에 본질적 결함 (예: 도구 실패 시 무한 루프)
- **Important**: 부재 시 사용성/신뢰성 손실 (예: 메모리 사용자 가시 UI)
- **Nice-to-have**: 차별화 요소 (예: Canvas, vision)

각 갭에는 다음 메타데이터 부착:

- 갭 설명
- 발견 audit (architecture/runtime-tools/memory-knowledge/interface-channels)
- 영향 범위 (사용자 / 운영자 / 개발자)
- 추정 작업량 (S: 1주 / M: 2-4주 / L: 1-3개월)
- 참조 코드 경로
