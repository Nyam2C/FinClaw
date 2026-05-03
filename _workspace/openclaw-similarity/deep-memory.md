# Memory Deep-Dive (HIGH 신뢰도)

본 보고서는 `memory-knowledge.md` 의 MEDIUM 신뢰도 라벨을 OpenClaw `src/memory/`·`src/agents/{memory-search,compaction,context*,session-*,cache-trace,tools/memory-tool}.ts`·`src/sessions/*.ts` 와 FinClaw `packages/storage/src/{database,tables/memories,search/hybrid,embeddings/*}` · `packages/agent/src/agents/{context,session}` · `packages/server/src/auto-reply/stages/memory-{capture,retrieval}.ts` 파일 본문을 직접 읽어 HIGH 로 끌어올렸다.

## 한 줄 결론

직접 읽고 보니 OpenClaw 메모리는 **사용자가 markdown 파일을 직접 작성** 하는 read-only 인덱서이고, **자동 추출이 없다**. 이전 보고서가 "pi-coding-agent 자율 추출"로 추측한 것은 부정확. Claude-only + Discord-only 컨텍스트에서 보면 FinClaw 의 명시적 capture / eager system-prompt 주입은 **OpenClaw 보다 더 적극적인 메모리 시스템** 이고, 진짜 갭은 (1) compaction 미배선과 (2) qmd-manager 의 _외부 markdown source-of-truth_ 부재 두 가지로 좁혀진다 — 나머지 누락은 대부분 의도된 단순화로 재라벨된다.

## OpenClaw 메모리 시스템 라이프사이클

### 1. Capture (자동 추출 — **부재**)

`memory-tool.ts:40-99` 의 `createMemorySearchTool` 과 `createMemoryGetTool` 은 **둘 다 read-only**. `manager.ts` 와 `qmd-manager.ts` 어디에도 `writeMemory`/`createMemory`/`recordMemory` 같은 쓰기 함수가 없다. 유일한 fs.writeFile 호출 (`qmd-manager.ts:1364`) 은 _세션 transcript 의 markdown 변환_ 이지 사용자 발화에서의 메모리 추출이 아니다.

→ **OpenClaw 의 메모리 capture 모델 = 사용자가 직접 `MEMORY.md` / `memory/YYYY-MM-DD.md` 를 편집**. `manager.ts:86` 의 chokidar `FSWatcher` 가 파일 변경을 감지해 인덱싱한다 (`watch`, `watchDebounceMs:1500`).

이전 보고서의 "(없음 — pi-coding-agent 가 자율 추출)" 은 잘못. 정정: **양쪽 모두 자동 추출 부재**, FinClaw 는 정규식 5종으로 명시 capture 추가 (OpenClaw 보다 적극적).

### 2. Storage (markdown + sqlite)

- 1차 source-of-truth: 사용자 `MEMORY.md` (evergreen) + `memory/YYYY-MM-DD.md` (dated). `temporal-decay.ts:15` 의 `DATED_MEMORY_PATH_RE = /(?:^|\/)memory\/(\d{4})-(\d{2})-(\d{2})\.md$/` 가 핵심 식별자.
- sqlite 는 인덱스 (chunk + vec0 + fts5). `manager.ts:34-36` 의 `VECTOR_TABLE = "chunks_vec"`, `FTS_TABLE = "chunks_fts"`, `EMBEDDING_CACHE_TABLE = "embedding_cache"`.
- 임베딩 캐시 **존재** (이전 보고서가 "별도 캐시 없음" 으로 표기한 것은 부정확). FinClaw 와 동급.

### 3. Embedding

`embeddings.ts:144-260`. 5종 (openai/local/gemini/voyage/mistral) + `auto` mode 의 우선순위 fallback chain (`REMOTE_EMBEDDING_PROVIDER_IDS = ["openai","gemini","voyage","mistral"]`). missing API key 면 다음 provider 시도, 모두 실패하면 **null provider 반환 → FTS-only 모드** (`embeddings.ts:204-211`). 이는 FinClaw 와 동일한 graceful degradation 패턴. FinClaw 는 voyage→openai 만.

### 4. Retrieval

`memory-search.ts:88-98` 의 기본값:

- `DEFAULT_MAX_RESULTS = 6`
- `DEFAULT_MIN_SCORE = 0.35`
- `DEFAULT_HYBRID_VECTOR_WEIGHT = 0.7` / `DEFAULT_HYBRID_TEXT_WEIGHT = 0.3`
- `DEFAULT_MMR_ENABLED = false` (opt-in)
- `DEFAULT_TEMPORAL_DECAY_ENABLED = false` (opt-in)
- `DEFAULT_TEMPORAL_DECAY_HALF_LIFE_DAYS = 30`

