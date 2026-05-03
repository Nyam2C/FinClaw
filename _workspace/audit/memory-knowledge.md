# Memory & Knowledge Audit

본 감사는 `references/rubric.md` 의 "3. Memory & Knowledge" 7축을 기준으로
FinClaw 의 영속 기억·지식 시스템을 ChatGPT Memory, Claude.ai Projects,
Letta/MemGPT, Mem0, LlamaIndex+LangChain RAG 와 비교 평가한다.

사용자 제약 가중치:

- 1인 전용 → multi-tenant 결손 무시.
- 직접 학습 비대상 → fine-tuning 결손 무시.
- 감사 가능성·환각 방지·읽기 전용 가중치 ↑ → RAG citation, audit trail,
  memory 출처 추적 가중치 +.

---

## 점수 카드

| #   | 축                | 점수        | 한 줄 평                                                                                                                                                                              |
| --- | ----------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | 영속 스키마       | **4 / 5**   | SQLite + WAL + sqlite-vec + FTS5 + v6 마이그레이션 + FK CASCADE + 인덱스 모두 갖춤. memory→agent_runs 링크와 schedule_id 추가까지 진화. 시계열 분리/메모리 그래프는 부재.             |
| 3.2 | 메모리 캡처       | **3 / 5**   | 정규식 5종 명시적 선언 + sha256 dedup + FTS-only fallback. 사용자 결정으로 LLM 자동 추출은 의도적 제외 — MVP 충족. archival 자동 승격은 부재.                                         |
| 3.3 | RAG 회수          | **3.5 / 5** | 벡터+FTS 하이브리드 + 임계값(0.65) + 신선도(exp(-d/90)) + 상한(3) + 감사 로그 + 거래 동시 주입. system prompt 에 마크다운 섹션으로 인라인 주입. **citation/re-ranking 부재**.         |
| 3.4 | 임베딩 파이프라인 | **3 / 5**   | Voyage(1024D) primary + OpenAI(1536D, 호환 안 됨) + sha256 cache + atomicReindex. **mock fallback 없음** — 키 없이 hybrid 테스트 불가, FTS-only 로 회피. 차원 마이그레이션 도구 부재. |
| 3.5 | agent_runs        | **3 / 5**   | model/prompt/output/toolCalls/tokens/duration/role/memoryId/error 저장 + RPC list/get + UI. 재실행/diff/span tree 부재.                                                               |
| 3.6 | 거래/도메인       | **3.5 / 5** | transactions v4 + recomputeHoldings (application-level, BEGIN IMMEDIATE) + synthetic migration + WS broadcast. **소수점 정밀도(REAL), 음수 holdings 미허용, 회계 무결성 검증 부재**.  |
| 3.7 | 컨텍스트 관리     | **4 / 5**   | window-guard 4단계 상태 + 3단계 폴백 압축(full→partial→truncate) + system prompt 보존 + reserveTokens. 긴 대화에서 안정. **archival/working 분리 부재**.                              |

**평균: 3.43 / 5 (Production-grade 진입; 4.2 industry-leading 미달)**

가중치 (감사 가능성·환각 방지·읽기 전용 ↑) 적용 시:

- 3.3 RAG citation 부재가 **Critical** (출처 추적 약화)
- 3.4 mock fallback 부재가 **Important** (테스트가 외부 키에 의존하는 위험)
- 3.6 회계 무결성 부재가 **Important** (사용자 자산 데이터 정합성)

---

## 메모리 라이프사이클 다이어그램

