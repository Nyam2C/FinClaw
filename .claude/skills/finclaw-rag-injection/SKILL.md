---
name: finclaw-rag-injection
description: FinClaw 의 기억·거래 RAG 주입 알고리즘 표준. 벡터+FTS 하이브리드 검색(mergeHybridResults 활용), 유사도 임계값(0.65), 신선도 가중치(exp(-days/90)), 상한(3개), 심볼 기반 거래 이력 동시 주입, system prompt "사용자 배경지식" 섹션 빌드, 감사 로그(memory.injected JSON)가 필요할 때 반드시 이 스킬을 사용할 것. agent.run output 의 memory 화 훅도 본 스킬에 포함. packages/storage/src/search/* 와 packages/agent/src/prompts/finance-context.ts (또는 상응) 변경 시 반드시 참조.
---

# finclaw-rag-injection

기억·거래를 검색해 system prompt 에 주입한다. **감사 가능성** 이 핵심: 모든 주입은 로그로 추적 가능해야 한다.

## 1. 검색 함수 시그니처

```ts
// 모듈 위치 후보: packages/server/src/auto-reply/services/rag-service.ts
//                또는 packages/agent/src/prompts/rag.ts
export interface RagInput {
  userQuery: string;
  sessionKey: string;
  embedding?: number[]; // 미리 계산되어 있으면 재사용
}

export interface RagResult {
  snippets: Array<{
    id: string;
    type: string;
    content: string;
    savedAt: number;
    rawScore: number;
    adjustedScore: number;
  }>;
  transactions: Transaction[]; // 발화에 심볼 등장 시
  log: {
    sessionKey: string;
    ids: string[];
    rawScores: number[];
    adjustedScores: number[];
    userQuery: string;
    mode: 'hybrid' | 'fts-only';
  };
}

export async function searchRelevantMemories(input: RagInput): Promise<RagResult>;
```

## 2. 알고리즘 (한 함수로 정리)

```ts
const THRESHOLD = 0.65;
const FRESHNESS_DECAY_DAYS = 90;
const TOP_K_HYBRID = 5;
const FINAL_CAP = 3;
const TYPES = ['preference', 'fact', 'financial'] as const;

async function searchRelevantMemories({ userQuery, sessionKey, embedding }) {
  // 1. 임베딩 생성 (실패 시 FTS-only 모드)
  let mode: 'hybrid' | 'fts-only' = 'hybrid';
  let vec = embedding;
  if (!vec) {
    try {
      vec = await embeddingProvider.embed(userQuery);
    } catch (e) {
      mode = 'fts-only';
      logger.warn('embedding failed, fts only');
    }
  }

  // 2. 하이브리드 검색
  const candidates =
    mode === 'hybrid'
      ? await mergeHybridResults({
          vectorQuery: vec!,
          ftsQuery: userQuery,
          topK: TOP_K_HYBRID,
          types: TYPES,
        })
      : await searchFts({ query: userQuery, topK: TOP_K_HYBRID, types: TYPES });

  // 3. 임계값 + 신선도 가중치
  const now = Date.now();
  const adjusted = candidates
    .map((c) => {
      const days = Math.max(0, (now - c.savedAt) / 86_400_000);
      const adjustedScore = c.score * Math.exp(-days / FRESHNESS_DECAY_DAYS);
      return { ...c, rawScore: c.score, adjustedScore };
    })
    .filter((c) => c.rawScore >= THRESHOLD)
    .sort((a, b) => b.adjustedScore - a.adjustedScore)
    .slice(0, FINAL_CAP);

  // 4. 거래 이력 (심볼 추출)
  const symbols = extractSymbols(userQuery); // 단순 패턴
  const transactions =
    symbols.length > 0 ? await listRecentTransactions({ symbols, limit: 3 }) : [];

  // 5. 감사 로그
  const log = {
    sessionKey,
    ids: adjusted.map((a) => a.id),
    rawScores: adjusted.map((a) => a.rawScore),
    adjustedScores: adjusted.map((a) => a.adjustedScore),
    userQuery,
    mode,
  };

  return { snippets: adjusted, transactions, log };
}
```

## 3. 임계값·가중치 의사결정

| 상수                 | 값   | 근거                                                                    |
| -------------------- | ---- | ----------------------------------------------------------------------- |
| THRESHOLD            | 0.65 | 무관 발화에 무관 기억이 끼지 않는 마지노선. 튜닝 시 사용자 피드백 기반. |
| FRESHNESS_DECAY_DAYS | 90   | 3개월 지나면 가중치 ~37% (e^-1). 사용자 라이프사이클 가정.              |
| TOP_K_HYBRID         | 5    | 상한 3 보다 약간 크게 가져와 임계값 컷 후도 3개 남길 여유.              |
| FINAL_CAP            | 3    | 프롬프트 비용 통제. system prompt 에 들어가는 사용자 배경지식은 짧게.   |

상수는 한 모듈에서 export (`packages/agent/src/prompts/rag-constants.ts` 또는 등가). 매직 넘버 산재 금지.

## 4. 심볼 추출 (단순 패턴)

```ts
function extractSymbols(text: string): string[] {
  // 대문자 2-5자 (영문) 또는 한국 종목코드 6자리
  const re = /\b[A-Z]{2,5}\b|\b\d{6}\b/g;
  const matches = text.match(re) ?? [];
  // 통화 단위 등 false positive 제거
  const blocklist = new Set(['USD', 'KRW', 'EUR', 'JPY', 'CNY', 'HKD', 'GBP']);
  return [...new Set(matches.filter((s) => !blocklist.has(s)))];
}
```

정밀 NER 불필요. AAPL/BTC/MSFT/005930 같은 명백한 케이스만 잡으면 충분.

## 5. system prompt 섹션 빌더

```ts
function buildUserContextSection(snippets, transactions): string {
  const lines = [];
  if (snippets.length > 0) {
    lines.push('## 사용자 배경지식 (자동 주입)');
    for (const s of snippets) {
      const date = new Date(s.savedAt).toISOString().slice(0, 10);
      lines.push(`- [${s.type}] ${s.content} (${date} 저장)`);
    }
  }
  if (transactions.length > 0) {
    const symbol = transactions[0].symbol;
    lines.push(`\n## 최근 거래 (${symbol})`);
    for (const t of transactions) {
      const date = new Date(t.executed_at).toISOString().slice(0, 10);
      lines.push(`- ${date}: ${t.action} ${t.quantity}주 @ ${t.currency} ${t.price ?? '-'}`);
    }
  }
  return lines.join('\n');
}
```

빈 결과 시 빈 문자열 반환 → caller 가 섹션 자체를 system prompt 에 넣지 않음 (빈 헤더 노출 방지).

## 6. agent.run output → memory (밀스톤 D 훅)

```ts
// agent.run 핸들러 끝부분
async function attachMemoryFromAgentRun(run: AgentRun): Promise<string | null> {
  if (run.error || run.output.length < 100) {
    return null; // 오류 또는 너무 짧음 → 저장 X
  }
  try {
    const memory = await memoryService.addWithEmbedding({
      content: run.output,
      type: 'financial',
      sessionKey: run.session_key ?? null,
      sourceRef: { kind: 'agent_run', id: run.id },
    });
    return memory.id;
  } catch (e) {
    logger.warn('agent.run memory attach failed', { runId: run.id, error: e });
    return null;
  }
}

// agent_runs 테이블에 memory_id 업데이트
await db.prepare('UPDATE agent_runs SET memory_id = ? WHERE id = ?').run(memId, runId);
```

## 7. 감사 로그 표준 형식

```json
{
  "event": "memory.injected",
  "sessionKey": "<id>",
  "ids": ["m1", "m7"],
  "rawScores": [0.81, 0.72],
  "adjustedScores": [0.78, 0.55],
  "userQuery": "내 선호가 뭐였지?",
  "mode": "hybrid"
}
```

JSON 한 줄. 파일 또는 DB 한 곳으로 일관 출력. SQL/jq 로 추후 분석 가능.

## 8. 검증 시나리오

- "내 투자 철학 뭐였지?" → preference 매칭 ≥1
- "AAPL 얘기해줘" → AAPL 거래 3건 주입, AAPL 관련 financial 기억 매칭
- "오늘 날씨 어때" → snippets 0, transactions 0, log injected: 0
- 어제 vs 3개월 전 동시 매칭 → 어제 우선 (adjustedScore)
- 임베딩 키 미설정 → mode='fts-only', 결과 빈약하지만 동작
- agent.run 오류 → memory 저장 X, agent_runs.memory_id NULL

## 9. 작성 후 알릴 곳

- pipeline-engineer 에게: 검색 함수 시그니처 확정 통보, retrieval 스테이지 호출.
- rpc-engineer 에게: agent.run 핸들러에 `attachMemoryFromAgentRun` 훅 삽입 위치.
- qa-engineer 에게 `TaskCreate`: 임계값 / 신선도 / 심볼 추출 / 빈 결과 시나리오.

## 참고

- `packages/storage/src/search/hybrid.ts` — `mergeHybridResults` (이미 구현)
- `packages/storage/src/search/{vector,fts}.ts` — 단독 호출도 가능
- `packages/storage/src/embeddings/voyage.ts` — 다국어 임베딩 권장 (plan.md Q4)
