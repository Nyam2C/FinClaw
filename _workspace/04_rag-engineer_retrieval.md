# 04 — RAG 엔지니어: MemoryRetrievalService (밀스톤 C 1차)

## 1. 신설 모듈

`packages/server/src/auto-reply/stages/memory-retrieval.ts` (~280 LOC)

본 단계는 **검색 서비스 + 섹션 빌더 + 감사 로그** 만 산출. pipeline 배선·system prompt 통합은 다음 단계 pipeline-engineer 가 처리.

## 2. 상수 (단일 출처)

```ts
SIMILARITY_THRESHOLD = 0.65; // raw 점수 컷오프
FRESHNESS_HALF_LIFE_DAYS = 90; // exp(-daysOld / 90)
MAX_INJECTED_MEMORIES = 3; // 프롬프트 비용 상한
TOP_K_FETCH = 5; // 임계값 컷 후 3개 채울 여유
SYMBOL_TX_LIMIT = 3; // 심볼당 거래 이력 N건
```

내부 `SEARCHABLE_TYPES = {fact, preference, financial}` (summary 는 자동 회상에서 제외).

`SYMBOL_BLOCKLIST` — 통화(USD/KRW/EUR/JPY/GBP/CNY/HKD/CHF/CAD/AUD), 시간대(AM/PM/EST/PST/KST/UTC/GMT), 관용 약어(IPO/ETF/CEO/CFO/CTO/GDP/FED/SEC/IRS/ROI/EPS/PER/PBR).

매직 넘버 산재 금지: 다른 모듈은 본 모듈에서 import.

## 3. 알고리즘 (의사코드)

```
input: { userQuery, sessionKey }

# 1. 모드 결정 + 검색
mode = embeddingProvider ? 'hybrid' : 'fts-only'

if mode == 'hybrid':
  try:
    [vec, fts] = await Promise.all([
      searchVector(db, userQuery, provider, TOP_K_FETCH * 2),  # chunk 단위
      searchFts   (db, userQuery,           TOP_K_FETCH * 2),
    ])
    merged = mergeHybridResults(vec, fts, { limit: TOP_K_FETCH * 2, minScore: 0 })
  catch err:
    logger.warn('memory.retrieval.embedding_failed', err.message)
    mode = 'fts-only'
    merged = searchFts(db, userQuery, TOP_K_FETCH * 2)
else:
  merged = searchFts(db, userQuery, TOP_K_FETCH * 2)

# 2. memoryId 별 dedup (가장 높은 chunk score 채택)
bestByMemory = {}
for r in merged:
  if r.memoryId not in bestByMemory or r.score > bestByMemory[r.memoryId].score:
    bestByMemory[r.memoryId] = r

# 3. 메타 로드 + 임계값 + 신선도
candidates = []
for r in bestByMemory.values():
  if r.score < SIMILARITY_THRESHOLD: continue        # 컷오프
  entry = getMemory(db, r.memoryId)
  if not entry: continue                             # 인덱스/테이블 불일치
  if entry.type not in SEARCHABLE_TYPES: continue
  daysOld = max(1, (now - entry.createdAt) / 86_400_000)   # ≥ 1 clamp
  adjustedScore = r.score * exp(-daysOld / 90)
  candidates.append({id, content, type, createdAt, rawScore=r.score, adjustedScore, daysOld})

# 4. 정렬 + 상한
candidates.sort(by adjustedScore desc)
snippets = candidates[:MAX_INJECTED_MEMORIES]

# 5. 거래 동시 주입
symbols = extractSymbols(userQuery)                  # 정규식 + 블록리스트
transactions = []
for symbol in symbols:
  txs = listTransactions(db, { symbol, limit: SYMBOL_TX_LIMIT })  # executed_at DESC
  transactions.extend(map(toInjected, txs))

# 6. 감사 로그
auditLog = {
  event: 'memory.injected',
  sessionKey, userQuery,
  memoryIds: snippets.map(.id),
  rawScores: snippets.map(.rawScore),
  adjustedScores: snippets.map(.adjustedScore),
  mode,
  transactionSymbols: symbols,
  timestamp: now,
}
logger.info('memory.injected', auditLog)

return { snippets, transactions, mode, auditLog }
```

## 4. 공개 인터페이스 (pipeline-engineer 사용)

```ts
import {
  DefaultMemoryRetrievalService,
  formatBackgroundSection,
  type MemoryRetrievalService,
  type MemoryRetrievalServiceDeps,
  type RetrievalResult,
  type MemorySnippet,
  type InjectedTransaction,
  type AuditLog,
} from '../stages/memory-retrieval.js';

interface MemoryRetrievalService {
  searchRelevant(input: { userQuery: string; sessionKey: SessionKey }): Promise<RetrievalResult>;
}

interface RetrievalResult {
  readonly snippets: readonly MemorySnippet[]; // ≤ 3
  readonly transactions: readonly InjectedTransaction[]; // 심볼별 ≤ 3
  readonly mode: 'hybrid' | 'fts-only';
  readonly auditLog: AuditLog; // 이미 emit 됨, 디버그 반환용
}
```

