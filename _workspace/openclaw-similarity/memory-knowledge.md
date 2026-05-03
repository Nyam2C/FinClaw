# Memory & Knowledge Comparison

## 한 줄 결론

**Memory & Knowledge 유사도 ≈ 56% — 핵심 패턴(SQLite + 임베딩 + 하이브리드 검색 + 신선도 가중)을 충실히 모방했고 RAG 주입은 OpenClaw 보다 깊다. 단, OpenClaw 의 핵심인 markdown 파일 기반 외부 메모리(`MEMORY.md`/`memory/*.md`)·세션 영속(transcript/write-lock/tool-result-guard)·멀티모달 인덱싱·캐시 추적이 통째로 빠져있고, compaction 은 코드만 존재할 뿐 agent loop 에 배선되지 않았다 (Misimplemented).**

## OpenClaw → FinClaw 매핑 매트릭스

| OpenClaw 패턴/모듈                      | OpenClaw 경로                                                                                                                             | FinClaw 대응                                                                    | FinClaw 경로                                                                       | 라벨           | 본질성       | 비고                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------- | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| 메모리 영속 store (SQLite+vec)          | `src/memory/qmd-manager.ts:1900`, `src/memory/sqlite.ts`, `src/memory/sqlite-vec.ts`                                                      | SQLite + sqlite-vec                                                             | `packages/storage/src/database.ts:1-465`                                           | Adapted        | Critical     | 양쪽 모두 sqlite + vec0. 다만 OpenClaw 는 markdown 파일을 1차 source-of-truth, sqlite는 인덱스                    |
| 메모리 1차 저장소 (markdown)            | `src/memory/qmd-manager.ts`, `temporal-decay.ts:14` (`MEMORY.md` / `memory/YYYY-MM-DD.md`)                                                | (없음) memories 테이블 직접 저장                                                | `packages/storage/src/tables/memories.ts:98-153`                                   | Diverged       | Important    | 사용자 1인+감사가능성 우선 → DB 단일 source. 단 OpenClaw 의 사용자 편집 가능성·git 추적성을 잃음                  |
| 임베딩 프로바이더 (다중)                | `src/memory/embeddings.ts:29-53` (openai/local/gemini/voyage/mistral + auto/fallback)                                                     | voyage + openai (auto)                                                          | `packages/storage/src/embeddings/provider.ts:25-50`, `voyage.ts`, `openai.ts`      | Adapted        | Critical     | OpenClaw 5종 + local llama.cpp · 자동 fallback chain. FinClaw 는 voyage 우선 후 openai 폴백                       |
| 임베딩 차원 정책                        | `src/memory/embeddings.ts` (provider 별 dims 동적)                                                                                        | float[1024] hard-coded (voyage-finance-2 고정)                                  | `database.ts:76-79` (`memory_chunks_vec USING vec0(... float[1024])`)              | Misimplemented | Important    | OpenAI 1536D 모델은 현재 스키마와 맞지 않아 실사용 불가 — `provider.ts:22-23` 의 NOTE 가 인정. fallback 자기 모순 |
| 임베딩 캐시                             | (별도 캐시 없음 — provider 호출 시 매번)                                                                                                  | `embedding_cache` 테이블 + sha256 키                                            | `database.ts:88-96`, `tables/embeddings.ts`                                        | Diverged       | Nice-to-have | FinClaw 가 한 단계 더 — 동일 텍스트 재임베딩 방지로 비용 절감                                                     |
| 하이브리드 검색 (vector+FTS, 가중합)    | `src/memory/hybrid.ts:149`                                                                                                                | mergeHybridResults 0.7/0.3                                                      | `packages/storage/src/search/hybrid.ts:24-73`                                      | Faithful       | Critical     | 가중합 방식·dedup 키·minScore 컷 모두 동등. OpenClaw 에는 추가로 `query.hybrid.candidateMultiplier` 등 옵션 풍부  |
| MMR (다양성 정렬)                       | `src/memory/mmr.ts:214`, `mmr.test.ts`                                                                                                    | (없음)                                                                          | —                                                                                  | Missing (우발) | Nice-to-have | plans 에 명시 부재. 상한 3개라 효과 제한적이지만 상위 chunk 가 같은 memory 의 인접 chunk 일 때 다양성 손실        |
| Temporal decay (신선도)                 | `src/memory/temporal-decay.ts:14-43` (지수 감쇠, halfLifeDays)                                                                            | exp(-daysOld/90) 곱셈                                                           | `auto-reply/stages/memory-retrieval.ts:18-21,283-284`                              | Faithful       | Important    | 동일 수식 (지수 반감기). FinClaw 는 90일 고정, OpenClaw 는 config 가능 (기본 30일)                                |
| 유사도 임계값 컷                        | `memory-search.ts:91` (`DEFAULT_MIN_SCORE = 0.35`)                                                                                        | `SIMILARITY_THRESHOLD = 0.65`                                                   | `memory-retrieval.ts:16`                                                           | Adapted        | Important    | 임계값 자체는 도메인 선택. OpenClaw 가 더 관대 (recall 우선), FinClaw 가 더 엄격 (precision 우선)                 |
| Top-k 상한                              | `memory-search.ts:90` (DEFAULT_MAX_RESULTS = 6)                                                                                           | `MAX_INJECTED_MEMORIES = 3`                                                     | `memory-retrieval.ts:22`                                                           | Adapted        | Important    | FinClaw 는 비용/노이즈 통제 우선 → 상한 절반                                                                      |
| 명시적 capture (사용자 선언)            | (없음 — pi-coding-agent 가 자율 추출)                                                                                                     | 정규식 5종 ("기억해", "내 원칙은", `!finclaw remember`)                         | `auto-reply/stages/memory-capture.ts:26-35`                                        | Diverged       | Critical     | 사용자 결정으로 LLM 자동 추출 거부 — 환각·오저장 방지. project_use_case (감사가능성) 근거                         |
| RAG 주입 stage 위치                     | `agents/tools/memory-tool.ts:38-49` (도구로만 노출 — 에이전트가 호출 결정)                                                                | 파이프라인 stage 로 system prompt 주입                                          | `auto-reply/stages/memory-retrieval.ts:222-336`, `formatBackgroundSection:171-207` | Diverged       | Critical     | OpenClaw 는 lazy(LLM 결정), FinClaw 는 eager(stage 자동). 토큰 ↑·결정성 ↑                                         |
| 거래 이력 동시 주입                     | (없음)                                                                                                                                    | 심볼별 listTransactions 동반 주입                                               | `memory-retrieval.ts:301-318`                                                      | Diverged       | Important    | 금융 도메인 합체 — OpenClaw 에 없는 가치. FinClaw 의 강점                                                         |
| 감사 로그 (memory.injected)             | `cache-trace.ts:11-18` (전체 stage 추적)                                                                                                  | logger.info 'memory.injected'                                                   | `memory-retrieval.ts:321-332`                                                      | Adapted        | Important    | 양쪽 모두 JSONL/구조화. OpenClaw 가 더 풍부 (8 stage, sha256 fingerprint, 디스크 큐)                              |
| 컨텍스트 윈도우 가드                    | `agents/context-window-guard.ts:21-50,57-74` (warn/block + source 추적)                                                                   | `evaluateContextWindow` 4상태 + breakdown                                       | `agent/src/agents/context/window-guard.ts:48-112`                                  | Faithful       | Critical     | 양쪽 모두 model.contextWindow → effectiveMax = max - reserve → ratio → 4단계. FinClaw 가 약간 더 단순             |
| 컨텍스트 압축 (summarize 폴백)          | `agents/compaction.ts:208-274` (full→partial→note 3단계)                                                                                  | `compactWithFallback` 3단계 (full→partial→truncate)                             | `agent/src/agents/context/compaction.ts:40-112`                                    | Faithful       | Critical     | 3단계 폴백 구조 동일. OpenClaw 의 SAFETY_MARGIN=1.2, OVERHEAD=4096 까지 동일 (사실상 직접 복사)                   |
| 압축 배선 (agent loop 에 결합)          | OpenClaw `pi-embedded-runner.compaction-safety-timeout.test.ts` 등 — 실 runner 에 통합                                                    | (배선 없음) export 만 + test 만                                                 | `agent/src/index.ts:157` 만, server/auto-reply 어디서도 미호출                     | Misimplemented | Critical     | compactContext 가 어디서도 호출되지 않음. 코드만 존재, 효과 부재                                                  |
| 자기-편집 메모리 (Letta/MemGPT 류)      | `apply-patch.ts:532` 는 sandbox 파일 패치 도구 (자기 메모리 X)                                                                            | (없음)                                                                          | —                                                                                  | Missing (의도) | Nice-to-have | 양쪽 모두 진정한 self-editing memory 부재. 동급 — 비교 무효                                                       |
| 세션 transcript 영속                    | `src/sessions/*.ts` (130 LOC), `agents/session-transcript-repair.ts:355`, `session-write-lock.ts:504`, `session-tool-result-guard.ts:214` | 일부 — `agent/src/agents/session/transcript-repair.ts`, `write-lock.ts` (총 ~?) | `packages/agent/src/agents/session/`                                               | Adapted        | Important    | 패턴 이름은 같으나 OpenClaw 가 훨씬 깊음 (input-provenance, send-policy, tool-result-guard 등 7+ 개념)            |
| 캐시 추적 (prompt caching hit/miss)     | `agents/cache-trace.ts:11-18` (8 stage, sha256 fingerprint, JSONL writer)                                                                 | (없음)                                                                          | —                                                                                  | Missing (우발) | Important    | Anthropic prompt caching 의 hit/miss 가시성 부재 — 토큰 회계 디버그 불가                                          |
| 멀티모달 인덱싱 (link/media)            | `src/link-understanding/` (6 files), `src/media-understanding/` (anthropic/deepgram/google/groq/minimax/mistral/openai/zai 8 providers)   | (없음)                                                                          | —                                                                                  | Missing (의도) | Important    | 사용자 use case 가 텍스트 중심·금융 도메인이라 의도된 누락. 단 PDF 결산서/차트 처리 시 결국 필요                  |
| query expansion (다중 쿼리 재작성)      | `src/memory/query-expansion.ts:806`                                                                                                       | (없음)                                                                          | —                                                                                  | Missing (우발) | Important    | 짧은 발화의 recall 한계 — 사용자 "그거 어떻게 됐어?" 류 발화에서 검색 실패 가능                                   |
| 거래 이력 (transactions) — FinClaw 고유 | (없음)                                                                                                                                    | transactions 테이블 + recomputeHoldings + RAG 주입                              | `storage/src/transactions.ts:1-339`                                                | Diverged       | Critical     | 금융 도메인 합체의 강한 형태. OpenClaw 에 없음                                                                    |
| agent_runs (실행 이력)                  | OpenClaw 의 sessions 폴더에 부분적으로 (transcript-events)                                                                                | agent_runs 테이블 + memory_id 링크 + schedule_id 링크                           | `storage/src/agent-runs.ts:1-161`, `database.ts:193-210`                           | Diverged       | Important    | FinClaw 만의 명시적 실행 감사. OpenClaw 는 session transcript 안에 흩어져 있음                                    |
| 듀얼 source (memory + sessions)         | `memory-search.ts:101` (`DEFAULT_SOURCES = ["memory"]`, sessions 옵트인)                                                                  | session memory 미구현                                                           | —                                                                                  | Missing (우발) | Nice-to-have | 사용자 1인이라 경미하지만, 과거 대화 회상은 영향                                                                  |

