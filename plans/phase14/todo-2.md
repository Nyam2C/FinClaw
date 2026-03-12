# Phase 14 Todo-2: 검색 & 임베딩 계층

> FTS5, sqlite-vec 벡터 검색, 하이브리드 검색(WSF), 임베딩 프로바이더, Atomic Reindex
> todo-1 완료 후 실행. DB 스키마 및 테이블 CRUD가 존재한다고 가정.

---

## 1. `packages/storage/src/search/fts.ts` — FTS5 BM25 전문 검색

### 타입 참조

- `node:sqlite`: `DatabaseSync`
- `search/hybrid.ts`: `ChunkSearchResult`

### 내보내기

```typescript
export function buildFtsQuery(query: string): string;
export function bm25RankToScore(rank: number): number;
export function searchFts(
  db: DatabaseSync,
  query: string,
  limit?: number, // 기본 20
): ChunkSearchResult[];
```

### buildFtsQuery 구현

1. 공백 기준 토큰 분할
2. 빈 토큰 필터링
3. 각 토큰을 `"..."` 이스케이프 (내부 `"` → `""`)
4. `AND` 연결
5. 예: `"삼성전자 실적"` → `"삼성전자" AND "실적"`

### bm25RankToScore 구현

- BM25 rank는 음수 (낮을수록 좋음)
- 정규화: `1 / (1 + Math.abs(rank))` → 0~1 범위

### searchFts 구현 (plan.md §5.2)

1. `buildFtsQuery(query)` → ftsQuery (빈 문자열이면 `[]` 반환)
2. SQL:
   ```sql
   SELECT f.id, f.memory_id, f.text, rank AS bm25_rank
   FROM memory_chunks_fts f
   WHERE memory_chunks_fts MATCH ?
   ORDER BY rank
   LIMIT ?
   ```
3. 행 매핑: `{ id, memoryId: memory_id, text, score: bm25RankToScore(bm25_rank), source: 'fts' }`

검증: trigram 토크나이저로 한국어 부분 매칭 ("삼성" 으로 "삼성전자" 검색)

---

## 2. `packages/storage/src/search/vector.ts` — sqlite-vec 코사인 유사도 검색

### 타입 참조

- `node:sqlite`: `DatabaseSync`
- `embeddings/provider.ts`: `EmbeddingProvider`
- `search/hybrid.ts`: `ChunkSearchResult`

### 내보내기

```typescript
export function cosineSimilarity(a: number[], b: number[]): number;

export async function searchVector(
  db: DatabaseSync,
  query: string,
  provider: EmbeddingProvider,
  limit?: number, // 기본 20
): Promise<ChunkSearchResult[]>;
```

### 내부 함수

```typescript
function float32ArrayToBuffer(arr: Float32Array): Buffer;
```

### cosineSimilarity 구현

- 내적 / (normA \* normB)
- denominator=0이면 0 반환

### searchVector 구현 (plan.md §5.3)

1. `provider.embedQuery(query)` → queryEmbedding
2. `new Float32Array(queryEmbedding)` → `float32ArrayToBuffer()` → queryBlob
3. SQL:
   ```sql
   SELECT c.id, c.memory_id, c.text, vec_distance_cosine(v.embedding, ?) AS distance
   FROM memory_chunks_vec v
   JOIN memory_chunks c ON v.chunk_id = c.id
   ORDER BY distance ASC
   LIMIT ?
   ```
4. 행 매핑: `{ id, memoryId, text, score: 1 - distance, source: 'vector' }`

검증: mock 임베딩 프로바이더로 KNN 검색 정확성

---

## 3. `packages/storage/src/search/hybrid.ts` — WSF 하이브리드 병합

### 내보내기

```typescript
export interface ChunkSearchResult {
  readonly id: string;
  readonly memoryId: string;
  readonly text: string;
  readonly score: number; // 0-1 정규화
  readonly source: 'vector' | 'fts' | 'hybrid';
}

export interface HybridSearchOptions {
  readonly query: string;
  readonly limit?: number; // 기본 10
  readonly vectorWeight?: number; // 기본 0.7
  readonly textWeight?: number; // 기본 0.3
  readonly minScore?: number; // 기본 0.1
}

export function mergeHybridResults(
  vectorResults: ChunkSearchResult[],
  ftsResults: ChunkSearchResult[],
  options: Pick<HybridSearchOptions, 'vectorWeight' | 'textWeight' | 'limit' | 'minScore'>,
): ChunkSearchResult[];
```

