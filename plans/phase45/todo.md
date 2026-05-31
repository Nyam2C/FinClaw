# Phase 45 todo — dead-code sweep (audit-driven) — 초안

> 결정·설계·인벤토리·안전 원칙·마일스톤 = `plans/phase45/plan.md`, 인벤토리 원본 = `_workspace/decl-audit/unused-report.md`.
> 본 todo 는 **M-A (T1 무참조 39개)** 실행 체크리스트만 분해. M-B (T2 죽은 군집 34개) + M-C (T3 테스트만 41개) 는 M-A 완료 후 별도 todo 분해.
> **검증 근거:** 9 패키지 병렬 재검증(워크플로우 `wf_529714fe-0c6`) — 각 심볼 grep + 배럴 + 테스트 + 동적 dispatch 모두 통과.

## 재검증 결과 (M-A 진입 전)

| 패키지         | 감사 T1 | CONFIRMED_DEAD | LIVE (보류) | ALREADY_REMOVED |
| -------------- | ------: | -------------: | ----------: | --------------: |
| types          |       4 |              4 |           0 |               0 |
| infra          |       4 |              4 |           0 |               0 |
| storage        |       3 |              3 |           0 |               0 |
| config         |       2 |              2 |           0 |               0 |
| agent          |       2 |              2 |           0 |               0 |
| skills-finance |       9 |              9 |           0 |               0 |
| skills-general |       1 |              1 |           0 |               0 |
| gateway        |       2 |              2 |           0 |               0 |
| server         |      12 |             12 |           0 |               0 |
| **합계**       |  **39** |         **39** |       **0** |           **0** |

**모든 39 개 CONFIRMED_DEAD.** false positive 0, 이미 제거된 항목 0. 감사 보고서가 정확함을 9 에이전트가 grep + barrel + 테스트 트리 검증.

## 보류 (LIVE false positive)

없음.

## ALREADY_REMOVED (phase44 흡수)

없음.

---

## 마일스톤 A — T1 무참조 39개 제거 (바텀업, 패키지별 서브밀스톤)

**각 서브밀스톤 종료 시 게이트:**

```
pnpm format && pnpm lint && pnpm typecheck && pnpm exec tsc --build && pnpm test --run
```

**커밋 메시지:** `refactor(phase45): remove dead <area> (<count> items)`

순서 = types → infra → storage → config → agent → skills-finance → skills-general → gateway → server. 하위 레이어 제거 후 게이트 통과해야 상위로.

---

### A-1 types (4 items)

#### Step A-1-1: REMOVE `TimeInterval`

- **파일:** `packages/types/src/finance.ts` L52-53
- **제거 대상:**
  ```ts
  /** 시계열 간격 */
  export type TimeInterval = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w' | '1M';
  ```
- **배럴 동반:** 없음 (`packages/types/src/index.ts:11` 이 wildcard `export type * from './finance.js'` — 자동 흡수)
- **재검증:** `rg "\bTimeInterval\b" packages/*/src --type ts` → 0 expected.

#### Step A-1-2: REMOVE `WsEvent` (+ 변형 union 멤버 5종)

- **파일:** `packages/types/src/gateway.ts` L86-92 (WsEvent union 만)
- **제거 대상:**
  ```ts
  /** WebSocket 이벤트 */
  export type WsEvent =
    | WsMessageEvent
    | WsTypingEvent
    | WsAgentStatusEvent
    | WsAlertEvent
    | WsErrorEvent;
  ```
- **배럴 동반:** `packages/gateway/src/rpc/types.ts` L18 — re-export 줄에서 `WsEvent,` 제거
- **변형 멤버 5개 (WsMessageEvent / WsTypingEvent / WsAgentStatusEvent / WsAlertEvent / WsErrorEvent, L94-128) 은 변형 union 만 참조 → 일괄 dead.** WsEvent 제거 시 변형도 같이 정리할지 별 step 으로 빼서 phase45 범위 안에서 처리할지 → **이 step 에서는 WsEvent 만 제거, 변형 5개는 typecheck 가 오류 안 내는 한 보존** (감사 T1 범위 외; phase46 검토).
- **재검증:** `rg "\bWsEvent\b" packages/*/src --type ts` → 0 expected.

#### Step A-1-3: REMOVE `GatewayStatus`

- **파일:** `packages/types/src/gateway.ts` L130-137
- **제거 대상:**
  ```ts
  /** 게이트웨이 상태 */
  export interface GatewayStatus {
    uptime: number;
    connections: number;
    activeAgents: number;
    activeSessions: number;
    version: string;
  }
  ```
- **배럴 동반:** `packages/gateway/src/rpc/types.ts` L19 — re-export 줄에서 `GatewayStatus,` 제거
- **재검증:** `rg "\bGatewayStatus\b" packages/*/src --type ts` → 0 expected.

#### Step A-1-4: REMOVE `BroadcastChannel`

- **파일:** `packages/types/src/notification.ts` L42-43
- **제거 대상:**
  ```ts
  /** 브로드캐스트 채널 */
  export type BroadcastChannel =
    | 'config.updated'
    | 'session.event'
    | 'system.status'
    | 'market.tick';
  ```
- **배럴 동반 (2 곳):**
  - `packages/gateway/src/rpc/types.ts` L6 — import 줄에서 `BroadcastChannel,` 제거
  - `packages/gateway/src/rpc/types.ts` L21 — re-export 줄에서 `BroadcastChannel,` 제거
- **재검증:** `rg "\bBroadcastChannel\b" packages/*/src --type ts` → 0 expected.

#### Verification A-1:

```
pnpm format && pnpm lint && pnpm typecheck && pnpm exec tsc --build && pnpm test --run
```

**Commit:** `refactor(phase45): remove dead types (4 items)`

---

### A-2 infra (4 items)

#### Step A-2-1: REMOVE `ConcurrencyLaneManager.resetGeneration`

- **파일:** `packages/infra/src/concurrency-lane.ts` L175-177
- **제거 대상:**
  ```ts
    resetGeneration(laneId: LaneId): void {
      this.getLane(laneId).resetGeneration();
    }
  ```