```
   사용자 발화
       │
       ▼
[normalize] ────────────────────────────────────────────────┐
       │                                                    │
       ▼                                                    │
[memory-capture] ── 정규식 5종 매치? ──┐                    │
       │                YES            │                    │
       ▼                ▼              │                    │
       │       sha256(content) ─ dup? ─┴─ skip + log       │
       │                NO                                  │
       │                ▼                                   │
       │       addMemoryWithEmbedding                       │
       │         ├─ INSERT memories                         │
       │         ├─ chunkMarkdown(maxTokens=512, overlap=64)│
       │         ├─ INSERT memory_chunks                    │
       │         ├─ INSERT memory_chunks_fts (trigram)      │
       │         ├─ embedBatchWithCache                     │
       │         │    ├─ getCachedEmbedding (sha256 hit)    │
       │         │    └─ provider.embedBatch (Voyage 1024D) │
       │         └─ INSERT memory_chunks_vec                │
       │                                                    │
       ▼                                                    │
[ack] (typing indicator)                                    │
       │                                                    │
       ▼                                                    │
[context] (enrichContext → portfolio/alerts/news/market)    │
       │                                                    │
       ▼                                                    │
[memory-retrieval] ◀─────── userQuery ──────────────────────┘
       │
       ├─ embeddingProvider 있음? ─ YES → searchVector + searchFts (Promise.all)
       │                              └─ mergeHybridResults (vec=0.7, fts=0.3)
       │  NO/throw → fts-only fallback
       │
       ├─ memoryId 별 dedup (best chunk score)
       ├─ getMemory + type ∈ {fact, preference, financial}
       ├─ raw < 0.65 컷
       ├─ adjustedScore = raw × exp(-daysOld / 90)
       ├─ sort + slice(MAX_INJECTED_MEMORIES=3)
       ├─ extractSymbols(query) → listTransactions(symbol, limit=3)
       └─ logger.info("memory.injected", {memoryIds, rawScores, adjustedScores, mode})
       │
       ▼
[execute]
       │
       ├─ formatBackgroundSection(retrievalResult)
       │    ## 사용자 배경지식 (자동 주입)
       │    - [preference] ... (2026-04-12 저장)
       │    ## 최근 거래 (AAPL)
       │    - 2026-03-15: 매수 10주 @ USD 180
       │
       ├─ composedSystemPrompt = baseSystemPrompt + "\n\n" + section
       ├─ runner.execute(...) → agent.run
       │
       └─ addAgentRun(prompt, output, toolCalls, tokens, duration, model, role)
              │
              ├─ output 길이 > 100 & no error? ─ YES
              │     ├─ addMemoryWithEmbedding(type='financial', metadata.source='agent.run')
              │     └─ linkMemoryToAgentRun(agentRunId, memoryId)
              │
              └─ NO → skip 'too-short' / 'has-error'
       │
       ▼
[deliver] (capturedMemory 가 있으면 "기억했습니다" 꼬리표)
```

핵심 관찰:

- 캡처·회수 모두 **best-effort**: 임베딩 throw 시 FTS-only fallback, capture
  실패 시 파이프라인 진행. 환각 방지보다 가용성 우선.
- 라이프사이클 끝에서 agent.run 출력이 다시 memories 로 들어가는 **재귀 루프**
  존재 (Mem0 의 episodic→semantic 추상화와 유사하나 요약 단계 없음).
- 만료/archive 로직 없음 → 영구 보존, 신선도 가중치로만 노화.

---

## RAG 주입 분석

### 위치

`packages/server/src/auto-reply/execution-adapter.ts:192-200`

```ts
const baseSystemPrompt = this.deps.systemPrompt;
const backgroundSection = ctx.retrievalResult ? formatBackgroundSection(ctx.retrievalResult) : '';
const composedSystemPrompt = backgroundSection
  ? `${baseSystemPrompt}\n\n${backgroundSection}`
  : baseSystemPrompt;
```

→ system prompt **꼬리** 에 부착. user/assistant 메시지에는 들어가지 않음.

### 형식

`packages/server/src/auto-reply/stages/memory-retrieval.ts:171-207` —
**마크다운**, JSON 아님.

```
## 사용자 배경지식 (자동 주입)
- [preference] 나는 분기별 리밸런싱 한다 (2025-12-02 저장)
- [financial] AAPL 분석 요약: ... (2026-03-20 저장)

## 최근 거래 (AAPL)
- 2026-03-15: 매수 10주 @ USD 180
- 2026-03-20: 매수 5주 @ USD 200
```

