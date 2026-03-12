# Phase 14 Todo-1: 기반 계층 (DB + 테이블 CRUD)

> SQLite 초기화, 스키마, 7개 테이블 CRUD, StorageAdapter 팩토리
> 외부 API 의존 없이 독립 실행 가능

---

## 1. `packages/storage/package.json` 수정

sqlite-vec 의존성 추가:

```json
{
  "dependencies": {
    "@finclaw/types": "workspace:*",
    "sqlite-vec": "0.1.7-alpha.2"
  }
}
```

검증: `pnpm install` 성공, `node_modules/sqlite-vec` 존재

---

## 2. `packages/storage/src/database.ts` — DB 초기화 & 스키마

### 내보내기

```typescript
// 인터페이스
export interface Database {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly schemaVersion: number;
  close(): void;
}

export interface DatabaseOptions {
  readonly path: string;
  readonly enableWAL?: boolean; // 기본 true
  readonly enableForeignKeys?: boolean; // 기본 true
}

// 함수
export function openDatabase(options: DatabaseOptions): Database;
```

### 내부 함수

```typescript
function readMetaValue(db: DatabaseSync, key: string): string | null;
function writeMetaValue(db: DatabaseSync, key: string, value: string): void;
function runMigrations(db: DatabaseSync, from: number, to: number): void;
```

### 상수

```typescript
const SCHEMA_VERSION = 1;
const SCHEMA_DDL: string; // plan.md §5.1의 전체 DDL
const MIGRATIONS: Record<number, string> = {};
```

### DDL 테이블 목록 (SCHEMA_DDL 내용)

1. `meta` — key/value 메타 정보
2. `conversations` — 대화 세션 (id, title, agent_id, channel_id, created_at, updated_at, metadata)
3. `messages` — 메시지 (id, conversation_id, role, content, tool_calls, token_count, created_at) + FK + idx
4. `memories` — 메모리 엔트리 (id, session_key, content, type, hash, created_at, metadata) + idx
5. `memory_chunks` — 청크 (id, memory_id, text, start_line, end_line, model, hash, created_at) + FK + idx
6. `memory_chunks_vec` — vec0 가상 테이블 (chunk_id TEXT PK, embedding float[1024])
7. `memory_chunks_fts` — FTS5 가상 테이블 (text, id UNINDEXED, memory_id UNINDEXED, tokenize='trigram')
8. `embedding_cache` — (provider, model, hash) PK, embedding BLOB, dims, updated_at
9. `alerts` — 알림 (id, name, symbol, condition_type, condition_value, condition_field, enabled, channel_id, trigger_count, cooldown_ms, last_triggered_at, created_at) + idx
10. `market_cache` — (key PK, data, provider, ttl_ms, cached_at, expires_at) + idx

### openDatabase 구현 순서

1. `new DatabaseSync(path, { allowExtension: true })`
2. sqlite-vec 로드: `load(db)` (from `sqlite-vec`)
3. `enableLoadExtension(false)`
4. PRAGMA: WAL, foreign_keys, synchronous=NORMAL, cache_size=-64000, mmap_size=268435456, temp_store=MEMORY
5. `db.exec(SCHEMA_DDL)`
6. meta 테이블에서 schema_version 읽기 → 없으면 INSERT, 낮으면 마이그레이션 후 UPDATE
7. Database 객체 반환 (close에서 PRAGMA optimize + db.close())

검증: `:memory:` DB에서 모든 테이블 생성 확인, `SELECT vec_version()` 성공

---

## 3. `packages/storage/src/tables/conversations.ts` — 대화 CRUD

### 타입 참조

- `@finclaw/types`: `SessionKey`, `AgentId`, `Timestamp`, `ConversationRecord`, `ConversationMessage`
- `database.ts`: `Database`

plan.md의 `Conversation` 인터페이스는 DB 행 매핑용 내부 타입이다. 외부 API는 `ConversationRecord`를 사용.

### 내보내기