- **주의:** `ConcurrencyLane.resetGeneration` 은 보존 (테스트 contract). 본 step 은 매니저 래퍼 메서드만.
- **배럴:** 없음.
- **재검증:** `rg "manager\.resetGeneration|Manager\.resetGeneration" packages/*/src --type ts` → 0 expected (lane.resetGeneration 은 보존).

#### Step A-2-2: REMOVE `EventMap`

- **파일:** `packages/infra/src/events.ts` L4-16 (JSDoc 포함)
- **제거 대상:**
  ```ts
  /**
   * 이벤트 맵 타입 — 이벤트명 → 핸들러 시그니처 매핑
   * ...
   */
  export type EventMap = Record<string, (...args: never[]) => void>;
  ```
- **배럴 동반:** `packages/infra/src/index.ts` L64 — `type EventMap,` 줄 제거
- **재검증:** `rg "\bEventMap\b" packages/*/src --type ts` → 0 expected. (FinClawEventMap 은 별 타입, 보존.)

#### Step A-2-3: REMOVE `createFlushFn`

- **파일:** `packages/infra/src/logger-transports.ts` L86-99 (JSDoc 포함)
- **제거 대상:**
  ```ts
  /**
   * 모든 트랜스포트의 버퍼 플러시
   * ...
   */
  export function createFlushFn(streams: fs.WriteStream[]): () => Promise<void> {
    ...
  }
  ```
- **배럴:** 없음 (`packages/infra/src/index.ts` 의 logger-transports 섹션은 `attachFileTransport` + `type FileTransportConfig` 만 re-export).
- **재검증:** `rg "\bcreateFlushFn\b" packages/*/src --type ts` → 0 expected.

#### Step A-2-4: REMOVE `defaultLoggerFactory`

- **파일:** `packages/infra/src/logger.ts` L111-114
- **제거 대상:**
  ```ts
  /** 기본 LoggerFactory 구현 */
  export const defaultLoggerFactory: LoggerFactory = {
    create: createLogger,
  };
  ```
- **배럴 동반:** `packages/infra/src/index.ts` L52 — `defaultLoggerFactory,` 줄 제거
- **주의:** `LoggerFactory` 타입은 보존 (감사 범위 외).
- **재검증:** `rg "\bdefaultLoggerFactory\b" packages/*/src --type ts` → 0 expected.

#### Verification A-2:

```
pnpm format && pnpm lint && pnpm typecheck && pnpm exec tsc --build && pnpm test --run
```

**Commit:** `refactor(phase45): remove dead infra (4 items)`

---

### A-3 storage (3 items)

#### Step A-3-1: REMOVE `updateConversation`

- **파일:** `packages/storage/src/tables/conversations.ts` L146-165
- **제거 대상:**
  ```ts
  export function updateConversation(
    db: DatabaseSync,
    sessionKey: SessionKey,
    updates: { title?: string; metadata?: Record<string, unknown> },
  ): void {
    ...
  }
  ```
- **배럴:** 없음 (`packages/storage/src/index.ts` 의 conversations 블록 L60-66 에 updateConversation 부재).
- **재검증:** `rg "\bupdateConversation\b" packages/*/src --type ts` → 0 expected.

#### Step A-3-2: REMOVE `deleteCachedEmbeddings`

- **파일:** `packages/storage/src/tables/embeddings.ts` L51-60
- **제거 대상:**
  ```ts
  export function deleteCachedEmbeddings(db: DatabaseSync, provider: string, model?: string): number {
    if (model) {
      const result = db
        .prepare('DELETE FROM embedding_cache WHERE provider = ? AND model = ?')
        .run(provider, model);
    ...
  }
  ```
- **배럴:** 없음 (re-export 안 됨).
- **주의:** `setCachedEmbedding` / `getCachedEmbedding` 은 `embedBatchWithCache` 가 내부 사용 — 보존.
- **재검증:** `rg "\bdeleteCachedEmbeddings\b" packages/*/src --type ts` → 0 expected.

#### Step A-3-3: REMOVE `listConversations`

- **파일:** `packages/storage/src/tables/conversations.ts` L249-275
- **제거 대상:**
  ```ts
  export function listConversations(
    db: DatabaseSync,
    options?: { agentId?: AgentId; limit?: number; offset?: number },
  ): ConversationRecord[] {
    ...
  }
  ```
- **배럴 동반:** `packages/storage/src/index.ts` L65 — `listConversations,` 줄 제거 (conversations 블록 안 multi-export 의 한 줄)
- **재검증:** `rg "\blistConversations\b" packages/*/src --type ts` → 0 expected.

#### Verification A-3:

```
pnpm format && pnpm lint && pnpm typecheck && pnpm exec tsc --build && pnpm test --run
```

**Commit:** `refactor(phase45): remove dead storage (3 items)`

---

### A-4 config (2 items)

#### Step A-4-1: REMOVE `now`

- **파일:** `packages/config/src/sessions/store.ts` L118-121
- **제거 대상:**
  ```ts
  /** 현재 타임스탬프 생성 헬퍼 */
  export function now(): ReturnType<typeof createTimestamp> {
    return createTimestamp(Date.now());
  }
  ```
- **배럴 동반:** `packages/config/src/index.ts` L49 — `export { createSessionStore, now } from './sessions/store.js';` 줄에서 `, now` 제거 → `export { createSessionStore } from './sessions/store.js';`
- **재검증:** `rg "from '@finclaw/config'" packages -A3 --type ts | grep "\bnow\b"` → 0 expected.

#### Step A-4-2: REMOVE `ValidatedFinClawConfig`

- **파일:** `packages/config/src/zod-schema.ts` L182
- **제거 대상:**
  ```ts
  export type ValidatedFinClawConfig = z.infer<typeof FinClawConfigSchema>;
  ```
- **배럴 동반:** `packages/config/src/index.ts` L20 — `export type { ValidatedFinClawConfig } from './zod-schema.js';` 줄 삭제
- **재검증:** `rg "\bValidatedFinClawConfig\b" packages/*/src --type ts` → 0 expected.

#### Verification A-4:

```
pnpm format && pnpm lint && pnpm typecheck && pnpm exec tsc --build && pnpm test --run
```

**Commit:** `refactor(phase45): remove dead config (2 items)`

---

### A-5 agent (2 items)

