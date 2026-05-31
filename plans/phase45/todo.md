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

## M-A 완료 후 후속 (별도 todo 분해)

- **M-B T2 죽은 군집 34개** — `_workspace/decl-audit/actionable-unused.json` 의 island 군집 식별 후 새 todo 작성.
- **M-C T3 테스트만 41개** — 동반 제거 default + KEEP case-by-case, 새 todo 작성. 분량 초과 시 phase46 이월.

## 통계

- 서브밀스톤 9 개 (A-1 ~ A-9)
- step 39 개 (감사 T1 39 항목과 1:1 매칭) + 인터페이스 트림 1 step (A-9-9 안에 포함)
- 게이트 9 회 (서브밀스톤 종료마다)
- 커밋 9 개
- 파일 삭제 3 개 (errors.ts / event-bridge.ts / process/errors.ts)
- 배럴 정리 16+ 곳

## 검증 요약 (각 step 의 재검증 명령은 step 안에)

전 step 의 재검증 = `rg "\b<SYMBOL>\b" packages/*/src --type ts` 가 0 hits (정의 + 배럴 모두 제거 후). 게이트 = format/lint/typecheck/build/test 전부.