```typescript
// DB 행 ↔ ConversationRecord 변환용 내부 타입 (필요 시)
interface ConversationRow {
  id: string;
  title: string | null;
  agent_id: string;
  channel_id: string | null;
  created_at: number;
  updated_at: number;
  metadata: string; // JSON
}

// CRUD 함수
export function createConversation(db: DatabaseSync, record: ConversationRecord): void;

export function getConversation(
  db: DatabaseSync,
  sessionKey: SessionKey,
): ConversationRecord | null;

export function updateConversation(
  db: DatabaseSync,
  sessionKey: SessionKey,
  updates: { title?: string; metadata?: Record<string, unknown> },
): void;

export function deleteConversation(db: DatabaseSync, sessionKey: SessionKey): boolean;

export function listConversations(
  db: DatabaseSync,
  options?: { agentId?: AgentId; limit?: number; offset?: number },
): ConversationRecord[];
```

### 구현 상세

- `createConversation`: INSERT conversations 행 + 각 message INSERT (트랜잭션)
- `getConversation`: SELECT conversations WHERE id=sessionKey → messages JOIN → ConversationRecord 조립
- `updateConversation`: UPDATE conversations SET title/metadata/updated_at
- `deleteConversation`: DELETE conversations WHERE id=? (CASCADE로 messages 삭제)
- `listConversations`: SELECT with optional agent_id 필터, ORDER BY updated_at DESC, LIMIT/OFFSET

### 행 변환

- `ConversationRow` → `ConversationRecord`: agent_id→agentId, metadata JSON.parse, messages는 별도 조회
- `ConversationRecord` → INSERT: sessionKey→id, agentId→agent_id, metadata JSON.stringify

검증: 대화 생성/조회/삭제, FK 캐스케이드로 messages 동시 삭제

---

## 4. `packages/storage/src/tables/messages.ts` — 메시지 CRUD

### 타입 참조

- `@finclaw/types`: `ConversationMessage` (role: system|user|assistant|tool, content, toolCallId?, name?)
- plan.md `Message`: id, conversationId, role, content, toolCalls, tokenCount, createdAt

### 내보내기

```typescript
// DB 행 타입
interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  tool_calls: string | null; // JSON
  token_count: number | null;
  created_at: number;
}

// plan.md의 ToolCallRecord
export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
}

// CRUD 함수
export function addMessage(
  db: DatabaseSync,
  conversationId: string,
  message: ConversationMessage,
  options?: { tokenCount?: number },
): string; // 반환: 생성된 message ID

export function getMessages(
  db: DatabaseSync,
  conversationId: string,
  options?: { limit?: number; offset?: number; order?: 'asc' | 'desc' },
): Message[];

export function getMessageCount(db: DatabaseSync, conversationId: string): number;

export function deleteMessage(db: DatabaseSync, messageId: string): boolean;
```

### 구현 상세

- `addMessage`: UUID 생성 (crypto.randomUUID()), ConversationMessage → MessageRow 변환, INSERT
  - `content`: string이면 그대로, ContentBlock[]이면 JSON.stringify
  - `tool_calls`: ConversationMessage에서 tool_use 블록 추출 → ToolCallRecord[] → JSON
  - `created_at`: Date.now()
  - conversations.updated_at도 함께 UPDATE
- `getMessages`: SELECT FROM messages WHERE conversation_id=? ORDER BY created_at ASC/DESC
- `getMessageCount`: SELECT COUNT(\*)
- `deleteMessage`: DELETE FROM messages WHERE id=?

검증: 메시지 삽입 후 대화별 시간순 조회, conversationId 외래 키 제약

---

## 5. `packages/storage/src/tables/memories.ts` — 메모리 CRUD + chunkMarkdown

### 타입 참조

- `@finclaw/types`: `MemoryEntry` (id, sessionKey, content, embedding?, type, createdAt, metadata?)
- plan.md: `MemoryRow`, `MemoryChunk`

### 내보내기