### mergeHybridResults 구현 (plan.md §5.4)

1. `vectorWeight` 기본 0.7, `textWeight` 기본 0.3, `limit` 기본 10, `minScore` 기본 0.1
2. Map<id, result & { combinedScore }> 구축
3. 벡터 결과: `merged.set(id, { ...result, source:'hybrid', combinedScore: vectorWeight * score })`
4. FTS 결과: 기존 있으면 `combinedScore += textWeight * score`, 없으면 새로 추가
5. `combinedScore >= minScore` 필터
6. 내림차순 정렬
7. `.slice(0, limit)`
8. `combinedScore` → `score` 매핑 후 반환

검증: 중복 ID 합산, 가중치 적용, minScore 필터, 정렬 순서

---

## 4. `packages/storage/src/embeddings/provider.ts` — 임베딩 프로바이더 인터페이스 + 팩토리

### 내보내기

```typescript
export interface EmbeddingProvider {
  readonly id: string; // "anthropic" | "openai"
  readonly model: string; // "voyage-finance-2" | "text-embedding-3-small"
  readonly dimensions: number; // 1024 | 1536

  embedQuery(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export type EmbeddingMode = 'auto' | 'anthropic' | 'openai';

export function createEmbeddingProvider(
  mode: EmbeddingMode,
  config: { anthropicApiKey?: string; openaiApiKey?: string },
): Promise<EmbeddingProvider>;
```

### createEmbeddingProvider 구현 (plan.md §5.5)

- `'anthropic'` → lazy import `./anthropic.js`, `new AnthropicEmbeddingProvider(apiKey)`
- `'openai'` → lazy import `./openai.js`, `new OpenAIEmbeddingProvider(apiKey)`
- `'auto'` → anthropicApiKey 있으면 anthropic, 그 다음 openaiApiKey → 둘 다 없으면 Error

> 주의: plan.md에서 `createAnthropicProvider`/`createOpenAIProvider` 반환이 `Promise<EmbeddingProvider>`이므로 `createEmbeddingProvider` 자체도 `async`여야 함.

검증: auto 모드 우선순위, API 키 없을 때 에러

---

## 5. `packages/storage/src/embeddings/anthropic.ts` — Voyage-finance-2 프로바이더

### 내보내기

```typescript
export class AnthropicEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'anthropic';
  readonly model = 'voyage-finance-2';
  readonly dimensions = 1024;

  constructor(private readonly apiKey: string);

  async embedQuery(text: string): Promise<number[]>;
  async embedBatch(texts: string[]): Promise<number[][]>;
}
```

### embedQuery 구현

- POST `https://api.voyageai.com/v1/embeddings`
- Headers: `Authorization: Bearer ${apiKey}`, `Content-Type: application/json`
- Body: `{ model: 'voyage-finance-2', input: text, input_type: 'query' }`
- 응답: `data[0].embedding`

### embedBatch 구현

- 배치 크기: 50 (BATCH_SIZE)
- input_type: `'document'` (배치는 document 타입)
- 50개씩 슬라이스하며 API 호출
- 실패 시 개별 폴백: 배치 실패하면 각 텍스트를 `embedQuery`로 개별 호출

검증: mock fetch로 API 호출 형식 확인, 배치 분할, 폴백 동작

---

## 6. `packages/storage/src/embeddings/openai.ts` — text-embedding-3-small 프로바이더

### 내보내기

```typescript
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai';
  readonly model = 'text-embedding-3-small';
  readonly dimensions = 1536;

  constructor(private readonly apiKey: string);

  async embedQuery(text: string): Promise<number[]>;
  async embedBatch(texts: string[]): Promise<number[][]>;
}
```

### embedQuery 구현

- POST `https://api.openai.com/v1/embeddings`
- Headers: `Authorization: Bearer ${apiKey}`, `Content-Type: application/json`
- Body: `{ model: 'text-embedding-3-small', input: text }`
- 응답: `data[0].embedding`

### embedBatch 구현

- 배치 크기: 100 (OpenAI 한도 더 높음)
- Body: `{ model: 'text-embedding-3-small', input: batch }` (배열로 전달)
- 동일한 배치 실패 → 개별 폴백 패턴

검증: mock fetch, 배치 분할

---

## 7. 임베딩 캐시 통합 함수

`tables/embeddings.ts`에 추가하거나 별도 유틸로 구현:

### 내보내기

