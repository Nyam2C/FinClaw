# 03_rpc-engineer — Phase 26 밀스톤 B memory.\* RPC 신설

## 핵심 결정

- **storage 모듈 직접 호출** — `@finclaw/storage` 가 `getMemory` / `deleteMemory` / `searchVector` / `searchFts` / `mergeHybridResults` 를 노출하므로 RPC 핸들러는 이를 그대로 호출. 별도 어댑터 없음.
- **list 는 직접 SQL** — storage 에 `listMemoriesAcrossSessions` 같은 함수가 없음(`getMemoriesBySession` 은 sessionKey 필수). RPC 핸들러 내부에 짧은 SQL 헬퍼 추가. type/sessionKey/limit 옵션을 동적 binding 으로 안전하게 조립.
- **db 의존성 옵셔널** — `MemoryRpcDeps.db?: DatabaseSync` 미주입 시 모든 메서드 `provider_unavailable` 에러. finance.\* 와 동일 패턴.
- **embeddingProvider 옵셔널** — 주입되면 hybrid (vector + FTS) 검색, 없으면 FTS-only fallback. memory.search 가 RAG 스테이지(밀스톤 C)와 다른 점: **임계값/신선도/상한 적용 X — 디버깅 용 raw 검색**.
- **delete 는 멱등** — 미존재 id 호출 시 `{deleted: false}` 응답 (NOT_FOUND 에러 X). 사용자가 같은 버튼을 두 번 눌러도 안전.
- **storage.deleteMemory 가 vec0 + FTS5 동시 cleanup** — RPC 핸들러는 단순 위임. 한 군데 누락 검증은 storage 단위 테스트(memories.storage.test.ts)에 이미 있음.
- **search 결과 dedupe** — chunk 단위 hits → memoryId 단위로 1개씩만. `getMemory` 로 본문/createdAt 보강. 기존 storage 의 `searchMemory` 와 동일 알고리즘.
- **WebSocket notification 없음** — 본 단계에서는 `memory.changed` 같은 broadcast 안 함. 사용자가 Settings UI 에서 직접 누른 결과만 RPC 응답으로 반영. (밀스톤 C 의 RAG 주입 로그는 별도 채널.)

## 변경/신설 파일

| 경로                                                     | 변경 종류       | 요약                                                                                                            |
| -------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------- |
| `packages/types/src/gateway.ts`                          | 수정            | `RpcMethod` union 에 `memory.{list,delete,search}` 3개 추가.                                                    |
| `packages/server/src/gateway/rpc/methods/memory.ts`      | 신설 (~210 LOC) | `MemoryRpcDeps` interface, `registerMemoryMethods` 함수, 3개 핸들러.                                            |
| `packages/server/src/gateway/server.ts`                  | 수정 (~5 LOC)   | `GatewayServerDeps.memoryDeps?` 추가, `registerMemoryMethods(deps.memoryDeps ?? {})` 호출.                      |
| `packages/server/src/main.ts`                            | 수정 (~25 LOC)  | `createEmbeddingProvider('auto')` best-effort 호출(키 없으면 skip), `memoryDeps: {db, embeddingProvider}` 주입. |
| `packages/server/src/gateway/rpc/methods/memory.test.ts` | 신설 (~330 LOC) | 21건 단위 테스트. mock-only, in-memory-temp DB 기반.                                                            |

## 신규 RPC 시그니처

### memory.list

```ts
input: {
  type?: 'fact' | 'preference' | 'summary' | 'financial';   // 선택 필터
  sessionKey?: string;                                       // 선택 필터 (미지정 시 모든 세션)
  limit?: number;                                            // 1~500, default 100
}
output: {
  memories: Array<{
    id: string;
    sessionKey: SessionKey;
    content: string;
    type: 'fact' | 'preference' | 'summary' | 'financial';
    createdAt: Timestamp;
  }>;                                                        // created_at DESC
}
errors: provider_unavailable (db 미주입), Invalid params (Zod)
```

### memory.delete

```ts
input: {
  memoryId: string;                                          // 필수
}
output: {
  deleted: boolean;                                          // true (삭제됨) / false (미존재)
}
side-effect: memories 행 + memory_chunks (CASCADE) + memory_chunks_vec + memory_chunks_fts 동시 cleanup
errors: provider_unavailable, Invalid params
```