```typescript
// DB 행 타입 (내부)
interface MemoryRow {
  id: string;
  session_key: string;
  content: string;
  type: 'fact' | 'preference' | 'summary' | 'financial';
  hash: string;
  created_at: number;
  metadata: string;
}

export interface MemoryChunk {
  readonly id: string;
  readonly memoryId: string;
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly model: string;
}

// 청킹 함수
export function chunkMarkdown(
  text: string,
  maxTokens?: number, // 기본 512
  overlap?: number, // 기본 64
): Array<{ text: string; startLine: number; endLine: number }>;

// CRUD 함수
export function addMemory(db: DatabaseSync, entry: MemoryEntry): void;

export function getMemory(db: DatabaseSync, id: string): MemoryEntry | null;

export function getMemoriesBySession(
  db: DatabaseSync,
  sessionKey: SessionKey,
  options?: { type?: MemoryEntry['type']; limit?: number },
): MemoryEntry[];

export function deleteMemory(db: DatabaseSync, id: string): boolean;

export function getMemoryChunks(db: DatabaseSync, memoryId: string): MemoryChunk[];
```

### chunkMarkdown 알고리즘 (plan.md §5.6)

1. `maxChars = maxTokens * 4` (토큰-문자 비율)
2. `overlapChars = overlap * 4`
3. 줄 단위 순회, 현재 청크에 추가
4. `currentChunk.length + line.length + 1 > maxChars` → flush
5. flush 시 뒤에서 overlapChars만큼 carry
6. `startLine = max(0, currentLine - countNewlines(carry))`
7. 마지막 잔여 청크 push

### addMemory 구현 상세

1. content의 SHA-256 해시 계산 (crypto.createHash)
2. 중복 체크: `SELECT id FROM memories WHERE hash = ?` → 존재하면 early return (또는 update)
3. INSERT INTO memories
4. `chunkMarkdown(content)` → 청크 배열
5. 각 청크에 대해 INSERT INTO memory_chunks (id=randomUUID, model='pending')
6. 각 청크를 INSERT INTO memory_chunks_fts (text, id, memory_id)
7. 임베딩은 todo-2에서 처리 (model='pending'으로 표시)

### deleteMemory 구현 상세 (vec0 수동 CASCADE)

1. `SELECT id FROM memory_chunks WHERE memory_id = ?` → chunk IDs
2. `DELETE FROM memory_chunks_vec WHERE chunk_id IN (...)` — vec0 수동 삭제
3. `DELETE FROM memory_chunks_fts WHERE id IN (...)` — FTS5 수동 삭제
4. `DELETE FROM memories WHERE id = ?` — CASCADE로 memory_chunks 삭제

검증: 메모리 CRUD, 청킹 결과, 중복 방지(hash), 삭제 시 chunks/vec/fts 동기화

---

## 6. `packages/storage/src/tables/embeddings.ts` — 임베딩 캐시

### 내보내기

```typescript
// DB 행 타입
interface EmbeddingCacheRow {
  provider: string;
  model: string;
  hash: string;
  embedding: Buffer; // Float32Array → Buffer
  dims: number | null;
  updated_at: number;
}

export function getCachedEmbedding(
  db: DatabaseSync,
  provider: string,
  model: string,
  hash: string,
): number[] | null;

export function setCachedEmbedding(
  db: DatabaseSync,
  provider: string,
  model: string,
  hash: string,
  embedding: number[],
): void;

export function deleteCachedEmbeddings(db: DatabaseSync, provider: string, model?: string): number; // 삭제된 행 수
```

### 구현 상세

- `getCachedEmbedding`: SELECT embedding FROM embedding_cache WHERE provider=? AND model=? AND hash=? → Buffer → Float32Array → number[]
- `setCachedEmbedding`: number[] → Float32Array → Buffer, INSERT OR REPLACE (dims=embedding.length)
- Buffer ↔ Float32Array 변환 유틸:
  ```typescript
  function float32ToBuffer(arr: Float32Array): Buffer;
  function bufferToFloat32(buf: Buffer): Float32Array;
  ```

검증: 캐시 저장/조회, Buffer↔Float32Array 왕복 변환

---

## 7. `packages/storage/src/tables/alerts.ts` — 알림 CRUD

### 타입 참조

- `@finclaw/types/finance.ts`: `Alert`, `AlertCondition`, `AlertConditionType`, `TickerSymbol`, `Timestamp`

### 내보내기