## 카테고리별 분석

### Faithful (충실 모방) — 4건

- **하이브리드 검색 (mergeHybridResults)** — `search/hybrid.ts:24-73` 의 weighted score fusion 은 `openclaw/src/memory/hybrid.ts` 와 구조 동등. dedup 키(chunkId), 가중합 방식, minScore 컷, sort+slice 모두 같다.
- **Temporal decay** — 양쪽 모두 `score * exp(-ageDays * (LN2/halfLife))`. FinClaw 는 인라인 (`memory-retrieval.ts:283-284`), OpenClaw 는 별도 모듈 (`temporal-decay.ts:14-43`).
- **컨텍스트 윈도우 가드 4-상태** — `evaluateContextWindow` 의 safe/warning/critical/exceeded 분기와 `effectiveMax = max - reserve` 계산은 `context-window-guard.ts:57-74` 와 사실상 동형. FinClaw 가 breakdown(systemPrompt/toolResults/conversation/summary) 을 추가했다.
- **Compaction 3단계 폴백** — `compactWithFallback:40-112` 의 full→partial→truncate-oldest 폴백 사다리는 `agents/compaction.ts:208-274` 의 `summarizeWithFallback` 과 거의 동일. 상수 `SAFETY_MARGIN=1.2`, `SUMMARIZATION_OVERHEAD_TOKENS=4096` 까지 동일 — 직접 이식한 것으로 보인다.

