---
name: finclaw-testing
description: FinClaw 4-tier vitest 테스트 작성 표준. unit / storage / e2e / live 분리, mock-only 외부 API 격리(임베딩·시세 API 키 없이도 테스트 통과 필수), 마이그레이션 v3→v4 시뮬레이션, 경계면 교차 검증(스토리지↔RPC↔UI shape 일치)이 필요할 때 반드시 이 스킬을 사용할 것. *.test.ts 또는 *.storage.test.ts 신설/수정 시 반드시 참조. qa-engineer 의 핵심 도구.
---

# finclaw-testing

FinClaw 의 4-tier vitest 패턴. **외부 API 키 없이도 모든 테스트가 통과** 해야 한다 (MEMORY.md 제약).

## 1. 4-tier 구조

| Tier    | 파일 패턴           | 실행 환경                | 외부 의존                  |
| ------- | ------------------- | ------------------------ | -------------------------- |
| unit    | `*.test.ts`         | 일반 vitest              | 없음 (전부 mock)           |
| storage | `*.storage.test.ts` | better-sqlite3 in-memory | DB 만 (외부 API 키 X)      |
| e2e     | `*.e2e.test.ts`     | full server boot         | 없음 (외부 API mock)       |
| live    | `*.live.test.ts`    | 실제 키 필요             | API 키 (CI 에서 skip 가능) |

본 Phase 26 의 검증은 unit + storage + e2e 만으로 끝낸다. live 추가 X.

## 2. mock 주입 패턴

```ts
// 임베딩 프로바이더 mock
const mockEmbedding = {
  embed: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)),
  dimension: 1024,
};

// storage 의존성 주입 시
const memoryService = createMemoryService({ db, embeddingProvider: mockEmbedding });
```

핵심: 프로덕션 코드가 의존성을 인자로 받는 구조여야 mock 가능. 모듈 내부에서 `import { embeddingProvider } from '...'` 하드 와이어 금지.

## 3. 마이그레이션 무결성 테스트 (밀스톤 A)

```ts
// packages/storage/src/database.test.ts (보강)
test('v3 → v4 holdings preserved as synthetic transactions', () => {
  const db = createDb({ migrationsUpTo: 3 });
  db.prepare('INSERT INTO portfolios (id, name) VALUES (?, ?)').run('p1', 'main');
  db.prepare(
    'INSERT INTO portfolio_holdings (portfolio_id, symbol, quantity, average_cost, currency, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('p1', 'AAPL', 10, 180, 'USD', 1710000000000);

  runMigrations(db); // v4 까지

  const txns = db.prepare('SELECT * FROM transactions WHERE portfolio_id=?').all('p1');
  expect(txns).toHaveLength(1);
  expect(txns[0].action).toBe('buy');
  expect(txns[0].quantity).toBe(10);
  expect(txns[0].price).toBe(180);
  expect(txns[0].source).toBe('manual');

  const holdings = db.prepare('SELECT * FROM portfolio_holdings WHERE portfolio_id=?').all('p1');
  expect(holdings[0].quantity).toBe(10);
  expect(holdings[0].average_cost).toBe(180);
});
```

## 4. 경계면 교차 검증 (qa-engineer 핵심 작업)

QA 의 진짜 가치는 단일 모듈 합격이 아니라 **모듈 간 shape 일치**.

```ts
// 예: transactions storage row ↔ Zod 응답 스키마 ↔ UI 컴포넌트 사용 필드
test('transaction storage row matches finance.transaction.list response shape', () => {
  const row = addTransaction({
    /* ... */
  });
  const rpcResponse = TransactionListOutput.parse({ transactions: [row] });
  // UI 가 사용하는 필드 (날짜/심볼/액션/수량/단가/금액)
  for (const f of ['symbol', 'action', 'quantity', 'price', 'executed_at']) {
    expect(rpcResponse.transactions[0]).toHaveProperty(f);
  }
});
```

## 5. holdings 재계산 정확도 (밀스톤 A)

```ts
test('weighted average cost: buy 10@180 + buy 5@200 = avg 186.67', () => {
  const portfolioId = setupPortfolio();
  addTransaction({
    portfolio_id: portfolioId,
    symbol: 'AAPL',
    action: 'buy',
    quantity: 10,
    price: 180,
    currency: 'USD',
    executed_at: 1710000000000,
  });
  addTransaction({
    portfolio_id: portfolioId,
    symbol: 'AAPL',
    action: 'buy',
    quantity: 5,
    price: 200,
    currency: 'USD',
    executed_at: 1711000000000,
  });
  const h = getHolding(portfolioId, 'AAPL');
  expect(h.quantity).toBe(15);
  expect(h.average_cost).toBeCloseTo(186.67, 2);
});

test('sell 3 keeps average_cost (PnL is separate)', () => {
  // ... buy 15 → sell 3
  expect(h.quantity).toBe(12);
  expect(h.average_cost).toBeCloseTo(186.67, 2);
});
```

## 6. capture 정규식 5종 (밀스톤 B)