```typescript
export function createAlert(db: DatabaseSync, alert: Alert): void;

export function getAlert(db: DatabaseSync, id: string): Alert | null;

export function getAlertsBySymbol(
  db: DatabaseSync,
  symbol: TickerSymbol,
  options?: { enabledOnly?: boolean },
): Alert[];

export function getActiveAlerts(db: DatabaseSync): Alert[];

export function updateAlertTrigger(db: DatabaseSync, id: string, triggeredAt: Timestamp): void;

export function toggleAlert(db: DatabaseSync, id: string, enabled: boolean): void;

export function deleteAlert(db: DatabaseSync, id: string): boolean;
```

### DB 행 ↔ Alert 변환

DB 행 (flat):

```
id, name, symbol, condition_type, condition_value, condition_field, enabled, channel_id, trigger_count, cooldown_ms, last_triggered_at, created_at
```

Alert 객체 (nested condition):

```typescript
{
  id, name, symbol (as TickerSymbol),
  condition: { type: condition_type, value: condition_value, field: condition_field },
  enabled: Boolean(enabled), channelId: channel_id,
  triggerCount: trigger_count, cooldownMs: cooldown_ms,
  lastTriggeredAt: last_triggered_at (as Timestamp | undefined),
  createdAt: created_at (as Timestamp)
}
```

- `createAlert`: Alert → flat columns INSERT
- `getAlert`: SELECT → row → Alert 조립
- `getAlertsBySymbol`: SELECT WHERE symbol=? (AND enabled=1 if enabledOnly)
- `getActiveAlerts`: SELECT WHERE enabled=1
- `updateAlertTrigger`: UPDATE SET last_triggered_at=?, trigger_count=trigger_count+1
- `toggleAlert`: UPDATE SET enabled=?
- `deleteAlert`: DELETE WHERE id=?

검증: Alert 타입 정합 (condition 중첩 구조), TickerSymbol 브랜드 타입 호환

---

## 8. `packages/storage/src/tables/market-cache.ts` — TTL 캐시

### 내보내기

```typescript
export const CACHE_TTL: {
  readonly QUOTE: 300_000; // 5분
  readonly HISTORICAL_1D: 3_600_000; // 1시간
  readonly HISTORICAL_1W: 21_600_000; // 6시간
  readonly FOREX: 900_000; // 15분
  readonly CRYPTO: 180_000; // 3분
};

export interface MarketCacheEntry {
  readonly key: string;
  readonly data: string;
  readonly provider: string;
  readonly ttlMs: number;
  readonly cachedAt: number;
  readonly expiresAt: number;
}

export function getCachedData<T>(db: DatabaseSync, key: string): T | null;

export function setCachedData(
  db: DatabaseSync,
  key: string,
  data: unknown,
  provider: string,
  ttlMs: number,
): void;

export function purgeExpiredCache(db: DatabaseSync): number; // 삭제된 행 수
```

### 구현 (plan.md §5.7 그대로)

- `getCachedData`: SELECT data WHERE key=? AND expires_at > Date.now() → JSON.parse
- `setCachedData`: INSERT ON CONFLICT UPDATE, expires_at = cachedAt + ttlMs
- `purgeExpiredCache`: DELETE WHERE expires_at <= Date.now(), return changes

검증: 캐시 저장/조회, TTL 만료 후 null 반환, purge 삭제 수 확인

---

## 9. `packages/storage/src/index.ts` — barrel export + createStorage 팩토리

### 내보내기

```typescript
// re-export
export { openDatabase, type Database, type DatabaseOptions } from './database.js';
export { chunkMarkdown, type MemoryChunk } from './tables/memories.js';
export { CACHE_TTL, type MarketCacheEntry } from './tables/market-cache.js';

// StorageAdapter 팩토리
export interface StorageOptions {
  dbPath: string;
  enableWAL?: boolean;
}

export function createStorage(options: StorageOptions): StorageAdapter;
```

### createStorage 구현

1. `openDatabase({ path: options.dbPath, enableWAL: options.enableWAL })`
2. `StorageAdapter` 인터페이스 구현 객체 반환:

```typescript
{
  async initialize() { /* DB 이미 openDatabase에서 초기화됨 — no-op 또는 검증 */ },
  async close() { database.close(); },
  async saveConversation(record) { createConversation(database.db, record); },
  async getConversation(sessionKey) { return getConversation(database.db, sessionKey); },
  async searchConversations(query) { /* FTS 검색 — todo-2에서 구현, 여기서는 기본 LIKE 검색 */ },
  async saveMemory(entry) { addMemory(database.db, entry); },
  async searchMemory(query, limit) { /* todo-2에서 하이브리드 검색, 여기서는 LIKE 폴백 */ },
}
```