```typescript
export async function embedBatchWithCache(
  db: DatabaseSync,
  texts: string[],
  provider: EmbeddingProvider,
): Promise<number[][]>;
```

### 구현 (plan.md §5.10)

1. 각 text → `crypto.createHash('sha256').update(text).digest('hex')` → hash
2. `getCachedEmbedding(db, provider.id, provider.model, hash)` 조회
3. 캐시 미스인 텍스트만 모아서 `provider.embedBatch(missTexts)`
4. 새 결과 → `setCachedEmbedding(db, ...)` 캐시 저장
5. 원래 입력 순서에 맞춰 캐시 히트 + 신규 결과 병합 반환

검증: 동일 텍스트 2회 호출 시 두 번째는 API 미호출 (mock 확인)

---

## 8. memories.ts 업그레이드 — 임베딩 연동

todo-1에서 `addMemory`는 임베딩 없이 chunks만 저장했다. todo-2에서:

### addMemoryWithEmbedding 추가 (또는 addMemory 확장)

```typescript
export async function addMemoryWithEmbedding(
  db: DatabaseSync,
  entry: MemoryEntry,
  provider: EmbeddingProvider,
): Promise<void>;
```

1. `addMemory(db, entry)` — 기존 로직 (memories + chunks + fts 삽입)
2. chunks 텍스트 추출
3. `embedBatchWithCache(db, chunkTexts, provider)` → embeddings
4. 각 chunk에 대해:
   - UPDATE memory_chunks SET model = provider.model
   - INSERT INTO memory_chunks_vec (chunk_id, embedding) — Float32Array → Buffer

### index.ts의 searchMemory 업그레이드

todo-1의 LIKE 폴백을 하이브리드 검색으로 교체:

```typescript
async searchMemory(query, limit) {
  const [vectorResults, ftsResults] = await Promise.all([
    searchVector(database.db, query, embeddingProvider, limit),
    Promise.resolve(searchFts(database.db, query, limit)),
  ]);
  const merged = mergeHybridResults(vectorResults, ftsResults, { limit });
  // ChunkSearchResult → MemoryEntry 변환 (memoryId로 memories 테이블 조회)
}
```

검증: 메모리 저장 → 임베딩 생성 → 하이브리드 검색 e2e

---

## 9. Atomic Reindex (plan.md §5.9)

### 위치: `packages/storage/src/database.ts` 또는 별도 `reindex.ts`

### 내보내기

```typescript
export async function atomicReindex(dbPath: string, provider: EmbeddingProvider): Promise<void>;
```

### 구현

1. `tmpPath = dbPath + '.reindex.tmp'`
2. `openDatabase({ path: tmpPath })` → tmpDb
3. 원본 DB에서 `SELECT * FROM memories` → all memories
4. 각 memory에 대해 `chunkMarkdown()` → chunks
5. `embedBatchWithCache(tmpDb.db, chunkTexts, provider)` → embeddings
6. INSERT INTO memory_chunks + memory_chunks_vec + memory_chunks_fts (tmpDb)
7. `tmpDb.close()`
8. `renameSync(tmpPath, dbPath)` — atomic swap
   - WAL/SHM 파일도 처리: `renameSync(tmpPath + '-wal', dbPath + '-wal')` 등
9. 실패 시 try/catch: `unlinkSync(tmpPath)`, 원본 보존

검증: 리인덱싱 중 원본 DB 접근 가능, 스왑 후 새 DB 사용

---

## 10. 테스트 파일

### 10.1 `packages/storage/src/search/fts.storage.test.ts`

```typescript
describe('FTS5 검색', () => {
  // Setup: DB 열기 → 메모리 + 청크 + FTS 삽입
  it('buildFtsQuery — 공백 토큰화 + 따옴표 이스케이프');
  it('buildFtsQuery — 빈 문자열 → 빈 문자열');
  it('bm25RankToScore — 음수 rank → 0~1 점수');
  it('searchFts — 정확한 단어 매칭');
  it('searchFts — trigram 부분 매칭 (한국어)');
  it('searchFts — limit 적용');
  it('searchFts — 빈 쿼리 → 빈 배열');
  it('searchFts — BM25 랭킹 순서 확인');
});
```

테스트 데이터: 한국어/영어 혼합 메모리 청크 3~5개 삽입

### 10.2 `packages/storage/src/search/vector.storage.test.ts`

