---
name: finclaw-rpc-design
description: FinClaw 게이트웨이에 JSON-RPC 메서드를 추가·확장하는 표준 절차. finance.transaction.{add,list,update,delete}, memory.{list,delete,search}, agent.runs.{list,get} RPC 신설, Zod v4 스키마 정의, WebSocket broadcaster.broadcastToChannel 통합, finance.portfolio.get 응답 확장(recentTransactions)이 필요할 때 반드시 이 스킬을 사용할 것. packages/server/src/gateway/rpc/methods/* 와 packages/types/src/gateway.ts 변경 시 반드시 참조.
---

# finclaw-rpc-design

게이트웨이 RPC 메서드를 추가하는 표준 절차. Zod 검증·에러 코드·WebSocket notification 까지 한 사이클로.

## 1. 메서드 추가 6단계

```
1. packages/types/src/gateway.ts 에 Zod 입력 스키마 + 응답 타입 추가
2. methods/{domain}.ts 에 핸들러 작성 (storage 호출, broadcaster 호출)
3. router 등록 (이미 자동 등록이면 건너뜀, 패키지 컨벤션 확인)
4. 부수 효과 후 broadcaster.broadcastToChannel 호출 (응답 전이 아니라 응답 직전)
5. methods/{domain}.test.ts 에 단위 테스트 (mock storage)
6. ui-engineer 에게 `SendMessage`: "메서드 X 가용, 시그니처 첨부"
```

## 2. 신규 메서드 명세 (Phase 26 전체)

### 밀스톤 A: finance.transaction.\*

| 메서드                       | 입력                                                                                  | 응답                                          | 부수효과                      |
| ---------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------- |
| `finance.transaction.add`    | `{portfolioId?, symbol, action, quantity, price?, fee?, currency, executedAt, note?}` | `{transactionId, createdAt, updatedHoldings}` | broadcast `portfolio.changed` |
| `finance.transaction.list`   | `{portfolioId?, symbol?, from?, to?, limit?}`                                         | `{transactions: Transaction[]}`               | 없음                          |
| `finance.transaction.update` | `{transactionId, ...partial}`                                                         | `{updatedHoldings}`                           | broadcast `portfolio.changed` |
| `finance.transaction.delete` | `{transactionId}`                                                                     | `{deleted: true, updatedHoldings}`            | broadcast `portfolio.changed` |

`finance.portfolio.get` 응답 확장:

```ts
{
  holdings: Holding[],          // 기존
  summary: PortfolioSummary,    // 기존
  recentTransactions: Transaction[]  // 신규, 최근 10건
}
```

### 밀스톤 B/E: memory.\*

| 메서드          | 입력              | 응답                                                |
| --------------- | ----------------- | --------------------------------------------------- |
| `memory.list`   | `{type?, limit?}` | `{memories: Memory[]}`                              |
| `memory.delete` | `{memoryId}`      | `{deleted: true}` (DB + vec/fts 인덱스 동시)        |
| `memory.search` | `{query, limit?}` | `{results: MemorySearchHit[]}` (테스트용 수동 검색) |

### 밀스톤 D: agent.runs.\*

| 메서드            | 입력                             | 응답                                                 |
| ----------------- | -------------------------------- | ---------------------------------------------------- |
| `agent.runs.list` | `{agentId?, from?, to?, limit?}` | `{runs: AgentRunSummary[]}`                          |
| `agent.runs.get`  | `{runId}`                        | `{run: AgentRunFull}` (prompt + output + tool_calls) |

## 3. Zod 스키마 작성 패턴

```ts
// packages/types/src/gateway.ts
import { z } from 'zod';

export const TransactionAddInput = z.object({
  portfolioId: z.string().optional(),
  symbol: z.string().min(1).max(20),
  action: z.enum(['buy', 'sell', 'dividend', 'fee', 'split']),
  quantity: z.number().positive(),
  price: z.number().nonnegative().optional(),
  fee: z.number().nonnegative().default(0),
  currency: z.string().length(3),
  executedAt: z.number().int().positive(), // ms epoch
  note: z.string().max(500).optional(),
});

export type TransactionAddInput = z.infer<typeof TransactionAddInput>;
```

핸들러는 입력을 `.parse()` 한 결과로만 동작 — raw 입력 만지지 않음.

## 4. 핸들러 패턴

```ts
// packages/server/src/gateway/rpc/methods/finance.ts
export async function transactionAdd(rawParams, ctx) {
  const params = TransactionAddInput.parse(rawParams); // 검증 + 타입 추론
  const portfolioId = params.portfolioId ?? (await getDefaultPortfolioId(ctx.db));

  const result = await ctx.storage.addTransaction({
    ...params,
    portfolio_id: portfolioId,
  });
  // recomputeHoldings 는 storage 안에서 동기 호출됨

  ctx.broadcaster.broadcastToChannel('portfolio.changed', {
    portfolioId,
    updatedAt: Date.now(),
    reason: 'transaction.add',
    transactionId: result.id,
  });

  return {
    transactionId: result.id,
    createdAt: result.created_at,
    updatedHoldings: result.holdings,
  };
}
```

## 5. 에러 코드 매핑

| 상황                                          | code                  | 메시지                              |
| --------------------------------------------- | --------------------- | ----------------------------------- |
| Zod 검증 실패                                 | `INVALID_PARAMS`      | Zod issues 를 `data.issues` 에 담음 |
| portfolio 미존재                              | `NOT_FOUND`           | `portfolio not found: <id>`         |
| FK 위반 (delete 시 transactions 가 아직 있음) | `CONFLICT`            | 사용자에게 cascade 의도 알림        |
| 임베딩 프로바이더 장애 (memory.add 부분)      | `SERVICE_UNAVAILABLE` | 단, 부분 성공 (raw 저장됨) 알림     |
| 그 외 storage 에러                            | `INTERNAL_ERROR`      | 메시지 마스킹                       |

`errors.ts` 의 `RpcError` 사용. 일반 `Error` throw 금지.

## 6. WebSocket broadcaster 패턴

```ts
// 페이로드는 가볍게 — 변경 식별자만
ctx.broadcaster.broadcastToChannel('portfolio.changed', {
  portfolioId,
  updatedAt: Date.now(),
  reason: 'transaction.add' | 'transaction.update' | 'transaction.delete',
  transactionId,
});
```

UI 는 이 알림 받고 `finance.portfolio.get` 다시 호출. 페이로드에 풀 데이터 X.

## 7. 응답 호환성 규칙

- 기존 응답에 **필드 추가** OK (옛 클라이언트는 무시)
- 기존 필드 **타입 변경/이름 변경/삭제** 금지 (메이저 버전 필요)
- 새 enum 값 추가 시: 클라이언트 측 unknown 처리 가능 여부 확인

## 8. 작성 후 알릴 곳

- ui-engineer 에게 `SendMessage`: 메서드별 요청 예시, 응답 형태, 에러 case. WebSocket 채널명·페이로드.
- qa-engineer 에게 `TaskCreate`: 메서드 단위 테스트 + UI ↔ RPC shape 교차 비교.
- pipeline-engineer 에게: memory.list/search 가 capture stage 와 같은 storage 함수 사용한다는 사실 통보 (테스트 격리 시 mock 공유 가능).

## 참고

- 기존 RPC 테스트: `methods/finance.test.ts`, `methods/agent.test.ts`
- broadcaster 사용 예: gateway 안에 검색