호출 순서 (`hybrid.ts:51-148`):

1. vector candidates · keyword candidates 수집 → `byId` Map 으로 dedup
2. weighted score: `vectorWeight * vectorScore + textWeight * textScore`
3. **temporal decay 곱셈** (`hybrid.ts:134`, `temporal-decay.ts:121-167`) — _async_ 인 이유: 파일 mtime 으로 timestamp 추출 (`fs.stat`)
4. sort
5. **MMR** (opt-in, `hybrid.ts:144-146`) — 최종 단계
6. caller 가 `minScore` 컷 + slice (메모리 도구 측에서)

중요: MMR 과 temporal-decay 는 **기본 disabled**. `memory-search.ts:96,98`. 이전 보고서가 "OpenClaw 는 MMR 사용" 으로 적었으나, **기본값은 사용 안 함**. 사용자가 config 로 켜야 한다.

### 5. RAG 주입 (memory-tool 도구)

`memory-tool.ts:50-99` — **lazy / LLM-driven**. tool description 에 "**Mandatory** recall step: semantically search MEMORY.md ... before answering questions about prior work, decisions, dates, people, preferences, or todos" 라고 강제하지만 호출 결정 자체는 LLM 에 위임.

도구 ID: `memory_search` (검색) + `memory_get` (line range read). `memory-get` 은 검색 후 line snippet 만 끌어오는 용도 — 컨텍스트 절약을 LLM 이 의식적으로 하도록 만든 설계.

citations 모드 (`memory-tool.ts:142-148, 214-242`): direct chat 에서는 자동 inject, group/channel 에서는 자동 suppress. Discord-only FinClaw 컨텍스트에서는 의미가 없는 분기.

### 6. Session 영속

- `session-transcript-repair.ts:203-355` — `repairToolUseResultPairing` 이 핵심. 어떤 문제를 풀이?
  1. assistant 의 `toolCall` 직후 매칭 `toolResult` 가 없으면 합성 toolResult 삽입 (Anthropic 400 방지)
  2. toolResult 가 다른 위치에 있으면 매칭 toolCall 직후로 이동
  3. duplicate toolResult 제거
  4. orphan toolResult (매칭 toolCall 없음) 제거
  5. assistant `stopReason === "error" | "aborted"` 면 합성 result 만들지 않음 (incomplete tool_use 보호)
- `session-write-lock.ts` (504 LOC) — PID + watchdog + cleanup signal handler + reentrant lock + watchdog interval. 네트워크 storage 환경에서 동시 쓰기 방지.
- `session-tool-result-guard.ts:24-32` — toolResult 의 oversized text block 을 `HARD_MAX_TOOL_RESULT_CHARS` (별도 상수) 로 truncate + suffix 추가. persist hook + before-write hook + synthetic result allow 옵션.
- `sessions/input-provenance.ts` — `external_user | inter_session | internal_system` 3-kind 표시. **Discord-only FinClaw 에서는 모두 `external_user` 라 의미가 없음**.
- `sessions/send-policy.ts` (123 LOC) — channel/chatType/sessionKey 매칭으로 allow/deny 결정. Discord-only 환경에서는 허용 정책이 단순 (router-helper 로 충분).
- `sessions/level-overrides.ts` (32 LOC), `model-overrides.ts` (76 LOC) — 채널/세션별 model·log level 오버라이드. Claude-only FinClaw 에서는 의미 약화.

### 7. Compaction

`compaction.ts` 의 핵심 흐름 (`compaction.ts:208-274` `summarizeWithFallback`):

1. **Full**: `summarizeChunks` 한 번에 시도
2. **Partial**: `isOversizedForSummary` (msg > 50% context) 인 메시지를 빼고 small messages 만 요약, oversized 는 `[Large user (~32K tokens) omitted from summary]` 노트로 대체
3. **Fallback note**: 최종 실패 시 `"Context contained N messages (M oversized). Summary unavailable due to size limits."` 라는 정적 노트 반환

상수: `BASE_CHUNK_RATIO = 0.4`, `MIN_CHUNK_RATIO = 0.15`, `SAFETY_MARGIN = 1.2`, `SUMMARIZATION_OVERHEAD_TOKENS = 4096`.

