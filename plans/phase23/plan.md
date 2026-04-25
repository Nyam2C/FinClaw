# Phase 23 — 프로그래밍 배선 (Programmatic Wiring)

## Context

Phase 22에서 Discord → Runner → skills-finance 의 **대화형** 경로가 완성되었다. 사용자가 `!finclaw` 로 말을 걸면 Claude가 도구를 호출해 응답하고, 11개 금융 도구(Market 4 + News 3 + Alerts 4)가 Runner에 등록되어 동작한다.

그러나 **AI를 거치지 않는 직접 접근 경로**는 아직 비어 있다.

1. **RPC 메서드 stub** — `packages/server/src/gateway/rpc/methods/finance.ts` 의 5개 메서드 전부 `throw 'Not implemented'`. `agent.ts` 의 `agent.run` 도 `throw`, `agent.status`/`agent.list` 는 하드코딩 더미값.
2. **Web UI 뷰 비어있음** — `packages/web/src/views/{market,portfolio,alerts,settings}-view.ts` 전부 placeholder 문자열만 반환. 사용자가 Web UI Market 탭을 열어도 시세가 나오지 않음.
3. **Gateway ↔ skills-finance 디커플링** — `main.ts` 에서 생성한 `marketHandle.quoteService`, `newsHandle.aggregator`, alerts store/portfolio store 가 RPC 레이어로 전달되지 않음. RPC 핸들러는 context 주입 메커니즘이 없어 모듈 레벨 `registerMethod` 만 호출.

본 Phase의 목표는 **기존 스킬 로직을 RPC·Web UI 에 노출하여, AI 없이도 데이터 조회·알림 관리·포트폴리오 조회가 결정론적으로 가능한 상태**를 만드는 것. 신규 기능 개발은 없고, **기존 skills-finance 서비스를 RPC/UI 로 공개하는 배선 작업**이 전부다.

**사용자 결정 사항** (2026-04-24 Q&A):

- 3개 밀스톤 일괄 스코프 (A: finance._ RPC / B: agent._ RPC / C: Web UI 뷰)
- 모델 라우팅 (역할 프로파일 + 스킬 minModel) 은 **Phase 24 (가칭) 로 분리**
- **기억·거래 시스템** (거래 기록 테이블, `memories` RAG 배선, 장기 컨텍스트 주입) 은 **Phase 25 (가칭) 로 분리** — 현재 `memories`/`memory_chunks_vec`/`memory_chunks_fts` 인프라는 존재하나 server/agent 어디서도 호출되지 않음(dead code 상태). 거래 내역 테이블도 없음(`portfolio_holdings` 는 현재 스냅샷만). 본 Phase 23 의 `finance.portfolio.get` 은 **읽기 전용 스냅샷** 으로 한정.
- `agent.run` 동시 호출 정책: **큐잉** — 동일 agentId 에 대한 요청은 순차 처리. 새 ConcurrencyLane 을 agent 실행용으로 1개 할당.
- `finance.alert.create` 응답 정책: **즉시 평가 1회** — 생성 직후 동기로 조건 평가해서 이미 충족이면 응답에 `immediateTrigger: true` 포함 + 실제 알림 채널로 1회 발사.
- `agent.run` 감사 저장: 본 Phase 에서는 **로그 파일 only**. DB 저장/RAG 는 Phase 25.
- 3개 배선이 모두 end-to-end 동작 검증 완료되어야 Phase 종료
- 범위 외: `config.*` RPC, OpenAI 호환 엔드포인트, TUI 패널, Discord `/ask` 커맨드, `StubFinanceContextProvider` 구현, 포트폴리오 편집

---

## 밀스톤 A — finance.\* RPC 배선

### 목표

5개 finance RPC 메서드가 skills-finance 의 실제 서비스를 호출해 JSON 응답을 반환. AI/Runner 를 거치지 않는 **결정론적 경로**.

### 전제

- `main.ts:171-202` 에서 `marketHandle`, `newsHandle` 를 이미 생성한다.
- `marketHandle.quoteService` 는 `getStockPrice/Crypto/Forex` 제공.
- `newsHandle.aggregator` 는 `fetchNews({ query, symbols, limit })` 제공.
- `registerAlertTools` 는 **현재 AlertStore 를 반환하지 않는다** — monitor 만 반환. 소극적 리팩토링으로 `alertStore` 를 handle 에 포함시켜야 함.
- `PortfolioStore` 는 `packages/skills-finance/src/news/portfolio/store.ts` 에 위치. `registerNewsTools` 가 생성만 하고 외부 노출 안 함 → handle 에 추가 필요.
- RPC 레이어에 **context 주입 메커니즘 부재** — 현재 `registerMethod` 가 모듈 로드 시점에 무인자로 호출됨. 의존성을 받을 수 있도록 `registerFinanceMethods(deps)` 시그니처 변경 필요.

