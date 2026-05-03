---
name: finclaw-pipeline-stage
description: FinClaw auto-reply 파이프라인(Normalize→Command→ACK→Context→Execute→Deliver)에 새 스테이지를 안전하게 끼워 넣는 표준 절차. MemoryCaptureStage, MemoryRetrievalStage 신설, pipeline.ts 등록, pipeline-context.ts 의존성 주입, 정규식 기반 명시적 선언 패턴 매칭(기억해/내 원칙은/!finclaw remember)이 필요할 때 반드시 이 스킬을 사용할 것. packages/server/src/auto-reply/* 변경 시 반드시 참조.
---

# finclaw-pipeline-stage

`packages/server/src/auto-reply/` 의 6단계 파이프라인을 확장한다. 본 Phase 에서는 capture(B), retrieval(C) 두 스테이지를 추가.

## 1. 파이프라인 현재 구조

```
Normalize → Command → ACK → Context → Execute → Deliver
```

각 스테이지: `auto-reply/stages/{name}.ts`. 등록처: `auto-reply/pipeline.ts`. 공유 의존성: `pipeline-context.ts`.

## 2. 새 스테이지 위치 결정

| 스테이지        | 위치                         | 이유                                                           |
| --------------- | ---------------------------- | -------------------------------------------------------------- |
| MemoryCapture   | Command 직후, ACK 전         | 명령어가 우선 처리되어야 capture 패턴이 명령어와 충돌하지 않음 |
| MemoryRetrieval | Context 안 또는 Context 직후 | system prompt 빌드 시 주입돼야 함                              |

```
Normalize → Command → MemoryCapture → ACK → Context+MemoryRetrieval → Execute → Deliver
                       ^^^^^^^^^^^^^^^               ^^^^^^^^^^^^^^^^^
                       (밀스톤 B)                    (밀스톤 C)
```

## 3. 스테이지 스켈레톤

```ts
// packages/server/src/auto-reply/stages/memory-capture.ts
import type { PipelineContext, PipelineMessage } from '../pipeline-context';

const PATTERNS = [
  { regex: /^기억해[:\s]\s*(.+)/i, type: 'fact' as const },
  { regex: /내 (?:투자 )?(?:기준|원칙|철학)[은는]\s*(.+)/i, type: 'preference' as const },
  { regex: /^선호[:\s]\s*(.+)/i, type: 'preference' as const },
  { regex: /^메모[:\s]\s*(.+)/i, type: 'fact' as const },
  { regex: /^!finclaw\s+remember\s+(.+)/i, type: 'fact' as const },
];

export async function memoryCaptureStage(msg: PipelineMessage, ctx: PipelineContext) {
  const text = msg.normalizedText;
  for (const { regex, type } of PATTERNS) {
    const match = text.match(regex);
    if (!match) continue;
    const content = match[1].trim();
    const hash = ctx.hash(content);
    const existing = await ctx.memoryService.findByHash(hash);
    if (existing) {
      msg.captureNote = `이미 기억 중 (#${existing.id})`;
      return;
    }
    const memory = await ctx.memoryService.addWithEmbedding({
      content,
      type,
      sessionKey: msg.sessionKey,
      hash,
    });
    msg.captureNote = `기억했습니다 (#${memory.id})`;
    return; // 한 발화당 한 번만 capture
  }
}
```

## 4. MemoryRetrieval 스테이지 (rag-engineer 와 협업)

```ts
// packages/server/src/auto-reply/stages/memory-retrieval.ts
export async function memoryRetrievalStage(msg, ctx) {
  if (msg.isCommand) return; // 명령어는 RAG 주입 X
  const result = await ctx.ragService.searchRelevantMemories({
    userQuery: msg.normalizedText,
    sessionKey: msg.sessionKey,
  });
  msg.injectedMemories = result.snippets;
  msg.injectedTransactions = result.transactions;
  ctx.audit.log({ event: 'memory.injected', ...result.log });
}
```

검색 알고리즘은 `rag-engineer` 가 `finclaw-rag-injection` 스킬에서 책임. 본 스테이지는 호출 지점만.

## 5. pipeline-context 주입

```ts
// packages/server/src/auto-reply/pipeline-context.ts (수정)
export interface PipelineContext {
  // 기존 필드
  memoryService: MemoryService; // 신규
  ragService: RagService; // 신규
  audit: AuditLogger; // 신규 또는 기존 확장
}
```

서비스는 `server/src/main.ts` 또는 등가 부트스트랩에서 주입. 스테이지가 `import` 로 storage 직접 참조 X.

## 6. pipeline.ts 등록

```ts
// 기존 등록 순서에 끼워넣기
pipeline
  .use(normalizeStage)
  .use(commandStage)
  .use(memoryCaptureStage) // 신규
  .use(ackStage)
  .use(contextStage)
  .use(memoryRetrievalStage) // 신규
  .use(executeStage)
  .use(deliverStage);
```

## 7. Deliver 응답 꼬리표

`captureNote` 가 있으면 응답 끝에 부착:

```ts
// stages/deliver.ts (외과적 수정)
if (msg.captureNote) {
  responseText += `\n\n— ${msg.captureNote}`;
}
```

## 8. 정규식 패턴 결정 사유

- **명시적 선언만**: 사용자 결정 (plan.md). LLM 자동 판정은 환각 위험.
- **5종으로 충분**: "기억해", "내 원칙은", "선호", "메모", "!finclaw remember". 더 늘리면 false positive 위험.
- **첫 매치만 사용**: 한 발화 = 한 capture. 다중 매치 시 우선순위 위에서 아래로.

## 9. 작성 후 알릴 곳

- rag-engineer 에게 `SendMessage`: retrieval 호출 인터페이스 (`searchRelevantMemories(input)`) 합의.
- qa-engineer 에게 `TaskCreate`: 정규식 5종 + edge case ("!finclaw remember X" 다중 공백, 한글 조사 누락 "내 원칙 X" 등).

## 10. 검증 시나리오

- "!finclaw remember 나는 분기별 리밸런싱 한다" → memories type='fact', captureNote 부착
- 같은 문장 재입력 → "이미 기억 중", 중복 저장 X
- "내 투자 원칙은 배당주 중심" → type='preference'
- "오늘 점심 뭐 먹지" → 매치 X, 통과 (capture 0)
- 임베딩 프로바이더 장애 → raw 저장 성공, 경고 로그

## 참고

- 기존 스테이지 모듈: `auto-reply/stages/{normalize,command,ack,context,execute,deliver}.ts`
- 테스트: `auto-reply/__tests__/`
