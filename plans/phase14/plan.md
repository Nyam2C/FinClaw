# Phase 14: 스토리지 & 메모리 시스템

> 복잡도: **XL** | 소스 파일: ~14 | 테스트 파일: ~6 | 총 ~20 파일

---

## 1. 목표

FinClaw의 **영속성 계층과 메모리 시스템**을 구축한다. Node.js 22 내장 `node:sqlite`를 기반으로 데이터베이스 스키마 관리, 대화 이력 저장, 메모리 CRUD, FTS5 전문 검색, sqlite-vec 벡터 검색, 그리고 두 검색 결과를 결합하는 하이브리드 검색 엔진을 구현한다. 또한 금융 데이터 캐싱을 위한 TTL 기반 market cache 테이블과 임베딩 프로바이더(Anthropic, OpenAI)를 제공한다.

**핵심 목표:**

- SQLite 데이터베이스 초기화, 스키마 생성, 버전 기반 마이그레이션
- 6개 핵심 테이블: conversations, messages, memories, embeddings, alerts, market_cache
- FTS5 전문 검색: BM25 랭킹 기반 텍스트 쿼리
- sqlite-vec 벡터 검색: 코사인 유사도 기반 시맨틱 검색
- 하이브리드 검색: FTS5 + vector 결과를 reciprocal rank fusion으로 병합
- 임베딩 프로바이더: Anthropic (voyage-3), OpenAI (text-embedding-3-small)
- Chokidar 파일 감시 기반 자동 동기화
- 금융 데이터 TTL 캐싱 (시세 5분, 과거 데이터 1시간)

---

## 2. OpenClaw 참조

### 참조 문서

| 문서 경로                                            | 적용할 패턴                                                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `openclaw_review/deep-dive/14-memory-media-utils.md` | MemoryIndexManager, Atomic Reindex, Hybrid Search, EmbeddingProvider, Batch+Fallback, memory-schema.ts DDL |

### 적용할 핵심 패턴

**1) SQLite + sqlite-vec 단일 DB (OpenClaw memory-schema.ts 95줄)**

- OpenClaw: meta/files/chunks/embedding_cache/FTS 테이블, `ensureColumn()` 마이그레이션
- FinClaw: conversations/messages/memories/embeddings/alerts/market_cache 테이블. 동일한 DDL 기반 스키마 관리 + version meta로 마이그레이션 제어

**2) Atomic Reindex — Temp-Swap (OpenClaw manager.ts 2,232줄)**

- OpenClaw: 임시 DB 생성 → seedEmbeddingCache → index → writeMeta → close → swapIndexFiles(rename) → reopen
- FinClaw: 동일 패턴 채택. 리인덱싱 중 서비스 중단 없이 원본 DB 보존

**3) Hybrid Search (OpenClaw hybrid.ts)**

- OpenClaw: `vectorWeight * vectorScore + textWeight * textScore` 가중치 합산
- FinClaw: 동일한 reciprocal rank fusion 구현. 가중치 기본값 vector=0.7, text=0.3

**4) EmbeddingProvider Strategy (OpenClaw embeddings.ts 226줄)**

- OpenClaw: auto|openai|local|gemini 프로바이더, lazy-load
- FinClaw: anthropic|openai 2개 프로바이더. auto 모드에서 설정된 API 키에 따라 자동 선택

**5) Batch + Fallback (OpenClaw batch-openai.ts 383줄)**

- OpenClaw: 배치 실패 `BATCH_FAILURE_LIMIT`(2) 도달 시 개별 임베딩으로 전환
- FinClaw: 동일 패턴. 단, OpenClaw보다 단순하게 단일 배치 → 개별 폴백으로 구현

**6) Markdown Chunking (OpenClaw internal.ts 241줄)**

- `chunkMarkdown(text, maxTokens, overlap)`: 라인 기반 분할, 오버랩으로 문맥 보존
- FinClaw: 동일 알고리즘 채택. maxTokens=512, overlap=64 기본값

---

## 3. 생성할 파일