미존재 id 도 에러가 아닌 `{deleted: false}` 응답. UI 가 같은 항목을 중복 호출해도 멱등.

### memory.search

```ts
input: {
  query: string;                                             // 필수, min 1
  limit?: number;                                            // 1~50, default 10
  types?: Array<'fact' | 'preference' | 'summary' | 'financial'>;  // 결과 후 필터
}
output: {
  results: Array<{
    id: string;
    content: string;
    type: 'fact' | 'preference' | 'summary' | 'financial';
    score: number;                                           // hybrid: 가중합 / FTS-only: BM25 0~1
    createdAt: Timestamp;
  }>;                                                        // memory 단위 dedup, 최대 limit 개
}
errors: provider_unavailable, Invalid params
```

알고리즘:

1. `embeddingProvider` 주입 → `searchVector` + `searchFts` 병렬 → `mergeHybridResults({limit: limit*2})`.
2. 미주입 → `searchFts(limit*2)` 단독.
3. chunkId 결과들을 `memoryId` 단위로 중복 제거, `getMemory(memoryId)` 로 본문 보강. `types` 필터 적용. 최종 `limit` 개만 반환.

**주의**: 임계값(0.65) / 신선도 가중치(exp(-days/90)) / 상한(3개) 등 RAG 알고리즘은 **여기서 적용하지 않음**. 본 RPC 는 디버깅용 raw 검색이며, 그 알고리즘은 밀스톤 C 의 `MemoryRetrievalStage` 책임.

## ui-engineer 호출 예시

```ts
// Settings → "내 기억" 섹션
const list = await rpc('memory.list', { type: 'preference', limit: 50 });
// list.memories: [{id, content, type, createdAt, sessionKey}, ...]

// 삭제 버튼
const del = await rpc('memory.delete', { memoryId: 'mem-abc' });
if (del.deleted) {
  // UI 에서 행 제거
} else {
  // 이미 삭제됨 (멱등) — UI 동기화만
}

// 디버깅 검색 박스
const hit = await rpc('memory.search', { query: '테슬라 매수 원칙', limit: 5 });
// hit.results: [{id, content, type, score, createdAt}, ...]
// score 가 단순 raw — 임계값 컷 X
```

WebSocket notification: 없음. UI 가 `memory.delete` 후 직접 list 를 다시 호출하거나 옵티미스틱 업데이트.

## 에러 메시지 표

| 상황                                                 | 메시지 prefix                                      |
| ---------------------------------------------------- | -------------------------------------------------- |
| db 미주입                                            | `provider_unavailable: storage db not initialized` |
| Zod 검증 실패 (limit 초과, 빈 query, 빈 memoryId 등) | `Invalid params: ...`                              |
| 검색 중 vec0/FTS5 에러                               | `INTERNAL_ERROR` (dispatchRpc 가 message 마스킹)   |

memory.delete 의 미존재 id 는 **에러가 아닌** `{deleted: false}` 응답.

## 테스트 결과

```
pnpm typecheck                                                       # 통과 (tsgo --noEmit)
pnpm exec oxlint memory.ts memory.test.ts server.ts main.ts gateway.ts  # 0 warnings / 0 errors (내가 추가/수정한 5개)
pnpm vitest run packages/server/src/gateway/rpc/methods/memory.test.ts   # 21/21 통과
pnpm test                                                            # 156 files / 1440 tests passed (이전 1416 + 신규 21 + pipeline-engineer 추가분)
pnpm test:storage                                                    # 7 files / 65 tests passed (회귀 0)
```

신규 테스트 21건 (모두 mock-only, API 키·네트워크 없이 통과):

**provider availability (3)**

1. `memory.list` db 미주입 → `provider_unavailable`
2. `memory.delete` db 미주입 → `provider_unavailable`
3. `memory.search` db 미주입 → `provider_unavailable`

**schema validation (4)** 4. `memory.list` limit > 500 → INVALID_PARAMS 5. `memory.delete` 빈 memoryId → INVALID_PARAMS 6. `memory.search` 빈 query → INVALID_PARAMS 7. `memory.list` token 미인증 → UNAUTHORIZED

**memory.list (5)** 8. 빈 DB → 빈 배열 9. 모든 세션 가로질러 created_at DESC 정렬 10. type 필터 동작 (preference 만 반환) 11. sessionKey 필터 동작 12. limit 파라미터 준수

