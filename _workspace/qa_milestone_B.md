# qa_milestone_B — Phase 26 밀스톤 B 게이트키퍼 검증

**검증자:** qa-engineer
**일자:** 2026-04-28
**대상:**

- pipeline-engineer (`_workspace/03_pipeline-engineer_memory-capture.md`) — MemoryCaptureStage + deliver 꼬리표
- rpc-engineer (`_workspace/03_rpc-engineer_memory.md`) — memory.{list,delete,search} RPC

---

## 1. 검증 매트릭스

| #   | 항목                                                                      | 결과                 | 근거 (직접 확인한 코드/테스트)                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 정규식 5종 패턴 매칭 정확도                                               | PASS                 | `memory-capture.ts:26-35` 의 PATTERNS 5개. `memory-capture.storage.test.ts:57-71` 의 parametrized 6 케이스 (기억해/메모/선호/내 투자 원칙/내 기준/!finclaw remember) 모두 type+content 정확 매칭.                                                           |
| 2   | plan.md 정규식과 실제 정규식 동치                                         | PASS (실제가 슈퍼셋) | plan.md line 165~169 `/내 (투자 )?(기준\|원칙\|철학)[은는]\s*(.+)/i` ↔ 실제 `/내\s*(?:투자\s*)?(?:기준\|원칙\|철학)[은는]\s*(.+)/i`. 실제는 공백 0+ 허용 (의미적 슈퍼셋). 다른 4개는 1:1 동일.                                                              |
| 3   | "내 기준은" / "내 원칙은" / "내 철학은" 한국어 조사 변형 단위 테스트 커버 | PASS                 | "내 투자 원칙은 배당주 중심" / "내 기준은 PER 15 이하만 매수" 2 케이스 명시 (`memory-capture.storage.test.ts:61-62`). "내 철학은" 은 정규식 분기에 포함되어 있으나 단위 테스트 명시 케이스 없음 — 코드 정확, 회귀 보호 차원에서 후속 보강 권장 (결함 아님). |
| 4   | 비명령 일반 발화 → capture skip                                           | PASS                 | `memory-capture.storage.test.ts:73-77` "오늘 점심 뭐 먹지" → null. content < 3 / 빈 문자열도 별도 케이스로 null 검증.                                                                                                                                       |
| 5   | 중복 hash → 기존 memoryId 재사용 + duplicate=true                         | PASS                 | `memory-capture.ts:79-97` sha256(content) 사전 SELECT. `memory-capture.storage.test.ts:113-122` 동일 발화 두 번 → 두 번째 `memoryId` 동일 + `duplicate=true` 검증. 다른 content 는 다른 memoryId 검증 (line 124~131).                                       |
| 6   | 임베딩 provider throw → addMemory FTS-only fallback                       | PASS                 | `memory-capture.ts:114-131` try/catch + `addMemory(deps.db, entry)` fallback + warn. `memory-capture.storage.test.ts:162-187` `embedBatch` mockRejected → row 존재 + warn 로그 호출 검증.                                                                   |
| 7   | 임베딩 provider 미주입 → addMemory FTS-only                               | PASS                 | `memory-capture.ts:111-113` `else { addMemory }`. `memory-capture.storage.test.ts:147-160` provider 미주입 시 row 존재 검증.                                                                                                                                |
| 8   | capture 결과 → deliver 꼬리표 부착 ("기억했습니다" / "이미 기억 중")      | PASS                 | `deliver.ts:43-50` `ctx.capturedMemory` 분기. `deliver.test.ts:167-213` 신규/중복 2 케이스 모두 통과 (text contains 기억했습니다/이미 기억 중 + #shortId8 + type).                                                                                          |
| 9   | deliver 가 silent reply 시 capture 꼬리표를 안 부착                       | PASS (의도)          | `deliver.ts:26-29` `hasSilentReply` 분기에서 `skip` 반환 → 꼬리표 코드 도달 X. silent reply 자체가 의도된 침묵이므로 보고서 명시("응답 본문이 비어있어도 꼬리표 부착")의 적용 범위 외. 결함 아님.                                                           |
| 10  | capture 위치: command 다음, ack 전 — 명령어 처리되면 capture skip         | PASS                 | `pipeline.ts:117-149` `commandStage` 후 `cmdResult.action !== 'continue'` → emitComplete + return (line 126-129). 즉 `/help` 같은 명령은 capture 도달 X. plan.md "사용자가 위 패턴을 쓰지 않는 한 자동 저장 안 함" 과 정합.                                 |
| 11  | memory.list ↔ capture 결과 일치 (경계면)                                  | PASS                 | 신규 통합 테스트 추가 (아래 섹션 2). capture("!finclaw remember 분기 리밸런싱") → 같은 db 의 memory.list 호출 → 동일 id/content/type='fact'/sessionKey 반환 검증.                                                                                           |
| 12  | memory.delete cascade (memories + memory_chunks_vec + memory_chunks_fts)  | PASS                 | storage `memories.ts:186-213` deleteMemory 가 BEGIN 트랜잭션 내에서 vec0 + FTS5 + memories 순차 DELETE. `memory.test.ts:259-321` 정상 삭제 / 멱등 / vec0 cleanup 3 케이스 검증. `integration: search after delete` 가 FTS 에서도 사라짐을 직접 검증.        |
| 13  | memory.delete 멱등 (미존재 id → `{deleted: false}`, NOT_FOUND 에러 X)     | PASS                 | `memory.ts:152-153` `deleted = deleteMemory(...)` 그대로 반환. `memory.test.ts:293-301` 미존재 id 호출 시 에러 X, `result.deleted === false` 검증.                                                                                                          |
| 14  | memory.search FTS-only fallback (provider 미주입 시)                      | PASS                 | `memory.ts:184-193` `if (deps.embeddingProvider)` 분기. `memory.test.ts:324-339` "FTS-only fallback finds memory by substring when no embeddingProvider" 케이스 통과.                                                                                       |
| 15  | memory.search hybrid (provider 주입 시) — vector + FTS 병합               | PASS                 | `memory.ts:185-190` `Promise.all([searchVector, searchFts]) → mergeHybridResults`. `memory.test.ts:341-359` "hybrid search returns results without error when provider given" 통과.                                                                         |
| 16  | memory.search 결과 dedupe + types 필터 + limit 준수                       | PASS                 | `memory.ts:196-220` Set 으로 memoryId dedup, types include 검사, hits.length >= limit break. `memory.test.ts:361-391` types 필터 / limit / 매칭 0건 케이스 모두 통과.                                                                                       |
| 17  | memory.\* 모두 db 미주입 시 `provider_unavailable`                        | PASS                 | `memory.ts:125-127, 147-149, 177-179`. `memory.test.ts:122-146` 3개 메서드 각각 검증.                                                                                                                                                                       |
| 18  | memory.list/delete/search Zod 검증 (limit 상한, min length)               | PASS                 | `memory.ts:119-123, 143-145, 171-175` Zod schema. `memory.test.ts:149-172` limit > 500 / 빈 memoryId / 빈 query / token 미인증 4 케이스 통과.                                                                                                               |
| 19  | main.ts: VOYAGE/OPENAI 키 미설정 시 embeddingProvider skip                | PASS                 | `main.ts:169-183` `if (process.env.VOYAGE_API_KEY \|\| process.env.OPENAI_API_KEY)` 가드. 미설정 시 변수 undefined 그대로. `memoryDeps.embeddingProvider` 와 `memoryCaptureService` 의 `embeddingProvider` 둘 다 undefined 전파 → 양쪽 모두 FTS-only 동작.  |
| 20  | 외부 API 키 없이 모든 테스트 통과 (mock-only 원칙)                        | PASS                 | unit 1441 + storage 65 모두 환경변수 의존 0. memory-capture.storage.test.ts 는 `:memory:` DB + mock provider, memory.test.ts 는 tmpdir + mock provider. 임베딩/네트워크 호출 없음.                                                                          |

추가 사실:

- `RpcMethod` union (`packages/types/src/gateway.ts:25-27`) 에 `memory.list/delete/search` 3개 등록 → dispatchRpc 가 인식 가능.
- 게이트웨이 server (`packages/server/src/gateway/server.ts:103`) 가 `registerMemoryMethods(deps.memoryDeps ?? {})` 호출. memoryDeps 미주입 시 모든 memory.\* 가 `provider_unavailable` 로 동작.
- main.ts (`packages/server/src/main.ts:300-323`) 가 `DefaultMemoryCaptureService` 를 생성하고 pipeline 의존성으로 주입. embeddingProvider 는 capture/RPC 양쪽이 동일 변수 공유 — 키 추가 후 재시작 시 hybrid 활성화.
- pipeline-context.ts (`pipeline-context.ts:39-46`) 의 `capturedMemory` 필드는 readonly + 옵셔널. enrichContext 결과에 capture 결과를 합성하는 책임은 pipeline.ts (`pipeline.ts:226-236`) 에서 ctxResult 직후 처리.
- capture 단계 위치: `pipeline.ts:135-149` Stage 2 (command) 와 Stage 3 (ack) 사이. cmdResult 가 'continue' 가 아니면 line 126-129 에서 이미 return → command 가 처리된 발화는 capture skip.

---

## 2. 경계면 통합 테스트 (신규)

**파일:** `packages/server/src/gateway/rpc/methods/memory.test.ts`

**테스트명:** `MemoryCaptureService capture followed by memory.list returns the captured entry`

**설계:**

- 같은 SQLite db 인스턴스를 `DefaultMemoryCaptureService` 와 `registerMemoryMethods` 가 공유 (production 와 동일 boundary).
- mock-only 원칙 준수: embeddingProvider 미주입 → capture 가 FTS-only 경로(`addMemory`) 로 저장.
- "!finclaw remember 분기 리밸런싱" 캡처 후 `memory.list({limit: 50})` 호출.
- 같은 memoryId 의 항목이 보이고 content="분기 리밸런싱" / type='fact' / sessionKey=sessionA 일치 검증.

**결과:** memory.test.ts 22/22 통과 (기존 21 + 신규 1). 회귀 0.

---

## 3. 검증 명령 출력

```text
$ pnpm typecheck
> tsgo --noEmit
(통과 — 출력 없음)

$ pnpm lint
> oxlint --config oxlintrc.json .
Found 0 warnings and 0 errors.
Finished in 361ms on 459 files with 126 rules using 12 threads.

$ pnpm test
 Test Files  156 passed (156)
      Tests  1441 passed (1441)   ← 밀스톤 A 마감 1417 → pipeline-engineer +23 → rpc-engineer +21 (실제 1440 보고됨, 신규 통합 1 추가로 1441)
   Duration  142.28s

$ pnpm test:storage
 Test Files  7 passed (7)
      Tests  65 passed (65)
   Duration  39.35s

$ pnpm vitest run packages/server/src/gateway/rpc/methods/memory.test.ts
 Test Files  1 passed (1)
      Tests  22 passed (22)        ← 21 + 신규 통합 1
```

---

## 4. 누락 항목 / 결함

매트릭스 20개 항목 모두 PASS. plan.md 명세 외 후속 보강 후보 2건 (결함 아님):

| 항목                                         | plan.md 라인  | 현재 상태                                                                                                                                                                                                                                                                                                                                          | 책임자 (필요 시)                           |
| -------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| "내 철학은 ..." 한국어 변형 단위 테스트 명시 | line 166      | 정규식 분기에 `철학` 포함 (`memory-capture.ts:34`) — 코드 정확. 단 단위 테스트는 "원칙" / "기준" 만 케이스로 두고 "철학" 명시 없음. 정규식 alternation 으로 동작 보장되므로 결함 아님. 회귀 보호 차원에서 후속 추가 권장.                                                                                                                          | (정보) pipeline-engineer 가 향후 보강      |
| silent reply 시 capture 꼬리표 미부착        | (보고서 명시) | `deliver.ts:26-29` 가 `hasSilentReply` → skip 반환 → capture 꼬리표 코드 (line 44~50) 도달 안 함. 의도된 침묵이므로 동작 정합 — plan.md 검증 항목에는 없음. silent reply 발화에서 capture 가 일어났다면 꼬리표가 사라지는 행동을 사용자가 인지하기 어려울 수 있음. 결함은 아니나 후속 단계(밀스톤 D agent.run 결과 자동 저장 시) 에서 재검토 권장. | (정보) pipeline-engineer 가 후속 단계 검토 |

추가 관찰 (결함 아님):

- `memory.search` 응답의 `score` 가 hybrid (가중합) vs FTS-only (BM25 0~1) 에서 의미가 다름. 보고서가 명시적으로 다룸. RAG 주입은 밀스톤 C 의 `MemoryRetrievalStage` 책임 — 본 RPC 는 raw 검색.
- `memory.list` 의 `listMemoriesAcrossSessions` 는 `memory.ts` 내부 SQL 헬퍼. storage 에 동등 함수가 없음 — 향후 storage 가 export 하면 그쪽으로 이동 권장.
- `memory.delete` broadcast (memory.changed) 없음 — 의도. UI 가 직접 list 재조회.

---

## 5. 최종 판정

**PASS — 밀스톤 C 진입 가능.**

근거:

- 검증 매트릭스 20/20 모두 통과 (직접 코드 + 테스트 확인).
- 경계면 통합 테스트 신규 1건 추가 통과 (capture → memory.list 같은 db 공유 boundary).
- typecheck / lint / 전체 1441 unit + 65 storage 통과, 회귀 0.
- mock-only 원칙 (외부 API 키·네트워크 호출 0) 준수 — VOYAGE/OPENAI 키 미설정 시 embeddingProvider 자체가 skip → capture 와 RPC 양쪽 자동 FTS-only.
- plan.md 의 명세 외 항목("내 철학은" 단위 테스트, silent reply 꼬리표)은 결함이 아닌 후속 보강 후보.

**다음 단계:** 밀스톤 C (MemoryRetrievalStage + RAG 주입). rag-engineer 호출 가능.

핵심 인계:

- pipeline.ts 의 capturedMemory 합성 패턴 (`pipeline.ts:226-236`) 을 retrieval 결과 (`injectedMemories`) 부착에 그대로 차용 가능.
- memory.ts 의 hybrid 검색 알고리즘 (`searchVector` + `searchFts` + `mergeHybridResults`) 이 RAG 단계의 base. 단 RAG 는 임계값 0.65 + 신선도 가중치 + 상한 3개 + 거래 이력 동시 주입 추가.
- main.ts 의 embeddingProvider 변수가 retrieval service 에도 그대로 주입 가능 (이미 capture/RPC 가 공유 중).
