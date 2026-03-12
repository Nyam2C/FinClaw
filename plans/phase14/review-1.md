# Phase 14 Review-1: Todo-1 기반 계층 (DB + 테이블 CRUD)

## 구현 완료 여부

### 파일 목록 (todo-1 대비)

| #   | 파일                                                       | 상태 | 비고                                      |
| --- | ---------------------------------------------------------- | ---- | ----------------------------------------- |
| 1   | `packages/storage/package.json`                            | ✅   | sqlite-vec 0.1.7-alpha.2 추가             |
| 2   | `packages/storage/src/database.ts`                         | ✅   | DDL + openDatabase + 마이그레이션         |
| 3   | `packages/storage/src/tables/conversations.ts`             | ✅   | 5개 CRUD 함수                             |
| 4   | `packages/storage/src/tables/messages.ts`                  | ✅   | 4개 CRUD 함수                             |
| 5   | `packages/storage/src/tables/memories.ts`                  | ✅   | chunkMarkdown + CRUD + vec0/FTS 수동 삭제 |
| 6   | `packages/storage/src/tables/embeddings.ts`                | ✅   | Buffer↔Float32Array 변환 포함             |
| 7   | `packages/storage/src/tables/alerts.ts`                    | ✅   | Alert nested condition 변환               |
| 8   | `packages/storage/src/tables/market-cache.ts`              | ✅   | CACHE_TTL + TTL CRUD                      |
| 9   | `packages/storage/src/index.ts`                            | ✅   | barrel export + createStorage 팩토리      |
| 10  | `packages/storage/src/database.test.ts`                    | ✅   | 7개 테스트 케이스                         |
| 11  | `packages/storage/src/tables/messages.storage.test.ts`     | ✅   | 7개 테스트 케이스                         |
| 12  | `packages/storage/src/tables/market-cache.storage.test.ts` | ✅   | 6개 테스트 케이스                         |

**결론: todo-1에 명시된 모든 파일과 함수가 구현됨.**

### 검증 항목 (todo-1 §검증 기준 대응)

| #   | 검증 항목           | 대응                                                | 상태 |
| --- | ------------------- | --------------------------------------------------- | ---- |
| 1   | DB 초기화           | database.test.ts `:memory:` 테이블 생성 확인        | ✅   |
| 2   | WAL 모드            | database.test.ts PRAGMA journal_mode 확인           | ✅   |
| 3   | 스키마 버전         | database.test.ts schema_version meta 확인           | ✅   |
| 4   | 대화 CRUD           | conversations.ts 5개 함수 구현                      | ✅   |
| 5   | 메시지 저장         | messages.storage.test.ts 시간순 정렬 + FK CASCADE   | ✅   |
| 6   | 메모리 청킹         | memories.ts chunkMarkdown 구현                      | ✅   |
| 11  | 시장 캐시 저장      | market-cache.storage.test.ts                        | ✅   |
| 12  | 시장 캐시 만료      | market-cache.storage.test.ts TTL 만료 확인          | ✅   |
| 13  | 캐시 정리           | market-cache.storage.test.ts purge 확인             | ✅   |
| 14  | 알림 CRUD           | alerts.ts 7개 함수 구현                             | ✅   |
| 16  | sqlite-vec 로드     | database.test.ts vec_version() 확인                 | ✅   |
| 20  | StorageAdapter 정합 | index.ts createStorage 반환값이 StorageAdapter 구현 | ✅   |
| 21  | Alert 타입 정합     | alerts.ts @finclaw/types Alert 사용                 | ✅   |

---

## 발견된 이슈

### I-1. DDL: alerts 테이블 CHECK 제약 누락 (Low)

**plan.md:**

```sql
condition_type TEXT NOT NULL CHECK(condition_type IN ('above', 'below', 'crosses_above', 'crosses_below', 'change_percent'))
```

**구현 (`database.ts:99`):**

```sql
condition_type TEXT NOT NULL,
```

CHECK 제약이 없으면 잘못된 condition_type 값이 DB에 저장될 수 있다. 애플리케이션 레이어에서 타입으로 제약하지만, DB 레벨 방어가 빠져있다.

