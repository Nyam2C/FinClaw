# Phase 37 — 감사 후속: chat auth 강등 + 싼 P1 정리 (config 스키마 · FTS 임계 · 클라 드리프트)

> 2026-05-25 전체 코드베이스 감사(`_workspace/codebase-audit/SUMMARY.md`)가 찾은 **검증된 P0/P1 중 외과적으로 닫을 수 있는 4건**. phase35 패턴(외과적·키불요·mock-only·밀스톤별 게이트) 그대로.

## 동기

감사에서 코어 구조는 건전하나 **"실 키로 안 돌려본 2차 경로"(web/tui 채팅 auth, opt-in config, FTS fallback, 클라 드리프트)에 결함이 군집**함이 드러남. 모두 typecheck-green 을 통과한 의미론적 배선 결함. 본 phase 는 이 중 결정·검증이 끝난 4건을 닫는다.

## 범위 (감사 SUMMARY 기반, 사용자 확정)

### 1. P0-1 — `chat.send`/`chat.stop` authLevel `'session'` → `'token'` 강등 (사용자 결정)

- **현상**: `chat.ts:80,137` 이 `authLevel:'session'` 인데 'session' 레벨을 부여하는 코드가 레포에 **없음**(최대 `auth/token.ts:64` 의 `'token'`). → web/tui 게이트웨이 채팅 전송 영구 UNAUTHORIZED. 테스트(`chat.test.ts:104,113,144`)가 `level:'session'` 수동 주입으로 은폐.
- **결정 (사용자)**: 미구현 세션 인증 의도가 아니라 **`'token'` 으로 강등**해 해결. chat.start/chat.history 가 이미 `'token'`(`:51,152`)이라 chat.\* 전부 일관.
- **수정**: `chat.ts:80,137` `'session'`→`'token'`. `chat.test.ts` 의 "requires session level" 테스트(`:144`)를 "requires token level / rejects below token"(예: `level:'api_key'` 거부, `'token'` 통과)로 갱신, fixture 의 `level:'session'`(`:104,113`)을 `'token'` 로.
- **대상**: `packages/server/src/gateway/rpc/methods/chat.ts`, `chat.test.ts`

### 2. P1-3 — config Zod strict 스키마 갭 (opt-in 부팅 크래시)

- **현상**: `FinClawConfig` 타입엔 `rag?`(`types/config.ts:18`)·`accessLog?`(`:16`)·gateway `auth?:{token?}`(`:83`)가 있고 런타임 소비되나(`runtime.ts:174`, `main.ts:353`, gateway auth), Zod 측엔 루트 `FinClawConfigSchema`(strictObject)에 `rag`/`accessLog` 없고 `GatewaySchema`(`zod-schema.ts:5`)에 `auth` 없음. → 사용자가 이 옵션을 config 에 쓰면 `validateConfigStrict` 가 `Unrecognized key` throw → **기동 불가**.
- **수정**: `zod-schema.ts` 에 `RagConfig`/`AccessLogConfig` 형태(`types/config.ts` 미러)로 `rag`/`accessLog` 루트 키 추가 + `GatewaySchema` 에 `auth` 추가. 타입과 1:1.
- **대상**: `packages/config/src/zod-schema.ts` (+ 필요시 `defaults.ts` 확인)

### 3. P1-4 — FTS-only RAG fallback 임계값 스케일 불일치 (조용한 회상 누락)

- **현상**: `SIMILARITY_THRESHOLD=0.65`(코사인 가정) 컷이 mode 무관하게 BM25 파생 점수에도 적용(`memory-retrieval.ts:291`). 임베딩 키 없/장애 시 다중어 질의(예 "분기별 리밸런싱")가 0.54/0.60 → **0건 주입**(조용히). 단일어는 1.0 통과.
- **수정**: 임계를 **mode 별로 분리** — vector(코사인) 경로는 0.65 유지, FTS/BM25 파생 경로는 적정 임계(또는 FTS 후보엔 코사인 컷 미적용, dedup·상한·신선도 정렬만). 정확한 분기는 todo 단계에서 score 산출 코드(`bm25RankToScore` 등) 실측 후 확정.
- **대상**: `packages/server/src/auto-reply/stages/memory-retrieval.ts`