### 소스 파일 (14개)

| 파일 경로                             | 역할                                                  | 예상 줄 수 |
| ------------------------------------- | ----------------------------------------------------- | ---------- |
| `src/storage/index.ts`                | 스토리지 모듈 barrel export                           | ~20        |
| `src/storage/database.ts`             | SQLite 데이터베이스 초기화, 스키마 생성, 마이그레이션 | ~200       |
| `src/storage/tables/conversations.ts` | 대화 세션 CRUD (생성, 조회, 메타데이터 갱신)          | ~120       |
| `src/storage/tables/messages.ts`      | 메시지 저장/조회 (대화 이력)                          | ~150       |
| `src/storage/tables/memories.ts`      | 메모리 엔트리 CRUD + 청킹 + 임베딩 연동               | ~200       |
| `src/storage/tables/embeddings.ts`    | 임베딩 캐시 테이블 (프로바이더별 해시 기반 캐시)      | ~80        |
| `src/storage/tables/alerts.ts`        | 가격 알림 테이블 (금융 특화)                          | ~100       |
| `src/storage/tables/market-cache.ts`  | 시장 데이터 TTL 캐시 (금융 특화)                      | ~100       |
| `src/storage/search/fts.ts`           | FTS5 전문 검색 (BM25 랭킹)                            | ~120       |
| `src/storage/search/vector.ts`        | sqlite-vec 벡터 유사도 검색 (코사인)                  | ~130       |
| `src/storage/search/hybrid.ts`        | FTS5 + vector 결합 하이브리드 검색                    | ~100       |
| `src/storage/embeddings/provider.ts`  | EmbeddingProvider 인터페이스 + 팩토리                 | ~80        |
| `src/storage/embeddings/anthropic.ts` | Anthropic voyage-3 임베딩 프로바이더                  | ~100       |
| `src/storage/embeddings/openai.ts`    | OpenAI text-embedding-3-small 프로바이더              | ~100       |

### 테스트 파일 (6개)

| 파일 경로                                         | 테스트 대상                            | 테스트 종류 |
| ------------------------------------------------- | -------------------------------------- | ----------- |
| `src/storage/database.test.ts`                    | DB 초기화, 스키마 생성, 마이그레이션   | unit        |
| `src/storage/tables/messages.storage.test.ts`     | 메시지 CRUD, 대화별 이력 조회          | storage     |
| `src/storage/tables/memories.storage.test.ts`     | 메모리 CRUD, 청킹, 임베딩 저장         | storage     |
| `src/storage/search/fts.storage.test.ts`          | FTS5 검색, BM25 랭킹                   | storage     |
| `src/storage/search/hybrid.test.ts`               | 하이브리드 검색 결과 병합, 가중치 조정 | unit        |
| `src/storage/tables/market-cache.storage.test.ts` | 금융 데이터 캐싱, TTL 만료             | storage     |

---

## 4. 핵심 인터페이스/타입