### 양

- `MAX_INJECTED_MEMORIES = 3`
- `SIMILARITY_THRESHOLD = 0.65` (raw 점수 컷)
- `FRESHNESS_HALF_LIFE_DAYS = 90` → 3개월 후 가중치 ≈ 37%
- `TOP_K_FETCH = 5` (임계값 컷 후 3 채울 여유)
- `SYMBOL_TX_LIMIT = 3` 거래 / 심볼당
- `vectorWeight = 0.7, textWeight = 0.3` (hybrid 가중치)
- 심볼 추출은 `\b[A-Z]{2,5}\b` + 24개 블록리스트 (USD/AM/IPO/ETF 등)

### 평가

- **위치**: ✓ system prompt 끝에 일관 주입. base 와 명확히 구분.
- **형식**: ✓ 마크다운 + 타입 태그 + 저장 시각 — 모델이 읽기 쉬움.
  ✗ **출처 ID 미노출** — 응답에서 "[fact #abc123]" 식 인용 불가.
- **양**: ✓ 임계값 + 상한으로 비용 통제. 무관 발화에 0건 주입 (audit 로그로 검증).
  ✗ **re-ranking 부재** — vector top-K 와 FTS top-K 를 단순 가중합. cross-encoder 없음.
- **감사**: ✓ `memory.injected` 로그에 `memoryIds, rawScores, adjustedScores, mode,
transactionSymbols` 전부 포함.

---

## 현대 비서 메모리 시스템과의 비교 매트릭스

| 기능                       | ChatGPT Memory      | Claude.ai Projects           | Letta / MemGPT            | Mem0        | LlamaIndex+LC RAG | **FinClaw**                                            |
| -------------------------- | ------------------- | ---------------------------- | ------------------------- | ----------- | ----------------- | ------------------------------------------------------ |
| **명시적 추출**            | ✓ ("기억해줘")      | ✓ (Project Memory 수동 편집) | ✓ (`memory_replace` tool) | ✓           | (앱이 처리)       | ✓ 정규식 5종 + `!finclaw remember`                     |
| **자동 추출**              | ✓ LLM 추출          | -                            | ✓ self-edit               | ✓ LLM 추출  | (앱)              | △ agent.run output → financial memory 자동 (요약 없음) |
| **사용자 가시 UI**         | ✓ Settings > Memory | ✓ Project files              | ✓ memory inspector        | ✓ dashboard | (앱)              | ✓ `/settings` Memories 섹션 (list/delete)              |
| **사용자 편집**            | ✓ on/off, 개별 삭제 | ✓ 직접 텍스트 편집           | ✓ self+user-edit          | ✓ CRUD      | (앱)              | △ **삭제만** — 편집 불가                               |
| **임베딩 검색**            | - (키워드 추정)     | ✓ 파일 RAG                   | ✓ archival store          | ✓ vec store | ✓                 | ✓ Voyage 1024D + sqlite-vec                            |
| **하이브리드 (vec+BM25)**  | -                   | △                            | △                         | △           | ✓                 | ✓ vec×0.7 + FTS5×0.3                                   |
| **재정렬 (cross-encoder)** | -                   | -                            | -                         | -           | ✓ Cohere/BGE      | ✗                                                      |
| **출처 인용 (citation)**   | -                   | ✓ 파일 단위                  | △ id 노출                 | △           | ✓ source nodes    | △ id 만 audit log, **응답엔 미노출**                   |
| **시간 가중 / TTL**        | -                   | -                            | ✓                         | ✓           | (앱)              | ✓ exp(-d/90), TTL 없음                                 |
| **자기-편집 (self-edit)**  | -                   | -                            | ✓ memory tools            | -           | -                 | ✗ (LLM 이 memory 직접 수정 불가)                       |
| **Working/Archival 분리**  | -                   | △                            | ✓ 3계층                   | △           | (앱)              | ✗ 단일 memories + agent_runs                           |
| **컨텍스트 압축**          | (자동)              | -                            | ✓ recursive_summary       | -           | (앱)              | ✓ 3단계 폴백 (full→partial→truncate)                   |
| **메모리 그래프**          | -                   | -                            | -                         | ✓           | △                 | ✗                                                      |
| **거래 도메인 영속**       | -                   | -                            | -                         | -           | -                 | ✓ (FinClaw 차별점)                                     |
| **agent.run 감사 trail**   | -                   | -                            | △                         | -           | -                 | ✓ tokens/duration/model/role/memoryId                  |
| **다중 임베딩 모델**       | -                   | -                            | △                         | ✓           | ✓                 | ✗ Voyage 1024D 고정 (vec0 DDL)                         |
| **mock-only 테스트**       | n/a                 | n/a                          | ✓                         | n/a         | ✓                 | △ FTS-only 회피 (hybrid 미검증)                        |