#### Step A-5-1: REMOVE `ToolGroup`

- **파일:** `packages/agent/src/agents/tools/groups.ts` L15-25 (JSDoc 포함, type 본문)
- **제거 대상:**

  ```ts
  // ── 도구 그룹 정의 ──

  /** 도구 그룹 정의 */
  export interface ToolGroup {
    readonly id: ToolGroupId;
    ...
  }
  ```

- **배럴 동반 (2 곳):**
  - `packages/agent/src/agents/tools/index.ts` L2 — `export type { ToolGroupId, ToolGroup } from './groups.js';` → `export type { ToolGroupId } from './groups.js';`
  - `packages/agent/src/index.ts` L80 — multi-export 줄에서 `ToolGroup,` 제거
- **재검증:** `rg "\bToolGroup\b" packages/*/src --type ts` → 0 expected.

#### Step A-5-2: REMOVE `ToolInputSchema`

- **파일:** `packages/agent/src/agents/tools/registry.ts` L22-27
- **제거 대상:**
  ```ts
  /** 도구 입력 파라미터 스키마 (JSON Schema 서브셋, 문서/검증용) */
  export interface ToolInputSchema {
    readonly type: 'object';
    readonly properties: Record<string, ToolPropertySchema>;
    readonly required?: readonly string[];
  }
  ```
- **배럴 동반 (2 곳):**
  - `packages/agent/src/agents/tools/index.ts` L6 — multi-export 줄에서 `ToolInputSchema,` 제거 (ToolPropertySchema 는 보존)
  - `packages/agent/src/index.ts` L81 — multi-export 줄에서 `ToolInputSchema,` 제거 (ToolPropertySchema 보존)
- **주의:** `ToolPropertySchema` 는 자기참조(`items: ToolPropertySchema`)로 살아있으니 보존.
- **재검증:** `rg "\bToolInputSchema\b" packages/*/src --type ts` → 0 expected.

#### Verification A-5:

```
pnpm format && pnpm lint && pnpm typecheck && pnpm exec tsc --build && pnpm test --run
```

**Commit:** `refactor(phase45): remove dead agent (2 items)`

---

### A-6 skills-finance (9 items)

#### Step A-6-1: REMOVE `ALERT_SKILL_METADATA`

- **파일:** `packages/skills-finance/src/alerts/index.ts` L131-149 (JSDoc + const 본문)
- **제거 대상:**
  ```ts
  export const ALERT_SKILL_METADATA: SkillMetadata = {
    name: 'alert-system',
    description: '...',
    ...
  };
  ```
- **배럴 동반:** `packages/skills-finance/src/index.ts` L20 — `export { registerAlertTools, ALERT_SKILL_METADATA } from './alerts/index.js';` → `export { registerAlertTools } from './alerts/index.js';`
- **재검증:** `rg "\bALERT_SKILL_METADATA\b" packages/*/src --type ts` → 0 expected.

#### Step A-6-2: REMOVE `MARKET_SKILL_METADATA`

- **파일:** `packages/skills-finance/src/market/index.ts` L267-282 (JSDoc + const)
- **제거 대상:**
  ```ts
  /** 스킬 메타데이터 — Phase 7의 skill registry에 등록 */
  export const MARKET_SKILL_METADATA: SkillMetadata = {
    name: 'market-data',
    ...
  };
  ```
- **배럴 동반:** `packages/skills-finance/src/index.ts` L2 — `MARKET_SKILL_METADATA` 토큰 제거
- **재검증:** `rg "\bMARKET_SKILL_METADATA\b" packages/*/src --type ts` → 0 expected.

#### Step A-6-3: REMOVE `NEWS_SKILL_METADATA`

- **파일:** `packages/skills-finance/src/news/index.ts` L126-140 (JSDoc + const)
- **제거 대상:**
  ```ts
  /** 스킬 메타데이터 */
  export const NEWS_SKILL_METADATA: SkillMetadata = {
    name: 'news-analysis',
    ...
  };
  ```
- **배럴 동반:** `packages/skills-finance/src/index.ts` L4 — `NEWS_SKILL_METADATA` 토큰 제거
- **재검증:** `rg "\bNEWS_SKILL_METADATA\b" packages/*/src --type ts` → 0 expected.

#### Step A-6-4: REMOVE `ProviderRegistry.resolveWithFallback`

- **파일:** `packages/skills-finance/src/market/provider-registry.ts` L30-33
- **제거 대상:**
  ```ts
    /** fallback chain (기존 forex 사용처 유지) */
    resolveWithFallback(symbol: TickerSymbol): MarketDataProvider[] {
      return this.providers.filter((p) => p.supports(symbol));
    }
  ```
- **배럴:** 없음.
- **재검증:** `rg "\bresolveWithFallback\b" packages/*/src --type ts` → 0 expected.

#### Step A-6-5: REMOVE `ProviderRegistry.list`

- **파일:** `packages/skills-finance/src/market/provider-registry.ts` L35-38
- **제거 대상:**
  ```ts
    /** Phase 27 D: status 표시용. 등록된 provider 목록 readonly view. */
    list(): ReadonlyArray<MarketDataProvider> {
      return this.providers;
    }
  ```
- **배럴:** 없음.
- **주의:** `registry.list()` / `providers.list()` 6 hits 는 다른 registry (ToolRegistry) 에 해당, 무관.
- **재검증:** `rg "providers?\.list\(\)|providerRegistry\.list" packages/*/src --type ts` → skills-finance ProviderRegistry 호출 없음 expected.

#### Step A-6-6: REMOVE `PortfolioStore.upsertPortfolio`

- **파일:** `packages/skills-finance/src/news/portfolio/store.ts` L46-58
- **제거 대상:**
  ```ts
    /** 포트폴리오 생성/갱신 */
    upsertPortfolio(portfolio: Pick<Portfolio, 'id' | 'name' | 'currency'>): void {
      this.db
        .prepare(
          `INSERT INTO portfolios (id, name, currency, updated_at) ...`
        )
        ...
    }
  ```
- **배럴:** 없음.
- **재검증:** `rg "\bupsertPortfolio\b" packages/*/src --type ts` → 0 expected.

#### Step A-6-7: REMOVE `PortfolioStore.deletePortfolio`

