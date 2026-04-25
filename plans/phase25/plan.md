# Phase 25 — 기억 & 거래 시스템 (Memory & Transactions)

## Context

Phase 23 에서 Web UI Portfolio 뷰는 `portfolio_holdings` 의 **현재 스냅샷만** 렌더하고, `agent.run` 결과는 **로그 파일에만** 남긴다. Phase 24 에서 모델 라우팅이 붙어도 **"FinClaw 가 과거를 기억하고 그 위에 판단한다"** 는 개인 금융 파트너의 핵심 가치는 빠져 있다.

현재 상태 (2026-04-24 기준 확인):

1. **거래 기록 없음** — `portfolios`, `portfolio_holdings` 테이블은 존재. 하지만 매수/매도 이력 저장소(`transactions` 등) 는 **스키마에 존재하지 않음**. "3월에 AAPL 50주를 180달러에 샀다" 를 기록할 자리가 없고, `average_cost` 만 들고 있어서 언제·얼마에·몇 번 샀는지 추적 불가.
2. **RAG 인프라 dead code** — `memories`, `memory_chunks`, `memory_chunks_vec` (1024-d 벡터), `memory_chunks_fts` (trigram FTS5), `embedding_cache`, 하이브리드 검색 함수(`searchVector`, `searchFts`, `mergeHybridResults`), 임베딩 프로바이더(`createEmbeddingProvider`) — 전부 구현됨. 그러나 `server/`, `agent/` 패키지 어디서도 호출하지 않음 (grep 결과 0건). 완전한 dead code.
3. **대화 이력 주입 범위** — `execution-adapter.ts:137,228` 에서 `priorMessages` 주입은 **같은 sessionKey 내 최근 메시지만**. 다른 세션 / 오래된 대화 / agent.run 결과는 주입 대상 밖.
4. **agent.run 감사 공백** — Phase 23 에서 로그 파일에만 기록. "지난주 크론 돌린 AAPL 분석 리포트" 를 다시 보려면 로그 파일 뒤져야 함.

본 Phase 의 목표는 **거래·기억·RAG 3축을 완성**하여 FinClaw 가:

- **쓰는 것**: 사용자가 명시한 거래·선호·철학을 DB 에 저장 (수동 입력 기반)
- **읽는 것**: 새 대화 시작 시 관련 기억·거래를 자동 로드해 system prompt 에 주입
- **기억하는 것**: agent.run 결과도 memories 로 저장되어 다음 대화에서 참조 가능

이 3축이 동작하게 만드는 것이다.

**사용자 결정 사항** (2026-04-24 Q&A):

- **거래 기록·기억 시스템은 Phase 23 에서 분리** (옵션 3 선택) — Phase 23 은 배선만, Phase 25 가 이 의제 전담.
- **포트폴리오 편집은 "거래 추가" 경로를 통해서만** — holdings 직접 수정 RPC 는 만들지 않음. trigger 로 자동 재계산.
- **기억 추출은 "명시적 선언" 방식** — 사용자가 "기억해줘", "내 기준은 X야" 같은 패턴을 쓸 때만 저장. LLM 기반 자동 추출은 환각 위험으로 범위 외 (Phase 26+).
- **감사 원칙 준수** — 모든 기억·거래 기록은 사용자가 조회·삭제 가능해야 함. RAG 주입 시 어떤 기억이 주입됐는지 로그에 남김.
- **읽기 전용 원칙 유지** — 거래 기록은 "사용자가 이미 한 매매 입력" 이지 "FinClaw 가 자동으로 매매 실행" 이 아님.

---

## 밀스톤 A — 거래 내역 테이블 & CRUD

### 목표

매수·매도·배당·수수료 로그를 저장하는 `transactions` 테이블 신설. `portfolio_holdings` 를 trigger 기반 자동 재계산으로 전환. RPC CRUD 제공.

### 전제