### I-2. DDL: alerts 부분 인덱스 변경 (Low)

**plan.md:**

```sql
CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(enabled) WHERE enabled = 1;
```

**구현 (`database.ts:113`):**

```sql
CREATE INDEX IF NOT EXISTS idx_alerts_enabled ON alerts(enabled);
```

부분 인덱스(WHERE enabled = 1)가 일반 인덱스로 변경됨. `getActiveAlerts()`에서 `WHERE enabled = 1` 쿼리가 빈번하므로 부분 인덱스가 더 효율적이다. 다만 현재 데이터 규모에서는 실질적 차이 없음.

### I-3. DDL: memory_chunks.hash 컬럼 nullable (Low)

**todo-1 §2:**

```
hash TEXT NOT NULL
```

**구현 (`database.ts:70`):**

```sql
hash TEXT,
```

NOT NULL이 빠지고 DEFAULT도 없다. 현재 addMemory에서 hash를 넣지 않으므로 NULL이 들어갈 수 있다. memory_chunks에 hash가 필요한 시점(todo-2 임베딩 처리)에서 NOT NULL로 변경하거나, 현재 nullable로 두되 이를 의도적 결정으로 기록해야 한다.

### I-4. enableLoadExtension(true) 미호출 (Info)

**todo-1 §2 openDatabase 순서:**

> 1. `new DatabaseSync(path, { allowExtension: true })`
> 2. sqlite-vec 로드: `load(db)`
> 3. `enableLoadExtension(false)`

**구현 (`database.ts:158-162`):**

```typescript
const db = new DatabaseSync(path, { allowExtension: true });
sqliteVec.load(db);
db.enableLoadExtension(false);
```

`enableLoadExtension(true)` 호출이 빠져있지만, 생성자 옵션 `allowExtension: true`가 동일 효과를 하므로 동작에 문제 없음. plan.md의 의사 코드와 미세한 차이일 뿐.

### I-5. messages role CHECK에 'tool' 추가 (Good)

**plan.md:**

```sql
role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system'))
```

**구현 (`database.ts:42`):**

```sql
role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool'))
```

`@finclaw/types`의 `ConversationMessage` role에 `'tool'`이 포함되어 있으므로 이 변경은 올바른 판단이다.

---

## 리팩토링 사항

### R-1. listConversations N+1 쿼리 (Medium)

`conversations.ts:217-224`에서 각 대화마다 별도 메시지 SELECT를 실행한다:

```typescript
return rows.map((row) => {
  const msgRows = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(row.id) as unknown as MessageRow[];
  return rowToRecord(row, msgRows.map(messageRowToMessage));
});
```

대화가 N개면 N+1 쿼리가 발생한다. 대안:

- `listConversations`는 메시지 없이 ConversationRecord를 반환하고, 필요 시 별도 조회
- 또는 JOIN으로 한 번에 조회 후 그룹화

### R-2. index.ts에 ConversationRow/MemoryRow 타입 중복 (Low)

`index.ts:34-49`에 `ConversationRow`, `MemoryRow`가 정의되어 있으나, 동일 타입이 `conversations.ts:13-21`, `memories.ts:16-24`에도 존재한다. table 파일에서 export하여 재사용하거나, `searchConversations`/`searchMemory`가 table 함수를 호출하도록 변경할 수 있다.

단, todo-2에서 이 LIKE 폴백이 FTS/vector hybrid로 교체되므로, 현 시점에서 리팩토링 우선순위는 낮다.

### R-3. tryParseContent 중복 (Low)

`conversations.ts:63-72`와 `messages.ts:48-57`에 동일한 `tryParseContent` 함수가 존재한다. 공통 유틸리티로 추출 가능하나, 두 파일 외 사용처가 없으므로 현재는 허용 범위.

---

## 종합 평가

구현이 todo-1 명세를 충실히 따르고 있으며, 모든 파일과 함수가 존재한다. DDL 차이(I-1~I-3)는 동작에 영향을 주지 않는 수준이고, N+1 쿼리(R-1)가 향후 성능 이슈가 될 수 있는 유일한 Medium 사항이다. 전체적으로 todo-2 진행에 문제 없음.