### 작업

**파일**:

- `packages/server/src/gateway/rpc/methods/finance.ts` (재작성, ~180 LOC)
- `packages/server/src/gateway/rpc/index.ts` (수정, 등록 함수 시그니처에 deps 허용 ~20 LOC)
- `packages/server/src/main.ts` (수정, RPC 등록 위치에서 handle 전달 ~25 LOC)
- `packages/skills-finance/src/alerts/index.ts` (수정, handle 에 `alertStore` 추가 ~10 LOC)
- `packages/skills-finance/src/news/index.ts` (수정, handle 에 `portfolioStore` 추가 ~10 LOC)
- `packages/server/src/gateway/rpc/methods/finance.test.ts` (수정, 실제 로직 테스트로 교체 ~150 LOC)

**세부 작업**:

1. **`finance.quote`** — `{symbol: string, kind?: 'stock'|'crypto'|'forex'}` → `{ symbol, price, currency, timestamp, provider, cached }`.
   - `kind` 생략 시 symbol 패턴으로 자동 판별 (대문자 3-5자=stock, BTC/ETH 등=crypto, `XXX/YYY`=forex).
   - 내부적으로 `quoteService.getStockPrice` 등 호출. 결과에 `provider` 포함(Alpha Vantage/CoinGecko).
   - `quoteService` 가 주입되지 않은 경우(키 없음) `-32010` (provider_unavailable) RPC 에러 반환.

2. **`finance.news`** — `{query?: string, symbols?: string[], limit?: number}` → `{ articles: [{title, url, source, publishedAt, summary, tickers}] }`.
   - `newsAggregator.fetchNews(params)` 위임.
   - 쿼리·심볼 둘 다 없으면 상위 헤드라인 20개 (`limit` 기본 20, 최대 50).

3. **`finance.alert.create`** — `{symbol, condition: 'price_above'|'price_below'|'change_percent'|'news_match', threshold?: number, keyword?: string, cooldownMs?: number}` → `{ alertId, createdAt, immediateTrigger: boolean }`.
   - `alertStore.create(...)` 호출. condition 타입별 파라미터 검증.
   - 기본 cooldown: `ALERT_DEFAULT_COOLDOWN_MS` (900000).
   - **생성 직후 즉시 평가 1회** — `AlertMonitor` 의 평가 함수를 동기 호출해 현재 조건 충족 여부 판정. 충족이면 `immediateTrigger: true` + 알림 채널(Discord 등) 로 즉시 1회 발사.
   - 즉시 평가 실패(API 오류 등) 시 알림 자체는 저장 유지. 응답에 `immediateTrigger: false` + 경고 로그.

4. **`finance.alert.list`** — `{symbol?: string}` → `{ alerts: [...] }`.
   - `alertStore.list({symbol})`. 비활성 상태 포함 여부는 응답에 `enabled` 플래그로 표현.

5. **`finance.portfolio.get`** — `{}` → `{ holdings: [{symbol, quantity, avgPrice, currency}], summary: {totalValue?, currency} }`.
   - `portfolioStore.getDefault()` (또는 유일 포트폴리오) 반환.
   - 빈 포트폴리오면 `{holdings: [], summary: {currency: 'USD'}}`.

**RPC 등록 흐름 변경**:

```
main.ts
  → finance handles 생성 (market/news/alerts 블록에서)
  → registerFinanceMethods({ quoteService?, newsAggregator?, alertStore?, portfolioStore? })
  → 각 handler execute() 는 closure 로 deps 캡처
  → deps 없는 메서드는 에러 -32010 반환
```

### 검증

- **단위**: `finance.test.ts` 모킹으로 5개 메서드 전부 성공·실패 경로 테스트.
- **통합**: 서버 기동 후 curl 로 JSON-RPC 직접 호출
  ```
  curl -X POST http://localhost:3000/rpc \
    -H 'Content-Type: application/json' \
    -H 'Authorization: Bearer <token>' \
    -d '{"jsonrpc":"2.0","method":"finance.quote","params":{"symbol":"AAPL"},"id":1}'
  ```
  → `{result: {symbol: "AAPL", price: 187.23, ...}}`
- **에러 케이스**: Alpha Vantage 키 제거 후 `finance.quote` → `-32010 provider_unavailable`.
- **캐시**: 같은 symbol 2회 연속 호출 시 두 번째 응답 `cached: true`.

---

## 밀스톤 B — agent.\* RPC 배선

### 목표

