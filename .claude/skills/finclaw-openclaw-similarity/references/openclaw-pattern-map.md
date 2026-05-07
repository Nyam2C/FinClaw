# OpenClaw 모듈 인덱스 (4축)

`finclaw-openclaw-similarity` 스킬의 4 auditor 가 자기 축의 시작점으로 사용. OpenClaw 의 핵심 모듈/결정을 4축으로 인덱싱.

**OpenClaw 위치:** `/mnt/c/Users/박/Desktop/hi/openclaw`
**규모:** 3,300+ 파일, 256K LOC
**언어:** TypeScript (ESM, monorepo)

---

## 축 A: 아키텍처 / 패키지 / 빌드

`architecture-auditor` 의 시작점.

### A.1 패키지 구조

- `packages/*` 7+ 패키지 (types, infra, config, agent, storage, server 등)
- pnpm workspace
- project references (`tsconfig.json`)

### A.2 빌드 / 타입체크

- `tsc --build`
- `tsgo --noEmit` (타입체크)
- vitest 4-tier (unit / storage / e2e / live)

### A.3 런타임 토폴로지

- 단일 Node 프로세스
- 채널 / 게이트웨이 / 자동화 / 에이전트가 같은 이벤트 루프
- 워커/큐 분리 여부는 코드 직접 확인

### A.4 배포

- Docker 스캐폴딩
- 단일 바이너리 옵션 (`packages/server/bin/`)

### A.5 확장성

- 플러그인 시스템 `src/plugins/`, `src/plugin-sdk/`
- `extensions/` 외부 플러그인
- MCP 클라이언트/서버 (있는 경우)

---

## 축 B: 런타임 / Agent / Tool / Skill / Provider

`runtime-tools-auditor` 의 시작점.

### B.1 Agent loop

- `src/agents/` 100+ 파일
- ReAct 루프, multi-turn tool-call
- `claude-cli-runner`, `cli-backends`
- max_turns, 무한 루프 방지

### B.2 도구 시스템

- `src/tools/` 도구 카탈로그
- `bash-tools.exec`, `apply-patch`, computer-use
- JSON schema 검증, 도구 디스커버리

### B.3 프로바이더 추상화

- `src/providers/` — Anthropic, OpenAI, byteplus, chutes, cloudflare, bedrock, huggingface, minimax 등 멀티 프로바이더
- streaming, structured output, tool_use, vision 통일 인터페이스

### B.4 스킬 시스템

- `src/skills/` (계산, 이미지, 검색 등)
- 동적 스킬 등록

### B.5 컨텍스트 관리

- `compaction`, `context-window-guard`
- `cache-trace`, `auth-profiles`

### B.6 관찰성

- trace/span/감사 로그
- token 회계, latency 측정

### B.7 에러 회복

- 도구 실패, timeout, rate limit 재시도/백오프
- 분류 체계

---

## 축 C: Memory / Knowledge / RAG / Storage

`memory-knowledge-auditor` 의 시작점.

### C.1 영속 메모리

- `src/memory/` — working / archival / recall 3 계층 (Letta 류)
- 자기-편집 가능 메모리 여부

### C.2 메모리 검색

- `src/agents/{memory-search,compaction,context}.ts`
- 임베딩, FTS, 벡터 검색 (멀티 백엔드)

### C.3 세션 영속화

- `src/sessions/`
- 대화 기록, 도구 호출 기록

### C.4 외부 콘텐츠 이해

- `src/link-understanding/` (URL 파싱, 콘텐츠 추출)
- `src/media-understanding/` (이미지/오디오/비디오)

### C.5 스토리지 백엔드

- 단일 SQLite vs 분리 스토어
- 마이그레이션 모델

### C.6 RAG 주입

- system prompt 의 메모리 주입 위치
- top-k, citation, re-ranking 여부

---

## 축 D: Interface / Channels / Gateway / UI

`interface-channels-auditor` 의 시작점.

### D.1 채널 어댑터

- `src/channels/` — Discord, Slack, Telegram, WhatsApp, iMessage, LINE, Signal (8+ 채널)
- ChannelDock 추상화

### D.2 게이트웨이

- `src/gateway/` — JSON-RPC 2.0, WebSocket
- `src/acp/` — Agent Communication Protocol
- OpenAI 호환 엔드포인트

### D.3 자동화

- `src/cron/` — cron 파서, 스케줄 등록
- `src/canvas-host/`

### D.4 CLI / TUI / Web

- `src/cli|tui|terminal/` — 명령어 체계
- `src/web/` — 웹 대시보드
- `src/wizard/` — 셋업 마법사
- `src/pairing/` — 디바이스 페어링

### D.5 보안

- `src/security/` — 인증, 권한, 자격증명 마스킹

### D.6 플러그인

- `src/plugins/`, `src/plugin-sdk/`
- `extensions/` 외부 플러그인

### D.7 모바일 (FinClaw 비대상)

- `apps/{ios,android,macos}` — 평가 비대상

---

## 비교 작업 우선순위 (auditor 시작 순서)

각 auditor 는 자기 축 안에서 다음 우선순위로 OpenClaw 를 추출:

1. **존재 여부 확인** — `ls`, `find` 로 모듈/디렉토리 확인
2. **규모 측정** — `wc -l`, 파일 수, 함수 수
3. **핵심 패턴 추출** — 인터페이스 / 어댑터 / 등록 메커니즘
4. **데이터 모델** — 타입 / 스키마 / 마이그레이션
5. **FinClaw 매핑 탐색** — `packages/*` 의 대응 모듈
6. **라벨 부착 + 정당성 평가**

## 비교 작업의 함정 (피할 것)

- **OpenClaw 의 모든 모듈을 매트릭스에 넣지 말 것** — FinClaw 1인 사용자 정체성에 비대상인 것 (멀티 사용자, 모바일, ML 학습) 은 `Missing (정당한 비대상)` 단일 행으로 합침
- **순서를 OpenClaw 측에서 시작할 것** — FinClaw 시작 → OpenClaw 찾기 순서면 FinClaw 의 독자 추가가 매트릭스를 채우고 OpenClaw 의 누락이 안 보임
- **추측 금지** — OpenClaw 의 모듈 의도 / 결정 사유는 OpenClaw 의 README / docs / 코드 주석에서 확인. 추측은 보고서에 "근거 부족" 명시