> `searchConversations`와 `searchMemory`는 todo-2에서 FTS/vector/hybrid로 교체. todo-1에서는 기본 SQL LIKE 검색으로 StorageAdapter 타입 정합만 달성.

검증: `createStorage()` 반환값이 `StorageAdapter` 타입에 할당 가능

---

## 10. 테스트 파일

### 10.1 `packages/storage/src/database.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { openDatabase } from './database.js';

describe('openDatabase', () => {
  it(':memory: DB에서 모든 테이블 생성');
  it('WAL 모드 활성화 확인');
  it('외래 키 활성화 확인');
  it('schema_version meta 기록 확인');
  it('sqlite-vec 로드 확인 — SELECT vec_version()');
  it('중복 호출 시 기존 스키마 유지 (IF NOT EXISTS)');
  it('close() 호출 후 재사용 불가');
});
```

테스트 헬퍼: `:memory:` DB 열기/닫기 (`beforeEach`/`afterEach`)

### 10.2 `packages/storage/src/tables/messages.storage.test.ts`

```typescript
describe('messages CRUD', () => {
  it('메시지 추가 후 conversationId로 조회');
  it('시간순 정렬 확인 (asc/desc)');
  it('limit/offset 페이지네이션');
  it('getMessageCount 정확성');
  it('deleteMessage 후 조회 불가');
  it('conversation 삭제 시 CASCADE 확인');
  it('tool_calls JSON 직렬화/역직렬화');
});
```

사전 조건: conversations 테이블에 테스트 대화 삽입

### 10.3 `packages/storage/src/tables/market-cache.storage.test.ts`

```typescript
describe('market-cache', () => {
  it('setCachedData 후 getCachedData로 조회');
  it('TTL 만료 후 getCachedData → null');
  it('동일 key에 setCachedData → 덮어쓰기 (UPSERT)');
  it('purgeExpiredCache — 만료 엔트리만 삭제');
  it('purgeExpiredCache — 삭제 수 반환');
  it('CACHE_TTL 상수 값 확인');
});
```

TTL 만료 테스트: `setCachedData`에서 ttlMs=1로 설정 후 약간의 지연 → `getCachedData` null 확인 (또는 Date.now mock)

---

## 실행 순서

1. `package.json` 수정 + `pnpm install`
2. `database.ts` 구현
3. `database.test.ts` 작성 → 테스트 통과
4. `tables/conversations.ts` 구현
5. `tables/messages.ts` 구현
6. `messages.storage.test.ts` 작성 → 테스트 통과
7. `tables/memories.ts` 구현 (chunkMarkdown 포함, 임베딩은 stub)
8. `tables/embeddings.ts` 구현
9. `tables/alerts.ts` 구현
10. `tables/market-cache.ts` 구현
11. `market-cache.storage.test.ts` 작성 → 테스트 통과
12. `index.ts` — barrel export + createStorage 팩토리
13. `tsc --build` 통과 확인

## 검증 기준 (plan.md §7 대응)

| #   | 검증 항목           | todo-1 대응                  |
| --- | ------------------- | ---------------------------- |
| 1   | DB 초기화           | database.test.ts             |
| 2   | WAL 모드            | database.test.ts             |
| 3   | 스키마 버전         | database.test.ts             |
| 4   | 대화 CRUD           | conversations.ts 구현        |
| 5   | 메시지 저장         | messages.storage.test.ts     |
| 6   | 메모리 청킹         | memories.ts chunkMarkdown    |
| 11  | 시장 캐시 저장      | market-cache.storage.test.ts |
| 12  | 시장 캐시 만료      | market-cache.storage.test.ts |
| 13  | 캐시 정리           | market-cache.storage.test.ts |
| 14  | 알림 CRUD           | alerts.ts 구현               |
| 16  | sqlite-vec 로드     | database.test.ts             |
| 20  | StorageAdapter 정합 | index.ts createStorage       |
| 21  | Alert 타입 정합     | alerts.ts                    |