- `packages/storage/src/database.ts` SCHEMA_VERSION=3. v4 마이그레이션 필요.
- `portfolio_holdings` 는 현재 수동 직접 쓰기 구조. 이를 **"transactions 로부터 파생되는 집계"** 로 전환.
- Phase 23 의 `finance.portfolio.get` RPC 가 이미 배선됨 — 응답 구조 확장으로 호환.

### 작업

**파일**:

- `packages/storage/src/database.ts` (수정, ~80 LOC — v4 마이그레이션)
- `packages/storage/src/transactions.ts` (신설, ~120 LOC — CRUD + trigger)
- `packages/storage/src/index.ts` (수정, re-export)
- `packages/server/src/gateway/rpc/methods/finance.ts` (수정, ~150 LOC — transaction.\* RPC 추가)
- `packages/types/src/finance.ts` (수정, ~40 LOC — Transaction 타입)
- `packages/types/src/gateway.ts` (수정, ~20 LOC — RPC 스키마)

**스키마 v4 추가**:

```sql
CREATE TABLE transactions (
  id            TEXT PRIMARY KEY,
  portfolio_id  TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('buy', 'sell', 'dividend', 'fee', 'split')),
  quantity      REAL NOT NULL,
  price         REAL,               -- buy/sell 필수, dividend/fee 선택
  fee           REAL DEFAULT 0,
  currency      TEXT NOT NULL,
  executed_at   INTEGER NOT NULL,   -- 사용자 입력 시각 (거래 발생일)
  source        TEXT NOT NULL CHECK (source IN ('manual', 'import')),
  note          TEXT,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
);

CREATE INDEX idx_transactions_portfolio ON transactions(portfolio_id, executed_at DESC);
CREATE INDEX idx_transactions_symbol ON transactions(portfolio_id, symbol, executed_at DESC);
```

**Holdings 재계산 trigger**:

```sql
CREATE TRIGGER recalc_holdings_after_txn
AFTER INSERT OR UPDATE OR DELETE ON transactions
FOR EACH ROW
BEGIN
  -- (portfolio_id, symbol) 별로 transactions 집계
  -- quantity = sum(buy) - sum(sell) + split adjustments
  -- average_cost = weighted avg of buy prices
  -- UPSERT into portfolio_holdings
END;
```

(SQLite trigger 로직은 구현 시 세분화. 혹시 너무 복잡하면 **트리거 대신 애플리케이션 레벨 재계산** 함수로 대체 — `recomputeHoldings(portfolioId)` 를 transaction CRUD 후 동기 호출.)

**RPC 추가**:

| 메서드                       | 파라미터                                                                              | 응답                                          |
| ---------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------- |
| `finance.transaction.add`    | `{portfolioId?, symbol, action, quantity, price?, fee?, currency, executedAt, note?}` | `{transactionId, createdAt, updatedHoldings}` |
| `finance.transaction.list`   | `{portfolioId?, symbol?, from?, to?, limit?}`                                         | `{transactions: [...]}`                       |
| `finance.transaction.update` | `{transactionId, ...부분 필드}`                                                       | `{updatedHoldings}`                           |
| `finance.transaction.delete` | `{transactionId}`                                                                     | `{deleted: true, updatedHoldings}`            |

**finance.portfolio.get 응답 확장** (Phase 23 호환):

```json
{
  "holdings": [...],
  "summary": {...},
  "recentTransactions": [...]  // 최근 10건, 신규 필드
}
```

**WebSocket notification 발신** (phase23 review.md line 104 후속):

`finance.transaction.{add,update,delete}` RPC 성공 시 `broadcaster.broadcastToChannel('portfolio.changed', ...)` 로 알림 송출. 페이로드는 변경된 portfolioId + updatedHoldings 요약. Web UI 가 자동 갱신할 수 있게 함 (밀스톤 E 에서 구독).

```ts
// finance.transaction.add 핸들러 끝부분 예시
broadcaster.broadcastToChannel('portfolio.changed', {
  portfolioId,
  updatedAt: Date.now(),
  reason: 'transaction.add',
  transactionId,
});
```

### 검증