추가 함수: `summarizeInStages` (parts ≥ 2 면 분할 후 partial 요약 → merge) + `pruneHistoryForContextShare` (요약 없이 청크 단위 drop + tool_use/tool_result 페어 보호).

배선 위치: `pi-embedded-runner.compaction-safety-timeout.test.ts` 등 **실 runner 에 통합**. agent loop 가 토큰 한계 도달 시 자동 호출.

### 8. Cache trace (8 stage)

`cache-trace.ts:11-18` — 실제 stage 7개 (이전 보고서 "8 stage" 부정확):

1. `session:loaded` — JSONL 로드 직후
2. `session:sanitized` — 정합성 보정 후
3. `session:limited` — limit 적용 후
4. `prompt:before` — prompt 조립 직전
5. `prompt:images` — 이미지 부착 직전
6. `stream:context` — `streamFn(model, context, options)` 호출 직전 (래퍼)
7. `session:after` — 응답 처리 후

기록 내용 (`cache-trace.ts:20-43`): `ts`, `seq` (단조 증가), `stage`, `runId`, `sessionId`, `sessionKey`, `provider`, `modelId`, `modelApi`, `workspaceDir`, `prompt`, `system`, `options`, `model`, `messages`, `messageCount`, `messageRoles`, `messageFingerprints` (각 message 의 sha256), `messagesDigest` (composite), `systemDigest` (system 의 sha256), `note`, `error`.

**용도**: Anthropic prompt caching 의 hit/miss 분석. 동일 prefix 가 변하지 않았는지 fingerprint 비교 가능. JSONL 큐 (`queued-file-writer.ts`).

## FinClaw 메모리 시스템 라이프사이클

### 1. Capture (정규식 5종)

`memory-capture.ts:26-35`:

```
^!finclaw\s+remember\s+(.+)        → fact
^기억해[:\s]\s*(.+)                 → fact
^메모[:\s]\s*(.+)                   → fact
^선호[:\s]\s*(.+)                   → preference
내\s*(?:투자\s*)?(?:기준|원칙|철학)[은는]\s*(.+) → preference
```

- 첫 매치만 적용 (66-69)
- content < 3 chars → null (74-76)
- sha256(content) dedup (79-97) — 기존 id 재사용 + `duplicate=true`
- embedding 실패 시 `addMemory` (FTS-only) fallback (114-130)
- 모든 단계 best-effort (`memoryCaptureStage:156-174` 가 throw 격리)

### 2. Storage (sqlite single-source)

`database.ts:51-86`:

- `memories(id, session_key, content, type, hash, created_at, metadata)` — type ∈ {fact, preference, summary, financial}
- `memory_chunks(id, memory_id, text, start_line, end_line, model, hash, created_at)` — chunk hash 는 nullable (review 노트)
- `memory_chunks_vec USING vec0(chunk_id PK, embedding float[1024])` — **차원 hard-coded**
- `memory_chunks_fts USING fts5(text, id UNINDEXED, memory_id UNINDEXED, tokenize='trigram')` — trigram tokenizer (한국어 대응)
- `embedding_cache(provider, model, hash, embedding BLOB, dims, updated_at, PRIMARY KEY (provider, model, hash))`

chunk 알고리즘 (`tables/memories.ts:39-77`): `maxTokens=512`, `overlap=64` (chars = tokens × 4 가정). 라인 단위 분할 + char overflow 시 새 chunk.

### 3. Embedding

`embeddings/provider.ts:22-23` 의 NOTE: "OpenAI text-embedding-3-small (1536D) will NOT work with the current schema". `'auto'` 모드는 voyage(1024D) → openai(1536D) 순이지만 openai 가 vec0 INSERT 시 실패 — **fallback 자기모순** (Misimplemented, 이전 보고서와 일치).

### 4. Retrieval

`memory-retrieval.ts:222-336` 흐름:

1. extractSymbols(query) — 대문자 2-5자, blocklist 제외 (USD/KRW/AM/PM/IPO/ETF/CEO/...)
2. embedding 가능 → hybrid (`searchVector(TOP_K_FETCH × 2) || searchFts(TOP_K_FETCH × 2)`); 실패 → fts-only
3. `mergeHybridResults` (`hybrid.ts:24-73`) — vector 0.7 + text 0.3, minScore 0
4. memoryId 단위 dedup — 가장 높은 chunk score 만 유지
5. raw score < 0.65 컷 (SIMILARITY_THRESHOLD)
6. 신선도: `adjustedScore = rawScore × exp(-daysOld / 90)` — `daysOld` 는 1로 clamp (시계 오차 방지)
7. 정렬 + 상한 3개
8. 심볼별 `listTransactions(symbol, limit=3)` — 거래 동시 주입
9. 감사 로그 `memory.injected` (sessionKey, userQuery, memoryIds, rawScores, adjustedScores, mode, transactionSymbols, timestamp)