**memory.delete (3)** 13. 정상 삭제 → memories/FTS/vec0 모두 비워짐 검증 14. 미존재 id → 에러 X, `{deleted: false}` (멱등) 15. addMemoryWithEmbedding 후 삭제 → vec0 도 0 행

**memory.search (5)** 16. FTS-only fallback (provider 미주입) — 'finance' 매칭 17. hybrid (provider 주입) — 결과 반환 + memoryId dedup 18. types 필터 동작 (financial 만) 19. limit 준수 20. 매칭 없는 query → 빈 결과

**경계면 통합 (1)** 21. addMemory → memory.search 매칭 → memory.delete → memory.search 0건 (FTS 인덱스 cleanup 검증)

기존 finance/agent/chat/session/system RPC 테스트 회귀 0.

## 다른 팀원이 알아야 할 사실

- **listMemoriesAcrossSessions 직접 SQL** — storage 에 동등 함수가 없어 `memory.ts` 내부에 짧은 헬퍼. 향후 storage 가 같은 함수 export 하면 그쪽으로 이동.
- **memory.delete 멱등 정책** — `{deleted: false}` 응답이지 NOT_FOUND 에러 X. UI 가 두 번 눌러도 안전. (qa-engineer: 테스트 명세에 명시.)
- **memory.search 임계값/신선도 적용 안 함** — 본 RPC 는 raw 검색. RAG 주입은 밀스톤 C 의 `MemoryRetrievalStage` 가 담당 (pipeline-engineer 가 `mergeHybridResults({minScore: 0.65})` + 신선도 가중치 적용).
- **embeddingProvider 키 없을 때** — main.ts 가 `VOYAGE_API_KEY` / `OPENAI_API_KEY` 둘 다 없으면 createEmbeddingProvider 호출 자체를 skip → `memoryDeps.embeddingProvider = undefined` → search 자동 FTS-only fallback. 사용자가 키 추가 후 재시작하면 hybrid 활성화.
- **WebSocket broadcast 없음** — `memory.changed` 같은 채널 신설 안 함. UI 가 행위 직후 list 를 직접 fetch.
- **DDL 가정 (review-1)** — `memory_chunks_fts` 와 `memory_chunks_vec` 는 schema-architect 의 v3 마이그레이션에서 이미 생성됨. 본 RPC 는 그것들이 존재한다고 가정.

## 다음 단계 위임 포인트

- **ui-engineer** (밀스톤 E Settings 뷰): 위 호출 예시 그대로 사용. 행 삭제 시 `deleted: false` 케이스 (이미 누군가 삭제) 도 graceful 처리.
- **pipeline-engineer** (밀스톤 C MemoryRetrievalStage): 본 RPC 가 사용하는 `searchVector` + `searchFts` + `mergeHybridResults` 를 동일하게 활용하되, `minScore: 0.65` + 신선도 가중치 + 상한 3개 + 심볼 기반 거래 이력 동시 주입 추가. 같은 storage 함수 사용 → 본 RPC 와 행동 일관성 유지.
- **qa-engineer** (밀스톤 B QA): 본 단위 테스트 21건으로 mock-level 커버 완료. 실제 디스크 e2e 시나리오(임베딩 캐시 hit/miss · 대용량 memories 의 list 페이지네이션) 는 밀스톤 E 통합 단계에서 추가 권장.

## 범위 외 (의도적으로 안 한 것)

- `memory.add` RPC — 기억 추가는 사용자 수동 호출이 아닌 **MemoryCaptureStage 가 발화**(밀스톤 B). UI 입력으로 강제 추가는 본 단계 안 함.
- `memory.update` RPC — 기억은 immutable. 잘못된 기억은 delete + 재발화로 처리.
- `memory.changed` WebSocket — 본 단계에서는 단일 사용자 + Settings UI 의 단일 탭 시나리오만. 멀티 클라이언트 동시 편집은 추측성 기능.
- 페이지네이션 (offset) — 단순함 우선. limit 만 노출. 500 건 이상이 누적되면 추후 추가.
- RpcError 클래스 — 기존 finance.ts 와 컨벤션 통일 (`Error.message` prefix 기반). 별도 리팩토링 단계.