- `finance.transaction.add {symbol: 'AAPL', action: 'buy', quantity: 10, price: 180, currency: 'USD', executedAt: 1710000000000}` → holdings 에 AAPL 10주 / avg 180 생성
- 같은 AAPL 에 `buy 5주 @ 200` 추가 → avg 계산: (10*180 + 5*200) / 15 = 186.67
- `sell 3주 @ 220` → quantity=12, avg 유지(평가손익은 별도 계산)
- `delete` 시 holdings 재계산
- sell > 현재 보유 수량 → 경고 (에러는 아님, short 가능성 고려)
- 기간 필터 `from`/`to` 동작
- **마이그레이션**: 기존 `portfolio_holdings` 레코드가 있으면 source='manual', action='buy' 로 synthetic transaction 생성 (1건씩)
- `transaction.add` 호출 시 WebSocket 으로 `portfolio.changed` notification 도달 확인 (브라우저 dev tools 또는 별도 WS 클라이언트)

---

## 밀스톤 B — 기억 저장 파이프라인

### 목표

사용자 발화 중 "기억해야 할" 내용을 `memories` 테이블에 저장 + 임베딩 생성.

### 전제

- `packages/storage/src/memories.ts` 에 `addMemory`, `addMemoryWithEmbedding` 이미 존재.
- `memory_chunks_vec` (1024-d), `memory_chunks_fts` 인덱스 동작 중.
- `createEmbeddingProvider` 가 anthropic/openai 지원.
- **추출 방식**: 명시적 선언만 (사용자 결정).

### 작업

**파일**:

- `packages/server/src/auto-reply/stages/memory-capture.ts` (신설, ~120 LOC)
- `packages/server/src/auto-reply/pipeline.ts` (수정, ~20 LOC — 스테이지 등록)
- `packages/server/src/auto-reply/pipeline-context.ts` (수정, ~15 LOC — memory service 주입)
- `packages/types/src/storage.ts` (수정, ~10 LOC — MemoryType 확장)

**명시적 선언 패턴** (정규식 + 접두어 매칭):

```
/^기억해[:\s]\s*(.+)/i          → type: 'fact'
/내 (투자 )?(기준|원칙|철학)[은는]\s*(.+)/i  → type: 'preference'
/^선호[:\s]\s*(.+)/i             → type: 'preference'
/^메모[:\s]\s*(.+)/i             → type: 'fact'
!finclaw remember <내용>         → type: 'fact' (명령어, 파싱 명확)
```

사용자가 위 패턴을 쓰지 **않는 한** 자동 저장 안 함. 환각 위험 회피.

**저장 스테이지 동작**:

1. auto-reply 파이프라인에서 사용자 발화 수신
2. MemoryCaptureStage 가 패턴 매칭
3. 매칭 시 `addMemoryWithEmbedding({content, type, sessionKey, hash})`
4. 중복 방지: 동일 hash 가 이미 존재하면 skip + "이미 기억 중" 로그
5. 저장 완료 후 DeliverStage 응답에 "기억했습니다 (#memId)" 꼬리표 부착

**기억 종류** (memories.type):

- `preference` — 사용자 투자 선호 (장기/단기, 리스크 취향 등)
- `fact` — 일반 사실 (주식 계좌 원화/달러 비중 등)
- `financial` — 과거 분석 결과 (agent.run 출력, 밀스톤 D)
- `summary` — 대화 요약 (자동 추출, 범위 외)

### 검증

- "!finclaw remember 나는 분기별 리밸런싱 한다" → memories 에 insert, 임베딩 생성, memory_chunks_vec/fts 에 인덱싱
- "내 투자 원칙은 배당주 중심" → type='preference' 로 저장
- 같은 문장 재입력 → "이미 기억 중" 메시지, 중복 저장 X
- 임베딩 프로바이더 장애 시 → 저장은 성공 (임베딩만 실패), 경고 로그 + 재시도 큐 (stretch)

---

## 밀스톤 C — RAG 주입 파이프라인

### 목표

사용자 발화 시작 시 관련 기억·거래를 자동 검색해 system prompt 에 주입.

### 전제