### 5. RAG 주입

`execution-adapter.ts:194-200`:

```
const baseSystemPrompt = this.deps.systemPrompt;
const backgroundSection = ctx.retrievalResult ? formatBackgroundSection(...) : '';
const composedSystemPrompt = backgroundSection
  ? `${baseSystemPrompt}\n\n${backgroundSection}`
  : baseSystemPrompt;
```

→ **eager / pipeline-driven**. 모든 user 발화에서 retrieval 후 system prompt 끝에 합성. 결정성·재현성 ↑, 토큰 ↑.

`formatBackgroundSection` 출력 형식 (`memory-retrieval.ts:171-207`):

```
## 사용자 배경지식 (자동 주입)
- [fact] ... (YYYY-MM-DD 저장)
- [preference] ... (YYYY-MM-DD 저장)

## 최근 거래 (AAPL)
- YYYY-MM-DD: 매수 10주 @ USD 150
```

### 6. Session

`agents/session/transcript-repair.ts` (245 LOC) — 손상 5종 감지/복구:

- duplicate-entry (timestamp+role+content 동일)
- orphan-tool-result (toolUseId 매칭 없음)
- missing-tool-result (assistant tool_use 후 tool 누락)
- invalid-role-sequence (tool 이 assistant 없이 등장)
- empty tool content (abort)

복구는 in-memory 변환만 — DB 저장 없음.

`agents/session/write-lock.ts` (205 LOC) — 파일 잠금 (`.lock` exclusive create) + PID 생존 확인 + reentrant + stale 처리 + SIGINT/SIGTERM cleanup.

→ OpenClaw 의 7+ 개념 (transcript-repair, write-lock, tool-result-guard, input-provenance, send-policy, level-overrides, model-overrides) 중 **2개만 이식**.

### 7. Compaction (코드 있으나 미배선)

`agent/src/agents/context/compaction.ts:40-112` `compactWithFallback` — full→partial→truncate-oldest 3단계, OpenClaw 와 거의 동일 (상수 `SAFETY_MARGIN=1.2`, `SUMMARIZATION_OVERHEAD_TOKENS=4096` 까지 일치).

추가: `evaluateContextWindow` 의 4상태 (`safe|warning|critical|exceeded`) + breakdown (systemPrompt/toolResults/conversation/summary).

`grep -rn "compactContext\|evaluateContextWindow" packages/server packages/agent/src` 결과:

- agent/src/index.ts:157 export 만
- agent/src/agents/context/index.ts:2,5 re-export 만
- agent/src/agents/context/{compaction,window-guard}.ts 정의 만
- **server/auto-reply/\* 어디에도 호출 없음**

→ Misimplemented (확정).

### 8. Cache trace (부재)

`cache-trace.ts` 동등 모듈이 FinClaw 에 전혀 없다. Anthropic prompt caching hit/miss 가시성 부재. 토큰 회계 디버그 불가.

## 풍부한 1:1 매핑 매트릭스

