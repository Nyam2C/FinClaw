# Phase 14 Review-2: Todo-2 검색 & 임베딩 계층

## 구현 완료 여부

### 파일 목록 (todo-2 대비)

| #   | 파일                                                   | 상태 | 비고                                                       |
| --- | ------------------------------------------------------ | ---- | ---------------------------------------------------------- |
| 1   | `packages/storage/src/search/hybrid.ts`                | ✅   | ChunkSearchResult, HybridSearchOptions, mergeHybridResults |
| 2   | `packages/storage/src/search/fts.ts`                   | ✅   | buildFtsQuery, bm25RankToScore, searchFts                  |
| 3   | `packages/storage/src/search/vector.ts`                | ✅   | cosineSimilarity, searchVector, float32ToBuffer            |
| 4   | `packages/storage/src/embeddings/provider.ts`          | ✅   | EmbeddingProvider, EmbeddingMode, createEmbeddingProvider  |
| 5   | `packages/storage/src/embeddings/anthropic.ts`         | ✅   | AnthropicEmbeddingProvider, BATCH_SIZE=50                  |
| 6   | `packages/storage/src/embeddings/openai.ts`            | ✅   | OpenAIEmbeddingProvider, BATCH_SIZE=100                    |
| 7   | `packages/storage/src/tables/embeddings.ts` (확장)     | ✅   | embedBatchWithCache 추가                                   |
| 8   | `packages/storage/src/tables/memories.ts` (확장)       | ✅   | addMemoryWithEmbedding 추가                                |
| 9   | `packages/storage/src/index.ts` (업그레이드)           | ✅   | searchMemory 하이브리드 교체 + saveMemory 임베딩 연동      |
| 10  | `packages/storage/src/reindex.ts`                      | ✅   | atomicReindex 구현                                         |
| 11  | `packages/storage/src/search/hybrid.test.ts`           | ✅   | 8개 테스트 케이스                                          |
| 12  | `packages/storage/src/search/fts.storage.test.ts`      | ✅   | 6개 테스트 케이스                                          |
| 13  | `packages/storage/src/search/vector.storage.test.ts`   | ✅   | 5개 테스트 케이스                                          |
| 14  | `packages/storage/src/tables/memories.storage.test.ts` | ✅   | 13개 테스트 케이스 (CRUD 8 + embedding 5)                  |

**결론: todo-2에 명시된 모든 파일과 함수가 구현됨.**

### 검증 항목 (todo-2 §검증 기준 대응)

| #   | 검증 항목          | 대응                                                               | 상태 |
| --- | ------------------ | ------------------------------------------------------------------ | ---- |
| 7   | FTS5 검색          | fts.storage.test.ts: exact match, trigram, limit, empty, BM25 순서 | ✅   |
| 8   | 벡터 검색          | vector.storage.test.ts: KNN, limit, cosineSimilarity 단위테스트    | ✅   |
| 9   | 하이브리드 검색    | hybrid.test.ts: 가중치 합산, 필터, 정렬, limit                     | ✅   |
| 10  | 임베딩 캐시        | memories.storage.test.ts: embedBatchWithCache 캐시 히트 확인       | ✅   |
| 15  | Atomic reindex     | reindex.ts: atomicReindex 구현                                     | ✅   |
| 17  | vec0 삭제 동기화   | memories.storage.test.ts: deleteMemory vec0+FTS 삭제 확인          | ✅   |
| 18  | trigram 한국어 FTS | fts.storage.test.ts: '삼성전' 부분 매칭 테스트                     | ✅   |
| 19  | 임베딩 캐시 HIT    | memories.storage.test.ts: embedding_cache 행 수 확인               | ⚠️   |

---

## 발견된 이슈

### I-1. ChunkSearchResult 필드명 변경: `id` → `chunkId` (Medium)

**todo-2 명세:**

```typescript
export interface ChunkSearchResult {
  readonly id: string;        // ← todo-2 spec
  readonly memoryId: string;
  ...
}
```

**구현 (`hybrid.ts:4`):**

```typescript
readonly chunkId: string;     // ← 실제 구현
```

`id` → `chunkId`로 변경됨. fts.ts, vector.ts, hybrid.ts, hybrid.test.ts 모두 일관되게 `chunkId`를 사용하므로 내부적으로 정합성은 있다. 의미적으로는 `chunkId`가 더 명확하다. plan과의 차이이지만, 의도적 개선으로 보인다.

### I-2. HybridSearchOptions에서 `query` 필드 누락 (Low)

**todo-2 명세:**

