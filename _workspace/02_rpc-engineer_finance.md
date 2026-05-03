# 02_rpc-engineer — Phase 26 밀스톤 A finance.transaction.\* RPC + portfolio.get 확장 + portfolio.changed broadcast

## 핵심 결정

- **storage 모듈 직접 호출** — `@finclaw/storage` 가 `addTransaction`/`listTransactions`/`updateTransaction`/`deleteTransaction`/`getTransaction` 함수를 노출하므로 RPC 핸들러는 이를 그대로 호출. holdings 재계산은 storage 내부에서 동기적으로 일어남.
- **db 의존성 옵셔널** — `FinanceRpcDeps.db?: DatabaseSync` 로 두고, `transaction.*` 호출 시 db 미주입이면 `provider_unavailable` 에러. 기존 `quote/news/alert` 와 동일 패턴.
- **broadcast best-effort** — `broadcaster` 와 `connections` 둘 다 주입됐을 때만 `portfolio.changed` notification 발행. broadcast 실패는 try/catch 로 흡수해 RPC 응답에 영향 없음(`tryBroadcastPortfolioChanged` 헬퍼).
- **portfolioId 기본값** — RPC 입력에 portfolioId 가 없으면 `portfolios` 테이블의 첫 번째 행(`ORDER BY updated_at ASC LIMIT 1`) 사용. 없으면 `not_found` 에러. (portfolios 테이블 컬럼 확인 결과 `created_at` 이 없어 `updated_at` 사용 — schema-architect 보고와 일치.)
- **source 는 항상 'manual'** — RPC 입력에서 받지 않고 핸들러가 강제. `'import'` 는 본 단계에서 안 씀.
- **finance.portfolio.get 확장** — `recentTransactions: Transaction[]` 필드 추가(최근 10건). db 미주입 시 빈 배열. 기존 `holdings`/`summary` 그대로 — 옛 클라이언트 호환.
- **broadcast 페이로드 가볍게** — `{portfolioId, updatedAt, reason, transactionId}` 만. holdings 풀 데이터는 X. UI 가 `finance.portfolio.get` 으로 후속 fetch.

## 변경/신설 파일