```typescript
// src/storage/database.ts — 데이터베이스 인스턴스
import { DatabaseSync } from 'node:sqlite';

export interface Database {
  /** 내부 node:sqlite 인스턴스 */
  readonly db: DatabaseSync;

  /** 데이터베이스 파일 경로 */
  readonly path: string;

  /** 스키마 버전 */
  readonly schemaVersion: number;

  /** 데이터베이스 종료 */
  close(): void;
}

export interface DatabaseOptions {
  readonly path: string;
  readonly enableWAL?: boolean; // 기본 true
  readonly enableForeignKeys?: boolean; // 기본 true
}

// src/storage/tables/conversations.ts
export interface Conversation {
  readonly id: string; // UUID
  readonly title: string | null;
  readonly agentId: string;
  readonly channelId: string | null;
  readonly createdAt: number; // Unix timestamp ms
  readonly updatedAt: number;
  readonly metadata: Record<string, unknown>;
}

// src/storage/tables/messages.ts
export interface Message {
  readonly id: string; // UUID
  readonly conversationId: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly toolCalls: ToolCallRecord[] | null;
  readonly tokenCount: number | null;
  readonly createdAt: number; // Unix timestamp ms
}

// src/storage/tables/memories.ts
export interface MemoryEntry {
  readonly id: string; // UUID
  readonly path: string; // 원본 파일 경로 또는 가상 경로
  readonly source: 'conversation' | 'note' | 'document' | 'code';
  readonly title: string;
  readonly content: string;
  readonly hash: string; // SHA-256
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MemoryChunk {
  readonly id: string;
  readonly memoryId: string;
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly embedding: number[]; // float32 벡터
  readonly model: string; // 사용된 임베딩 모델
}

// src/storage/tables/alerts.ts — 금융 알림
export interface PriceAlert {
  readonly id: string;
  readonly ticker: string; // 예: "AAPL", "BTC-USD"
  readonly condition: 'above' | 'below';
  readonly targetPrice: number;
  readonly currentPrice: number | null;
  readonly currency: string; // 예: "USD", "KRW"
  readonly channelId: string | null;
  readonly triggered: boolean;
  readonly triggeredAt: number | null;
  readonly createdAt: number;
}

// src/storage/tables/market-cache.ts — 시장 데이터 캐시
export interface MarketCacheEntry {
  readonly key: string; // 예: "quote:AAPL", "historical:BTC-USD:1d"
  readonly data: string; // JSON 직렬화된 데이터
  readonly provider: string; // 예: "alpha-vantage", "coingecko"
  readonly ttlMs: number; // TTL (밀리초)
  readonly cachedAt: number; // 캐시 시간
  readonly expiresAt: number; // 만료 시간 = cachedAt + ttlMs
}

// src/storage/search/hybrid.ts — 검색 결과
export interface SearchResult {
  readonly id: string;
  readonly memoryId: string;
  readonly text: string;
  readonly path: string;
  readonly score: number; // 0-1 정규화 점수
  readonly source: 'vector' | 'fts' | 'hybrid';
}

export interface HybridSearchOptions {
  readonly query: string;
  readonly limit?: number; // 기본 10
  readonly vectorWeight?: number; // 기본 0.7
  readonly textWeight?: number; // 기본 0.3
  readonly minScore?: number; // 기본 0.1
}

// src/storage/embeddings/provider.ts — 임베딩 프로바이더
export interface EmbeddingProvider {
  readonly id: string; // "anthropic" | "openai"
  readonly model: string; // "voyage-3" | "text-embedding-3-small"
  readonly dimensions: number; // 1024 | 1536

  /** 단일 텍스트 임베딩 */
  embedQuery(text: string): Promise<number[]>;

  /** 배치 텍스트 임베딩 */
  embedBatch(texts: string[]): Promise<number[][]>;
}

export type EmbeddingMode = 'auto' | 'anthropic' | 'openai';
```

---

## 5. 구현 상세

### 5.1 데이터베이스 초기화 & 스키마

```typescript
// src/storage/database.ts
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 1;

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    agent_id TEXT NOT NULL,
    channel_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    tool_calls TEXT,
    token_count INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(conversation_id, created_at);

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'note',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memories_path ON memories(path);
  CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(hash);

  CREATE TABLE IF NOT EXISTS memory_chunks (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    text TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    embedding BLOB NOT NULL,
    model TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_chunks_memory ON memory_chunks(memory_id);

  -- FTS5 가상 테이블: BM25 전문 검색
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
    text,
    id UNINDEXED,
    memory_id UNINDEXED,
    path UNINDEXED,
    model UNINDEXED,
    start_line UNINDEXED,
    end_line UNINDEXED
  );

  CREATE TABLE IF NOT EXISTS embedding_cache (
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    hash TEXT NOT NULL,
    embedding BLOB NOT NULL,
    dims INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (provider, model, hash)
  );

  -- 금융 특화: 가격 알림
  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    condition TEXT NOT NULL CHECK(condition IN ('above', 'below')),
    target_price REAL NOT NULL,
    current_price REAL,
    currency TEXT NOT NULL DEFAULT 'USD',
    channel_id TEXT,
    triggered INTEGER NOT NULL DEFAULT 0,
    triggered_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_ticker ON alerts(ticker);
  CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(triggered) WHERE triggered = 0;

  -- 금융 특화: 시장 데이터 캐시
  CREATE TABLE IF NOT EXISTS market_cache (
    key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    provider TEXT NOT NULL,
    ttl_ms INTEGER NOT NULL,
    cached_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_market_cache_expires ON market_cache(expires_at);
`;