- **파일:** `packages/skills-finance/src/news/portfolio/store.ts` L60-64
- **제거 대상:**
  ```ts
    /** 포트폴리오 삭제 (CASCADE로 holdings도 삭제) */
    deletePortfolio(id: string): boolean {
      const result = this.db.prepare('DELETE FROM portfolios WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    }
  ```
- **재검증:** `rg "\bdeletePortfolio\b" packages/*/src --type ts` → 0 expected.

#### Step A-6-8: REMOVE `PortfolioStore.upsertHolding`

- **파일:** `packages/skills-finance/src/news/portfolio/store.ts` L66-85
- **제거 대상:**
  ```ts
    /** 보유 종목 추가/갱신 */
    upsertHolding(
      portfolioId: string,
      holding: Pick<PortfolioHolding, 'symbol' | 'quantity' | 'averageCost'>,
    ): void {
      ...
    }
  ```
- **재검증:** `rg "\bupsertHolding\b" packages/*/src --type ts` → 0 expected.

#### Step A-6-9: REMOVE `PortfolioStore.removeHolding`

- **파일:** `packages/skills-finance/src/news/portfolio/store.ts` L87-93
- **제거 대상:**
  ```ts
    /** 보유 종목 제거 */
    removeHolding(portfolioId: string, symbol: TickerSymbol): boolean {
      const result = this.db
        .prepare('DELETE FROM portfolio_holdings WHERE portfolio_id = ? AND symbol = ?')
        .run(portfolioId, symbol as string);
      return Number(result.changes) > 0;
    }
  ```
- **재검증:** `rg "\bremoveHolding\b" packages/*/src --type ts` → 0 expected.

#### Notes for A-6:

- A-6-6 ~ A-6-9: PortfolioStore 의 write 메서드 4종 일괄 제거 → **read-only 우선 보존 불변 (CLAUDE.md, 매수=사람) 과 정합**.
- A-6-1 ~ A-6-3: SKILL_METADATA 3종이 모두 dead → skills-finance 의 메타 노출 표면 축소.

#### Verification A-6:

```
pnpm format && pnpm lint && pnpm typecheck && pnpm exec tsc --build && pnpm test --run
```

**Commit:** `refactor(phase45): remove dead skills-finance (9 items)`

---

### A-7 skills-general (1 item)

#### Step A-7-1: REMOVE `GENERAL_SKILL_METADATA`

- **파일:** `packages/skills-general/src/index.ts` L47-61
- **제거 대상:**
  ```ts
  export const GENERAL_SKILL_METADATA: SkillMetadata = {
    name: 'general',
    description: '타임존 시각, 웹 콘텐츠 조회, 로컬 파일 읽기 등 범용 도구 모음.',
    version: '1.0.0',
    requires: {
      ...
    },
    tools: [...],
  };
  ```
- **배럴:** 자기 자신이 index.ts (정의 = export 한 줄).
- **재검증:** `rg "\bGENERAL_SKILL_METADATA\b" packages/*/src --type ts` → 0 expected.

#### Verification A-7:

```
pnpm format && pnpm lint && pnpm typecheck && pnpm exec tsc --build && pnpm test --run
```

**Commit:** `refactor(phase45): remove dead skills-general (1 item)`

---

### A-8 gateway (2 items)

#### Step A-8-1: REMOVE `WsOutboundMessage`

- **파일:** `packages/gateway/src/rpc/types.ts` L93-94
- **제거 대상:**
  ```ts
  /** WebSocket 아웃바운드 메시지 */
  export type WsOutboundMessage = RpcResponse | JsonRpcNotification;
  ```
- **배럴:** 없음.
- **재검증:** `rg "\bWsOutboundMessage\b" packages/*/src --type ts` → 0 expected.

#### Step A-8-2: REMOVE `resetVersionCache`

- **파일:** `packages/gateway/src/version.ts` L28-31
- **제거 대상:**
  ```ts
  /** 테스트용: 캐시 초기화 */
  export function resetVersionCache(): void {
    cached = null;
  }
  ```
- **배럴:** 없음.
- **주의:** JSDoc 이 "테스트용" 이라지만 실제 테스트 0개 → 죽은 테스트 헬퍼.
- **재검증:** `rg "\bresetVersionCache\b" packages/*/src --type ts` → 0 expected.

#### Verification A-8:

```
pnpm format && pnpm lint && pnpm typecheck && pnpm exec tsc --build && pnpm test --run
```

**Commit:** `refactor(phase45): remove dead gateway (2 items)`

---

### A-9 server (12 items, 인터페이스 트림 포함)

#### Step A-9-1: REMOVE `PipelineError` (+ file delete)

- **파일:** `packages/server/src/auto-reply/errors.ts` 전체 (L1-26)
- **제거 대상:** 파일 전체 — PipelineErrorCode type + PipelineError class 둘 다 호출처 0.

  ```ts
  // packages/server/src/auto-reply/errors.ts
  import { FinClawError } from '@finclaw/infra';

  /** 파이프라인 에러 코드 */
  export type PipelineErrorCode = ...;
  ...
  export class PipelineError extends FinClawError {
    ...
  }
  ```

- **배럴:** 없음 (server top-level 가 auto-reply/errors re-export 안 함).
- **재검증:** `rg "\bPipelineError\b" packages/*/src --type ts` → 0 expected.

#### Step A-9-2: REMOVE `CommandStageResult`

- **파일:** `packages/server/src/auto-reply/stages/command.ts` L6-9
- **제거 대상:**
  ```ts
  export interface CommandStageResult {
    readonly handled: boolean;
    readonly commandResult?: CommandResult;
  }
  ```
- **배럴:** 없음.
- **주의:** `commandStage` 함수 반환은 `StageResult<MsgContext>` (별 타입). 본 인터페이스 고아.
- **재검증:** `rg "\bCommandStageResult\b" packages/*/src --type ts` → 0 expected.

#### Step A-9-3: REMOVE `PluginExports`