```typescript
export interface HybridSearchOptions {
  readonly query: string;        // ← todo-2에 포함
  readonly limit?: number;
  ...
}
```

**구현 (`hybrid.ts:11-16`):** `query` 필드가 없다.

`mergeHybridResults`는 순수 함수로 query 문자열이 불필요하므로, 제거한 것은 합리적이다. `query`는 상위 레이어(index.ts의 searchMemory)에서 처리한다.

### I-3. createEmbeddingProvider config 시그니처 변경 (Medium)

**todo-2 명세:**

```typescript
export function createEmbeddingProvider(
  mode: EmbeddingMode,
  config: { anthropicApiKey?: string; openaiApiKey?: string },
): Promise<EmbeddingProvider>;
```

**구현 (`provider.ts:13-15, 24-27`):**

```typescript
export interface EmbeddingConfig {
  readonly apiKey?: string; // 단일 apiKey
}
export async function createEmbeddingProvider(
  mode: EmbeddingMode,
  config?: EmbeddingConfig, // optional + 단일 키
): Promise<EmbeddingProvider>;
```

변경 사항:

1. `config`가 optional이 됨
2. `anthropicApiKey`/`openaiApiKey` 두 개가 하나의 `apiKey`로 통합됨

이 설계에서는 `auto` 모드일 때 anthropic이 실패하면 openai로 폴백하는데, 두 프로바이더에 서로 다른 API 키를 전달할 수 없다. 각 프로바이더 생성자가 `process.env`에서 각자의 환경변수(`VOYAGE_API_KEY`, `OPENAI_API_KEY`)를 읽으므로 실제 운용에는 문제 없으나, 프로그래밍 방식 키 주입이 제한된다.

### I-4. createEmbeddingProvider의 auto 모드 로직 (Medium)

**todo-2 명세:**

> `'auto'` → anthropicApiKey 있으면 anthropic, 그 다음 openaiApiKey → 둘 다 없으면 Error

**구현 (`provider.ts:28-42`):**

```typescript
if (mode === 'anthropic' || mode === 'auto') {
  try {
    const { AnthropicEmbeddingProvider } = await import('./anthropic.js');
    return new AnthropicEmbeddingProvider(config?.apiKey);
  } catch {
    if (mode === 'anthropic') throw new Error('...');
  }
}
```

auto 모드에서 API 키 존재 여부가 아닌, 생성자의 throw 여부로 폴백을 결정한다. `AnthropicEmbeddingProvider` 생성자에서 `VOYAGE_API_KEY`가 없으면 throw → catch → openai 시도. 이는 API 키 유무 체크와 동일한 효과이지만, import 실패 등 다른 에러도 삼켜버릴 수 있다. catch 블록에서 에러 타입을 구분하지 않는 점이 약점.

### I-5. searchVector SQL — todo-2와 다른 vec0 쿼리 구문 (High)

**todo-2 명세:**

```sql
SELECT c.id, c.memory_id, c.text, vec_distance_cosine(v.embedding, ?) AS distance
FROM memory_chunks_vec v
JOIN memory_chunks c ON c.id = v.chunk_id
ORDER BY distance ASC
LIMIT ?
```

**구현 (`vector.ts:46-51`):**

```sql
SELECT v.chunk_id, c.memory_id, c.text, v.distance
FROM memory_chunks_vec v
JOIN memory_chunks c ON c.id = v.chunk_id
WHERE v.embedding MATCH ? AND k = ?
ORDER BY v.distance
```

vec0 가상 테이블은 `vec_distance_cosine()` 함수가 아닌 `MATCH` + `k =` 구문으로 KNN 검색을 수행한다. 이것은 sqlite-vec의 실제 API에 맞는 올바른 구문이다. todo-2 명세의 SQL이 잘못되었고, 구현이 정확하다. `LIMIT ?` 대신 `k = ?`로 KNN 수를 지정하는 것도 sqlite-vec 표준이다.

### I-6. HybridSearchOptions의 `options` 파라미터가 optional로 변경 (Low)

**todo-2 명세:**

```typescript
export function mergeHybridResults(
  vectorResults: ChunkSearchResult[],
  ftsResults: ChunkSearchResult[],
  options: Pick<HybridSearchOptions, ...>,   // required
): ChunkSearchResult[];
```

**구현 (`hybrid.ts:25`):**

```typescript
options?: HybridSearchOptions,               // optional, full type
```

`options`가 optional이 되었고, `Pick<...>` 대신 전체 `HybridSearchOptions`를 받는다. 모든 필드가 optional이므로 기본값이 적용된다. 유연성 향상이며 문제 없다.

