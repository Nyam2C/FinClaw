# 03 — 파이프라인 엔지니어: MemoryCaptureStage (밀스톤 B)

## 1. 정규식 5종 (확정)

우선순위 위에서 아래로, 첫 매치만 사용. 한 발화 = 한 capture.

| 순위 | 정규식 (소스)                                            | type       | 비고                                                                                                                      |
| ---- | -------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1    | `^!finclaw\s+remember\s+(.+)` (i)                        | fact       | 명시적 명령. command 단계가 prefix 매칭 안 했을 때만 도달 (현재 `!finclaw remember` 는 등록되지 않음 → capture 가 책임짐) |
| 2    | `^기억해[:\s]\s*(.+)` (i)                                | fact       | "기억해:" 또는 "기억해 " 모두 허용                                                                                        |
| 3    | `^메모[:\s]\s*(.+)` (i)                                  | fact       |                                                                                                                           |
| 4    | `^선호[:\s]\s*(.+)` (i)                                  | preference |                                                                                                                           |
| 5    | `내\s*(?:투자\s*)?(?:기준\|원칙\|철학)[은는]\s*(.+)` (i) | preference | "내 투자 원칙은", "내 기준은", "내 철학은" 등                                                                             |

부가 규칙:

- `match[1].trim()` 으로 capture content 추출.
- `content.length < 3` → 무시 (return null).

## 2. 파이프라인 흐름 (capture 위치)

```
Normalize → Command → [MemoryCapture] → ACK → Context → Execute → Deliver
                          ↑                                          ↓
                          (정규식 매칭 시 저장)                    (꼬리표 부착)
```

위치 결정 사유: command 단계가 `continue` 인 경우(=명령어 매칭 안됨)에만 도달.
즉 `/help` 같은 등록된 명령어와 충돌하지 않는다.
capture 결과는 `enrichedCtx.capturedMemory` 에 실어 deliver 까지 전달.

## 3. capture 흐름도

```
text 입력
  ↓
PATTERNS 5종 순회
  ↓ 매치 X
  return null  ← 비매칭 발화는 비용 0
  ↓ 매치 O
content = match[1].trim()
  ↓
content.length < 3?
  → return null
  ↓
hash = sha256(content)
  ↓
DB: SELECT id FROM memories WHERE hash = ?
  ↓ 있음
  return { memoryId: existing.id, duplicate: true } ← deliver 가 "이미 기억 중" 꼬리표
  ↓ 없음
entry = { id: uuid, sessionKey, content, type, createdAt, metadata }
  ↓
embeddingProvider 있음?
  ├ Yes → addMemoryWithEmbedding(db, entry, provider)
  │       └ throw 시 → addMemory(db, entry) fallback + warn 로그
  └ No  → addMemory(db, entry)  ← FTS 만 인덱싱
  ↓
return { memoryId: entry.id, duplicate: false }
```

## 4. 임베딩 fallback 동작 매트릭스

| 시나리오                        | 동작                     | 로그 이벤트                              | row 저장 | FTS 인덱싱 | vec 인덱싱 |
| ------------------------------- | ------------------------ | ---------------------------------------- | -------- | ---------- | ---------- |
| provider 미주입                 | `addMemory`              | `memory.capture.success`                 | yes      | yes        | no         |
| provider 정상                   | `addMemoryWithEmbedding` | `memory.capture.success`                 | yes      | yes        | yes        |
| provider throw                  | `addMemory` fallback     | `memory.capture.embedding_failed` (warn) | yes      | yes        | no         |
| provider throw + fallback throw | 포기                     | `memory.capture.failed` (error)          | no       | no         | no         |
| 중복 hash                       | skip + 기존 id 반환      | `memory.capture.duplicate`               | (기존)   | (기존)     | (기존)     |
| 일반 에러 (stage wrapper)       | suppress                 | `memory.capture.stage_error` (warn)      | no       | no         | no         |

## 5. 코드 변경 파일