export function openDatabase(options: DatabaseOptions): Database {
  const db = new DatabaseSync(options.path);

  // WAL 모드: 읽기-쓰기 동시성 향상
  if (options.enableWAL !== false) {
    db.exec('PRAGMA journal_mode = WAL');
  }

  // 외래 키 제약 조건 활성화
  if (options.enableForeignKeys !== false) {
    db.exec('PRAGMA foreign_keys = ON');
  }

  // 성능 튜닝
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA cache_size = -64000'); // 64MB

  // 스키마 초기화
  db.exec(SCHEMA_DDL);

  // 버전 관리
  const currentVersion = readMetaValue(db, 'schema_version');
  if (currentVersion === null) {
    writeMetaValue(db, 'schema_version', String(SCHEMA_VERSION));
  } else if (Number(currentVersion) < SCHEMA_VERSION) {
    runMigrations(db, Number(currentVersion), SCHEMA_VERSION);
    writeMetaValue(db, 'schema_version', String(SCHEMA_VERSION));
  }

  return { db, path: options.path, schemaVersion: SCHEMA_VERSION, close: () => db.close() };
}

function readMetaValue(db: DatabaseSync, key: string): string | null {
  const stmt = db.prepare('SELECT value FROM meta WHERE key = ?');
  const row = stmt.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function writeMetaValue(db: DatabaseSync, key: string, value: string): void {
  const stmt = db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
  );
  stmt.run(key, value, value);
}

function runMigrations(db: DatabaseSync, from: number, to: number): void {
  // 버전별 마이그레이션 실행
  for (let v = from + 1; v <= to; v++) {
    const migration = MIGRATIONS[v];
    if (migration) {
      db.exec(migration);
    }
  }
}

const MIGRATIONS: Record<number, string> = {
  // 향후 스키마 변경 시 추가
  // 2: 'ALTER TABLE memories ADD COLUMN tags TEXT;',
};
```

### 5.2 FTS5 전문 검색

```typescript
// src/storage/search/fts.ts
import type { DatabaseSync } from 'node:sqlite';
import type { SearchResult } from './hybrid.js';

/**
 * FTS5 쿼리를 빌드한다.
 * 입력 텍스트를 토큰화하고 각 토큰을 따옴표로 감싸 AND 연결한다.
 * 예: "삼성전자 실적" → '"삼성전자" AND "실적"'
 */
export function buildFtsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`);

  return tokens.join(' AND ');
}

/**
 * BM25 rank를 0-1 범위 점수로 변환한다.
 * BM25 rank는 음수 (낮을수록 좋음)이므로 1/(1+abs(rank))로 정규화한다.
 */
export function bm25RankToScore(rank: number): number {
  return 1 / (1 + Math.abs(rank));
}

/**
 * FTS5 전문 검색을 실행한다.
 */
export function searchFts(db: DatabaseSync, query: string, limit: number = 20): SearchResult[] {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  const stmt = db.prepare(`
    SELECT
      f.id,
      f.memory_id,
      f.text,
      f.path,
      rank AS bm25_rank
    FROM memory_chunks_fts f
    WHERE memory_chunks_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);

  const rows = stmt.all(ftsQuery, limit) as Array<{
    id: string;
    memory_id: string;
    text: string;
    path: string;
    bm25_rank: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    memoryId: row.memory_id,
    text: row.text,
    path: row.path,
    score: bm25RankToScore(row.bm25_rank),
    source: 'fts' as const,
  }));
}
```

### 5.3 벡터 검색 (sqlite-vec)

```typescript
// src/storage/search/vector.ts
import type { DatabaseSync } from 'node:sqlite';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { SearchResult } from './hybrid.js';