3개 agent RPC 메서드가 agent 레지스트리와 Runner 에 연결되어 **일회성 에이전트 실행** 경로가 동작.

### 전제

- `Runner` 는 `runnerFactory(dispatcher)` 로 세션별 생성 중. RPC 에선 요청당 1회 실행 → 기존 factory 재사용 가능.
- 서버에 **에이전트 레지스트리 개념이 명시적으로 없음**. `DEFAULT_SYSTEM_PROMPT` + 등록된 도구 세트 = 유일한 에이전트 `finclaw-partner`. Phase 23 에선 이 **단일 기본 에이전트**만 노출.
- `ProfileHealthMonitor` 에서 최근 호출·오류를 조회 가능.

### 작업

**파일**:

- `packages/server/src/gateway/rpc/methods/agent.ts` (재작성, ~140 LOC)
- `packages/server/src/main.ts` (수정, agent deps 전달 ~15 LOC)
- `packages/types/src/gateway.ts` (수정, `agent.run` 파라미터 스키마 확장 ~10 LOC)

**세부 작업**:

1. **`agent.list`** — `{}` → `{ agents: [{id: 'finclaw-partner', name, description, toolCount, systemPromptHash}] }`.
   - 하드코딩 1개. Phase 24 에서 역할별 프로파일 분리 시 다수화.

2. **`agent.status`** — `{agentId}` → `{ agentId, status: 'idle'|'busy'|'error', activeRuns, totalCalls, lastCallAt, lastError?, health: {...profileHealthMonitor snapshot} }`.
   - `ProfileHealthMonitor.getStatus(agentId)` 조회.
   - 서버 프로세스 내 카운터로 `activeRuns` 추적 (단순 Map).

3. **`agent.run`** — `{agentId, prompt: string, maxTurns?: number, timeoutMs?: number}` → `{ output: string, toolCalls: [...], tokenUsage: {input, output, cached?}, durationMs, stopReason }`.
   - Runner 인스턴스 생성 (runnerFactory 재사용).
   - 단일 턴 대화로 실행 (메시지 이력 없음, system prompt 는 DEFAULT_SYSTEM_PROMPT).
   - `maxTurns` 기본 5, 최대 20. `timeoutMs` 기본 60000, 최대 120000.
   - **동시 실행 큐잉** — `ConcurrencyLane` 을 agent 전용으로 1개 할당 (`laneId: 'agent-run'`, `maxConcurrent: 1`). 동일 agentId 에 대한 다중 요청은 순차 처리.
   - 도구 호출 내역은 `toolCalls: [{name, input, output, durationMs}]` 로 요약 (Phase 22의 감사 원칙과 일관).
   - **감사 저장** — 실행 시작/종료/오류를 구조화 로그로만 기록 (`logger.info({event: 'agent.run', ...})`). DB 저장 없음 (Phase 25).
   - **스트리밍 미지원** — stream 요청 들어오면 `-32004 use_chat_api` 에러로 `chat.*` 안내.

**파라미터 스키마** (`types/gateway.ts`):

```
agent.run: { agentId: string, prompt: string, maxTurns?: number, timeoutMs?: number }
```

### 검증

- `agent.list` → 1개 에이전트, `id: 'finclaw-partner'`.
- `agent.run {agentId: 'finclaw-partner', prompt: '지금 몇 시야?'}` → `get_current_datetime` 도구 호출 후 응답.
- `agent.run {agentId: 'finclaw-partner', prompt: 'AAPL 시세 알려줘'}` → `get_stock_price` 호출, `toolCalls` 에 내역 포함.
- 연속 호출 후 `agent.status` → `totalCalls` 증가, `lastCallAt` 갱신.
- 잘못된 agentId → `-32004 unknown_agent`.
- timeout 초과 시 실행 중단 + 명확한 에러.

---

## 밀스톤 C — Web UI 뷰 연결

### 목표

Web UI 의 Market / Portfolio / Alerts 3뷰가 placeholder 대신 실제 gateway 호출로 데이터 렌더. 사용자가 채팅 없이 UI만으로 조회 가능.

### 전제

- `createAppGateway` (packages/web/src/app-gateway.ts 등) 가 JSON-RPC 호출 기반 클라이언트 이미 제공.
- 각 뷰 파일은 현재 정적 문자열 반환 함수 하나뿐.
- Settings 뷰는 `config.*` RPC 에 의존 → Phase 23 범위 밖이므로 **placeholder 유지**.

### 작업

**파일**:

- `packages/web/src/views/market-view.ts` (재작성, ~100 LOC)
- `packages/web/src/views/portfolio-view.ts` (재작성, ~70 LOC)
- `packages/web/src/views/alerts-view.ts` (재작성, ~130 LOC)
- `packages/web/src/app-gateway.ts` 또는 상응 파일 (수정, finance/agent 메서드 래퍼 추가 ~40 LOC)

**세부 작업**:

1. **Market 뷰** — symbol 입력 + "조회" 버튼.
   - `gateway.call('finance.quote', {symbol})` → 카드 렌더 (가격, 변동률, 제공자, 갱신 시각).
   - 에러 시 사용자 친화 메시지 ("API 키 누락: 관리자에게 문의").
   - 최근 조회 5개 심볼 로컬 상태로 보관 (페이지 이동 시 유실 OK).

2. **Portfolio 뷰** — 자동 로드.
   - `gateway.call('finance.portfolio.get', {})` → 테이블 (symbol/qty/avgPrice/currency).
   - 빈 포트폴리오 상태: "포트폴리오에 종목이 없습니다" + 채팅으로 추가하라는 힌트.

3. **Alerts 뷰** — 자동 로드 + 추가 폼.
   - `gateway.call('finance.alert.list', {})` → 리스트.
   - "알림 추가" 폼: symbol + condition 드롭다운 + threshold/keyword → `gateway.call('finance.alert.create', ...)`.
   - 제거 기능은 **Phase 23 범위 밖** (remove_alert RPC 가 현재 finance.\* 에 없음. 밀스톤 A 에서 추가하지 않음. 사용자는 채팅으로 제거).

**gateway client wrapper** (선택):

```
gatewayClient.finance.quote(params)
gatewayClient.finance.news(params)
gatewayClient.finance.alert.create(params)
gatewayClient.finance.alert.list(params)
gatewayClient.finance.portfolio.get()
gatewayClient.agent.list()
gatewayClient.agent.run(params)
```

얇은 래퍼만 추가. 스트리밍은 쓰지 않음.

### 검증

- `pnpm dev` → 브라우저에서 3뷰 각각 열기.
- **Market**: `AAPL` 입력 → 카드에 실제 가격 표시. `INVALIDSYMBOL` → 에러 카드.
- **Portfolio**: 테이블 렌더 (DB 상태 반영). 빈 상태 메시지 확인.
- **Alerts**: 기존 알림 리스트 표시. 새 알림 추가 → 리스트에 즉시 반영. 페이지 새로고침 후에도 유지.
- **네트워크 탭**: 각 뷰 진입 시 `/rpc` 호출 관찰. 응답 형식이 밀스톤 A 스펙과 일치.
- **에러 UX**: 서버 중단 상태 → "연결 끊김" 배너.

---

## 완료 조건 (Phase 23 Done When)

- 밀스톤 A/B/C 각각의 검증 체크리스트 모두 통과.
- `finance.*` 5개, `agent.*` 3개 RPC 가 **stub 없이** 실제 로직 수행.
- Web UI 3뷰가 **실제 데이터** 렌더링.
- `tsgo --noEmit`, `pnpm lint`, `pnpm test` 전부 통과.
- `!finclaw status` 출력에 "RPC methods: N loaded" 같은 간단한 health 라인 추가 (stretch).
- `plans/phase23/todo.md` 작성 (작업 진행 중 체크리스트).

---

## 범위 외 (이후 Phase)

- **Phase 24 (가칭 "Model Routing")**: 모델 역할 라우팅 — `fetch / chat / analysis / summarize` + `automation` 플래그, 스킬 minModel 메타데이터, A+C 결합 라우터. 문서 미작성.
- **Phase 25 (가칭 "Memory & Transactions")**: 기억·거래 시스템 — `memories`/`memory_chunks_vec`/`memory_chunks_fts` RAG 인프라를 실제 파이프라인에 배선, 거래 내역 테이블(`transactions`) 신설, `agent.run` 결과 DB 저장 + 임베딩, 장기 컨텍스트 자동 주입. 문서 미작성.
- `config.*` RPC 실구현 (Settings 뷰 활성화 포함).
- `finance.alert.remove` RPC 추가 (Web 에서 알림 삭제 기능).
- 포트폴리오 편집 RPC (현재 쓰기 경로 없음, Phase 25 와 함께 다루는 게 자연스러움).
- OpenAI 호환 엔드포인트 (`/v1/chat/completions`) 실구현.
- TUI 패널 활성화.
- Discord `/ask` 슬래시 커맨드 → Runner 연동.
- `StubFinanceContextProvider` 를 실 DB 쿼리로 교체 (auto-reply 품질 개선).

---

## 남은 오픈 질문

(모두 2026-04-24 확정) 현재 없음. 필요 시 본 섹션에 추가.