### 4. P1-5 — 클라이언트 드리프트 4건 (서버 계약은 정상, 클라가 어긋남)

서버 계약을 바꾸지 않고 **클라이언트를 서버에 맞춘다** (서버 shape/method 불변).

- **F5** web 이 `chat.start` 생략하고 random sessionId 로 `chat.send`(`web/app.ts:157`) → session not found. **수정**: web 이 `chat.send` 전 `chat.start` 호출해 서버 발급 sessionId 사용.
- **F6** CLI `agent status <name>` 가 `{name}` 전송, 서버 strict `{agentId}` → INVALID_PARAMS. **수정**: CLI 가 `{agentId: name}` 전송.
- **F7** CLI `alert list` 가 bare array 기대, 서버 `{alerts,total}` → 항상 "No alerts". **수정**: CLI 가 `result.alerts` 읽기.
- **F8** CLI `news` 가 bare array 기대, 서버 `{articles,total}` → 항상 "No news". **수정**: CLI 가 `result.articles` 읽기.
- **대상**: `packages/web/src/app.ts`, `packages/server/src/cli/commands/{agent,alert,news}.ts`

## 밀스톤 (각 = 1 커밋, 외과적, 밀스톤별 검증)

- **A. chat auth 강등** (항목 1) — `chat.ts` 2줄 + `chat.test.ts` 갱신. 격리·소.
- **B. config 스키마 갭** (항목 2) — `zod-schema.ts` rag/accessLog/auth 추가. 회귀 테스트: `validateConfigStrict({rag:{rerank:{enabled:true}}, accessLog:{retentionDays:7}})` 통과.
- **C. FTS 임계 분리** (항목 3) — `memory-retrieval.ts`. 회귀 테스트: 임베딩 미주입 + 다중어 질의가 0건 아닌 회상.
- **D. 클라 드리프트** (항목 4) — web/app.ts + cli 3개. 서버 불변.

각 밀스톤 끝: `pnpm typecheck` + `pnpm build` + `pnpm test --run` + `pnpm test:storage` + `pnpm lint`.

## 의도적 비대상

- **P0-2 (CLI 미등록 메서드: `system.shutdown`/`finance.alert.remove`/`channel.*`)** — 메서드 신규 등록 vs CLI 명령 제거 **결정이 선행 필요**(scope 확장). 별도 처리. 본 phase 는 "method 존재하나 클라가 잘못 씀"(드리프트)만.
- **P1-6 analysis tier 발산 (sonnet vs opus)** — 라우팅 정책 설계 결정 필요. 비대상.
- **P2 dead code 정리** (execution:_/agent:run:_ 이벤트, always-NULL 컬럼, DefaultPipelineObserver, README 39→45 등) — 무해, 별도.
- **서버 RPC 계약 변경** — 항목 4 는 클라만 고침. 서버 shape 불변.

## 완료 조건

- [ ] `chat.send`/`chat.stop` 이 `'token'` 으로 동작 (token-level auth 로 통과하는 테스트, session 강제 없음).
- [ ] `validateConfigStrict` 가 `rag`/`accessLog`/`gateway.auth` 포함 config 를 throw 없이 통과 (회귀 테스트).
- [ ] 임베딩 미주입(FTS-only) + 다중어 질의가 RAG 회상 0건이 아님 (회귀 테스트).
- [ ] web 채팅이 chat.start→chat.send 순서, CLI agent status/alert list/news 가 올바른 shape/param.
- [ ] `pnpm typecheck` + `pnpm build` + `pnpm test --run` + `pnpm test:storage` + `pnpm lint` 전부 green.

## 추정

A(0.5일) + B(0.5일) + C(0.5-1일) + D(0.5일) = 2-2.5일. 전부 외과적·국소.

## 전제 / 리스크

- phase36 머지 후(#71) 진입. base = 현재 main HEAD.
- **항목 4(클라 드리프트)는 web/tui/cli 자동 테스트 커버리지가 얕을 수 있음** → 가능한 곳에 회귀 테스트 추가, 어려우면 수동 검증 권장(실 부팅 smoke 와 합류).
- mock-only 스탠스 유지.
- P0-1 강등으로 web/tui 채팅이 "auth 통과"하게 되나, 실제 동작은 항목 4(F5) + 실 부팅 검증이 있어야 end-to-end 확정.