- **파일:** `packages/server/src/plugins/loader.ts` L24-30 (TODO comment + interface)
- **제거 대상:**
  ```ts
  // TODO(review): PluginExports 인터페이스가 런타임 타입 검증에 사용되지 않음 — 활용처 확보 또는 제거 검토.
  /** 플러그인 모듈 exports (register || activate) */
  export interface PluginExports {
    readonly register?: (api: PluginBuildApi) => void;
    readonly activate?: (api: PluginBuildApi) => void;
    readonly deactivate?: () => Promise<void>;
  }
  ```
- **배럴 동반:** `packages/server/src/plugins/index.ts` L32 — multi-export 줄에서 `PluginExports,` 제거 (`PluginBuildApi`, `LoadResult` 는 보존 검토 — 본 step 범위 외)
- **재검증:** `rg "\bPluginExports\b" packages/*/src --type ts` → 0 expected.

#### Step A-9-4: REMOVE `resetJiti`

- **파일:** `packages/server/src/plugins/loader.ts` L70-74 (TODO comment + function)
- **제거 대상:**
  ```ts
  // TODO(review): resetJiti() — 현재 테스트에서 미사용. 필요 시 테스트 격리에 활용, 불필요 시 제거.
  /** 테스트용 jiti 리셋 */
  export function resetJiti(): void {
    jitiLoader = null;
  }
  ```
- **배럴:** 없음.
- **재검증:** `rg "\bresetJiti\b" packages/*/src --type ts` → 0 expected.

#### Step A-9-5: REMOVE `ProcessLifecycle.shutdown`

- **파일:** `packages/server/src/process/lifecycle.ts` L43-54
- **제거 대상:**
  ```ts
    /** 수동 종료 (테스트 등에서 사용) */
    async shutdown(): Promise<void> {
      this.logger.info('Manual shutdown initiated');
      const reversed = [...this.cleanupFns].toReversed();
      for (const cleanup of reversed) {
        try {
          await cleanup();
        } catch (err) {
          this.logger.error(`Cleanup error: ${String(err)}`);
        }
      }
    }
  ```
- **배럴:** 없음.
- **주의:** graceful shutdown 은 `setupGracefulShutdown` + SIGINT/SIGTERM 경로로 일원화 — 본 메서드는 우회됨. 제거 안전.
- **재검증:** `rg "lifecycle\.shutdown|ProcessLifecycle.*shutdown" packages/*/src --type ts` → 0 expected.

#### Step A-9-6: REMOVE `PluginLoadError`

- **파일:** `packages/server/src/plugins/errors.ts` L5-14
- **제거 대상:**
  ```ts
  /** 플러그인 로딩 실패 */
  export class PluginLoadError extends FinClawError {
    constructor(pluginName: string, phase: string, cause: Error) {
      super(`Plugin '${pluginName}' failed at ${phase}`, 'PLUGIN_LOAD_ERROR', {
        cause,
        details: { pluginName, phase },
      });
      this.name = 'PluginLoadError';
    }
  }
  ```
- **배럴 동반:** `packages/server/src/plugins/index.ts` L2 — multi-export 줄에서 `PluginLoadError,` 제거
- **재검증:** `rg "\bPluginLoadError\b" packages/*/src --type ts` → 0 expected.

#### Step A-9-7: REMOVE `bridgeHooksToEventBus` (+ file delete)

- **파일:** `packages/server/src/plugins/event-bridge.ts` 전체 (L1-48)
- **제거 대상:** 파일 전체.
- **배럴 동반:** `packages/server/src/plugins/index.ts` L34 — `export { bridgeHooksToEventBus } from './event-bridge.js';` 줄 삭제
- **재검증:** `rg "\bbridgeHooksToEventBus\b" packages/*/src --type ts` → 0 expected.

#### Step A-9-8: REMOVE `SpawnError` / `SpawnTimeoutError` / `LaneClearedError` / `QueueFullError` (+ file delete)

- **파일:** `packages/server/src/process/errors.ts` 전체 (L1-38)
- **제거 대상:** 4 클래스 모두 사용 0 → 파일 전체 삭제.
  ```ts
  // SpawnError       L4-10
  // SpawnTimeoutError L12-20
  // LaneClearedError  L22-28
  // QueueFullError    L30-38
  ```
- **배럴 동반:** `packages/server/src/process/index.ts` L4 — `export { SpawnError, SpawnTimeoutError, LaneClearedError, QueueFullError } from './errors.js';` 줄 전체 삭제
- **재검증:** `rg "\b(SpawnError|SpawnTimeoutError|LaneClearedError|QueueFullError)\b" packages/*/src --type ts` → 0 expected.

#### Step A-9-9: REMOVE `InMemoryCommandRegistry.execute` (+ interface trim)

- **파일 1 — 구현:** `packages/server/src/auto-reply/commands/registry.ts` L111-117
- **제거 대상 (구현):**
  ```ts
    async execute(parsed: ParsedCommand, ctx: MsgContext): Promise<CommandResult> {
      const entry = this.get(parsed.name);
      if (!entry) {
        return { content: `알 수 없는 명령어: ${parsed.name}`, ephemeral: true };
      }
      return entry.executor(parsed.args, ctx);
    }
  ```
- **파일 2 — 인터페이스 트림:** `packages/server/src/auto-reply/commands/registry.ts` L41
- **제거 대상 (인터페이스):**
  ```ts
    execute(parsed: ParsedCommand, ctx: MsgContext): Promise<CommandResult>;
  ```
- **주의:** pipeline `commandStage` (`stages/command.ts:48`) 는 `registry.get(name).executor(...)` 로 직접 호출 → wrapper 우회. 인터페이스 + 구현 둘 다 제거 안전.
- **재검증:** `rg "commandRegistry\.execute|registry\.execute" packages/server/src --type ts` → 0 expected (ToolRegistry.execute 호출은 다른 type, 무관).

#### Verification A-9:

```
pnpm format && pnpm lint && pnpm typecheck && pnpm exec tsc --build && pnpm test --run
```

**Commit:** `refactor(phase45): remove dead server (12 items + 1 interface trim)`

---

## M-A 완료 (커밋 `713a699`~`c962e33`, 9 sub-milestones, 39 + 1 interface trim, 파일 삭제 3, 배럴 정리 16+)

---

# 마일스톤 B — T2 죽은 군집 31 items + 보류 2 + ALREADY_REMOVED 1

## 재검증 결과 (M-B 진입 전, M-A 후속 상태)