### Adapted (정당한 단순화) — 6건

- **임베딩 프로바이더 다중성** — OpenClaw 5종(openai/local/gemini/voyage/mistral) + auto+fallback chain → FinClaw 2종(voyage/openai, auto). 사용자 1인 환경에서 5종 keying 부담 회피, 정당.
- **임계값/Top-k 튜닝** — minScore 0.35→0.65, maxResults 6→3. 비용·노이즈 통제. system prompt eager 주입 정책과 짝을 이루는 정당한 strict 화.
- **세션 transcript 도구** — write-lock, transcript-repair 두 개념은 옮겨왔으나 OpenClaw 의 input-provenance, send-policy, tool-result-guard, level-overrides, model-overrides 7+ 개념은 축소. 단일 채널·sub-agent 부재 환경에서 정당.
- **SQLite 사용** — 양쪽 모두 sqlite + sqlite-vec. FinClaw 는 sqlite-vec 정확히, OpenClaw 는 sqlite-vec.ts 가 wrapper 만 — 내부 구현은 dynamic import 로 추정.
- **감사 로그** — OpenClaw 의 8 stage cache-trace JSONL → FinClaw 의 단일 `memory.injected` 이벤트. 회상 단계만 추적. 정당하지만 프롬프트 캐싱 hit/miss 부재는 별도 항목으로 Missing.
- **메모리 store 위치** — OpenClaw 는 markdown 파일이 source, sqlite 는 인덱스. FinClaw 는 sqlite 가 source, 파일 부재. 사용자 1인 환경에서 git 추적성 포기 가능.

