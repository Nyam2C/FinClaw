# 밀스톤 B 종합 산출물 — 기억 저장 파이프라인

## 결과: PASS (밀스톤 C 진입 가능)

전체 1441 테스트 통과. 회귀 0. mock-only 원칙 준수.

## 변경 파일

**파이프라인 (pipeline-engineer):**

- `packages/server/src/auto-reply/stages/memory-capture.ts` (신설) — DefaultMemoryCaptureService + 정규식 5종
- `packages/server/src/auto-reply/__tests__/memory-capture.storage.test.ts` (신설) — 18 케이스
- `packages/server/src/auto-reply/pipeline.ts` — capture 단계 끼워넣기 (command 직후, ack 직전)
- `packages/server/src/auto-reply/pipeline-context.ts` — capturedMemory 필드
- `packages/server/src/auto-reply/stages/deliver.ts` — 응답 끝 꼬리표 부착
- `packages/server/src/main.ts` — DefaultMemoryCaptureService 주입
- `packages/storage/src/index.ts` — memory CRUD re-export
- `packages/server/src/auto-reply/__tests__/deliver.test.ts` — capturedMemory 꼬리표 2건

**RPC (rpc-engineer):**

- `packages/server/src/gateway/rpc/methods/memory.ts` (신설) — memory.{list,delete,search}
- `packages/server/src/gateway/rpc/methods/memory.test.ts` (신설) — 21 케이스
- `packages/server/src/gateway/server.ts` — memoryDeps 주입
- `packages/server/src/main.ts` — createEmbeddingProvider best-effort + memoryDeps
- `packages/types/src/gateway.ts` — RpcMethod union 확장

**QA (qa-engineer):**

- `packages/server/src/gateway/rpc/methods/memory.test.ts` — 경계면 통합 테스트 1건 추가 (capture↔list)

## 핵심 결정

- **capture 위치 = command 직후, ack 직전.** 등록 명령어(`/help` 등)는 capture 도달 X. passthrough 발화만 매칭.
- **dedup = hash 사전 검사 + 기존 memoryId 재사용.** duplicate 마커 함께 deliver 로 전달.
- **임베딩 fallback = `addMemoryWithEmbedding` throw 시 `addMemory` (FTS-only) + warn.** 양쪽 모두 throw 시에만 포기.
- **memory.search 는 raw top-K.** 임계값/신선도/상한은 밀스톤 C 의 RetrievalStage 가 담당 (디버깅용 RPC 와 분리).
- **memory.delete 멱등.** 미존재 id 도 NOT_FOUND 에러 X (UI 두 번 클릭 안전).

## 다음 밀스톤 (C) 가 알아야 할 사실

- `MemoryCaptureService` 인터페이스 / 정규식 5종은 그대로 유지 — RetrievalStage 는 retrieval 만 담당.
- `EmbeddingProvider` 는 main.ts 에서 best-effort 생성. 미주입 시 retrieval 도 FTS-only fallback 필요.
- `memory.search` RPC 는 디버깅용. RAG 주입은 별도 service (DefaultMemoryRetrievalService 등) 로 분리.
- search/vector + search/fts + mergeHybridResults 는 storage 패키지에서 그대로 가용.

## 후속 보강 후보 (결함 아님)

- "내 철학은 ..." 한국어 변형 단위 테스트 명시 케이스.
- silent reply 시 capture 꼬리표 미부착 — 밀스톤 D 의 agent.run 자동 저장 시 재검토.