| 경로                                                      | 변경 종류 | 요약                                                                                                                                                                                                                                |
| --------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/types/src/gateway.ts`                           | 수정      | `RpcMethod` union 에 `finance.transaction.{add,list,update,delete}` 4개 추가.                                                                                                                                                       |
| `packages/server/src/gateway/rpc/methods/finance.ts`      | 수정      | `FinanceRpcDeps` 에 `db`/`broadcaster`/`connections` 옵셔널 필드 추가. transaction 4개 핸들러 신규. `portfolio.get` 응답에 `recentTransactions` 필드 추가. `resolvePortfolioId`/`readHoldings`/`tryBroadcastPortfolioChanged` 헬퍼. |
| `packages/server/src/gateway/server.ts`                   | 수정      | `registerFinanceMethods` 호출 시 `ctx.broadcaster`/`ctx.connections` 를 `financeDeps` 에 spread 주입.                                                                                                                               |
| `packages/server/src/main.ts`                             | 수정      | `financeDeps.db = storage.db` 추가.                                                                                                                                                                                                 |
| `packages/server/src/gateway/rpc/methods/finance.test.ts` | 수정      | 신규 describe block `finance.transaction.*` 에 단위 테스트 10건 추가. 기존 `portfolio.get` 테스트 1건은 `recentTransactions: []` 확인 필드 추가(외과적 보강).                                                                       |

## 신규 RPC 시그니처

### finance.transaction.add

```ts
input: {
  portfolioId?: string;          // 미지정 시 첫 번째 portfolio
  symbol: string;                // 1~20자, 대문자 정규화됨
  action: 'buy' | 'sell' | 'dividend' | 'fee' | 'split';
  quantity: number;              // > 0
  price?: number;                // ≥ 0
  fee?: number;                  // ≥ 0
  currency: string;              // length 3 (ISO 4217)
  executedAt: number;            // ms epoch (positive int)
  note?: string;                 // ≤ 500
}
output: {
  transactionId: string;         // crypto.randomUUID()
  createdAt: number;             // ms epoch
  updatedHoldings: Array<{
    symbol: string;
    quantity: number;
    averageCost: number;
  }>;
}
side-effect: broadcast 'portfolio.changed' { portfolioId, updatedAt, reason: 'transaction.add', transactionId }
```

### finance.transaction.list

```ts
input: {
  portfolioId?: string;
  symbol?: string;               // 1~20자
  from?: number;                 // ms epoch
  to?: number;                   // ms epoch
  limit?: number;                // 1~500
}
output: {
  transactions: Transaction[];   // executed_at DESC, created_at DESC
}
```

### finance.transaction.update

```ts
input: {
  transactionId: string;         // 필수
  portfolioId?, symbol?, action?, quantity?, price?, fee?,
  currency?, executedAt?, note?: 부분 필드 (모두 선택)
  // price/note 는 nullable 가능 (DB 에서 NULL 으로 변경 가능)
}
output: {
  updatedHoldings: Array<{symbol, quantity, averageCost}>;
}
errors: not_found (id 미존재 시)
side-effect: broadcast 'portfolio.changed' { reason: 'transaction.update', ... }
```

### finance.transaction.delete

```ts
input: { transactionId: string; }
output: {
  deleted: true;
  updatedHoldings: Array<{symbol, quantity, averageCost}>;
}
errors: not_found (id 미존재 시)
side-effect: broadcast 'portfolio.changed' { reason: 'transaction.delete', ... }
```

### finance.portfolio.get (확장)

```ts
output: {
  portfolioId?: string;          // (기존)
  name?: string;                 // (기존)
  holdings: Array<{symbol, quantity, avgPrice, currency}>;  // (기존)
  summary: { currency, totalHoldings };                     // (기존)
  recentTransactions: Transaction[];                        // 신규 — 최근 10건. db 미주입 시 []
}
```

`Transaction` 의 정확한 모양은 `@finclaw/types/finance.ts` 참조(camelCase 매핑은 storage 가 처리).

## WebSocket notification

채널: `portfolio.changed`

페이로드:

```ts
{
  portfolioId: string;
  updatedAt: number; // Date.now()
  reason: 'transaction.add' | 'transaction.update' | 'transaction.delete';
  transactionId: string;
}
```

전송 조건:

- `broadcaster` + `connections` 모두 주입됐을 때만(테스트 시 미주입 → broadcast skip).
- transactions CRUD 가 성공한 RPC 응답 직전에 broadcast.
- `broadcaster.broadcastToChannel` 호출이 throw 해도 RPC 는 성공으로 응답(best-effort).

## ui-engineer 호출 예시

```ts
// 거래 추가
const r = await rpc('finance.transaction.add', {
  symbol: 'AAPL',
  action: 'buy',
  quantity: 10,
  price: 180,
  currency: 'USD',
  executedAt: Date.now(),
});
// r.transactionId, r.updatedHoldings

// 거래 목록 (특정 portfolio)
const list = await rpc('finance.transaction.list', { portfolioId: 'pf-1', limit: 50 });

// 삭제
await rpc('finance.transaction.delete', { transactionId: r.transactionId });

// portfolio.get — recentTransactions 자동 동봉
const snap = await rpc('finance.portfolio.get', {});
// snap.recentTransactions: Transaction[] (최근 10건)