| 패키지   | 감사 T2 | CONFIRMED_DEAD | LIVE (보류) | ALREADY_REMOVED |
| -------- | ------: | -------------: | ----------: | --------------: |
| types    |       7 |              7 |           0 |               0 |
| infra    |      19 |             17 |           2 |               0 |
| agent    |       3 |              3 |           0 |               0 |
| config   |       3 |              3 |           0 |               0 |
| storage  |       1 |              1 |           0 |               0 |
| server   |       1 |              0 |           0 |               1 |
| **합계** |  **34** |         **31** |       **2** |           **1** |

**재검증 근거:** 워크플로우 `wf_6f1c22a8-52a` — 6 패키지 병렬 grep + island 분석. 전 항목 evidence 첨부.

## 보류 (LIVE_FALSE_POSITIVE — review.md 기록)

| 패키지 | 심볼           | 위치                                  | 라이브 사유                                                                                                                                              |
| ------ | -------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| infra  | `readFileSafe` | `packages/infra/src/fs-safe.ts:42-50` | `packages/infra/src/json-file.ts` 의 `readJsonFile` 안에서 호출, json-file 은 config/storage 가 라이브 소비.                                             |
| infra  | `ensureDir`    | `packages/infra/src/fs-safe.ts:55-57` | `infra/json-file.ts:writeJsonFile` + `config/sessions/store.ts` 가 호출 (단 sessions/store 는 M-B B-3 삭제 대상 → 재평가 필요. json-file 경로는 라이브). |

## ALREADY_REMOVED (M-A 흡수)

| 패키지 | 심볼                | 사유                                          |
| ------ | ------------------- | --------------------------------------------- |
| server | `PipelineErrorCode` | A-9 가 `auto-reply/errors.ts` 파일 전체 삭제. |

---

## 마일스톤 B — 바텀업 패키지별 서브밀스톤 (5 sub-milestones)

**각 서브밀스톤 종료 시 게이트:**

```
pnpm format && pnpm lint && pnpm typecheck && pnpm exec tsc --build && pnpm test --run
```

순서 = types → storage → config → agent → infra. server 는 skip.

---

### B-1 types (7 items, 1 file delete + 1 test file delete)

#### Step B-1-1: REMOVE `ErrorReason` + `FinClawError` interface (island pair)

- **파일:** `packages/types/src/common.ts` L28-46
- **제거 대상:**
  ```ts
  // ─── 에러 타입 ───
  export type ErrorReason = ... ;
  export interface FinClawError {
    reason: ErrorReason;
    ...
  }
  ```
- **주의:** **`@finclaw/types` 의 FinClawError interface 는 `@finclaw/infra` 의 live FinClawError class 와 별개**. 모든 소비처 (agent/config/infra/server) 가 infra 쪽에서 import → types 의 interface 는 island.
- **테스트 동반 제거:** `packages/types/test/type-safety.test.ts`
  - L7-8 import 줄에서 `FinClawError`, `ErrorReason` 토큰 제거
  - L49-51 `FinClawError` 타입 어설션 테스트 제거
  - L54-68 `describe('ErrorReason', ...)` 블록 전체 제거
- **재검증:** `rg "\bErrorReason\b|\bFinClawError\b" packages/types/src` → 0 hits. infra 의 FinClawError class 는 보존.

#### Step B-1-2: REMOVE 5 Ws* event interfaces (Ws*Event island)

- **파일:** `packages/types/src/gateway.ts` L86-120 (5 인터페이스 연속)
- **제거 대상:**
  - `WsMessageEvent` (L86-92)
  - `WsTypingEvent` (L94-99)
  - `WsAgentStatusEvent` (L101-105)
  - `WsAlertEvent` (L107-114)
  - `WsErrorEvent` (L116-120)
- **주의:** M-A A-1 가 `WsEvent` union 제거 → 이제 5 변형 모두 zero-ref.
- **재검증:** `rg "\bWs(Message|Typing|AgentStatus|Alert|Error)Event\b" packages/*/src --type ts` → 0 hits.

#### Step B-1-3: DELETE `types/src/skill.ts` (whole file + barrel + test)

- **파일 삭제:** `packages/types/src/skill.ts` 전체
  - SkillMetadata interface
  - ToolMetadata interface
  - SkillMetadataInput type
  - normalizeSkillMetadata function
- **테스트 파일 삭제:** `packages/types/test/skill-metadata.test.ts` 전체
- **배럴 동반 (2 곳):**
  - `packages/types/src/index.ts` L6 — `export type * from './skill.js';` 줄 삭제
  - `packages/types/src/index.ts` L27-28 — `// 스킬 메타 정규화 (Phase 24)\nexport { normalizeSkillMetadata } from './skill.js';` 줄 삭제
- **주의:** `*_SKILL_METADATA` 객체들이 phase45 M-A A-6/A-7 에서 제거됨 → SkillMetadata 인터페이스 자체가 사용처 없음 → 군집 dead.
- **재검증:** `rg "\bSkillMetadata\b|\bToolMetadata\b|\bnormalizeSkillMetadata\b|\bSkillMetadataInput\b" packages/*/src --type ts` → 0 hits.

#### Verification B-1:

```
pnpm format && pnpm lint && pnpm typecheck && pnpm exec tsc --build && pnpm test --run
```

**Commit:** `refactor(phase45): remove dead types island (7 items, 2 files delete)`

---

### B-2 storage (1 item)

#### Step B-2-1: REMOVE `ChunkRow` interface + `getMemoryChunks` function

- **파일:** `packages/storage/src/tables/memories.ts`
  - L28-35 — ChunkRow interface 정의
  - L215-228 — getMemoryChunks function (ChunkRow 의 유일 소비처, test-only)
- **배럴 동반:** `packages/storage/src/index.ts` L40 — `getMemoryChunks` 토큰 제거
- **테스트 동반 검토:** `packages/storage/src/tables/memories.storage.test.ts` 의 `getMemoryChunks` 4 호출 — assertion 자체 제거 또는 직접 SQL 로 대체.
  - 보수적 접근: assertion 제거 (테스트 함수 호출만 삭제). chunk 생성/삭제 검증 자체가 무의미해지면 해당 테스트 케이스 통째 삭제.