| 파일                                                                      | 변경 종류 | 핵심                                                                                                                                                                |
| ------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/auto-reply/stages/memory-capture.ts`                 | 신설      | `DefaultMemoryCaptureService`, `memoryCaptureStage`, 5 PATTERNS                                                                                                     |
| `packages/server/src/auto-reply/pipeline.ts`                              | 수정      | `PipelineDependencies.memoryCaptureService?` 추가, command→ACK 사이에 stage 삽입, `enrichedCtx` 에 `capturedMemory` 합성                                            |
| `packages/server/src/auto-reply/pipeline-context.ts`                      | 수정      | `PipelineMsgContext.capturedMemory?` 필드 추가                                                                                                                      |
| `packages/server/src/auto-reply/stages/deliver.ts`                        | 수정      | `ctx.capturedMemory` 시 응답 끝에 "기억했습니다 / 이미 기억 중" 꼬리표 부착                                                                                         |
| `packages/server/src/main.ts`                                             | 수정      | `DefaultMemoryCaptureService` 인스턴스 생성 + 파이프라인 의존성 주입. 기존 embeddingProvider 변수 재활용                                                            |
| `packages/storage/src/index.ts`                                           | 수정      | `addMemory`, `addMemoryWithEmbedding`, `getMemory`, `getMemoriesBySession`, `deleteMemory`, `getMemoryChunks` re-export. 다른 작업자(RPC)도 의존하던 미해결 export. |
| `packages/server/src/auto-reply/__tests__/memory-capture.storage.test.ts` | 신설      | 18 테스트 (정규식 5종 + 비매칭 + 길이 미달 + 우선순위 + 중복 + provider 유무 + 임베딩 throw + stage wrapper)                                                        |
| `packages/server/src/auto-reply/__tests__/deliver.test.ts`                | 보강      | capturedMemory 신규/중복 꼬리표 2건                                                                                                                                 |

## 6. 테스트 결과

```
pnpm build       → tsc --build  통과 (에러 0)
pnpm typecheck   → tsgo --noEmit 통과 (에러 0)
pnpm lint        → oxlint 통과 (warnings 0, errors 0)
pnpm format      → oxfmt --check 통과 (이슈 0)

pnpm test (unit tier)         → 156 files / 1440 tests passed (밀스톤 A 마감 1417 → +23)
pnpm test:storage (storage tier) → 7 files / 65 tests passed
  - memory-capture.storage.test.ts: 18 tests passed
  - 그 중 핵심:
    * 정규식 5종 6건 (parametrized) — 모두 정확히 type/content 매칭
    * 비매칭 발화 → null
    * content < 3 → null
    * 빈 문자열 → null
    * 우선순위 (기억해 vs 내 원칙) → 기억해 우선
    * 중복 hash → 기존 memoryId 재사용 + duplicate=true
    * 다른 content → 다른 memoryId
    * provider 미주입 → FTS-only 저장 row 존재
    * embedBatch throw → addMemory fallback + warn 로그 + row 존재
    * provider 정상 → embedBatch 호출
    * stage wrapper: service undefined → null
    * stage wrapper: capture throw → suppress + warn 로그
    * stage wrapper: 정상 → service 결과 그대로 반환
```

## 7. 인터페이스 합의 (다른 작업자에게)

### rag-engineer 에게

retrieval 단계는 본 capture 단계와 **독립**. Context 단계 안 또는 직후에 끼워넣을 것.
입력은 `(userQuery, sessionKey)`, 기대 출력은 `MemorySnippet[]`.
capture 가 방금 저장한 메모리는 **같은 턴 retrieval 에 등장해도 무방** (ranking 이 알아서 처리).

### qa-engineer 에게

스테이지 단위 테스트 위치:

- `packages/server/src/auto-reply/__tests__/memory-capture.storage.test.ts` (storage tier — `:memory:` DB 사용)
- `packages/server/src/auto-reply/__tests__/deliver.test.ts` (unit tier — capturedMemory 케이스)
- `packages/server/src/auto-reply/__tests__/pipeline.test.ts` (unit tier — 회귀 통과 확인. memoryCaptureService 미주입 시 stage 통과 검증은 기존 케이스로 충분)

### rpc-engineer 에게

storage 패키지의 `addMemory`, `addMemoryWithEmbedding`, `getMemory`, `getMemoriesBySession`, `deleteMemory`, `getMemoryChunks` 가 본 작업에서 처음 re-export 되었다. memory.\* RPC 의존이 해소되었다.

## 8. 후속 (밀스톤 C 진입 시)

- `MemoryRetrievalService` 도 동일 패턴으로 `pipeline.ts` 의 `PipelineDependencies` 에 옵셔널 주입.
- `enrichContext` 또는 별도 stage 함수로 retrieval 호출 → `enrichedCtx.injectedMemories` 부착.
- system prompt 빌더가 `injectedMemories` 를 "사용자 배경지식" 섹션으로 변환.
- retrieval 실패 시 그 섹션 자체를 빼고 진행 (빈 섹션 노출 X — 본 PR 의 capture 와 동일한 best-effort 원칙).

## 9. 제약 준수 체크 (CLAUDE.md 4원칙)

- [x] **추측 금지**: `EmbeddingProvider`, `MemoryEntry` 모두 storage/types 패키지 import 로 확인 후 사용. dedup 동작은 `addMemory` (memories.ts:101-107) 의 실제 구현을 참고하여 hash 사전 검사로 우회.
- [x] **단순함**: 첫 매치만 사용. 5개 패턴 외 추가 X. capture service 외 새 추상화 X.
- [x] **외과적 변경**: pipeline.ts 의 다른 단계 시그니처 무수정. `memoryCaptureService` 는 옵셔널 — 미주입 시 stage 자체 skip.
- [x] **검증 가능**: 정규식 5종 각각 명시적 테스트. 회귀 0 (1417 → 1440, 모두 추가).