// WebSocket 구독: 'portfolio.changed' 수신 시 portfolio.get 재호출
ws.subscribe('portfolio.changed');
ws.on('notification.portfolio.changed', () => {
  // payload 무시하고 단순히 다시 fetch
  rpc('finance.portfolio.get', {}).then(updateUi);
});
```

## 에러 메시지 표

| 상황                                         | 메시지 prefix                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| db 미주입                                    | `provider_unavailable: storage db not initialized`                           |
| portfolios 비어 있음 또는 portfolioId 미존재 | `not_found: portfolio not found: <id>` 또는 `not_found: no portfolio exists` |
| transactionId 미존재 (update/delete)         | `not_found: transaction not found: <id>`                                     |
| Zod 검증 실패                                | `Invalid params: ...` (dispatchRpc 가 자동 처리)                             |

(현 finance.ts 패턴상 `Error` throw → dispatchRpc 가 INTERNAL_ERROR 로 매핑. 향후 `RpcError` 도입 시 일괄 변경 예정 — 본 단계에서는 기존 finance handler 와 컨벤션 통일.)

## 테스트 결과

```
pnpm typecheck                                                       # 통과 (tsgo --noEmit)
pnpm lint                                                            # 통과 (oxlint, 0 warnings / 0 errors)
pnpm vitest run packages/server/src/.../finance.test.ts              # 29/29 통과
pnpm test                                                            # 155 files / 1416 tests passed (이전 1406 + 신규 10)
pnpm test:storage                                                    # 6 files / 47 tests passed (회귀 0)
```

신규 테스트 10건 (모두 mock-only, API 키·네트워크 없이 통과):

1. `transaction.add` 성공 → updatedHoldings + broadcaster 1회 호출 + 페이로드 검증
2. `transaction.add` db 미주입 → `provider_unavailable`
3. `transaction.add` portfolioId 미존재 → `not_found`
4. `transaction.list` executedAt DESC 정렬
5. `transaction.delete` 성공 → updatedHoldings 빈 배열 + broadcast `transaction.delete` reason
6. `transaction.delete` 미존재 id → `not_found`
7. `transaction.update` quantity 변경 → holdings 반영 + broadcast `transaction.update` reason
8. `portfolio.get` recentTransactions 1건 동봉(db 주입 시)
9. `portfolio.get` recentTransactions = [] (db 미주입 시)
10. `transaction.add` broadcaster 미주입 시도 best-effort 성공

기존 finance.test.ts 28건 회귀 0.

## 다른 팀원이 알아야 할 사실

- **server.ts 의 financeDeps spread 변경** — `registerFinanceMethods({ ...deps.financeDeps, broadcaster, connections })`. 기존 `?? {}` 는 oxlint `no-useless-fallback-in-spread` 위배. spread 자체가 falsy-safe.
- **portfolios 테이블엔 `created_at` 없음** — `updated_at` 만 있음. resolvePortfolioId 의 ORDER BY 도 `updated_at ASC` 사용. (schema-architect 보고와 모순 없음 — 보고에 `created_at` 언급은 transactions 테이블 컬럼이었음.)
- **dispatchRpc 가 알려진 Error.message 의 prefix(`provider_unavailable:`, `not_found:`)를 그대로 노출** — 기존 quote/news 핸들러와 동일 컨벤션. 향후 `RpcError` 코드화는 별도 리팩토링.
- **Web UI 가 `notification.portfolio.changed` 를 구독해야 자동 갱신** — 페이로드는 식별자만, UI 는 `finance.portfolio.get` 으로 재 fetch.

## 다음 단계 위임 포인트

- **ui-engineer** (밀스톤 E): 위 호출 예시·notification 채널 사용. `recentTransactions` 가 `holdings` 옆에 자연스럽게 보이게 UI 추가.
- **qa-engineer**: 통합 테스트는 본 단계 단위 테스트 10건으로 mock-level 커버 완료. 실제 SQLite 디스크 e2e 시나리오(여러 거래 → broadcast → UI fetch round-trip)는 밀스톤 E 통합 단계에서 추가 권장.
- **밀스톤 B (memory.\*)**: 본 RPC 패턴(deps 옵셔널·broadcast best-effort) 그대로 재사용 가능.

## 범위 외 (의도적으로 안 한 것)

- `transactions` 의 currency 자동 추론 — 사용자가 입력. (단순함 우선 원칙)
- short selling / 잔량 음수 경고 — 본 단계 안 함. holdings 에서 자동 삭제만.
- `RpcError` 클래스 일괄 도입 — 기존 finance handler 와 컨벤션 통일. 별도 리팩토링.
- `transaction.add` 시 portfolio 자동 생성 — portfolios 가 비어 있으면 `not_found` 명시 에러. 자동 생성은 추측성 기능.