### I-7. mergeHybridResults 입력 타입이 readonly 배열 (Info)

**todo-2:** `ChunkSearchResult[]`
**구현:** `readonly ChunkSearchResult[]`

더 엄격한 타입이므로 개선 사항.

### I-8. anthropic.ts embedQuery — input이 배열 (Low)

**todo-2 명세:**

```json
{ "model": "voyage-finance-2", "input": text, "input_type": "query" }
```

**구현 (`anthropic.ts:31`):**

```typescript
input: [text],   // 배열로 래핑
```

Voyage API는 `input`을 문자열 또는 문자열 배열로 받으므로 동작에 문제 없다. 단, 응답 형식이 달라질 수 있는데 `data[0].embedding`으로 접근하므로 배열 입력에 맞다.

### I-9. atomicReindex — WAL/SHM 처리 순서 (Medium)

**todo-2 명세:**

> WAL/SHM 파일도 처리: `renameSync(tmpPath + '-wal', dbPath + '-wal')` 등

**구현 (`reindex.ts:53-59`):**

```typescript
// Clean up WAL/SHM from original if they exist
for (const ext of ['-wal', '-shm']) {
  try {
    unlinkSync(dbPath + ext);
  } catch {
    // may not exist
  }
}
```

tmp DB는 `enableWAL: false`로 열리므로 WAL/SHM이 생성되지 않는다. rename 후 원본의 WAL/SHM을 삭제하여 정리한다. 이 접근은 올바르다. 다만 rename 이후 원본 WAL/SHM이 이미 `dbPath-wal`에 남아있으면, 새 DB를 열 때 stale WAL이 적용될 수 있다. **rename 전에** WAL/SHM을 삭제하거나, rename 직후 즉시 삭제해야 한다. 현재 구현은 rename 직후 삭제하므로 경합 시간(time window)은 극히 짧지만 이론적 위험이 있다.

실제로는: (1) `renameSync(tmpPath, dbPath)` 실행 → 원본의 `-wal`, `-shm`이 여전히 존재 → (2) 새 DB가 열리면 stale WAL이 적용됨. 그러나 atomicReindex를 호출하는 시점에는 원본 DB의 connection이 이미 닫혀 있어야 하므로(origDb.close() 후 다른 reader가 없어야), WAL 파일은 체크포인트 완료 후 비어있을 가능성이 높다.

### I-10. atomicReindex — 원본 DB 접근 시 sqlite-vec 미로드 (High)

**구현 (`reindex.ts:27`):**

```typescript
const origDb = new DatabaseSync(dbPath, { readOnly: true });
```

원본 DB를 `new DatabaseSync`로 직접 열면서 sqlite-vec 확장을 로드하지 않는다. memory_chunks_vec은 vec0 가상 테이블이므로 sqlite-vec 없이는 접근할 수 없다. 다만, 현재 코드에서 origDb는 `memories` 테이블만 SELECT하므로 vec0 테이블에 접근하지 않아 실제 런타임 에러는 발생하지 않는다.

하지만 `openDatabase`와 달리 DDL 실행, sqlite-vec 로드 없이 raw `DatabaseSync`를 사용하므로, 향후 쿼리 변경 시 문제가 될 수 있다. 이 점을 주석으로 명시해두면 좋겠다.

### I-11. embedBatchWithCache 캐시 히트 테스트가 불완전 (Medium)

**todo-2 §10.4:**

> `it('embedBatchWithCache — 캐시 히트 시 API 미호출');`

**구현 (`memories.storage.test.ts:175-192`):**

테스트 이름은 "cache hit on second call"이지만, 실제로는 2번째 `embedBatch` 호출이 일어나지 않는지 검증하지 않는다. 첫 번째 호출 후 `embedding_cache` 테이블에 행이 있는지만 확인한다. 캐시 히트 시 `provider.embedBatch`가 호출되지 않음을 검증하려면, 동일 텍스트로 `addMemoryWithEmbedding`을 다시 호출하고(다른 ID로) `embedBatchCalls`가 여전히 1인지 확인해야 한다.

현재 테스트는 캐시 적재(cache write)만 검증하고, 캐시 히트(cache read → API 미호출)를 검증하지 못한다.

### I-12. float32ToBuffer 중복 정의 (Low)

`float32ToBuffer` 함수가 3곳에서 독립적으로 정의됨:

- `packages/storage/src/search/vector.ts:14` (이름: `float32ToBuffer`)
- `packages/storage/src/tables/embeddings.ts:7`
- `packages/storage/src/tables/memories.ts:232`