- **재검증:** `rg "\bChunkRow\b|\bgetMemoryChunks\b" packages/*/src --type ts` → 0 hits.

#### Verification B-2:

```
pnpm format && pnpm lint && pnpm typecheck && pnpm exec tsc --build && pnpm test --run
```

**Commit:** `refactor(phase45): remove dead storage island (ChunkRow + getMemoryChunks)`

---

### B-3 config (3 items, sessions sub-system 전체)

#### Step B-3-1: DELETE `config/src/sessions/` 디렉터리 전체

- **파일 삭제 (3 개):**
  - `packages/config/src/sessions/store.ts` (SessionStore interface + createSessionStore — A-4 의 `now` 제거 후 잔존 본체)
  - `packages/config/src/sessions/types.ts` (SessionScope + SessionEntry + mergeSessionEntry)
  - `packages/config/src/sessions/session-key.ts` (deriveSessionKey)
- **테스트 파일 삭제 (2 개):**
  - `packages/config/test/sessions.test.ts`
  - `packages/config/test/sessions-key.test.ts` (또는 파일명 변형 — 실제 디렉터리 확인)
- **배럴 동반:** `packages/config/src/index.ts` — sessions 관련 export 줄 모두 제거 (L7, L46, L47, L48 추정 — 실제 라인 확인 후 정확히)
  - `export { mergeSessionEntry } from './sessions/types.js';`
  - `export { deriveSessionKey } from './sessions/session-key.js';`
  - `export { createSessionStore } from './sessions/store.js';`
  - 관련 type re-export
- **주의:** sessions 서브시스템 전체 dead — agent.run sessionKey 등은 별 path (gateway/server) 에서 처리. `ensureDir` (LIVE) 는 sessions/store.ts 가 호출하지만 sessions/store.ts 자체가 삭제되므로 fs-safe 의 `ensureDir` 호출처는 json-file.ts 만 남음.
- **재검증:** `rg "\bSessionStore\b|\bSessionScope\b|\bSessionEntry\b|\bcreateSessionStore\b|\bmergeSessionEntry\b|\bderiveSessionKey\b" packages/*/src --type ts` → 0 hits.

#### Verification B-3:

```
pnpm format && pnpm lint && pnpm typecheck && pnpm exec tsc --build && pnpm test --run
```

**Commit:** `refactor(phase45): remove dead config sessions subsystem (3 items, 3+2 files delete)`

---

### B-4 agent (3 items, cooldown 서브시스템 전체)

#### Step B-4-1: REMOVE `ToolPropertySchema`

- **파일:** `packages/agent/src/agents/tools/registry.ts` L20-29 (JSDoc + interface)
- **제거 대상:**
  ```ts
  export interface ToolPropertySchema {
    readonly type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    readonly description: string;
    readonly enum?: readonly string[];
    ...
  }
  ```
- **배럴 동반 (2 곳):**
  - `packages/agent/src/agents/tools/index.ts` L6 — multi-export 에서 `ToolPropertySchema,` 토큰 제거
  - `packages/agent/src/index.ts` L80 — multi-export 에서 `ToolPropertySchema,` 토큰 제거
- **주의:** M-A A-5 가 ToolInputSchema 제거 → ToolPropertySchema 의 유일 참조처 사라짐. 이제 zero-ref.
- **재검증:** `rg "\bToolPropertySchema\b" packages/*/src --type ts` → 0 hits.

#### Step B-4-2: DELETE `agent/src/auth/cooldown.ts` (whole file + test)

- **파일 삭제:** `packages/agent/src/auth/cooldown.ts` 전체
  - CooldownEntry interface
  - CooldownTracker class (L13-106)
- **테스트 파일 삭제:** `packages/agent/test/cooldown.test.ts`
- **배럴 동반:** `packages/agent/src/index.ts` L64-66 — CooldownTracker / CooldownEntry / 관련 re-export 줄 제거
- **주의:** 메모리 노트에 "CooldownTracker — gateway/server live 소비" 라고 적혀있으나 워크플로우 재검증에서 zero-ref 확인 (실제 소비처 부재). 메모리 노트 stale.
- **재검증:** `rg "\bCooldownTracker\b|\bCooldownEntry\b" packages/*/src --type ts` → 0 hits.

#### Verification B-4:

```
pnpm format && pnpm lint && pnpm typecheck && pnpm exec tsc --build && pnpm test --run
```

**Commit:** `refactor(phase45): remove dead agent islands (ToolPropertySchema + cooldown subsystem, 1 file delete)`

---

### B-5 infra (17 items, 7 sub-steps — 가장 큰 cascade)

> 패키지 내 다중 컴포넌트 군집. 한 step 한 컴포넌트 단위.

#### Step B-5-1: DELETE `infra/src/paths.ts` (whole file)

- **파일 삭제:** `packages/infra/src/paths.ts` 전체 (`getDataDir`, `getConfigDir`, `getSessionDir`, `getLockDir`, `getConfigFilePath`, `getAllPaths`)
- **테스트 파일 삭제:** `packages/infra/test/paths.test.ts`
- **배럴 동반:** `packages/infra/src/index.ts` L39-43 (paths 5 export 줄) — 모두 제거
- **재검증:** `rg "\bgetDataDir\b|\bgetConfigDir\b|\bgetSessionDir\b|\bgetLockDir\b|\bgetConfigFilePath\b|\bgetAllPaths\b" packages/*/src --type ts` → 0 hits.

#### Step B-5-2: DELETE `infra/src/system-events.ts` (whole file)

- **파일 삭제:** `packages/infra/src/system-events.ts` 전체 (`MAX_EVENTS_PER_SESSION`, `SystemEvent`, `queues`, `clearSystemEvents`, push/get 함수들)
- **테스트 파일 삭제:** 없으면 skip.
- **배럴 동반:** `packages/infra/src/index.ts` 의 system-events 관련 export 줄 모두 제거
- **재검증:** `rg "\bMAX_EVENTS_PER_SESSION\b|\bSystemEvent\b|\bclearSystemEvents\b" packages/*/src --type ts` → 0 hits.

#### Step B-5-3: DELETE `infra/src/warnings.ts` (whole file)