```typescript
describe('벡터 검색', () => {
  // Setup: mock EmbeddingProvider (고정 벡터 반환)
  it('cosineSimilarity — 동일 벡터 → 1.0');
  it('cosineSimilarity — 직교 벡터 → 0.0');
  it('cosineSimilarity — 제로 벡터 → 0.0');
  it('searchVector — KNN 검색 유사도 순');
  it('searchVector — limit 적용');
  it('float32ArrayToBuffer 왕복 변환');
});
```

Mock 프로바이더:

```typescript
const mockProvider: EmbeddingProvider = {
  id: 'mock',
  model: 'mock-model',
  dimensions: 4,
  async embedQuery(text) {
    return [0.1, 0.2, 0.3, 0.4];
  },
  async embedBatch(texts) {
    return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
  },
};
```

테스트 데이터: 미리 계산된 4차원 벡터를 memory_chunks_vec에 수동 삽입

### 10.3 `packages/storage/src/search/hybrid.test.ts` (unit — DB 불필요)

```typescript
describe('mergeHybridResults', () => {
  it('벡터+FTS 동일 ID → 가중치 합산');
  it('벡터만 있는 결과 → vectorWeight만 적용');
  it('FTS만 있는 결과 → textWeight만 적용');
  it('minScore 미만 필터링');
  it('limit 적용');
  it('기본 가중치: vector=0.7, text=0.3');
  it('커스텀 가중치 적용');
  it('빈 입력 → 빈 배열');
  it('source 필드는 항상 hybrid');
});
```

순수 함수 테스트 — 고정된 `ChunkSearchResult[]` 입력으로 출력 검증

### 10.4 `packages/storage/src/tables/memories.storage.test.ts`

```typescript
describe('memories CRUD + 임베딩', () => {
  // Setup: DB + mock EmbeddingProvider
  it('addMemory — 메모리 + 청크 + FTS 삽입');
  it('addMemory — 중복 hash → 스킵');
  it('getMemory — 존재하는 ID 조회');
  it('getMemory — 없는 ID → null');
  it('getMemoriesBySession — 세션별 필터');
  it('getMemoriesBySession — type 필터');
  it('deleteMemory — vec0 + FTS 동기 삭제');
  it('chunkMarkdown — 짧은 텍스트 → 단일 청크');
  it('chunkMarkdown — 긴 텍스트 → 복수 청크 + 오버랩');
  it('chunkMarkdown — 빈 텍스트 → 빈 배열');
  it('addMemoryWithEmbedding — 청크 임베딩 생성 + vec0 삽입');
  it('addMemoryWithEmbedding → searchVector로 검색 가능');
  it('embedBatchWithCache — 캐시 히트 시 API 미호출');
});
```

---

## 실행 순서

1. `search/hybrid.ts` — 타입 + mergeHybridResults (의존성 없음)
2. `search/hybrid.test.ts` → 테스트 통과
3. `search/fts.ts` — FTS5 검색
4. `search/fts.storage.test.ts` → 테스트 통과
5. `embeddings/provider.ts` — 인터페이스 + 팩토리
6. `embeddings/anthropic.ts` — Voyage 프로바이더
7. `embeddings/openai.ts` — OpenAI 프로바이더
8. `search/vector.ts` — 벡터 검색
9. `search/vector.storage.test.ts` → 테스트 통과
10. `tables/embeddings.ts` 확장 — `embedBatchWithCache`
11. `tables/memories.ts` 확장 — `addMemoryWithEmbedding`
12. `memories.storage.test.ts` → 테스트 통과
13. `index.ts` 업그레이드 — searchMemory 하이브리드 교체
14. `database.ts`(또는 reindex.ts) — atomicReindex
15. `tsc --build` 통과 확인

## 검증 기준 (plan.md §7 대응)

| #   | 검증 항목          | todo-2 대응                                    |
| --- | ------------------ | ---------------------------------------------- |
| 7   | FTS5 검색          | fts.storage.test.ts                            |
| 8   | 벡터 검색          | vector.storage.test.ts                         |
| 9   | 하이브리드 검색    | hybrid.test.ts                                 |
| 10  | 임베딩 캐시        | memories.storage.test.ts (embedBatchWithCache) |
| 15  | Atomic reindex     | atomicReindex 구현                             |
| 17  | vec0 삭제 동기화   | memories.storage.test.ts (deleteMemory)        |
| 18  | trigram 한국어 FTS | fts.storage.test.ts                            |
| 19  | 임베딩 캐시 HIT    | memories.storage.test.ts                       |