/**
 * sqlite-vec 확장을 로드한다.
 * sqlite-vec은 SQLite에 벡터 연산 함수를 추가하는 네이티브 확장이다.
 */
export function loadVecExtension(db: DatabaseSync): void {
  // sqlite-vec 패키지가 제공하는 확장 경로를 로드
  const sqliteVec = require('sqlite-vec');
  sqliteVec.load(db);
}

/**
 * 코사인 유사도를 계산한다.
 * 두 벡터의 내적을 각각의 크기(norm)로 나눈다.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * 벡터 유사도 검색을 실행한다.
 * 쿼리 텍스트를 임베딩으로 변환한 후 sqlite-vec의 vec_distance_cosine으로 검색한다.
 */
export async function searchVector(
  db: DatabaseSync,
  query: string,
  provider: EmbeddingProvider,
  limit: number = 20,
): Promise<SearchResult[]> {
  // 1. 쿼리 텍스트를 벡터로 변환
  const queryEmbedding = await provider.embedQuery(query);
  const queryBlob = float32ArrayToBuffer(new Float32Array(queryEmbedding));

  // 2. sqlite-vec의 KNN 검색 실행
  const stmt = db.prepare(`
    SELECT
      c.id,
      c.memory_id,
      c.text,
      m.path,
      vec_distance_cosine(c.embedding, ?) AS distance
    FROM memory_chunks c
    JOIN memories m ON c.memory_id = m.id
    ORDER BY distance ASC
    LIMIT ?
  `);

  const rows = stmt.all(queryBlob, limit) as Array<{
    id: string;
    memory_id: string;
    text: string;
    path: string;
    distance: number;
  }>;

  // 3. 코사인 거리를 유사도 점수로 변환 (1 - distance)
  return rows.map((row) => ({
    id: row.id,
    memoryId: row.memory_id,
    text: row.text,
    path: row.path,
    score: 1 - row.distance,
    source: 'vector' as const,
  }));
}

function float32ArrayToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}
```

### 5.4 하이브리드 검색 (Reciprocal Rank Fusion)

```typescript
// src/storage/search/hybrid.ts
import type { SearchResult, HybridSearchOptions } from './hybrid.js';

/**
 * FTS5와 벡터 검색 결과를 reciprocal rank fusion으로 병합한다.
 *
 * 알고리즘:
 * 1. 각 검색 결과에서 ID 기준으로 Map을 구축
 * 2. 동일 ID가 양쪽에 존재하면 가중치 합산: vectorWeight * vectorScore + textWeight * textScore
 * 3. 한쪽에만 존재하면 해당 가중치만 적용
 * 4. 합산 점수로 내림차순 정렬
 */
export function mergeHybridResults(
  vectorResults: SearchResult[],
  ftsResults: SearchResult[],
  options: Pick<HybridSearchOptions, 'vectorWeight' | 'textWeight' | 'limit' | 'minScore'>,
): SearchResult[] {
  const vectorWeight = options.vectorWeight ?? 0.7;
  const textWeight = options.textWeight ?? 0.3;
  const limit = options.limit ?? 10;
  const minScore = options.minScore ?? 0.1;

  const merged = new Map<string, SearchResult & { combinedScore: number }>();

  // 벡터 결과 추가
  for (const result of vectorResults) {
    merged.set(result.id, {
      ...result,
      source: 'hybrid',
      combinedScore: vectorWeight * result.score,
    });
  }

  // FTS 결과 병합
  for (const result of ftsResults) {
    const existing = merged.get(result.id);
    if (existing) {
      existing.combinedScore += textWeight * result.score;
    } else {
      merged.set(result.id, {
        ...result,
        source: 'hybrid',
        combinedScore: textWeight * result.score,
      });
    }
  }

  // 점수 정규화 및 정렬
  return Array.from(merged.values())
    .filter((r) => r.combinedScore >= minScore)
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, limit)
    .map(({ combinedScore, ...rest }) => ({
      ...rest,
      score: combinedScore,
    }));
}
```

### 5.5 임베딩 프로바이더

```typescript
// src/storage/embeddings/provider.ts
import type { EmbeddingProvider, EmbeddingMode } from './provider.js';