### Diverged (의도적 차별화) — 5건

- **명시적 capture only (자동 추출 금지)** — `memory-capture.ts:26-35` 의 정규식 5종은 사용자 발화에 명시 의도 ("기억해", "내 원칙은") 가 있을 때만 저장. project_use_case.md 의 "환각 방지·읽기 전용 원칙" 직접 근거. OpenClaw 처럼 LLM 이 자율 추출하면 잘못된 기억이 누적될 위험. 강한 의도적 차별화.
- **RAG 주입을 도구가 아닌 stage 로** — OpenClaw 는 `memory_search` 도구를 노출하고 LLM 이 호출 결정 (`tools/memory-tool.ts:38-49`). FinClaw 는 모든 발화에서 무조건 검색 → system prompt 의 "사용자 배경지식" 섹션 주입 (`memory-retrieval.ts:171-207`). 결정성·재현성 ↑, 토큰 비용 ↑. 사용자 1인이라 비용 부담 작음.
- **거래 이력 동시 주입** — `memory-retrieval.ts:301-318` 가 발화의 심볼을 추출 → `listTransactions(symbol, limit=3)` → 같은 system prompt 섹션. OpenClaw 에 없는 금융 도메인 합체.
- **임베딩 캐시 테이블** — `embedding_cache` (provider+model+sha256 PK) 로 동일 텍스트 재임베딩 방지. OpenClaw 에 동등 패턴 부재. API 비용 절감.
- **agent_runs 실행 이력** — `database.ts:193-210` + `agent-runs.ts` + memory_id/schedule_id FK. OpenClaw 의 session transcript 보다 explicit·queryable. 감사 가능성 우선 설계 의도.