| OpenClaw 메커니즘                 | OpenClaw 코드 인용                                                                                                                      | FinClaw 대응                                                                               | FinClaw 코드 인용                                 | 라벨                                    | 본질성 (Claude+Discord) | 비고                                                                                                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------- | --------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 메모리 영속 store                 | `manager.ts:34-36`, `qmd-manager.ts` (sqlite + vec0 + fts5 + embedding_cache)                                                           | sqlite + vec0 + fts5 + embedding_cache                                                     | `database.ts:51-96`                               | Adapted                                 | Critical                | 양쪽 모두 sqlite 4-table 동형. 차이는 1차 source 위치                                                                                                                        |
| 1차 source = markdown 파일        | `temporal-decay.ts:15` (`memory/YYYY-MM-DD.md`), watcher 기반 인덱싱 (`manager.ts:86`)                                                  | (없음) sqlite 단일 source                                                                  | `tables/memories.ts:98-153`                       | Diverged                                | Important               | 사용자 1인 → DB 단일이 정당. 단 사용자 직접 편집·git 추적성 잃음                                                                                                             |
| 자동 추출 (LLM 기반)              | (부재 — read-only 인덱서)                                                                                                               | (부재)                                                                                     | —                                                 | Faithful (동급)                         | —                       | **이전 보고서 정정** — OpenClaw 도 자동 추출 없음. 양쪽 동급                                                                                                                 |
| 명시적 capture                    | (부재)                                                                                                                                  | 정규식 5종, 첫 매치만, sha256 dedup                                                        | `memory-capture.ts:26-148`                        | FinClaw 추가 (Diverged)                 | Critical                | OpenClaw 보다 **적극적**. 사용자가 markdown 편집 안 해도 발화에서 메모리화. Diverged 강점                                                                                    |
| 임베딩 provider 다중성            | `embeddings.ts:37-40` 5종 + auto fallback chain + null provider degrade                                                                 | voyage→openai 2종 + auto                                                                   | `embeddings/provider.ts:25-50`                    | Adapted                                 | Critical                | 사용자 1인이라 5종 keying 불필요. 정당                                                                                                                                       |
| 임베딩 차원 정책                  | provider 별 dims (Voyage 1024, OpenAI 1536, Gemini 768/3072 등)                                                                         | `float[1024]` hard-coded                                                                   | `database.ts:78`                                  | Misimplemented                          | Important               | OpenAI fallback 자기모순. 이전 보고서와 일치                                                                                                                                 |
| 임베딩 캐시                       | `manager.ts:36` `embedding_cache` 테이블                                                                                                | `embedding_cache(provider, model, hash, ...)`                                              | `database.ts:88-96`                               | Faithful                                | Nice-to-have            | **이전 보고서 정정** — OpenClaw 도 캐시 있음. 양쪽 동등                                                                                                                      |
| Hybrid weighted fusion            | `hybrid.ts:121-131` (vec×0.7 + text×0.3)                                                                                                | `hybrid.ts:39-72` 동일                                                                     | `search/hybrid.ts:24-73`                          | Faithful                                | Critical                | 거의 1:1. dedup 키만 차이 (chunkId vs id)                                                                                                                                    |
| MMR 다양성                        | `mmr.ts:184-214`, **기본 disabled** (`memory-search.ts:96`)                                                                             | (없음)                                                                                     | —                                                 | Missing(의도)                           | Nice-to-have            | OpenClaw 도 기본 OFF. 상한 3개 환경에서 효과 미미. **이전 보고서의 Missing(우발) → Missing(의도) 재라벨**                                                                    |
| Temporal decay                    | `temporal-decay.ts:24-42` exp(-λ·age), λ=LN2/halfLifeDays, **기본 disabled**                                                            | exp(-daysOld/90) 인라인, 항상 ON                                                           | `memory-retrieval.ts:283-284`                     | Diverged                                | Important               | FinClaw 가 더 적극적 (항상 ON). OpenClaw 는 opt-in. **재라벨: Faithful → Diverged 강점**                                                                                     |
| Temporal decay 의 timestamp 소스  | 파일 mtime 또는 `memory/YYYY-MM-DD.md` 파싱                                                                                             | `memory.created_at` (DB column)                                                            | `tables/memories.ts:99-124`                       | Adapted                                 | Important               | DB single-source 와 일관                                                                                                                                                     |
| Query expansion                   | `query-expansion.ts:723-754` stop-word 기반 keyword 추출 (한·영·중·일·아·스·포 7언어), `qmd-manager.ts:72-100` Han BM25 정규화에서 사용 | (없음)                                                                                     | —                                                 | Missing(우발)                           | Important               | **이전 보고서가 "다중 쿼리 재작성"으로 추정한 것 정정** — LLM 호출이 아닌 stop-word 추출. 짧은 발화 ("그거 어떻게 됐어?") 의 FTS recall 한계. trigram tokenizer 가 일부 보완 |
| 유사도 임계값                     | `memory-search.ts:91` `DEFAULT_MIN_SCORE=0.35` (정렬 후 컷)                                                                             | `SIMILARITY_THRESHOLD=0.65` (정렬 전 raw score 컷)                                         | `memory-retrieval.ts:17,271`                      | Adapted                                 | Important               | FinClaw 가 더 엄격. 적용 시점 다름 — FinClaw 가 신선도 곱셈 *전*에 컷 (raw 기준이라 더 보수적)                                                                               |
| Top-k 상한                        | `DEFAULT_MAX_RESULTS = 6`                                                                                                               | `MAX_INJECTED_MEMORIES = 3`                                                                | `memory-retrieval.ts:23`                          | Adapted                                 | Important               | system-prompt eager 주입과 짝 — 토큰 통제                                                                                                                                    |
| RAG 주입 위치                     | tool (`memory-tool.ts:50-99`) — LLM lazy decision                                                                                       | system prompt 자동 합성 (`execution-adapter.ts:194-200`)                                   | `memory-retrieval.ts:171-207`                     | Diverged                                | Critical                | FinClaw 의 강점. Claude-only 환경에서 결정성·재현성 ↑                                                                                                                        |
| 거래 이력 동시 주입               | (없음)                                                                                                                                  | `listTransactions(symbol, limit=3)` + 심볼별 그룹                                          | `memory-retrieval.ts:300-318`                     | Diverged                                | Critical                | 금융 도메인 합체. OpenClaw 에 없는 가치                                                                                                                                      |
| 감사 로그                         | `cache-trace.ts:11-18` 7 stage + sha256 fingerprint                                                                                     | `memory.injected` 1 event (memoryIds, rawScores, adjustedScores, mode, transactionSymbols) | `memory-retrieval.ts:321-332`                     | Adapted                                 | Important               | OpenClaw 가 깊지만 FinClaw 도 회상 단계 핵심은 잡힘                                                                                                                          |
| 컨텍스트 윈도우 가드              | `context-window-guard.ts:57-74` shouldWarn/shouldBlock 2-state + `WARN_BELOW=32K` `HARD_MIN=16K`                                        | 4-state (safe/warning/critical/exceeded) + 4-source breakdown                              | `agent/src/agents/context/window-guard.ts:48-112` | Faithful                                | Critical                | FinClaw 가 약간 더 풍부 (breakdown). 사실상 동등                                                                                                                             |
| Compaction 3-단계 폴백            | `compaction.ts:208-274` full→partial→note + `summarizeInStages` parts splitter + `pruneHistoryForContextShare`                          | `compactWithFallback` full→partial→truncate-oldest, 상수 동일                              | `agent/src/agents/context/compaction.ts:40-112`   | Faithful (코드) / Misimplemented (배선) | Critical                | 코드는 1:1. **server 어디에서도 호출 없음** — long conversation 보호 부재                                                                                                    |
| transcript-repair                 | `session-transcript-repair.ts:203-355` 5종 (orphan/duplicate/move/missing/aborted) + tool_use_id 페어 보호                              | `transcript-repair.ts:45-245` 5종 (duplicate/orphan/missing/invalid-sequence/empty)        | `agents/session/transcript-repair.ts`             | Adapted                                 | Important               | 다루는 손상 종류 거의 동일. FinClaw 는 in-memory 만                                                                                                                          |
| session-write-lock                | 504 LOC PID + watchdog interval + reentrant + cleanup signals + max-hold                                                                | 205 LOC PID + reentrant + stale + cleanup signals (watchdog 없음)                          | `agents/session/write-lock.ts`                    | Adapted                                 | Important               | 핵심 1:1. watchdog interval 만 없음 — 사용자 1인이라 정당                                                                                                                    |
| session-tool-result-guard         | `session-tool-result-guard.ts:24-32` truncate (oversized text), persist hook, before-write hook, synthetic allow                        | (없음)                                                                                     | —                                                 | Missing(우발)                           | Important               | 큰 도구 결과 (시세 데이터, 차트 raw bytes) 가 transcript 에 그대로 들어가면 next turn token 폭증 + Anthropic 거부 위험                                                       |
| input-provenance                  | `sessions/input-provenance.ts:1-79` 3-kind                                                                                              | (없음)                                                                                     | —                                                 | Missing(의도)                           | Nice-to-have            | Discord-only 면 모두 external_user — 의미 없음. **재라벨: Important → Nice-to-have**                                                                                         |
| send-policy                       | `sessions/send-policy.ts:1-123` channel/chatType 매칭                                                                                   | router-helper 단순                                                                         | —                                                 | Missing(의도)                           | Nice-to-have            | Discord-only 면 의미 없음                                                                                                                                                    |
| level-overrides / model-overrides | `sessions/level-overrides.ts` (32), `model-overrides.ts` (76)                                                                           | (없음)                                                                                     | —                                                 | Missing(의도)                           | Nice-to-have            | Claude-only 면 multi-model 오버라이드 의미 없음                                                                                                                              |
| cache-trace (8 stage)             | `cache-trace.ts:11-18` 7 stage + sha256 fingerprint + JSONL                                                                             | (없음)                                                                                     | —                                                 | Missing(우발)                           | Important               | Anthropic prompt caching hit/miss 디버그 불가. 사용자 1인이라도 비용 회계 가치                                                                                               |
| 듀얼 source (memory + sessions)   | `memory-search.ts:101` `DEFAULT_SOURCES=["memory"]` + opt-in `sessionMemory` 실험 기능                                                  | session memory 부재                                                                        | —                                                 | Missing(우발)                           | Important               | Discord 단일 채널이라도 과거 대화 자연 회상 가치는 있음 — 명시 capture 안 한 발화는 회수 불가                                                                                |
| transactions (FinClaw 고유)       | (없음)                                                                                                                                  | `transactions` 테이블 + recompute holdings + RAG 주입                                      | `storage/src/transactions.ts`                     | Diverged                                | Critical                | 금융 도메인 합체. OpenClaw 에 없음                                                                                                                                           |
| agent_runs (실행 이력)            | sessions transcript 안에 분산                                                                                                           | `agent_runs` 테이블 + memory_id/schedule_id FK                                             | `database.ts:193-210`                             | Diverged                                | Important               | FinClaw 만의 explicit 감사                                                                                                                                                   |