모두 동일한 구현이다. todo-2에서 `float32ArrayToBuffer`라는 이름으로 vector.ts에 정의하도록 했으나 다른 파일에서도 독립적으로 존재한다.

### I-13. vector.storage.test.ts에서 float32ToBuffer 왕복 테스트 누락 (Low)

**todo-2 §10.2:**

> `it('float32ArrayToBuffer 왕복 변환');`

구현된 테스트 파일에 이 테스트가 없다. `float32ToBuffer`가 내보내지지 않으므로(private) 직접 테스트할 수 없다. 간접적으로 `insertWithVec` 헬퍼 내에서 검증되고 있으나 명시적 테스트는 누락.

### I-14. index.ts searchMemory — 개별 N+1 getMemory 호출 (Medium)

**todo-2 명세:**

> `ChunkSearchResult → MemoryEntry 변환 (memoryId로 memories 테이블 조회)`

**구현 (`index.ts:165-177`):**

```typescript
for (const result of merged) {
  ...
  const entry = getMemory(database.db, result.memoryId);
  ...
}
```

하이브리드 검색 결과마다 개별 `getMemory` 호출 → N+1 패턴. 결과 수가 적으므로(limit 기본 10) 실용적 문제는 없으나, `WHERE id IN (...)` 배치 쿼리로 개선 가능.

---

## 리팩토링 사항

### R-1. float32ToBuffer 공통 유틸 추출 (Low)

I-12에서 언급한 대로 3곳에서 중복. `src/utils/buffer.ts` 등으로 추출하면 중복 제거 가능. 다만 각각 2줄짜리 함수이므로 현재 허용 범위.

### R-2. hybrid.test.ts — source 필드 검증 테스트 누락 (Low)

**todo-2 §10.3:**

> `it('source 필드는 항상 hybrid');`

이 항목이 독립 테스트로 없다. 'overlapping results' 테스트에서 `source: 'hybrid'` 검증이 포함되어 있으나, 벡터만/FTS만 있는 경우에도 source가 'hybrid'인지 명시적으로 검증하지 않는다.

### R-3. fts.storage.test.ts — 빈 문자열 테스트가 buildFtsQuery와 통합 (Low)

**todo-2 §10.1:** `buildFtsQuery — 빈 문자열 → 빈 문자열`이 독립 테스트로 있어야 하나, `buildFtsQuery — AND join and quote escape` 테스트 내에 `expect(buildFtsQuery('')).toBe('')`로 포함됨. 기능적으로 검증되나 테스트 케이스 분리가 todo-2 명세와 다름.

### R-4. memories.storage.test.ts — chunkMarkdown 테스트 범위 (Low)

**todo-2 §10.4:**

> `it('chunkMarkdown — 긴 텍스트 → 복수 청크 + 오버랩');`
> `it('chunkMarkdown — 빈 텍스트 → 빈 배열');`

구현에는 짧은 텍스트 단일 청크 테스트만 있고, 긴 텍스트 복수 청크/오버랩 및 빈 텍스트 테스트가 누락. chunkMarkdown은 todo-1 범위 함수이므로 todo-2에서는 보조적이지만, 명시된 테스트가 빠져있다.

---

## 종합 평가

todo-2에 명시된 모든 소스 파일과 핵심 함수가 구현되었으며, 전체적인 아키텍처(FTS5 → 벡터 검색 → 하이브리드 병합 → 임베딩 캐시 → atomic reindex)가 plan을 충실히 따르고 있다.

**주요 차이점 요약:**

- `ChunkSearchResult.id` → `chunkId` 변경 (I-1): 의미적 개선, 내부 정합성 유지됨
- `createEmbeddingProvider` config 단순화 (I-3): env 기반 키 조회로 보완, 실용적 문제 없음
- searchVector SQL 구문 (I-5): todo-2 명세보다 **구현이 정확함** (sqlite-vec MATCH 구문)
- embedBatchWithCache 캐시 히트 테스트 불완전 (I-11): 캐시 적재만 검증, 히트 미검증

**위험도 분류:**

- High (2): I-5 (구현이 올바르고 명세가 잘못됨 — 실제 위험 없음), I-10 (원본 DB에서 vec0 미사용으로 현재 무해)
- Medium (4): I-1, I-3, I-9, I-11, I-14
- Low (5): I-2, I-6, I-8, I-12, I-13

**커밋 가능 여부:** 전체적으로 커밋 가능하다. High 이슈 2건은 현재 동작에 영향을 주지 않으며, Medium 이슈 중 I-11(캐시 히트 테스트 불완전)이 가장 보완 가치가 높다. 해당 테스트를 보강한 후 커밋하는 것을 권장한다.