요약:

- **FinClaw 가 우월**: 거래 도메인 + agent.run 감사 trail + 신선도 가중 + 마이그레이션 v6 + 컨텍스트 3단계 폴백
- **FinClaw 가 동등**: 하이브리드 검색, 사용자 가시 + 삭제 UI, 명시적 추출
- **FinClaw 가 열등**: citation, 자기-편집, working/archival 분리, re-ranking, memory 편집 UI, multi-embedding, mock fallback

---

## 갭 (Critical / Important / Nice-to-have)

### Critical

#### C-1. RAG 응답에 citation 부재

- **설명**: `formatBackgroundSection` 이 메모리 ID 를 system prompt 에 노출하지 않음.
  audit log 에는 `memoryIds` 가 있지만, **모델 응답에서 "이 답이 어느 기억으로부터
  나왔는지" 추적 불가**. 사용자 제약(감사 가능성, 환각 방지) 직격.
- **발견 audit**: memory-knowledge
- **영향**: 사용자 (어떤 기억을 근거로 한 응답인지 불분명), 운영자 (감사 약함)
- **추정 작업량**: S
- **참조**: `packages/server/src/auto-reply/stages/memory-retrieval.ts:177`
  (`- [${s.type}] ${s.content} (${isoDate(s.createdAt)} 저장)` —
  여기 `${s.id}` 추가 + system prompt 에 "응답에서 [#id] 형태로 인용하라" 지시 추가)

#### C-2. 임베딩 차원 호환성 함정 (OpenAIProvider 사용 시 silently broken)

- **설명**: `vec0(embedding float[1024])` 로 DDL 고정. `OpenAIEmbeddingProvider` 는
  1536D 반환 → INSERT 시 sqlite-vec 가 throw 가능. `createEmbeddingProvider('openai')`
  를 의식적으로 선택한 사용자가 **첫 capture 시점에야** 실패를 알게 됨.
  코드에 WARNING 주석은 있으나 런타임 가드는 없음.
- **발견 audit**: memory-knowledge
- **영향**: 운영자 (운영 중 잠복 실패), 개발자 (마이그레이션 함정)
- **추정 작업량**: S (provider.dimensions vs 1024 비교 후 throw)
- **참조**: `packages/storage/src/embeddings/openai.ts:11-19`,
  `packages/storage/src/database.ts:76-79`

### Important

#### I-1. mock 임베딩 프로바이더 부재 — 외부 키 없이 hybrid 테스트 불가

- **설명**: 룰릭 4점 기준 "mock fallback (테스트가 키 없이 통과)". 현 구조는
  `embeddingProvider` 미주입 시 FTS-only 로 fallback 하지만, **vector 경로 자체는
  실제 API 키 없이 검증 불가**. 사용자 제약 (테스트는 mock-only 강제) 위배.