- 밀스톤 A/B 완료되어 memories·transactions 에 데이터 존재.
- `mergeHybridResults` 가 벡터+FTS top-K 반환 가능.
- `buildSystemPrompt` 에 `buildFinanceContextSection` 존재 (Phase 22) — 여기에 "사용자 배경지식" 서브섹션 추가.

### 작업

**파일**:

- `packages/server/src/auto-reply/stages/memory-retrieval.ts` (신설, ~150 LOC)
- `packages/server/src/auto-reply/pipeline.ts` (수정, ~15 LOC)
- `packages/agent/src/prompts/finance-context.ts` 또는 상응 파일 (수정, ~50 LOC)

**주입 로직**:

1. 사용자 발화 수신 → 발화 텍스트를 임베딩
2. `mergeHybridResults({vectorQuery, ftsQuery, topK: 5, types: ['preference','fact','financial']})`
3. 필터링:
   - **유사도 임계값** 0.65 (이하 무시) — 무관한 질문에 아무 기억 주입 방지
   - **신선도 가중치** `score *= exp(-daysOld / 90)` — 3개월 지나면 가중치 37%
   - 상한 3개 (프롬프트 크기 제어)
4. 거래 이력도 동시 조회 (밀스톤 A):
   - 발화에 심볼(AAPL 등) 포함 시 해당 심볼 최근 3건 거래 로드
5. system prompt 에 섹션 주입:

```
## 사용자 배경지식 (자동 주입)
- [preference] 나는 분기별 리밸런싱 한다 (2025-12-02 저장)
- [financial] 2026-03 AAPL 분석 요지: 주가 상승 여력 있으나 고평가 우려

## 최근 거래 (AAPL)
- 2026-03-15: 매수 10주 @ $180
- 2026-03-20: 매수 5주 @ $200
```

6. 감사 로그: `{event: 'memory.injected', ids: [...], userQuery: '...', scores: [...]}`

### 검증

- "내 투자 철학 뭐였지?" → preference 타입 기억 검색되어 응답에 반영
- "AAPL 얘기해줘" → 최근 AAPL 거래 주입되어 응답에 포함
- "오늘 날씨" (무관) → 임계값 미달로 주입 0건, 로그 `injected: 0`
- 3개월 전 기억 vs 어제 기억 동시 매칭 → 어제 것이 우선
- 주입 기억 로그로부터 "왜 이 답이 나왔나" 추적 가능

---

## 밀스톤 D — agent.run 결과 저장 & RAG 통합

### 목표

Phase 23 의 `agent.run` 을 감사+RAG 대상으로 확장. 결과를 DB 저장, memories 연결, 다음 대화에서 검색 가능.

### 전제

- Phase 23 에서 agent.run 은 로그 파일에만 기록 (DB 저장 없음).
- 밀스톤 A/B/C 완료되어 memories/RAG 동작.

### 작업

**파일**:

- `packages/storage/src/database.ts` (수정, v4 에 agent_runs 테이블 포함)
- `packages/storage/src/agent-runs.ts` (신설, ~80 LOC)
- `packages/server/src/gateway/rpc/methods/agent.ts` (수정, ~40 LOC — 저장 훅)
- `packages/server/src/gateway/rpc/methods/agent-runs.ts` (신설, ~60 LOC — 조회 RPC)

**스키마**:

```sql
CREATE TABLE agent_runs (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  output          TEXT NOT NULL,
  tool_calls_json TEXT,               -- JSON array
  tokens_input    INTEGER,
  tokens_output   INTEGER,
  duration_ms     INTEGER,
  model_used      TEXT,               -- Phase 24 routing 결과
  role            TEXT,               -- Phase 24 role
  memory_id       TEXT,               -- 저장된 memory 링크 (null 가능)
  error           TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_agent_runs_created ON agent_runs(created_at DESC);
CREATE INDEX idx_agent_runs_agent ON agent_runs(agent_id, created_at DESC);
```

**agent.run 실행 후 훅**:

1. Runner 실행 종료 → `agent_runs` insert
2. output 길이 > 100 자 & 오류 없으면 `memories` 에 type='financial' 로 저장 + 임베딩
3. `agent_runs.memory_id` 에 링크 기록
4. 실패 시 memory 저장은 skip, agent_runs 는 error 필드에 기록

**신규 RPC** (밀스톤 E 에서 UI 에 쓰임):

- `agent.runs.list {agentId?, from?, to?, limit?}` → 실행 이력
- `agent.runs.get {runId}` → 전체 내용 (prompt + output + tool_calls)

### 검증

- `agent.run {prompt: "AAPL 분석"}` → agent_runs 에 레코드, memory_id 링크됨
- memories 검색에서 "AAPL 분석" 관련 질의 시 해당 출력이 top 결과로 나옴
- `agent.runs.list` → 최근 실행 목록
- 오류 시 agent_runs.error 에 기록, memory 는 저장 안 함

---

## 밀스톤 E — Web UI 확장 (거래 이력 + 기억 관리)

### 목표

Phase 23 에서 만든 뷰를 확장해 거래·기억·에이전트 실행 이력 조회·관리.

### 전제

- Phase 23 에서 Market/Portfolio/Alerts 뷰 배선됨. Settings 는 placeholder.
- Phase 24 에서 Chat 뷰에 modelHint 버튼 추가됨 (Stretch).

### 작업

**파일**:

- `packages/web/src/views/portfolio-view.ts` (수정, ~100 LOC — 거래 이력 탭 추가)
- `packages/web/src/views/settings-view.ts` (재작성, ~150 LOC — 기억 목록 + 에이전트 실행 이력)
- `packages/web/src/views/transaction-form.ts` (신설, ~120 LOC)
- `packages/web/src/app-gateway.ts` (수정, ~30 LOC — 신규 RPC 래퍼)

**Portfolio 뷰 확장**:

- 탭 2개: "보유 종목" (기존) / "거래 이력" (신규)
- 거래 이력: `finance.transaction.list` 호출, 테이블 렌더 (날짜 / 심볼 / 액션 / 수량 / 단가 / 금액)
- "거래 추가" 버튼 → 폼 모달 → `finance.transaction.add`
- 각 거래 행에 삭제 버튼 (`finance.transaction.delete`)
- **자동 갱신** (phase23 review.md line 104 후속): 밀스톤 A 에서 송출하는 `portfolio.changed` notification 을 `gateway.subscribe('portfolio.changed', ...)` 로 구독. 다른 클라이언트(채팅, 외부 RPC) 가 거래를 추가해도 본 뷰가 즉시 재로드. 현재 Phase 23 의 portfolio-view 는 수동 새로고침 버튼만 있어 channel 간 변경이 반영 안 됨.

**Settings 뷰**:

- 섹션 1: "내 기억" — `memory.list` 로 목록, type 필터 (preference/fact/financial), 개별 삭제 (`memory.delete`)
- 섹션 2: "에이전트 실행 이력" — `agent.runs.list`, 클릭 시 상세 (`agent.runs.get`)
- 섹션 3: "라우팅 통계" (Phase 24 연동) — 최근 1시간 모델 분포

**신규 RPC** (밀스톤 B 와 함께 추가):

- `memory.list {type?, limit?}` → 기억 목록
- `memory.delete {memoryId}` → 삭제 (DB + 벡터 인덱스 동시 제거)
- `memory.search {query, limit?}` → 테스트용 수동 검색

### 검증

- Portfolio 뷰에서 거래 추가 → 테이블에 즉시 반영, Holdings 탭 수치 재계산
- **자동 갱신**: 다른 터미널에서 `curl ... finance.transaction.add` 호출 → 열려있던 Web Portfolio 뷰가 수동 새로고침 없이 갱신
- Settings 기억 목록 → 밀스톤 B 에서 저장된 기억들 표시
- 기억 삭제 → DB + 벡터 인덱스 동시 삭제 확인 (memory.search 에서 안 나옴)
- 에이전트 실행 이력 → Phase 23 의 agent.run 호출 모두 기록되어 표시