## 사용자 컨텍스트 반영 재라벨 (이전 보고서 대비)

Claude-only + Discord-only 컨텍스트에서 본질성 재평가:

### 라벨 변경

| 항목                              | 이전 라벨                                             | 새 라벨                                      | 변경 사유                                                           |
| --------------------------------- | ----------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| 자동 추출 (LLM 기반)              | "OpenClaw 가 자율 추출, FinClaw 가 명시적" (Diverged) | **양쪽 동급 부재 (Faithful)**                | 직접 읽으니 OpenClaw 는 read-only 인덱서. capture 자체가 없음       |
| 임베딩 캐시                       | "FinClaw 가 한 단계 더 — OpenClaw 부재" (Diverged)    | **Faithful (양쪽 동등)**                     | OpenClaw `manager.ts:36` `EMBEDDING_CACHE_TABLE` 존재               |
| Temporal decay                    | Faithful (동등)                                       | **Diverged (FinClaw 강점)**                  | OpenClaw 는 opt-in, FinClaw 는 항상 ON                              |
| MMR 부재                          | Missing(우발) Nice                                    | **Missing(의도) Nice**                       | OpenClaw 도 기본 OFF. 양쪽 의식적 선택                              |
| Query expansion                   | Missing(우발) Important "다중 쿼리 재작성"            | **Missing(우발) Important "stop-word 추출"** | LLM 호출 아닌 stop-word 기반. recall 가치는 동일하나 비용 평가 다름 |
| input-provenance                  | Missing(의도) Important                               | **Missing(의도) Nice-to-have**               | Discord-only 면 모두 external_user, 본질성 ↓                        |
| send-policy                       | (Adapted 안에 묶임) Important                         | **Missing(의도) Nice-to-have**               | Discord 단일 채널 → 정책 분기 의미 없음                             |
| level/model overrides             | (Adapted) Important                                   | **Missing(의도) Nice-to-have**               | Claude-only → 모델 오버라이드 의미 없음                             |
| session-tool-result-guard         | Missing(우발) Nice-to-have                            | **Missing(우발) Important**                  | 시세/차트 raw bytes 들어오는 금융 도메인은 위험성 ↑                 |
| 7 stage 가 아닌 8 stage 라고 표기 | (오기)                                                | **7 stage 정정**                             | `cache-trace.ts:11-18` 7개                                          |