/**
 * 임베딩 프로바이더 팩토리.
 * mode가 'auto'이면 설정된 API 키에 따라 프로바이더를 자동 선택한다.
 * 우선순위: anthropic > openai
 */
export function createEmbeddingProvider(
  mode: EmbeddingMode,
  config: { anthropicApiKey?: string; openaiApiKey?: string },
): EmbeddingProvider {
  switch (mode) {
    case 'anthropic':
      return createAnthropicProvider(config.anthropicApiKey!);
    case 'openai':
      return createOpenAIProvider(config.openaiApiKey!);
    case 'auto': {
      if (config.anthropicApiKey) {
        return createAnthropicProvider(config.anthropicApiKey);
      }
      if (config.openaiApiKey) {
        return createOpenAIProvider(config.openaiApiKey);
      }
      throw new Error('No embedding provider available. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
    }
  }
}

async function createAnthropicProvider(apiKey: string): Promise<EmbeddingProvider> {
  const { AnthropicEmbeddingProvider } = await import('./anthropic.js');
  return new AnthropicEmbeddingProvider(apiKey);
}

async function createOpenAIProvider(apiKey: string): Promise<EmbeddingProvider> {
  const { OpenAIEmbeddingProvider } = await import('./openai.js');
  return new OpenAIEmbeddingProvider(apiKey);
}

// src/storage/embeddings/anthropic.ts
export class AnthropicEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'anthropic';
  readonly model = 'voyage-3';
  readonly dimensions = 1024;

  constructor(private readonly apiKey: string) {}

  async embedQuery(text: string): Promise<number[]> {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        input_type: 'query',
      }),
    });

    const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Voyage API는 최대 128개 입력을 지원
    const BATCH_SIZE = 128;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const response = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
          input_type: 'document',
        }),
      });

      const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
      results.push(...data.data.map((d) => d.embedding));
    }

    return results;
  }
}
```

### 5.6 Markdown 청킹 알고리즘

```typescript
// src/storage/tables/memories.ts (내부 함수)

/**
 * Markdown 텍스트를 토큰 수 기반으로 청킹한다.
 * 라인 단위로 분할하되, 오버랩으로 문맥을 보존한다.
 *
 * @param text - 분할할 텍스트
 * @param maxTokens - 청크당 최대 토큰 수 (기본 512)
 * @param overlap - 오버랩 토큰 수 (기본 64)
 * @returns 청크 배열 (각 청크에 startLine, endLine 포함)
 */
export function chunkMarkdown(
  text: string,
  maxTokens: number = 512,
  overlap: number = 64,
): Array<{ text: string; startLine: number; endLine: number }> {
  const maxChars = maxTokens * 4; // 대략적 토큰-문자 비율
  const overlapChars = overlap * 4;
  const lines = text.split('\n');
  const chunks: Array<{ text: string; startLine: number; endLine: number }> = [];

  let currentChunk = '';
  let startLine = 0;
  let currentLine = 0;

  for (const line of lines) {
    if (currentChunk.length + line.length + 1 > maxChars && currentChunk.length > 0) {
      // 현재 청크 flush
      chunks.push({
        text: currentChunk,
        startLine,
        endLine: currentLine - 1,
      });

      // 오버랩: 뒤에서부터 overlapChars만큼 캐리
      const carry = currentChunk.slice(-overlapChars);
      currentChunk = carry + '\n' + line;
      startLine = Math.max(0, currentLine - countNewlines(carry));
    } else {
      currentChunk += (currentChunk ? '\n' : '') + line;
    }
    currentLine++;
  }

  // 마지막 청크
  if (currentChunk) {
    chunks.push({
      text: currentChunk,
      startLine,
      endLine: currentLine - 1,
    });
  }

  return chunks;
}