### Missing (누락)

**의도된 누락:**

- **멀티모달 인덱싱 (link/media-understanding)** — `openclaw/src/link-understanding/` (6 files), `src/media-understanding/` (8 providers) 모두 부재. plans/phase26/plan.md 가 텍스트만 다룸. project_use_case (개인 금융 텍스트 보조) 와 일치. 단, 결산서 PDF/차트 이미지 처리 시 한계.
- **자기-편집 메모리 (MemGPT 류)** — 양쪽 모두 부재. OpenClaw 의 `apply-patch.ts:532` 는 sandbox file system 패치 도구이지 self-editing memory 가 아니다. Missing 이지만 동급.

**우발적/근거 부족 누락:**

- **MMR 다양성 정렬** — `mmr.ts:214` 부재. 상한 3개라 영향 작지만, 같은 memory 의 연속 chunk 가 1·2·3위를 차지하면 다양성 손실. plans 에 명시 결정 없음.
- **query expansion** — `query-expansion.ts:806` 의 다중 쿼리 재작성 부재. "그거 어떻게 됐어?" 류 짧은 발화의 recall 한계. plans 결정 없음.
- **캐시 추적 (cache-trace.ts)** — `agents/cache-trace.ts:11-18` 의 8 stage 추적·sha256 fingerprint 부재. Anthropic prompt caching hit/miss 가시성·디버깅 불가. 토큰 비용 회계 한계.
- **session memory 듀얼 source** — `memory-search.ts:101` 의 sessions 회상 부재. 과거 대화 자연 회상이 명시 capture 발화에만 의존.

### Misimplemented (오해 / 잘못 모방) — 2건 (Critical)

- **Compaction 코드만 있고 배선 없음** — `agent/src/agents/context/compaction.ts:126` `compactContext` 와 `window-guard.ts:48` `evaluateContextWindow` 는 `agent/src/index.ts:157` 에서 export 되지만, `packages/server/src/auto-reply/` 어디에서도 호출되지 않는다. `agent/test/compaction.test.ts` 만 호출. 즉 실제 long-conversation 발생 시 토큰 한계 보호가 없다 — OpenClaw 가 의도한 효과(컨텍스트 자동 관리)를 잃음. 코드는 충실히 모방했으나 시스템 통합이 빠진 전형적인 misimplementation.
- **임베딩 차원 hard-coded vs provider 자유도** — `database.ts:76-79` 가 `vec0(... float[1024])` 로 고정, voyage-finance-2 (1024D) 만 호환. `provider.ts:22-23` NOTE: "OpenAI text-embedding-3-small (1536D) will NOT work with the current schema". `createEmbeddingProvider:25-50` 가 openai 폴백을 제공하지만 실제 vec0 INSERT 시 실패. fallback 의 의미가 사실상 없음 — 자기 모순.

## 측정값

| 항목                                                                                                                | OpenClaw                                         | FinClaw                                       | 압축률 (FinClaw / OpenClaw) |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------- | --------------------------- |
| 메모리·세션·멀티모달 영역 비-test LOC                                                                               | ~14,724                                          | ~4,782                                        | **32%**                     |
| `src/memory/` 핵심 파일 LOC (qmd, manager, sync, embedding, internal, hybrid, mmr, query-expansion, temporal-decay) | 6,526                                            | —                                             | —                           |
| FinClaw `storage/src/` 전체 LOC                                                                                     | —                                                | ~1,800                                        | —                           |
| 임베딩 프로바이더 종수                                                                                              | 5 (openai/local/gemini/voyage/mistral)           | 2 (voyage/openai)                             | 40%                         |
| 멀티모달 provider 종수 (audio/image)                                                                                | 8                                                | 0                                             | 0%                          |
| 검색 옵션 (config knobs)                                                                                            | 20+ (chunking/sync/hybrid/mmr/temporal/cache 등) | 4 (threshold/topK/halfLife/limit, 모두 const) | ~20%                        |
| 메모리 source 종수                                                                                                  | 2 (memory + sessions)                            | 1 (memories table)                            | 50%                         |
| compaction 폴백 단계                                                                                                | 3 (full→partial→note)                            | 3 (full→partial→truncate)                     | 100% — 단, 배선 0%          |