`DefaultMemoryRetrievalService` 의존성 주입:

```ts
new DefaultMemoryRetrievalService({
  db: DatabaseSync,
  embeddingProvider?: EmbeddingProvider,
  logger: FinClawLogger,
})
```

`formatBackgroundSection(result): string` — system prompt 삽입용 마크다운 빌더. 빈 결과 시 빈 문자열.

`extractSymbols(text): string[]` — 단순 정규식 (대문자 2-5자) + 블록리스트. export.

## 5. 감사 로그 형식

```json
{
  "event": "memory.injected",
  "sessionKey": "<sessionKey>",
  "userQuery": "<원문>",
  "memoryIds": ["m1", "m2", "m3"],
  "rawScores": [0.81, 0.72, 0.68],
  "adjustedScores": [0.78, 0.55, 0.41],
  "mode": "hybrid",
  "transactionSymbols": ["AAPL"],
  "timestamp": 1730000000000
}
```

`logger.info('memory.injected', auditLog)` 한 줄. SQL/jq 분석 가능.

## 6. 빈 결과/에러 처리

| 상황                                    | 동작                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------- |
| snippets·transactions 모두 0            | `formatBackgroundSection` 빈 문자열 → caller 가 섹션 자체 생략         |
| embeddingProvider 미주입                | `mode='fts-only'`, audit log 동일 형식                                 |
| 임베딩 throw                            | `logger.warn('memory.retrieval.embedding_failed')` → fts-only fallback |
| `getMemory` null (인덱스/테이블 불일치) | 조용히 skip                                                            |
| `daysOld` < 0 (시계 오차)               | 1 로 clamp                                                             |

## 7. 다음 단계 (pipeline-engineer) 작업 가이드

1. `pipeline-context.ts` 의존성에 `memoryRetrievalService?: MemoryRetrievalService` 추가.
2. `pipeline.ts` Context 단계 직전 (또는 직후) 에 `await memoryRetrievalService?.searchRelevant({userQuery: text, sessionKey})` 호출.
3. 결과를 `enrichedCtx.memoryContext` 등으로 실어 Execute 단계 system prompt 빌더로 전달.
4. `formatBackgroundSection(result)` 결과를 system prompt 의 적절한 위치 (예: `buildFinanceContextSection` 직전/후) 에 prepend.
5. 빈 문자열이면 prepend 자체 생략 (빈 헤더 노출 방지).

## 8. 산출물 + 테스트 결과

**신설 파일:**

- `packages/server/src/auto-reply/stages/memory-retrieval.ts` (280 LOC)
- `packages/server/src/auto-reply/__tests__/memory-retrieval.storage.test.ts` (510 LOC, 22 tests)

**기존 파일 변경:** 없음 (외과적 변경 원칙 준수)

**검증 결과:**
| 명령 | 결과 |
|---|---|
| `pnpm build` | OK |
| `pnpm typecheck` | OK |
| `pnpm lint` | 0 warnings, 0 errors |
| `pnpm test:storage` | 87/87 passed (memory-retrieval 22/22 포함) |
| `pnpm test` | 1441/1441 passed (기존 테스트 무손상) |

## 9. 테스트 시나리오 커버리지

| 시나리오                                | 테스트                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| 심볼 추출 (정상/통화/시간대/약어/dedup) | `extractSymbols` 6 cases                                                     |
| 빈 결과 → 빈 섹션                       | `formatBackgroundSection: returns empty string`                              |
| snippets-only 포맷                      | `formats snippets-only result`                                               |
| transactions-only 포맷                  | `formats transactions-only result`                                           |
| 심볼별 그룹화                           | `groups transactions by symbol`                                              |
| price=null (배당)                       | `omits price suffix when price is null`                                      |
| hybrid 모드 매칭                        | `returns matching memory for identical query/content`                        |
| 감사 로그 emit                          | `emits memory.injected audit log`                                            |
| 상한 3개                                | `caps results at MAX_INJECTED_MEMORIES`                                      |
| 신선도 가중치                           | `freshness: yesterday-saved memory ranks above 90-days-old`                  |
| 임계값 컷                               | `excludes results with rawScore below SIMILARITY_THRESHOLD`                  |
| `SIMILARITY_THRESHOLD === 0.65`         | constant guard                                                               |
| fts-only (provider 미주입)              | `uses fts-only when embeddingProvider is undefined`                          |
| fts-only fallback (provider throw)      | `falls back to fts-only when embedding throws and warns`                     |
| 빈 결과 → 빈 섹션 (E2E)                 | `formatBackgroundSection returns empty when no snippets and no transactions` |
| 거래 주입 (심볼 매치)                   | `injects up to SYMBOL_TX_LIMIT transactions when query mentions symbol`      |
| 거래 주입 X (심볼 미매치)               | `does not inject transactions when no symbol detected`                       |

mock-only 임베딩 (결정론적 sparse vector) — 외부 API 키 불필요.