```ts
test.each([
  ['기억해: 분기 리밸런싱', 'fact'],
  ['내 투자 원칙은 배당주 중심', 'preference'],
  ['선호: 장기 보유', 'preference'],
  ['메모: 12월 세금 손실 매도', 'fact'],
  ['!finclaw remember 1년 한 번 점검', 'fact'],
])('captures "%s" as %s', async (text, expectedType) => {
  const ctx = createCtxWithMockMemory();
  await memoryCaptureStage({ normalizedText: text, sessionKey: 's1' }, ctx);
  expect(ctx.memoryService.addWithEmbedding).toHaveBeenCalledWith(
    expect.objectContaining({ type: expectedType }),
  );
});

test('non-matching text is not captured', async () => {
  const ctx = createCtxWithMockMemory();
  await memoryCaptureStage({ normalizedText: '오늘 점심 뭐 먹지', sessionKey: 's1' }, ctx);
  expect(ctx.memoryService.addWithEmbedding).not.toHaveBeenCalled();
});

test('duplicate hash skips with note', async () => {
  // 같은 content 두 번 → 두번째는 skip
});
```

## 7. RAG 동작 (밀스톤 C)

```ts
test('threshold filters out unrelated query', async () => {
  seedMemory({ type: 'preference', content: '나는 배당주 좋아함' });
  const result = await searchRelevantMemories({ userQuery: '오늘 날씨 어때', sessionKey: 's1' });
  expect(result.snippets).toHaveLength(0);
  expect(result.log.ids).toHaveLength(0);
});

test('freshness weighting: recent beats old', async () => {
  seedMemory({ id: 'old', savedAt: now - 120 * 86_400_000, content: 'X', score: 0.8 });
  seedMemory({ id: 'new', savedAt: now - 1 * 86_400_000, content: 'X', score: 0.75 });
  const result = await searchRelevantMemories({ userQuery: 'X 관련', sessionKey: 's1' });
  expect(result.snippets[0].id).toBe('new'); // adjustedScore 더 높음
});

test('symbol triggers transaction injection', async () => {
  seedTransaction({ symbol: 'AAPL' /* ... */ });
  const result = await searchRelevantMemories({ userQuery: 'AAPL 얘기해줘', sessionKey: 's1' });
  expect(result.transactions.length).toBeGreaterThan(0);
});

test('embedding failure falls back to FTS-only', async () => {
  mockEmbedding.embed.mockRejectedValueOnce(new Error('quota'));
  const result = await searchRelevantMemories({ userQuery: '...', sessionKey: 's1' });
  expect(result.log.mode).toBe('fts-only');
});
```

## 8. agent.run → memory (밀스톤 D)

```ts
test('agent.run output > 100 chars saves memory and links id', async () => {
  const runId = await runAgent({ prompt: 'AAPL 분석' }); // mock returns 500-char output
  const run = getAgentRun(runId);
  expect(run.memory_id).toBeTruthy();
  const mem = getMemory(run.memory_id);
  expect(mem.type).toBe('financial');
});

test('agent.run error skips memory save', async () => {
  mockExecutor.run.mockRejectedValueOnce(new Error('rate limit'));
  const runId = await runAgent({ prompt: 'X' }).catch((e) => e.runId);
  const run = getAgentRun(runId);
  expect(run.memory_id).toBeNull();
  expect(run.error).toContain('rate limit');
});
```

## 9. UI ↔ RPC ↔ DB 3계층 (밀스톤 E, e2e)

```ts
test('add transaction via RPC reflects in portfolio.get and triggers WS notification', async () => {
  const wsClient = await connectWs();
  await rpc('finance.transaction.add', {
    /* ... */
  });
  await waitForNotification(wsClient, 'portfolio.changed', { reason: 'transaction.add' });
  const portfolio = await rpc('finance.portfolio.get', {});
  expect(portfolio.recentTransactions).toHaveLength(1);
});
```

## 10. 실행

```bash
pnpm test                        # 전체 (unit + storage + e2e)
pnpm test --tier=storage         # storage tier 만
pnpm test packages/storage       # 패키지 한정
```

타입 체크는 별도: `pnpm typecheck` 또는 `tsgo --noEmit`.

## 11. 작성 후 체크리스트

- [ ] 외부 API 키 없이 동작 (CI 에서 검증)
- [ ] mock 이 의존성 주입 형태로 들어감 (전역 mock 회피)
- [ ] 마이그레이션 시뮬레이션은 v3 fixture → v4 변환 → 데이터 보존
- [ ] 경계면 테스트는 storage row → RPC 응답 → UI 사용 필드 3계층 연결 확인
- [ ] 음성 케이스(should-not-trigger, threshold 미달, 0 결과)도 포함

## 참고

- 기존 테스트: `packages/storage/src/tables/memories.storage.test.ts`, `packages/storage/src/database.test.ts`, `packages/server/src/gateway/rpc/methods/finance.test.ts`
- `vitest.config.ts` 의 tier 분리 설정 (있다면 참조)