function countNewlines(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (ch === '\n') count++;
  }
  return count;
}
```

### 5.7 금융 데이터 TTL 캐시

```typescript
// src/storage/tables/market-cache.ts
import type { DatabaseSync } from 'node:sqlite';
import type { MarketCacheEntry } from './market-cache.js';

/** TTL 기본값 (밀리초) */
export const CACHE_TTL = {
  QUOTE: 5 * 60 * 1000, // 실시간 시세: 5분
  HISTORICAL_1D: 60 * 60 * 1000, // 일별 데이터: 1시간
  HISTORICAL_1W: 6 * 60 * 60 * 1000, // 주간 데이터: 6시간
  FOREX: 15 * 60 * 1000, // 환율: 15분
  CRYPTO: 3 * 60 * 1000, // 암호화폐: 3분
} as const;

export function getCachedData<T>(db: DatabaseSync, key: string): T | null {
  const now = Date.now();
  const stmt = db.prepare('SELECT data FROM market_cache WHERE key = ? AND expires_at > ?');
  const row = stmt.get(key, now) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as T) : null;
}

export function setCachedData(
  db: DatabaseSync,
  key: string,
  data: unknown,
  provider: string,
  ttlMs: number,
): void {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO market_cache (key, data, provider, ttl_ms, cached_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      data = excluded.data,
      provider = excluded.provider,
      ttl_ms = excluded.ttl_ms,
      cached_at = excluded.cached_at,
      expires_at = excluded.expires_at
  `);
  stmt.run(key, JSON.stringify(data), provider, ttlMs, now, now + ttlMs);
}

/**
 * 만료된 캐시 엔트리를 정리한다.
 * Cron 작업 또는 서버 시작 시 호출된다.
 */
export function purgeExpiredCache(db: DatabaseSync): number {
  const stmt = db.prepare('DELETE FROM market_cache WHERE expires_at <= ?');
  const result = stmt.run(Date.now());
  return result.changes;
}
```

### 5.8 데이터 흐름 다이어그램

```
메모리 저장 흐름:
  사용자 → addMemory(content) → chunkMarkdown(content, 512, 64)
    → embedBatch(chunks.map(c => c.text))
    → INSERT INTO memories + INSERT INTO memory_chunks + INSERT INTO memory_chunks_fts

하이브리드 검색 흐름:
  사용자 쿼리 → search(query, options)
    ├─→ searchFts(db, query, limit) ─────→ FTS5 BM25 결과
    │                                        │
    ├─→ searchVector(db, query, provider) ─→ 벡터 코사인 결과
    │                                        │
    └─→ mergeHybridResults(vector, fts, weights)
         → 가중치 합산 (0.7 * vector + 0.3 * fts)
         → minScore 필터 → 정렬 → 상위 N개

금융 캐시 흐름:
  CLI/스킬 → getMarketQuote("AAPL")
    → getCachedData("quote:AAPL")
      ├─→ 캐시 HIT (만료 전): JSON.parse → 반환
      └─→ 캐시 MISS: API 호출 → setCachedData("quote:AAPL", data, "alpha-vantage", 300000) → 반환
```

---

## 6. 선행 조건

| 선행 Phase         | 필요한 산출물                                                  | 사용처                      |
| ------------------ | -------------------------------------------------------------- | --------------------------- |
| Phase 1 (types)    | `MemoryEntry`, `SearchResult`, `MarketData`, `PriceAlert` 타입 | 테이블 인터페이스 정의      |
| Phase 2 (infra)    | 로거, 경로 유틸리티 (`resolveDataDir()`)                       | DB 파일 경로 해석, 로깅     |
| Phase 3 (config)   | `loadConfig()`, API 키 설정                                    | 임베딩 프로바이더 API 키    |
| Phase 10 (gateway) | Gateway 서버                                                   | RPC를 통한 메모리 검색 접근 |

### 새로운 의존성

| 패키지       | 버전     | 용도                         |
| ------------ | -------- | ---------------------------- |
| `sqlite-vec` | `^0.2.0` | 벡터 유사도 검색 SQLite 확장 |

> **참고**: `node:sqlite`는 Node.js 22+ 내장 모듈이므로 별도 설치 불필요.

---

## 7. 산출물 및 검증

### 기능 검증 항목

| #   | 검증 항목       | 검증 방법                              | 기대 결과                        |
| --- | --------------- | -------------------------------------- | -------------------------------- |
| 1   | DB 초기화       | `openDatabase({ path: ':memory:' })`   | 모든 테이블 생성 확인            |
| 2   | WAL 모드        | `PRAGMA journal_mode` 조회             | 'wal' 반환                       |
| 3   | 스키마 버전     | meta 테이블 `schema_version` 조회      | SCHEMA_VERSION 값                |
| 4   | 대화 CRUD       | 대화 생성/조회/삭제                    | 정상 동작, FK 캐스케이드 삭제    |
| 5   | 메시지 저장     | 메시지 삽입 후 대화별 조회             | 시간순 정렬, 완전한 데이터       |
| 6   | 메모리 청킹     | `chunkMarkdown(longText, 512, 64)`     | 올바른 청크 분할, 오버랩 확인    |
| 7   | FTS5 검색       | 메모리 저장 후 `searchFts()`           | BM25 랭킹 결과, 관련도 순        |
| 8   | 벡터 검색       | mock 임베딩으로 `searchVector()`       | 코사인 유사도 결과, 유사도 순    |
| 9   | 하이브리드 검색 | 동일 쿼리로 FTS + vector 병합          | 가중치 합산 정확성, 중복 제거    |
| 10  | 임베딩 캐시     | 동일 해시 재요청                       | 캐시에서 반환, API 미호출        |
| 11  | 시장 캐시 저장  | `setCachedData()` 후 `getCachedData()` | 정상 반환                        |
| 12  | 시장 캐시 만료  | TTL 초과 후 `getCachedData()`          | null 반환                        |
| 13  | 캐시 정리       | `purgeExpiredCache()`                  | 만료 엔트리만 삭제, 삭제 수 반환 |
| 14  | 알림 CRUD       | 알림 생성/조회/트리거/삭제             | 정상 동작                        |
| 15  | Atomic reindex  | 리인덱싱 중 원본 DB 접근               | 원본 유지, 스왑 후 신규 DB 사용  |

### 테스트 커버리지 목표

| 모듈                      | 목표 커버리지          |
| ------------------------- | ---------------------- |
| `storage/database.ts`     | 90%+                   |
| `storage/tables/*.ts`     | 85%+                   |
| `storage/search/*.ts`     | 90%+                   |
| `storage/embeddings/*.ts` | 80%+ (API 호출은 mock) |

---

## 8. 복잡도 및 예상 파일 수

| 항목               | 값                                  |
| ------------------ | ----------------------------------- |
| 복잡도             | **XL** (Extra Large)                |
| 소스 파일          | 14개                                |
| 테스트 파일        | 6개                                 |
| 총 파일 수         | **~20개**                           |
| 예상 총 코드 줄 수 | ~2,500줄 (소스 ~1,700, 테스트 ~800) |
| 새 의존성          | `sqlite-vec`                        |
| 예상 구현 시간     | 8-12시간                            |

### 복잡도 근거

OpenClaw 메모리 시스템이 43파일/27K LOC인 반면, FinClaw는 미디어 이해, 링크 이해, TTS, ACP 프로토콜을 제외하고 **코어 스토리지 + 검색 + 임베딩**에만 집중한다. 그러나 SQLite 스키마 설계, FTS5 + sqlite-vec 하이브리드 검색, 임베딩 프로바이더, atomic reindex 등 기술적 난이도가 높은 컴포넌트가 집중되어 있어 XL 복잡도에 해당한다. 특히 금융 도메인의 TTL 캐시와 알림 테이블은 OpenClaw에 없는 FinClaw 고유 기능이다.