- **발견 audit**: memory-knowledge (cross: testing 축)
- **영향**: 개발자 (CI 신뢰성), 운영자 (회귀 위험)
- **추정 작업량**: S (FakeEmbeddingProvider — 결정적 해시 → 1024D 유닛 벡터)
- **참조**: `packages/storage/src/embeddings/provider.ts:25-50`,
  `packages/storage/src/tables/memories.storage.test.ts` 가 cache 만 검증 중

#### I-2. 거래 회계 무결성 검증 부재

- **설명**:
  - `transactions.price REAL` — float 누적 오차로 1년치 거래 후 average_cost 가
    소수점 5자리에서 흔들림. 결정적이지 않음.
  - `recomputeHoldings` 가 `quantity ≤ 0` 인 심볼을 holdings 에서 삭제하지만,
    음수 holdings (short) 자체는 막지 않아 의도 모호. plan.md line 133 "sell >
    현재 보유 수량 → 경고"가 코드에 없음.
  - dividend 의 cash 영향이 어디에도 누적되지 않음 (price 만 기록).
- **발견 audit**: memory-knowledge (cross: runtime-tools)
- **영향**: 사용자 (자산 데이터 정합성)
- **추정 작업량**: M (INTEGER cents 마이그레이션 + invariant 체크 + cash 별도 추적)
- **참조**: `packages/storage/src/transactions.ts:97-170`,
  `packages/storage/src/database.ts:155-169`

#### I-3. memory_chunks.hash NULL — chunk 단위 dedup 미동작

- **설명**: `memory_chunks.hash` 컬럼은 NOT NULL 이 아니며 (database.ts:70 주석
  "addMemory 에서 chunk hash 미설정"), `addMemory` 도 hash 를 채우지 않음. 결과:
  같은 chunk text 가 여러 memory_id 로 들어와도 dedup 안 됨. memories 테이블
  레벨에서만 sha256(content) dedup. 긴 문서를 일부만 다르게 다시 입력하면
  embedding/FTS 인덱스가 중복 부풀려짐.
- **발견 audit**: memory-knowledge
- **영향**: 운영자 (인덱스 비효율), 사용자 (top-K 결과에 중복 chunk 노출 가능)
- **추정 작업량**: S (addMemory 에서 sha256(chunk.text) 채우기 + UNIQUE 인덱스)
- **참조**: `packages/storage/src/database.ts:70`,
  `packages/storage/src/tables/memories.ts:128-145`

#### I-4. 사용자 메모리 편집 UI 부재

- **설명**: settings-view 가 list + delete 만 제공. ChatGPT/Letta/Mem0 모두
  편집을 지원. 잘못 캡처된 사실(오타/오해)을 사용자가 정정하려면 삭제 후
  재등록 필요. 룰릭 3.2 "사용자 승인 흐름" 의 정정 측면 미충족.
- **발견 audit**: memory-knowledge (cross: interface-channels)
- **영향**: 사용자
- **추정 작업량**: S (`memory.update` RPC + UI inline edit)
- **참조**: `packages/web/src/views/settings-view.ts:419-468`,
  `packages/server/src/gateway/rpc/methods/memory.ts` (update 핸들러 없음)

#### I-5. agent.run 출력의 비요약 저장으로 RAG noise 증폭

- **설명**: `agent-memory-hook.ts:85` — "raw output 그대로 memory.content 에
  저장 (요약·압축 없음, 단순함 우선)". 한 번의 분석이 1000자 이상이어도
  통째로 1개 memory 가 됨. 그 후 chunkMarkdown 이 다시 자르지만, RAG
  top-3 안에 같은 분석의 여러 chunk 가 들어가 다양성 손상. Mem0/Letta 식
  요약 추출이 부재.
- **발견 audit**: memory-knowledge
- **영향**: 운영자 (RAG 품질 저하), 사용자 (top-3 다양성 부족)
- **추정 작업량**: M (LLM 요약 호출 추가 + summary memory + 본문 archival 분리)
- **참조**: `packages/server/src/auto-reply/agent-memory-hook.ts:53-95`