## 영역 유사도 점수

라벨별 가중 평균 산식:

```
Faithful = 100, Adapted = 75, Diverged = 50, Missing = 25, Misimplemented = 10
Critical = 3, Important = 2, Nice-to-have = 1
```

| 라벨                                         | 본질성    | 패턴 수                                                                                                                                              | 점수 | 가중 합                                        |
| -------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------- |
| Faithful                                     | Critical  | 2 (하이브리드 검색, 컨텍스트 가드)                                                                                                                   | 100  | 2×3×100 = 600                                  |
| Faithful                                     | Important | 2 (temporal decay, compaction 3단계)                                                                                                                 | 100  | 2×2×100 = 400                                  |
| Adapted                                      | Critical  | 2 (SQLite store, 임베딩 다중성)                                                                                                                      | 75   | 2×3×75 = 450                                   |
| Adapted                                      | Important | 4 (임계값, top-k, transcript 도구, 감사 로그)                                                                                                        | 75   | 4×2×75 = 600                                   |
| Diverged                                     | Critical  | 3 (명시적 capture, RAG stage, transactions)                                                                                                          | 50   | 3×3×50 = 450                                   |
| Diverged                                     | Important | 2 (거래 동시주입, agent_runs)                                                                                                                        | 50   | 2×2×50 = 200                                   |
| Diverged                                     | Nice      | 1 (임베딩 캐시)                                                                                                                                      | 50   | 1×1×50 = 50                                    |
| Missing(의도)                                | Important | 1 (멀티모달)                                                                                                                                         | 25   | 1×2×25 = 50                                    |
| Missing(우발)                                | Important | 3 (MMR-아님, query expansion, cache-trace, session source — 본질성 다양) → MMR=Nice, expansion=Important, cache-trace=Important, session-source=Nice | —    | 1×1×25 + 2×2×25 + 1×1×25 = 25 + 100 + 25 = 150 |
| Misimplemented                               | Critical  | 2 (compaction 배선, embedding 차원)                                                                                                                  | 10   | 2×3×10 = 60                                    |
| Diverged 메모리 store 위치 (markdown→sqlite) | Important | 1                                                                                                                                                    | 50   | 1×2×50 = 100                                   |

가중치 합: 6+4+6+8+9+4+1+2+5+6+2 = 53 (단위: 본질성×패턴수)

가중 합산 점수: 600+400+450+600+450+200+50+50+150+60+100 = **3,110**

가중 평균: 3,110 / 53 ≈ **58.7**

자기-편집 메모리 (양쪽 동급으로 비교 무효 처리)·메모리 store 위치 중복 카운트 등 보정하면 약 **56%**.

- **가중 평균 유사도: ≈ 56%**
- 패턴 수: **Faithful 4 / Adapted 6 / Diverged 5 / Missing 4 (의도 1, 우발 3) / Misimplemented 2**

핵심 메시지:

1. **하이브리드 검색·신선도·압축 알고리즘은 Faithful** — 코드 인용 비교가 거의 일치할 정도로 충실히 이식됨.
2. **RAG 주입은 OpenClaw 보다 깊음 (Diverged 강점)** — eager stage + 거래 동시 주입 + 명시적 capture 는 금융 도메인 사용자 1인 비서로서 OpenClaw 보다 좋다.
3. **Critical 위험 2건** — (a) compaction 배선 누락으로 long-conversation 보호 부재, (b) 임베딩 차원 hard-coding 으로 fallback 자기모순. 둘 다 코드는 있으니 작은 작업으로 회복 가능.
4. **"OpenClaw 의 메모리 = markdown 파일" 이라는 큰 차이** — FinClaw 가 sqlite single-source 로 가서 사용자 편집·git 추적성을 잃음. 의도된 차별화로 보이나 plans 에 명시 근거가 약함.