- **파일 삭제:** `packages/infra/src/warnings.ts` 전체 (`emitted` const + 관련 함수)
- **테스트 파일 삭제:** 있으면 동반.
- **배럴 동반:** `packages/infra/src/index.ts` 에 warnings export 있으면 제거.
- **재검증:** 호출 패턴 (`emitted` 는 너무 흔하므로 file 경로로 확인) → `rg "warnings\.js|warnings\.ts" packages/*/src --type ts` → 0 hits.

#### Step B-5-4: REMOVE concurrency-lane methods (4 items)

- **파일:** `packages/infra/src/concurrency-lane.ts`
  - `ConcurrencyLane.resetGeneration` (L115-119)
  - `ConcurrencyLane.clearWaiters` (L121-130)
  - `ConcurrencyLane.dispose` (L132-136)
  - `ConcurrencyLaneManager.dispose` (L175-179)
- **주의:** M-A A-2 가 `ConcurrencyLaneManager.resetGeneration` 제거. 본 step 은 이어지는 island cascade. **테스트 동반 제거 (테스트만 호출처):**
  - `packages/infra/test/concurrency-lane.test.ts` — resetGeneration / clearWaiters / dispose 호출 케이스 제거
- **간접 cascade:** `packages/server/src/process/message-router.ts:159` 가 `laneManager.dispose()` 호출 + `:160` 가 `dedupe.clear()` 호출. message-router.dispose() 도 test-only consumer. **server message-router.dispose 도 같이 제거 검토** (cross-package).
  - 보수적: 본 step 은 infra dispose 제거만, message-router.dispose 는 별 step 또는 phase46.
  - 공격적: message-router.dispose 메서드 자체도 제거 (dead caller chain) → server 변경 동반.
  - **plan 결정:** 공격적 — chain 전체 제거 (message-router.dispose + 관련 test).
- **재검증:** `rg "\bresetGeneration\b|\bclearWaiters\b" packages/*/src --type ts` → 0 hits. `\.dispose\(\)` 는 다른 라이브 호출 가능성 있으니 별 검사.

#### Step B-5-5: REMOVE `CircuitBreaker.reset` method

- **파일:** `packages/infra/src/circuit-breaker.ts` L63-67
- **제거 대상:**
  ```ts
  reset(): void {
    ...
  }
  ```
- **간접 cascade:** `packages/agent/src/providers/adapter.ts:38` `resetBreakers()` 가 호출 → resetBreakers 가 test-only 라 같이 제거 (test fixture).
  - `packages/agent/src/index.ts` 의 `resetBreakers` re-export 제거
  - `packages/agent/test/fallback.test.ts` 의 `resetBreakers()` 호출 4 곳 제거
  - `packages/infra/test/circuit-breaker.test.ts:89` 의 `cb.reset()` 호출 제거
- **재검증:** `rg "\.reset\(\)" packages/*/src --type ts` → CircuitBreaker 외 호출 잔존 확인 (별 클래스). `\bresetBreakers\b` → 0 hits.

#### Step B-5-6: REMOVE `Dedupe.clear` method

- **파일:** `packages/infra/src/dedupe.ts` L71-74
- **제거 대상:**
  ```ts
  clear(): void {
    this.cache.clear();
  }
  ```
- **간접 cascade:** B-5-4 의 message-router.dispose 제거에 포함됨 (`this.dedupe.clear()` 호출). 본 step 은 method 정의만.
- **테스트 동반:** `packages/infra/test/dedupe.test.ts` 의 `dedupe.clear()` 호출 제거.
- **재검증:** `rg "dedupe\.clear|Dedupe\.clear" packages/*/src --type ts` → 0 hits.

#### Step B-5-7: REMOVE `LoggerFactory` interface

- **파일:** `packages/infra/src/logger.ts` L19-22
- **제거 대상:**
  ```ts
  /** ... */
  export interface LoggerFactory {
    create(name?: string): FinClawLogger;
  }
  ```
- **배럴 동반:** `packages/infra/src/index.ts` L53 — `type LoggerFactory,` 토큰 제거
- **주의:** M-A A-2 가 `defaultLoggerFactory` (유일 구현체) 제거. 이제 interface 도 zero-ref.
- **재검증:** `rg "\bLoggerFactory\b" packages/*/src --type ts` → 0 hits.

#### Verification B-5 (전 7 step 후):

```
pnpm format && pnpm lint && pnpm typecheck && pnpm exec tsc --build && pnpm test --run
```

**Commit:** `refactor(phase45): remove dead infra islands (17 items, 3 files delete, cross-package cascade to server)`

> ⚠️ B-5 는 cross-package cascade 가 가장 큼 (server message-router 동반 변경). 분리 권장 시 B-5a/B-5b 별 커밋 가능.

---

## M-B 완료 후 후속

- **M-C T3 테스트만 41개** — 동반 제거 default + KEEP case-by-case, 새 todo 작성. M-B 완료 후 별도 검증 워크플로우 진행. 분량 초과 시 phase46 이월.

## M-B 통계

- 서브밀스톤 5 개 (B-1 ~ B-5)
- step 13 개 (B-1: 3, B-2: 1, B-3: 1, B-4: 2, B-5: 7) = 31 actionable item × cascade
- 보류 2 개 (`readFileSafe` / `ensureDir`, fs-safe.ts 의 라이브 함수)
- ALREADY_REMOVED 1 개 (`PipelineErrorCode`, M-A A-9 흡수)
- 게이트 5 회 (서브밀스톤 종료마다)
- 커밋 5 개
- 파일 삭제 7 개 (types: 2 / config: 3 + 2 test / agent: 1 + 1 test / infra: 3 + 1 test)
- 배럴 정리 10+ 곳
- Cross-package cascade 1 곳 (B-5-4 server message-router.dispose chain)

## 통합 통계 (M-A + M-B)

- 서브밀스톤 14 개
- step 52 개 (M-A 39 + M-B 13)
- 게이트 14 회
- 커밋 14 개
- 파일 삭제 10 개

## 검증 요약 (각 step 의 재검증 명령은 step 안에)

전 step 의 재검증 = `rg "\b<SYMBOL>\b" packages/*/src --type ts` 가 0 hits. 게이트 = format/lint/typecheck/build/test 전부.