### Nice-to-have

#### N-1. Working / Archival / Recall 3계층 분리 (Letta-MemGPT 식)

- **설명**: 현재 단일 memories 테이블 + agent_runs. Letta 처럼 working memory
  (system prompt 직접 편집), archival (벡터 검색), recall (대화 검색) 분리하면
  사용자가 명시 선언한 fact 와 자동 캡처한 financial 의 우선순위를 시스템
  레벨에서 강제 가능.
- **추정 작업량**: L
- **참조**: 현재는 type 필드(`fact|preference|summary|financial`) 로 구분하지만
  주입 시 가중치는 동일.

#### N-2. Re-ranking (cross-encoder)

- **설명**: `mergeHybridResults` 는 단순 가중합. Cohere reranker / BGE-reranker
  를 추가하면 top-3 정확도 ↑. 다만 추가 API 호출 비용·지연.
- **추정 작업량**: M
- **참조**: `packages/storage/src/search/hybrid.ts:24-73`

#### N-3. 메모리 그래프 (Mem0 식 entity-relation)

- **설명**: "AAPL — 매수 — 2026-03 — financial #xyz" 같은 관계를 그래프로
  명시. 현재는 메타데이터 JSON blob. 그래프화 시 "내가 AAPL 에 대해 가진
  모든 기억과 거래" 류 쿼리 1회 hop.
- **추정 작업량**: L

#### N-4. 다중 임베딩 모델 + 차원 마이그레이션

- **설명**: vec0 DDL 이 1024D 고정. Voyage 신모델/한국어 특화 모델 도입 시
  새 컬럼 + 재인덱스 + 점진 cutover 필요. `atomicReindex` 는 같은 차원 내
  동일 모델만 재계산.
- **추정 작업량**: M

#### N-5. 명시적 TTL / archive 정책

- **설명**: plan.md 오픈 질문 #2 "기본 영구 보존". 메모리가 100건/년 이상
  쌓이면 신선도 가중치만으로는 top-3 압박. archive 플래그 + UI 토글.
- **추정 작업량**: S

#### N-6. 컨텍스트 윈도우 압축 결과의 archival 보존

- **설명**: `compactContext` 가 요약을 system 메시지로 inline 후 원본은 폐기.
  Letta 는 archival 로 보존. 사용자가 "30분 전에 뭐 얘기했지" 물으면 현재
  요약본만 검색됨.
- **추정 작업량**: M
- **참조**: `packages/agent/src/agents/context/compaction.ts:88-93`

---

## 결론 / 권고 우선순위

룰릭 평균 **3.43 / 5** — Production-grade 진입선. ChatGPT Memory + Claude.ai
Projects 의 명시 추출·가시·삭제 기능은 충족하고, 거래 도메인·agent.run 감사
trail·신선도 가중치는 차별화 강점. Letta/Mem0 의 자기-편집·메모리 그래프·
3계층 분리, LlamaIndex 의 re-ranking·citation 은 미충족.

**즉시 (S, 1주 이내)**:

1. C-1 citation: section 에 memoryId 노출 + system prompt 인용 지시
2. C-2 dimension guard: provider.dimensions ≠ 1024 throw
3. I-1 FakeEmbeddingProvider: 결정적 1024D mock
4. I-3 chunk hash 채우기

**중기 (M, 2-4주)**: 5. I-2 회계 무결성: INTEGER cents + invariant 검증 6. I-5 agent.run 요약 분리

**장기 (L, 1-3개월)**: 7. N-1 working/archival/recall 분리 — 사용자 제약(읽기 전용 + 환각 방지)
하에서 fact/preference 의 system prompt 우선권 보장 측면에서 가장 큰 ROI.

본 감사의 다른 axis 와의 의존성:

- C-1 citation 은 `runtime-tools-auditor` 의 prompt engineering 협업.
- I-4 메모리 편집 UI 는 `interface-channels-auditor` 의 settings-view 평가와
  중첩.