---

## 완료 조건 (Phase 25 Done When)

- 밀스톤 A/B/C/D/E 전부 완료.
- 스키마 v4 마이그레이션 무결성 검증 (v3 → v4 업그레이드 테스트).
- `pnpm test` 전체 통과 (memories, transactions, agent_runs 단위 테스트 포함).
- 전체 시나리오 수동 검증:
  1. `finance.transaction.add` 로 거래 입력 → Portfolio 뷰 반영
  2. `!finclaw remember 나는 배당주 선호` → memories 저장
  3. 이후 대화에서 "내 선호가 뭐였지?" → 저장된 preference 주입 확인
  4. `agent.run {prompt: 'AAPL 분석'}` 실행 → 결과 저장
  5. 다음 대화에서 "저번 AAPL 분석 요약해줘" → agent_runs 의 output 이 RAG 로 주입됨
  6. Settings 에서 해당 기억 삭제 → 이후 검색 결과에서 제외
- `tsgo --noEmit`, `pnpm lint` 통과.
- 감사 로그: 주입된 기억 id 들이 로그에서 추적 가능.

---

## 범위 외 (Phase 26 이후)

- **자동 기억 추출**: LLM 이 대화 보며 "기억할 만한 것" 자동 판정. 환각·개인정보 위험 크므로 별도 설계 필요.
- **거래 자동 수집**: 증권사 API 연동 (예: 한국투자증권 OpenAPI). 법·보안 검토 필요.
- **다중 포트폴리오**: 현재는 default 1개 전제. 계정별/전략별 분리.
- **포트폴리오 성과 분석**: TWR/MWR, 벤치마크 대비 수익률. Phase 27+.
- **기억 클러스터링**: 유사 기억 자동 병합.
- **기억 export / import**: 다른 환경으로 이관.
- **사용자 승인형 기억**: LLM 이 "이거 기억할까요?" 제안 → 사용자 승인 후 저장 (자동 추출의 보수적 버전).

---

## 오픈 질문 (Phase 25 진행 중 확정)

1. **Holdings 재계산 방식** — SQLite trigger vs 애플리케이션 레벨 함수. trigger 는 SQL 복잡 (average_cost weighted avg), 함수는 트랜잭션 일관성 신경. 기본 "애플리케이션 레벨 `recomputeHoldings(portfolioId)` 함수 + 거래 CRUD 내부에서 동기 호출" 제안.
2. **기억 TTL / 보존 정책** — 3개월 이상 미사용 기억 자동 archive? 아니면 영구 보존 + 신선도 가중치로 충분? 기본 "영구 보존, 가중치로 관리" 제안.
3. **임베딩 프로바이더** — Anthropic embedding API 존재 여부 / OpenAI 사용 시 키 관리. 기본 "Voyage AI(Anthropic 추천) 또는 OpenAI text-embedding-3-small, 사용자 config 로 선택" 제안. 키 미설정 시 임베딩 스킵 (FTS 만 사용) fallback.
4. **다국어 임베딩** — 한국어 질문 ↔ 영어 기억 매칭이 중요한가? Voyage AI `voyage-multilingual-2` 같은 모델 필요. 기본 "한국어+영어 혼용이므로 multilingual 모델 필수" 제안.
5. **거래 입력 시 시세 자동 조회** — `finance.transaction.add` 호출 시 executedAt 기준 과거 시세를 `finance.quote` 로 자동 대입할지? 기본 "아니오, 사용자가 직접 price 입력. 과거 시세 조회는 API 비용·신뢰성 이슈" 제안.
6. **Portfolio 여러 개 지원** — 기본 1개 vs 복수. 기본 "1개(default), Phase 27+ 에서 확장" 제안.
7. **agent_runs 를 memories 에 이중 저장하는 것의 중복 위험** — 별도 테이블 + memories 링크 방식이 맞는지, 아예 agent_runs 없이 memories 에만? 기본 "별도 테이블 유지 — 감사용 raw 데이터와 RAG 용 chunked 데이터는 목적 다름" 제안.