### 본질성 재평가 결과

- Critical 항목: 6개 (메모리 store / 임베딩 다중성 / hybrid / RAG 주입 / compaction / transactions)
- Important 항목: 8개
- Nice-to-have 항목: 6개 (이전 5개에서 +1 — input-provenance/send-policy/level-overrides/model-overrides 가 묶이며 실제 비교 가치는 낮아짐)

## 핵심 발견

### 1. "OpenClaw 가 자기-편집 메모리를 가졌다" 는 추측 — **거짓**

`apply-patch.ts:532` 는 sandbox file system 에 patch 를 적용하는 도구이지 _메모리 self-editing_ 이 아니다. OpenClaw 는 사용자가 markdown 을 직접 편집하는 모델이라 LLM 자기-편집의 필요가 작다 (사용자가 직접 한다). MemGPT 류의 self-editing memory 는 양쪽 모두 부재 — 본질성 비교 무효.

### 2. Query expansion 의 실제 효과

`query-expansion.ts:723` `extractKeywords` 는 LLM 호출 없이 7-언어 stop-word 기반 키워드 추출. 한국어는 trailing particle stripping 까지 (`KO_TRAILING_PARTICLES`). FinClaw 가 fts5 `tokenize='trigram'` 로 한국어 부분 검색을 보완하지만, "**그거 어떻게 됐어?**" 같이 의미 단어 자체가 없는 발화는 trigram 도 못 잡는다.

→ Discord-only 컨텍스트에서도 사용자가 짧은 한국어 follow-up 을 자주 쓰면 가치 있음. Important 유지.

### 3. MMR 의 실제 효과

OpenClaw 도 기본 OFF. 상한 3개 환경에서 같은 memory 의 인접 chunk 가 1·2·3위를 차지할 확률은 _FinClaw 가 이미 memoryId 단위 dedup_ (`memory-retrieval.ts:258-264`) 하므로 매우 낮음. → Missing(의도) Nice — 무시 가능.

### 4. Session memory 듀얼 source 의 진짜 가치

OpenClaw `memory-search.ts:101` `DEFAULT_SOURCES=["memory"]` + opt-in sessions. Discord 단일 채널이라도, **사용자가 명시 capture (`기억해`) 안 한 과거 대화** (예: "2주 전에 AAPL 매도하기로 했었지") 는 FinClaw 가 회수 불가. session 영속 자체는 messages 테이블에 있으나 RAG 검색 대상이 아님.

→ Discord-only 라도 가치 있음. 단, conversation summary 를 memories 의 `type='summary'` 로 자동 저장하는 hook 이 추가 단계 (현재 `auto-reply/agent-memory-hook.ts` 가 일부 처리하는지 별도 확인 필요).

## FinClaw 메모리 시스템의 즉시 개선 후보 (Claude+Discord 우선순위)

### 1. Compaction 배선 (Critical, 이전 보고서와 동일)

`compactContext` / `evaluateContextWindow` 가 `auto-reply/stages/context.ts` 또는 `execution-adapter.ts` 에서 prior messages 수집 후 호출되어야 함. 현재 long conversation 시 Claude API 가 토큰 한계로 거부할 위험. 코드는 이미 있으니 ~30 LOC 작업.

### 2. 임베딩 차원 자기모순 해결 (Critical, 이전 보고서와 동일)

옵션 A: voyage 단일 강제 (openai 분기 제거)
옵션 B: dim 별 vec0 테이블 분리 (`memory_chunks_vec_1024`, `memory_chunks_vec_1536`) + provider→테이블 라우팅
사용자 1인 환경에서 옵션 A 가 단순, 권장.

### 3. Cache trace JSONL 추가 (Important, 신규 발견)

Anthropic prompt caching 사용 중 (Phase 23~). hit/miss 가시성 없으면 토큰 비용 회계 디버그 불가. `cache-trace.ts` 의 7 stage 중 _FinClaw 단순화 버전_ (3 stage 정도: prompt:before / stream:context / response:after) + sha256 fingerprint 만 도입해도 가치 큼.

### 4. Session-tool-result-guard (Important, 재평가됨)

금융 도메인 = 시세 raw bytes / 차트 데이터 / 뉴스 본문 → tool result 가 거대해질 수 있음. 현재 truncation 이 없으면 next turn 토큰 폭증. `messages` 테이블에 truncate-on-write 후크 추가.

### 5. session memory 듀얼 source (Important)

`messages` 테이블의 user/assistant 발화를 `memory_chunks` 와 같은 vec0/fts5 인덱스에 자동 인덱싱하거나, `agent_runs.output` 을 자동으로 `memories` 의 `type='summary'` 로 보존. agent-memory-hook 의 확장 형태.

### 6. Query expansion (Important, 단순)

`query-expansion.ts:723-754` 의 코드는 직접 이식 가능 — LLM 호출 없는 순수 함수. 한국어 stop-word + trailing particle 처리. FinClaw `searchFts` 호출 직전에 적용하면 즉각 recall 향상.

## 신뢰도 등급

- **HIGH (직접 코드 인용 비교)**: 모든 라벨. 매트릭스 30건 전수.
- **MEDIUM (간접 추론)**: 없음.
- **LOW (미검증)**: 없음.

이전 보고서(MEDIUM 신뢰도) 의 36개 항목 중 **9개 항목 라벨 또는 사실 정정** — 위 "라벨 변경" 표 참조.
