# Phase 36 Todo: main() composition root 모듈화 (옵션 A — 순수 구조 리팩토링)

> plan.md 의 밀스톤 A/B/C 를 코드 단위로 분해. **순수 이동만 — 로직/순서/로그/API 한 줄도 바꾸지 않는다.** `main()` 의 wiring 블록을 `packages/server/src/composition/*.ts` 빌더로 추출하고 `main()` 이 **같은 순서·같은 인자·같은 반환 객체**로 호출. 패키지 추출(옵션 B/C)은 비대상.

---

## ⚠️ 이 phase 전체에 걸친 절대 규칙 (모든 단계에 적용)

implementer 는 매 단계에서 다음을 지킨다. 위반은 곧 동작 변경 = phase 실패.

1. **순수 이동**: 블록을 빌더로 옮길 때 코드 본문(변수명·로그 메시지·조건식·주석)을 **글자 그대로** 유지. 변경은 단 둘 — (a) 외부에서 오는 값을 함수 인자로 받기, (b) 다음 블록이 쓰는 값을 반환하기. 그 외 0.
2. **호출 순서·side-effect 순서 절대 보존**. 원래 `main()` 의 실행 순서:
   `storage.initialize()` (232) → `discordAdapter.setup()` (270) → `registerGeneralTools` (355) → `registerMarketTools/News/Alert` (377/400/428) → `registerBrokerageTools`+news-brief seed (484/501) → `addPolicyRule` (526) → `loadPlugins` (535) → (exec/pipeline 구성) → `new SchedulerService` (723) → gateway 생성 (759) → purge timer (822) → hotReload (846) → `deliveryHook` 대입 (864) → `lifecycle.init()` (875) → `gateway.start()` (876) → `scheduler.start()` (877) → `emit('system:ready')` (880).
   빌더 추출 후에도 이 순서가 **1:1 유지**되어야 한다.
3. **모든 `lifecycle.register(...)` 등록 시점 동일**. 원래 등록 순서(이게 cleanup 역순 실행 순서를 결정):
   ① storage.close (233) · ② discord cleanup (271) · ③ alert monitor.stop (437) · ④ mcp shutdown (542) · ⑤ scheduler.stop (757) · ⑥ purge clearInterval (839) · ⑦ gateway.stop (843) · ⑧ hotReloader.stop (858).
   빌더가 `lifecycle` 를 인자로 받아 **블록 내부의 원래 자리에서** register 한다 (cleanup 을 반환해 main 이 나중에 등록하는 식으로 순서를 바꾸지 말 것 — ③④⑤ 는 빌더 내부 등록이 자연스럽고 순서도 보존됨).
4. **기능·API·로그 메시지 변경 금지**. 신규 테스트 불요.
5. **`main.test.ts` 는 `main()` 을 직접 호출하지 않는다** — `requireEnv`/`MissingEnvError` (export 유지 필수) 와 `createGatewayServer` 직접 호출만 검증. 따라서 이 phase 의 회귀 안전망은 **`pnpm typecheck` + `pnpm build`(테스트가 dist 해석) + `pnpm test --run` green 유지** 다. `main.test.ts` 가 빌더를 커버한다고 기대하지 말 것. (단, `requireEnv`/`MissingEnvError`/기존 named export 의 시그니처·위치를 깨면 이 테스트가 깨지므로 손대지 말 것.)
6. **main() 잔존 블록** (plan §의도적비대상): env/prompt(177-191), foundation 일부, embedding(237-259), discord(264-272)의 생성/주입, MessageRouter(655-668), gatewayConfig(671-678)+port assert(679-688), gateway 생성(759-816), purge timer(818-843), hotReload(845-861), deliveryHook 대입(863-873), `lifecycle.init`/`gateway.start`/`scheduler.start`/emit(875-880). **추출 금지.**

### 공유 자원 주입 원칙 (밀스톤 경계 의존 해소)

여러 블록이 함께 쓰는 자원은 `main()` 에서 생성해 빌더에 **주입**한다. 빌더가 자원을 새로 만들지 않는다(중복 생성 = 동작 변경).

- `logger`, `lifecycle`, `finclawConfig`, `storage`, `embeddingProvider`, `discordAdapter`, `anthropicKey`, `DEFAULT_SYSTEM_PROMPT` → foundation/env 단계에서 main() 이 생성, 모든 빌더에 주입.

> **타입 표기 확정 (build 통과 형태, 추측 아님 — 코드 실측):**
>
> - logger 인자 타입 = **`FinClawLogger`** (`import type { FinClawLogger } from '@finclaw/infra'`). 선례: `packages/server/src/automation/scheduler.ts:56` 이 `readonly logger: FinClawLogger`. 아래 모든 빌더 골격의 `Logger` 를 `FinClawLogger` 로 읽을 것 (`@finclaw/infra` 는 `Logger` 라는 이름을 export 하지 않음).
> - `ProviderAdapter` = `@finclaw/agent` named export (확인됨) → `import type { ProviderAdapter } from '@finclaw/agent'` 그대로 사용 가능.
> - `Reranker` = `@finclaw/storage` named export (확인됨) → wireMemoryServices 의 inline `import('@finclaw/storage').Reranker` 와 동일.
> - storage 인자 타입 = `ReturnType<typeof createStorage>` (main 이 구체 타입 미명시, `.db` 접근 안전).
> - `routerLlm`/`providerAdapter` 등 factory 산출은 named type 우선, 없으면 `ReturnType<typeof ...>`.

- `modelCatalog` / `modelAliasIndex` / `profileHealth` → main() 4a(357-361)에서 생성, B(skills)·C(runtime) 양쪽이 주입받음.
- `toolRegistry` / `lanes` / `routerLlm` / `sdkAdapter` / `providerAdapter` → 밀스톤 A 의 `buildProviders` 반환 → main() 이 받아 B·C 에 주입.
- `scheduleRpc` → 밀스톤 A 의 `buildScheduleRpc` 반환 → main() 이 `registerGeneralTools` 호출에 사용(또는 B 로 넘김 — B 단계에서 결정).

---

## 사전 준비

### P-1. `src/composition/` 디렉터리 신설 — tsconfig 변경 불요 확인

`packages/server/tsconfig.json` 은 `"include": ["src"]` 이므로 `src/composition/` 하위는 **자동 포함**된다. tsconfig references / include 수정 **불필요**. 새 패키지가 아니므로 루트 `tsconfig.json` 도 손대지 않는다.

빈 디렉터리는 git 에 안 잡히므로 별도 작업 없음 — A1 에서 첫 파일 생성 시 디렉터리가 만들어진다.

검증: 없음 (다음 단계에서 함께 확인)

---

## 밀스톤 A — scaffold + 저위험 leaf 추출 (`buildScheduleRpc`, `buildProviders`, 상수)

> plan A: `composition/` 신설 + 가장 자기완결적인 블록 추출. `buildScheduleRpc(storage)` (storage 만 의존), `buildProviders({finclawConfig, anthropicKey})`. `defaultConfig`/`DEFAULT_MODEL` 상수는 `composition/constants.ts` 로(선택, 권장). main() 에서 호출로 대체.

### A1. CREATE `packages/server/src/composition/constants.ts` — 공유 상수 추출

main.ts 의 `defaultConfig` (97-120) 와 `DEFAULT_MODEL` (122-127) 을 그대로 이동. **값 한 글자도 바꾸지 말 것** (`process.env.GATEWAY_JWT_SECRET ?? 'dev-secret'` 포함).

```ts
// packages/server/src/composition/constants.ts
// Phase 36: main.ts 에서 추출한 공유 상수 (순수 이동, 값 불변).

import type { ModelRef } from '@finclaw/types';
import type { GatewayServerConfig } from '../gateway/rpc/types.js';

/** 기본 게이트웨이 설정 */
export const defaultConfig: GatewayServerConfig = {
  host: '0.0.0.0',
  port: 3000,
  cors: {
    origins: ['*'],
    maxAge: 600,
  },
  auth: {
    apiKeys: [],
    jwtSecret: process.env.GATEWAY_JWT_SECRET ?? 'dev-secret',
    sessionTtlMs: 30 * 60_000,
  },
  ws: {
    heartbeatIntervalMs: 30_000,
    heartbeatTimeoutMs: 10_000,
    maxPayloadBytes: 1024 * 1024,
    handshakeTimeoutMs: 10_000,
    maxConnections: 100,
  },
  rpc: {
    maxBatchSize: 10,
    timeoutMs: 60_000,
  },
};

export const DEFAULT_MODEL: ModelRef = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
};
```

⚠️ `defaultConfig.host`/`defaultConfig.port` 는 main() 의 GATEWAY_PORT 검증(188-191)·gatewayConfig spread(672-673)에서, `DEFAULT_MODEL` 은 main() 전역에서 광범위하게 쓰인다 → A6 에서 import 로 치환.

검증: `pnpm --filter @finclaw/server build`

### A2. CREATE `packages/server/src/composition/schedule-rpc.ts` — `buildScheduleRpc(storage)`

main.ts 305-353 의 `scheduleRpc` 객체를 그대로 이동. storage 만 의존하는 가장 안전한 leaf. **본문 로직·deliveryChannel `'web'`·deliveryTarget `'broadcast'` 등 그대로.**

```ts
// packages/server/src/composition/schedule-rpc.ts
// Phase 36: main.ts 305-353 에서 추출 (순수 이동). Phase 31 F 의 agent ScheduleRpc.

import { addSchedule, deleteSchedule, listSchedules, type createStorage } from '@finclaw/storage';
import type { ScheduleRpc, Timestamp } from '@finclaw/types';
import { createAgentId } from '@finclaw/types';
import { CronParseError, nextRunAt as computeNextRunAt, parseCron } from '../automation/cron.js';

type Storage = ReturnType<typeof createStorage>;

/**
 * Phase 31 F: agent 가 호출할 ScheduleRpc — gateway schedule.* 핸들러와 동일 로직을 wrap.
 * 핸들러가 inline RpcMethodHandler 라 export 되지 않으므로 storage + cron 유틸을 직접 호출.
 * agent 발화는 web/broadcast 채널로 송출 (deliveryTarget 미지정 시 기본값).
 */
export function buildScheduleRpc(storage: Storage): ScheduleRpc {
  return {
    async create(req) {
      const cron = parseCron(req.cron);
      const next = computeNextRunAt(cron, Date.now());
      const created = addSchedule(storage.db, {
        name: req.name,
        cron: req.cron,
        agentId: createAgentId('default'),
        prompt: req.prompt,
        deliveryChannel: 'web',
        deliveryTarget: 'broadcast',
        enabled: req.enabled,
        nextRunAt: next === null ? undefined : (next as Timestamp),
      });
      return { id: created.id, nextRunAt: created.nextRunAt ?? null };
    },
    async list(req) {
      const items = listSchedules(storage.db, { limit: req.limit });
      return {
        schedules: items.map((s) => ({
          id: s.id,
          name: s.name,
          cron: s.cron,
          enabled: s.enabled,
          status: s.status,
          consecutiveFailures: s.consecutiveFailures,
          nextRunAt: s.nextRunAt,
        })),
      };
    },
    async delete(req) {
      deleteSchedule(storage.db, req.scheduleId);
    },
    async testCron(req) {
      try {
        const cron = parseCron(req.cron);
        const next = computeNextRunAt(cron, Date.now());
        return { valid: true, nextRunAt: next === null ? undefined : next };
      } catch (err) {
        if (err instanceof CronParseError) {
          return { valid: false, reason: err.message };
        }
        throw err;
      }
    },
  };
}
```

> ⚠️ storage 타입: main.ts 는 `storage` 의 구체 타입을 명시하지 않고 `createStorage` 반환을 그대로 쓴다. 위처럼 `ReturnType<typeof createStorage>` 로 받으면 `.db` 접근이 타입 안전. `@finclaw/storage` 가 `Storage` 류 타입을 export 하면 그것을 import 해도 됨 — implementer 가 build 통과하는 형태로 선택 (둘 다 순수 이동, 동작 동일). **B/C 빌더의 storage 인자도 같은 타입 표기를 재사용.**

검증: `pnpm --filter @finclaw/server build`

### A3. CREATE `packages/server/src/composition/providers.ts` — `buildProviders(deps)`

main.ts 274-303 의 provider 레이어 블록 이동. `sdkAdapter`/`routerLlm`/`providerAdapter`/`lanes`/`toolRegistry` 5개 생성 + `provider.initialized` 로그. **CLI 모드 분기·`?? 'anthropic-sdk'` 기본값·로그 조건식 그대로.**

```ts
// packages/server/src/composition/providers.ts
// Phase 36: main.ts 274-303 에서 추출 (순수 이동).

import {
  AnthropicAdapter,
  ConcurrencyLaneManager,
  createLlmRouter,
  createProviderAdapter,
  DEFAULT_CLAUDE_BACKEND,
  InMemoryToolRegistry,
} from '@finclaw/agent';
import type { FinClawLogger } from '@finclaw/infra';
import type { FinClawConfig } from '@finclaw/types';

export interface BuildProvidersDeps {
  readonly finclawConfig: FinClawConfig;
  readonly anthropicKey: string;
  readonly logger: FinClawLogger;
}

export interface ProvidersBundle {
  readonly sdkAdapter: AnthropicAdapter;
  readonly routerLlm: ReturnType<typeof createLlmRouter>;
  readonly providerAdapter: ReturnType<typeof createProviderAdapter>;
  readonly lanes: ConcurrencyLaneManager;
  readonly toolRegistry: InMemoryToolRegistry;
}

export function buildProviders({
  finclawConfig,
  anthropicKey,
  logger,
}: BuildProvidersDeps): ProvidersBundle {
  // Phase 32 F: dual-path provider — config.provider 로 SDK / claude-cli 전환 (기본 SDK).
  const sdkAdapter = new AnthropicAdapter(anthropicKey);
  // Phase 34: LLM 오케스트레이터 라우터 — SDK Haiku 고정 (B-0). CLI 모드여도 SDK.
  // 선례: summarizer 도 항상 sdkAdapter (Phase 32 F).
  const routerLlm = createLlmRouter(sdkAdapter);
  const providerAdapter = createProviderAdapter({
    kind: finclawConfig.provider ?? 'anthropic-sdk',
    apiKey: anthropicKey,
    cliBackend: finclawConfig.cliBackend
      ? {
          ...DEFAULT_CLAUDE_BACKEND,
          command: finclawConfig.cliBackend.command ?? 'claude',
          reliability: finclawConfig.cliBackend.watchdog
            ? { watchdog: finclawConfig.cliBackend.watchdog }
            : undefined,
        }
      : undefined,
    defaultTimeoutMs: finclawConfig.cliBackend?.timeoutMs ?? 60_000,
    sdkFallback: sdkAdapter, // W2: CLI auth 만료 시 SDK 위임 (CLI 모드일 때만 쓰임)
  });
  logger.info('provider.initialized', {
    event: 'provider.initialized',
    providerKind: finclawConfig.provider ?? 'anthropic-sdk',
    ...(finclawConfig.provider === 'claude-cli'
      ? { note: 'CLI mode: streaming/caching/tool_use disabled' }
      : {}),
  });
  const lanes = new ConcurrencyLaneManager();
  const toolRegistry = new InMemoryToolRegistry();

  return { sdkAdapter, routerLlm, providerAdapter, lanes, toolRegistry };
}
```

> ⚠️ `Logger` 타입: main 은 `createLogger` 반환을 쓴다. `@finclaw/infra` 가 `Logger` 를 export 하지 않으면 `ReturnType<typeof createLogger>` 로 받을 것. build 통과 형태로 선택. **B/C 의 logger 인자도 동일 표기 재사용.**
> ⚠️ `routerLlm`/`providerAdapter` 의 반환 타입은 `ReturnType<typeof ...>` 로 안전하게. agent 패키지가 named 타입을 export 하면 그걸 써도 무방.

검증: `pnpm --filter @finclaw/server build`

### A4. EDIT `packages/server/src/main.ts` — 상수 2개 + scheduleRpc 블록 + providers 블록 삭제, import 추가

세 군데를 빌더 호출로 치환. **순서 불변**: providers(274-303) → scheduleRpc(305-353) → `registerGeneralTools`(355) 의 상대 순서 그대로.

(1) 상단 import 영역에 composition import 추가 (기존 `./services/news-memorizer.js` import 다음 줄 권장):

```ts
// ... 기존 마지막 import 들 ...
import { NewsMemorizer } from './services/news-memorizer.js';
// Phase 36: composition 빌더
import { DEFAULT_MODEL, defaultConfig } from './composition/constants.js';
import { buildProviders } from './composition/providers.js';
import { buildScheduleRpc } from './composition/schedule-rpc.js';
```

(2) **삭제**: `const defaultConfig: GatewayServerConfig = {...}` (97-120) 전체.
(3) **삭제**: `const DEFAULT_MODEL: ModelRef = {...}` (122-127) 전체.
→ 이 두 삭제로 `ModelRef` import (63-71 type block)·`GatewayServerConfig` import (86) 가 main 에서 계속 쓰이는지 확인. `GatewayServerConfig` 는 671 gatewayConfig 에서, `ModelRef` 는 더 이상 main 에서 직접 타입 주석에 안 쓰일 수 있음 → **미사용 import 가 되면 제거** (CLAUDE.md §3: 자기 변경이 만든 고아 import 정리). build/lint 가 잡아줌.

(4) **삭제**: providers 블록 (274-303, `const sdkAdapter` ~ `const toolRegistry`). **치환**:

```ts
// 4. Agent 레이어 (툴 레지스트리 + 러너 팩토리)
const { sdkAdapter, routerLlm, providerAdapter, lanes, toolRegistry } = buildProviders({
  finclawConfig,
  anthropicKey,
  logger,
});
```

(5) **삭제**: scheduleRpc 블록 (305-353, `const scheduleRpc: ScheduleRpc = {...}`). **치환**:

```ts
const scheduleRpc = buildScheduleRpc(storage);

registerGeneralTools(toolRegistry, { scheduleRpc });
```

> ⚠️ **`registerGeneralTools(toolRegistry, { scheduleRpc })` (355) 는 main() 에 그대로 잔존** — side-effect 호출이고 시점 보존 필요. A 단계에서는 B 로 안 옮긴다. (B 단계에서 skills 묶음으로 흡수할지 결정.)
> ⚠️ provider 생성이 toolRegistry 를 만들고, scheduleRpc 가 그 뒤, registerGeneralTools 가 그 뒤 — **이 3-순서 절대 보존**. 위 치환은 순서를 유지함.

(6) main.ts 상단의 이제-미사용 import 정리: `AnthropicAdapter`, `createLlmRouter`, `createProviderAdapter`, `DEFAULT_CLAUDE_BACKEND`, `ConcurrencyLaneManager`, `InMemoryToolRegistry` (agent), `addSchedule`/`deleteSchedule`/`listSchedules` 중 main 의 다른 곳(KIS seed 501-514 가 `addSchedule`·`getSchedule` 사용!)에서 **여전히 쓰는 것은 남긴다**. cron import (`CronParseError`/`computeNextRunAt`/`parseCron`) 도 KIS seed(503) 가 `parseCron`/`computeNextRunAt` 사용 → 남김. **build + lint 로 정확히 판별** — 추측으로 지우지 말 것.

검증: `pnpm --filter @finclaw/server build && pnpm typecheck`

### A5. 밀스톤 A 검증

순수 이동 확인 + 회귀 없음. 다음을 모두 통과해야 B 로 진입:

- `pnpm typecheck`
- `pnpm build` (project references — server dist 갱신, 테스트가 dist 해석)
- `pnpm test --run`
- `pnpm test:storage`
- (git diff 자체 점검) providers/scheduleRpc/상수 블록이 **글자 그대로** composition 으로 이동했는지, main 의 호출 순서가 보존됐는지 육안 확인.

→ **여기서 1 커밋** (예: `refactor(phase36): extract buildProviders/buildScheduleRpc/constants from main()`). 부분 머지 허용 지점.

---

## 밀스톤 B — skills/tools composition (`registerSkills`)

> plan B: `composition/skills.ts` 의 `registerSkills(deps)` 가 general/market/news/alert/brokerage 등록 + mcp policy + plugins (355,363-559) 를 흡수, `{marketHandle, newsHandle, alertHandle, brokerageSyncService}` 반환. **조건부 등록·`lifecycle.register`·로깅 그대로 보존.** 이번 phase 최대 난점(조건 분기 + side-effect 다수).

### B 설계 노트 (implementer 필독 — 순서 민감 최상)

`registerSkills` 가 흡수하는 원본 라인 범위와 그 안의 side-effect:

| 원본 라인 | 내용                                                                                                  | side-effect                           |
| --------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 355       | `registerGeneralTools(toolRegistry, { scheduleRpc })`                                                 | toolRegistry 등록                     |
| 363-371   | key rotator 생성 (finnhub/twelveData/alphaVantage/coinGecko/newsdata)                                 | -                                     |
| 376-394   | `registerMarketTools` (조건부) + 로그                                                                 | toolRegistry 등록                     |
| 399-423   | `registerNewsTools` (조건부, marketHandle 의존) + 로그                                                | toolRegistry 등록                     |
| 426-443   | `registerAlertTools` (조건부) + `lifecycle.register(monitor.stop)` (437) + 로그                       | toolRegistry 등록 **+ lifecycle ③**   |
| 447-523   | KIS: creds + `resolveDefaultPortfolioId` + `registerBrokerageTools` + news-brief seed (CLI 분기 포함) | toolRegistry 등록, storage 쓰기(seed) |
| 526-531   | `toolRegistry.addPolicyRule({mcp:*})`                                                                 | toolRegistry 정책                     |
| 533-546   | `loadPlugins` + 로그 + `lifecycle.register(mcp shutdown)` (542)                                       | plugin 로드 **+ lifecycle ④**         |
| 548-559   | CLI 모드 tool_use 비활성 경고                                                                         | 로그                                  |

**핵심 제약:**

- 이 블록 전체는 원본에서 **연속**이며(355,363-559 — 357-361 의 catalog/profileHealth 만 중간에 끼어 있음), `main()` 에서 **discord setup(270) 이후, exec adapter(576) 이전** 에 실행된다. 추출 후에도 그 위치(같은 호출 1줄)로 보존.
- **`registerGeneralTools` (355) 포함 여부**: plan B 가 "general/market/news/alert/brokerage 등록 ... 흡수" 라 명시 → `registerGeneralTools` 도 `registerSkills` 안으로 흡수. 단 그러려면 `scheduleRpc` 를 deps 로 받아야 함. A5 에서 main 이 `const scheduleRpc = buildScheduleRpc(storage)` 까지만 만들고, `registerGeneralTools` 호출을 B 에서 `registerSkills` 내부 첫 줄로 이동. **순서: registerGeneralTools 가 market/news/alert 보다 먼저** (원본 355 < 376) — 보존.
- **catalog/profileHealth/modelCatalog (357-361)**: news 등록(411-413)이 `profileHealth`/`modelCatalog` 를 주입받음. 이들은 **main() 에서 생성해 `registerSkills` 에 주입** (공유 자원 — C 도 씀). 즉 main() 의 357-361 은 **그대로 잔존**하고 registerSkills 호출보다 **앞서** 실행되도록 배치.
- **`resolveDefaultPortfolioId` (453-465)**: KIS 블록 내부에서만 쓰이는 지역 함수 → `registerSkills` 내부 지역 함수로 그대로 이동.
- **반환**: `{ marketHandle, newsHandle, alertHandle, brokerageSyncService }`. (KIS env 값 `kisEnv` 도 gateway `brokerageDeps.env`(802) 에서 쓰임 → **반환에 `kisEnv` 추가** 하거나, main 에서 `process.env.KIS_ENV` 를 재독. 원본은 변수 1회 평가 → **반환에 포함하는 게 순수**. 아래 B1 시그니처에 포함.)

### B1. CREATE `packages/server/src/composition/skills.ts` — `registerSkills(deps)`

```ts
// packages/server/src/composition/skills.ts
// Phase 36: main.ts 355 + 363-559 에서 추출 (순수 이동). 조건부 등록·lifecycle.register·로깅 보존.

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryModelCatalog,
  NEWS_BRIEF_PROMPT,
  NEWS_BRIEF_SCHEDULE_ID,
  ProfileHealthMonitor,
} from '@finclaw/agent';
import type { DiscordAdapter } from '@finclaw/channel-discord';
import type { FinClawLogger } from '@finclaw/infra';
import {
  KeyRotator,
  KisClient,
  KisTokenManager,
  readKeyArray,
  registerAlertTools,
  registerBrokerageTools,
  registerMarketTools,
  registerNewsTools,
  type AlertSkillHandle,
  type MarketSkillHandle,
  type NewsSkillHandle,
} from '@finclaw/skills-finance';
import { registerGeneralTools } from '@finclaw/skills-general';
import { addSchedule, getSchedule, type createStorage } from '@finclaw/storage';
import type { FinClawConfig, ModelRef, ScheduleRpc, Timestamp } from '@finclaw/types';
import { createAgentId } from '@finclaw/types';
import { InMemoryToolRegistry } from '@finclaw/agent';
import { nextRunAt as computeNextRunAt, parseCron } from '../automation/cron.js';
import { BrokerageSyncService } from '../services/brokerage-sync-service.js';
import type { makeRouterHelper } from '../auto-reply/router-helper.js';

type Storage = ReturnType<typeof createStorage>;
type RouterHelper = ReturnType<typeof makeRouterHelper> | undefined;

export interface RegisterSkillsDeps {
  readonly toolRegistry: InMemoryToolRegistry;
  readonly storage: Storage;
  readonly logger: FinClawLogger;
  readonly finclawConfig: FinClawConfig;
  readonly anthropicKey: string;
  readonly discordAdapter: DiscordAdapter;
  readonly routerHelper: RouterHelper;
  readonly profileHealth: ProfileHealthMonitor;
  readonly modelCatalog: InMemoryModelCatalog;
  readonly defaultModel: ModelRef;
  readonly scheduleRpc: ScheduleRpc;
  readonly lifecycle: { register(fn: () => void | Promise<void>): void };
}

export interface SkillsBundle {
  readonly marketHandle: MarketSkillHandle | undefined;
  readonly newsHandle: NewsSkillHandle | undefined;
  readonly alertHandle: AlertSkillHandle | undefined;
  readonly brokerageSyncService: BrokerageSyncService | undefined;
  readonly kisEnv: 'prod' | 'vts';
}

export async function registerSkills(deps: RegisterSkillsDeps): Promise<SkillsBundle> {
  const {
    toolRegistry,
    storage,
    logger,
    finclawConfig,
    anthropicKey,
    discordAdapter,
    routerHelper,
    profileHealth,
    modelCatalog,
    defaultModel,
    scheduleRpc,
    lifecycle,
  } = deps;

  // [원본 355] general tools (scheduleRpc 주입)
  registerGeneralTools(toolRegistry, { scheduleRpc });

  // [원본 363-371] key rotators
  const finnhubKeys = readKeyArray('FINNHUB_KEY');
  const twelveDataKeys = readKeyArray('TWELVE_DATA_KEY');
  const alphaVantageKeys = readKeyArray('ALPHA_VANTAGE_KEY');
  const coinGeckoKey = process.env.COINGECKO_API_KEY;
  const finnhubRotator = finnhubKeys.length > 0 ? new KeyRotator(finnhubKeys) : undefined;
  const twelveDataRotator = twelveDataKeys.length > 0 ? new KeyRotator(twelveDataKeys) : undefined;
  const alphaVantageRotator =
    alphaVantageKeys.length > 0 ? new KeyRotator(alphaVantageKeys) : undefined;

  // [원본 373-394] market
  let marketHandle: MarketSkillHandle | undefined;
  let newsHandle: NewsSkillHandle | undefined;
  if (finnhubRotator || twelveDataRotator || alphaVantageRotator || coinGeckoKey) {
    marketHandle = await registerMarketTools(toolRegistry, {
      db: storage.db,
      finnhubRotator,
      twelveDataRotator,
      alphaVantageRotator,
      coinGeckoKey,
    });
    logger.info('Market tools registered', {
      providers: [
        finnhubRotator && 'finnhub',
        twelveDataRotator && 'twelve-data',
        alphaVantageRotator && 'alpha-vantage',
        coinGeckoKey && 'coingecko',
      ].filter(Boolean),
    });
  } else {
    logger.info('No market keys set — skipping market tools');
  }

  // [원본 396-423] news
  const newsdataKeys = readKeyArray('NEWSDATA_API_KEY');
  const newsdataRotator = newsdataKeys.length > 0 ? new KeyRotator(newsdataKeys) : undefined;
  if (marketHandle && (alphaVantageRotator || newsdataRotator || finnhubRotator)) {
    newsHandle = await registerNewsTools(toolRegistry, {
      db: storage.db,
      alphaVantageKey: alphaVantageKeys[0],
      newsdataRotator,
      finnhubRotator,
      quoteService: marketHandle.quoteService,
      anthropicApiKey: anthropicKey,
      router: routerHelper,
      defaultModel,
      profileHealth,
      profileId: 'default',
      modelCatalog,
    });
    logger.info('News tools registered', {
      providers: [
        alphaVantageRotator && 'alpha-vantage',
        newsdataRotator && 'newsdata',
        finnhubRotator && 'finnhub-news',
      ].filter(Boolean),
    });
  } else if (marketHandle) {
    logger.info('No news keys set — skipping news tools');
  }

  // [원본 425-443] alert (+ lifecycle.register ③)
  let alertHandle: AlertSkillHandle | undefined;
  if (marketHandle && newsHandle) {
    const discordClient = discordAdapter.getClient();
    alertHandle = await registerAlertTools(toolRegistry, {
      db: storage.db,
      cache: marketHandle.cache,
      registry: marketHandle.providers,
      newsAggregator: newsHandle.aggregator,
      logger,
      discordClient: discordClient ?? undefined,
    });
    const handle = alertHandle;
    lifecycle.register(async () => {
      handle.monitor.stop();
    });
    logger.info('Alert monitor started');
  } else {
    logger.info('market/news tools unavailable — skipping alerts');
  }

  // [원본 445-523] KIS read-only 잔고 동기화 + news-brief seed
  const kisAppKey = process.env.KIS_APP_KEY;
  const kisAppSecret = process.env.KIS_APP_SECRET;
  const kisAccountNo = process.env.KIS_ACCOUNT_NO;
  const kisAccountProductCode = process.env.KIS_ACCOUNT_PRODUCT_CODE ?? '01';
  const kisEnv = (process.env.KIS_ENV ?? 'prod') as 'prod' | 'vts';

  /** 1인 사용자 기본 portfolio 보장 — 없으면 'default' 생성. */
  const resolveDefaultPortfolioId = (): string => {
    const existing = storage.db
      .prepare('SELECT id FROM portfolios ORDER BY updated_at ASC LIMIT 1')
      .get() as { id: string } | undefined;
    if (existing) {
      return existing.id;
    }
    storage.db
      .prepare(`INSERT INTO portfolios (id, name, currency, updated_at) VALUES (?, ?, ?, ?)`)
      .run('default', 'Default', 'USD', Date.now());
    return 'default';
  };

  let brokerageSyncService: BrokerageSyncService | undefined;
  if (kisAppKey && kisAppSecret && kisAccountNo) {
    const creds = {
      env: kisEnv,
      appKey: kisAppKey,
      appSecret: kisAppSecret,
      accountNo: kisAccountNo,
      accountProductCode: kisAccountProductCode,
    };
    const kisClient = new KisClient(creds, new KisTokenManager(creds));
    brokerageSyncService = new BrokerageSyncService({
      db: storage.db,
      client: kisClient,
      logger,
      resolvePortfolioId: resolveDefaultPortfolioId,
    });
    const syncService = brokerageSyncService;
    registerBrokerageTools(toolRegistry, {
      syncHoldings: async () => {
        const r = await syncService.run();
        return { holdingsCount: r.holdingsCount, marketsScanned: r.marketsScanned };
      },
    });
    logger.info('Brokerage (KIS) tools registered', { env: kisEnv });

    const isCliMode = (finclawConfig.provider ?? 'anthropic-sdk') === 'claude-cli';
    if (isCliMode) {
      logger.warn('news_brief.seed_skipped_cli', {
        event: 'news_brief.seed_skipped_cli',
        note: 'CLI mode disables tool_use; news-brief cron needs SDK mode. Schedule not seeded.',
      });
    } else if (getSchedule(storage.db, NEWS_BRIEF_SCHEDULE_ID) === null) {
      const briefCron = '0 0 * * *'; // 매일 00:00 UTC = 09:00 KST
      const briefNext = computeNextRunAt(parseCron(briefCron), Date.now());
      addSchedule(storage.db, {
        id: NEWS_BRIEF_SCHEDULE_ID,
        name: 'Daily holdings news brief',
        cron: briefCron,
        agentId: createAgentId('default'),
        prompt: NEWS_BRIEF_PROMPT,
        deliveryChannel: 'web',
        deliveryTarget: 'broadcast',
        enabled: true,
        nextRunAt: briefNext === null ? undefined : (briefNext as Timestamp),
      });
      logger.info('Seeded news-brief-daily schedule', {
        event: 'schedule.seeded',
        id: NEWS_BRIEF_SCHEDULE_ID,
        cron: briefCron,
      });
    }
  } else {
    logger.info('KIS not configured — skipping brokerage tools');
  }

  // [원본 525-531] MCP 정책
  toolRegistry.addPolicyRule({
    pattern: 'mcp:*',
    verdict: 'require-approval',
    reason: 'MCP external tools require explicit approval',
    priority: 100,
  });

  // [원본 533-546] plugin loader (+ lifecycle.register ④)
  const pluginsDir = process.env.FINCLAW_PLUGINS_DIR ?? join(homedir(), '.finclaw', 'plugins');
  const pluginResult = await loadPlugins([pluginsDir], [pluginsDir], toolRegistry);
  logger.info('Plugins loaded', {
    event: 'plugins.loaded',
    loaded: pluginResult.loaded,
    failed: pluginResult.failed,
    mcpServers: pluginResult.mcpHandles.length,
  });
  lifecycle.register(async () => {
    for (const h of pluginResult.mcpHandles) {
      await h.shutdown();
    }
  });

  // [원본 548-559] CLI 모드 tool_use 비활성 경고
  if (finclawConfig.provider === 'claude-cli') {
    const toolCount = toolRegistry.list().length;
    if (toolCount > 0) {
      logger.warn('provider.cli_tools_disabled', {
        event: 'provider.cli_tools_disabled',
        toolCount,
        note: 'CLI mode bypasses tool_use; registered tools are inactive. Use provider=anthropic-sdk for live data.',
      });
    }
  }

  return { marketHandle, newsHandle, alertHandle, brokerageSyncService, kisEnv };
}
```

> ⚠️ `loadPlugins` import 누락 주의 — 위 골격에 `import { loadPlugins } from '../plugins/loader.js';` 추가 필요 (작성 시 빠뜨리지 말 것). implementer 는 import 목록을 본문 사용 심볼과 대조해 build green 까지 맞춘다.
> ⚠️ `lifecycle` 인자 타입은 `ProcessLifecycle` 를 직접 import 해 써도 되고(`import { ProcessLifecycle } from '../process/lifecycle.js'`), 위처럼 최소 구조 타입 `{ register(...) }` 로 받아도 된다 — 순환·과결합 피하려면 `ProcessLifecycle` import 가 더 명확. implementer 선택(둘 다 동작 동일).
> ⚠️ **`registerGeneralTools` 가 함수 맨 앞** — 원본 355 가 market(376) 보다 앞이므로. 절대 뒤로 옮기지 말 것.
> ⚠️ alert 의 `lifecycle.register` (③) 가 plugins 의 `lifecycle.register` (④) 보다 **먼저** — 원본 437 < 542. 함수 본문 순서가 이를 보존함. 확인할 것.

검증: `pnpm --filter @finclaw/server build`

### B2. EDIT `packages/server/src/main.ts` — skills 블록(355,363-559) 삭제 후 `registerSkills` 1콜로 치환

(1) import 추가:

```ts
// ... 기존 composition import 들 ...
import { buildScheduleRpc } from './composition/schedule-rpc.js';
import { registerSkills } from './composition/skills.js';
```

(2) A4 에서 남겨둔 `registerGeneralTools(toolRegistry, { scheduleRpc })` (구 355) 한 줄을 **삭제** (registerSkills 안으로 이동했으므로). `const scheduleRpc = buildScheduleRpc(storage)` 는 **유지** — registerSkills 에 주입해야 하니까. 단 catalog 블록(357-361)보다 scheduleRpc 가 먼저 평가되도록 위치 유지 (원본 순서: scheduleRpc 305 < catalog 357).

(3) **삭제**: 363-559 의 skills/KIS/mcp/plugins 블록 전체 (key rotators ~ CLI 경고). catalog 블록 357-361 (`modelCatalog`/`modelAliasIndex`/`profileHealth`) 은 **잔존** (registerSkills + 이후 exec/pipeline 에 주입). **치환** (363 자리에):

```ts
// 4a. 모델 카탈로그 + 별칭 인덱스 + 프로필 건강 모니터. (잔존 — 357-361)
const modelCatalog = new InMemoryModelCatalog(BUILT_IN_MODELS);
const modelAliasIndex = buildModelAliasIndex(modelCatalog);
const profileHealth = new ProfileHealthMonitor();

// Phase 36: skills/tools/KIS/mcp/plugins 등록 (구 363-559 흡수)
const { marketHandle, newsHandle, alertHandle, brokerageSyncService, kisEnv } =
  await registerSkills({
    toolRegistry,
    storage,
    logger,
    finclawConfig,
    anthropicKey,
    discordAdapter,
    routerHelper,
    profileHealth,
    modelCatalog,
    defaultModel: DEFAULT_MODEL,
    scheduleRpc,
    lifecycle,
  });
```

> ⚠️ **순서 검증 포인트**: 치환 후 main() 의 실행 흐름이 `discord setup(잔존) → buildProviders → buildScheduleRpc → catalog(357-361 잔존) → registerSkills` 가 되어야 함. 원본은 `discord → providers → scheduleRpc → registerGeneralTools → catalog → market...` 이었다. **차이 하나**: 원본은 `registerGeneralTools` 가 catalog **앞**(355 < 357)이었는데, 치환 후엔 `registerSkills` 내부 첫 줄(registerGeneralTools)이 catalog **뒤**에 실행된다.
>
> - **이게 동작에 영향 없는지 반드시 확인**: `registerGeneralTools` 는 `scheduleRpc` 만 의존(catalog 무관), catalog 생성은 `registerGeneralTools` 산출물을 안 씀 → **두 작업은 독립, 순서 무관**. 따라서 안전. **단 implementer 는 이 1건의 상대순서 변동을 review 에 명시**(순수 이동 원칙상 유일한 순서 변화 — 부작용 없음 근거 첨부). 만약 완전 무변동을 원하면 대안: catalog 블록을 registerSkills 호출 **뒤**가 아니라, `registerGeneralTools` 만 main 에 남기고 나머지를 registerSkills 로(=plan 의 "general 흡수" 와 어긋남). → **plan 이 general 흡수를 명시했으므로 위 형태 채택, 독립성 근거를 review 에 기록**하는 것이 정답.

(4) 미사용 import 정리: main 에서 이제 안 쓰는 `readKeyArray`, `KeyRotator`, `KisClient`, `KisTokenManager`, `registerMarketTools`, `registerNewsTools`, `registerAlertTools`, `registerBrokerageTools`, `registerGeneralTools`, `NEWS_BRIEF_PROMPT`, `NEWS_BRIEF_SCHEDULE_ID`, `BrokerageSyncService`(주의: 717 NewsMemorizer 와 별개 — brokerageSyncService 는 이제 반환값으로만 받음, `new BrokerageSyncService` 가 main 에 없으면 import 제거), 타입 `AlertSkillHandle`/`MarketSkillHandle`/`NewsSkillHandle`, `getSchedule`. **단**: `addSchedule`/`computeNextRunAt`/`parseCron`/`createAgentId`/`Timestamp` 는 main 에 더 남는 게 있는지 build 로 확인 (KIS seed 가 통째로 빠졌으니 이들도 미사용일 가능성 큼 → lint/build 로 정확 판별, 추측 삭제 금지). `ProfileHealthMonitor`/`InMemoryModelCatalog`/`buildModelAliasIndex`/`BUILT_IN_MODELS` 는 catalog 블록(잔존)이 쓰므로 **남김**.

검증: `pnpm --filter @finclaw/server build && pnpm typecheck`

### B3. 밀스톤 B 검증

- `pnpm typecheck`
- `pnpm build`
- `pnpm test --run`
- `pnpm test:storage`
- (diff 점검) skills/KIS/mcp/plugins 블록이 글자 그대로 이동, 조건 분기·로그·2건의 `lifecycle.register`(③④) 가 registerSkills 내부 원래 순서로 보존됐는지. registerGeneralTools↔catalog 상대순서 변동 1건의 무해성 근거 기록.

→ **여기서 1 커밋** (예: `refactor(phase36): extract registerSkills (general/market/news/alert/kis/mcp/plugins) from main()`). A+B 까지 부분 머지 허용 지점.

---

## 밀스톤 C — runtime/pipeline/automation composition (`buildExecution`/`buildPipeline`/`buildAutomation`)

> plan C: `composition/runtime.ts` 의 `buildExecution(deps)` (tracer/runnerFactory/adapter 561-591), `buildPipeline(deps)` (593-653), `buildAutomation(deps)` (scheduler/newsMemorizer 704-757). 반환 번들. main() 은 이들 호출 + gateway/router/start 만 오케스트레이션. **gateway 생성(759-816)·MessageRouter(655-668)·deliveryHook 대입(863-873)·start(875-880) 은 main 잔존.**

### C 설계 노트 (implementer 필독)

세 빌더를 **한 파일** `composition/runtime.ts` 에 둔다(plan 명시). 각자 deps 번들 받아 산출물 반환. 순서: `buildExecution` → `buildPipeline` → (MessageRouter — main 잔존) → (gateway 직전 lanes/scheduleLane/gatewayConfig — 아래 분배) → `buildAutomation` → gateway 생성(main).

원본 흐름 재배치 주의 — **`buildAutomation`(scheduler) 은 원본 704-757, gateway 생성 759 보다 앞**. 그런데 scheduler 의 `onRunComplete` 는 `deliveryHook`(let, 864 lateinit) 를 클로저로 캡처한다. 이것이 **C 의 최대 난점**.

#### deliveryHook lateinit 처리 (순수 이동의 핵심 결정)

원본: main() 에 `let deliveryHook = null` (706) 선언 → scheduler `onRunComplete` 가 이 `let` 을 **참조 캡처** → gateway 생성 후 864 에서 `deliveryHook = (args) => deliverScheduleResult(...)` 로 **대입**.

`buildAutomation` 이 scheduler 를 만들면 `let deliveryHook` 도 함께 들어가야 클로저가 성립. **채택 방식 (순수 이동에 가장 충실)**: `let deliveryHook` 을 `buildAutomation` 내부로 이동하고, `onRunComplete` 가 그 내부 `let` 을 캡처. main() 이 나중에 대입할 수 있도록 빌더가 **setter 를 반환** (`setDeliveryHook(fn)`). main() 은 plan 이 "main 잔존" 으로 지정한 864 자리에서 `setDeliveryHook(...)` 호출. → 클로저 메커니즘(같은 `let` 의 mutable 캡처) 동일, 대입 시점 동일.

- ✅ 이렇게 하면 "scheduler 생성 = 704-757 추출", "deliveryHook **대입** = main 잔존" 이라는 plan 의 분담과 정확히 일치.
- ❌ 대안(거부): main 이 `let deliveryHook` 보유 + `() => deliveryHook` getter 를 buildAutomation 에 주입 → onRunComplete 가 `getDeliveryHook()` 호출. 이건 클로저 캡처를 getter 간접호출로 **바꾸는 미세 로직 변경** → 순수 이동 위반. 채택 안 함.

`deliverScheduleResult` 호출 본문(865-873)은 `gateway.ctx.broadcaster/connections` 와 `discordAdapter.getClient()` 를 쓰므로 **main 에 잔존**(gateway 생성 이후라야 가능). setter 에 넘기는 콜백이 그 본문 그대로.

#### lanes / scheduleLane / agentRunLane 배치

- `lanes`(ConcurrencyLaneManager) 는 buildProviders 산출(A). `runnerFactory`(568-574) 가 `lanes` 사용 → buildExecution 에 `lanes` 주입.
- `agentRunLane`(690-694), `scheduleLane`(698-702): 원본은 gateway 직전(689-702). `agentRunLane` 은 gateway `agentDeps`(782) 전용 → **main 잔존**(gateway 블록과 함께). `scheduleLane` 은 scheduler(727) 전용 → `buildAutomation` 이 내부 생성 or 주입. **원본 위치(698)가 scheduler 생성(723) 직전이므로 buildAutomation 내부 생성이 자연스럽고 순서 보존.** buildAutomation 내부로 이동.
- `maxConsecutiveFailures`(714-715): scheduler 전용 → buildAutomation 내부.

### C1. CREATE `packages/server/src/composition/runtime.ts` — `buildExecution` / `buildPipeline` / `buildAutomation`

세 빌더 + deps/bundle 인터페이스. 본문은 원본 561-591 / 593-653 / 698-757 을 글자 그대로.

```ts
// packages/server/src/composition/runtime.ts
// Phase 36: main.ts 561-591 / 593-653 / 698-757 에서 추출 (순수 이동).

import {
  approxTokenCount,
  DEFAULT_FALLBACK_CHAIN,
  InMemoryModelCatalog,
  ProfileHealthMonitor,
  Runner,
  type RunnerTracerAdapter,
} from '@finclaw/agent';
import type { AnthropicAdapter } from '@finclaw/agent';
import { ConcurrencyLane } from '@finclaw/infra';
import type { ConcurrencyLaneManager, FinClawLogger } from '@finclaw/infra';
import {
  createRerankerWithFallback,
  LocalReranker,
  type createStorage,
  type EmbeddingProvider,
} from '@finclaw/storage';
import type { ChannelPlugin, FinClawConfig, ModelRef, Schedule } from '@finclaw/types';
import { DefaultAttachMemoryService } from '../auto-reply/agent-memory-hook.js';
import { registerBuiltInCommands } from '../auto-reply/commands/built-in.js';
import { InMemoryCommandRegistry } from '../auto-reply/commands/registry.js';
import { RunnerExecutionAdapter, type RunnerFactory } from '../auto-reply/execution-adapter.js';
import { StubFinanceContextProvider } from '../auto-reply/pipeline-context.js';
import { AutoReplyPipeline } from '../auto-reply/pipeline.js';
import { DefaultMemoryCaptureService } from '../auto-reply/stages/memory-capture.js';
import { DefaultMemoryRetrievalService } from '../auto-reply/stages/memory-retrieval.js';
import { DefaultMemoryRetrievalService as _Retrieval } from '../auto-reply/stages/memory-retrieval.js'; // (실제로는 위 import 재사용)
import { NewsMemorizer } from '../services/news-memorizer.js';
import { SchedulerService } from '../automation/scheduler.js';
import type { MarketSkillHandle, NewsSkillHandle } from '@finclaw/skills-finance';
import type { makeRouterHelper } from '../auto-reply/router-helper.js';
import type { createTracer } from '../observability/tracer.js';
import { wireMemoryServices } from './memory-services.js'; // C2 로 이동한 헬퍼

type Storage = ReturnType<typeof createStorage>;
type RouterHelper = ReturnType<typeof makeRouterHelper> | undefined;
type Tracer = ReturnType<typeof createTracer>;

// ───────────────────────── buildExecution (561-591) ─────────────────────────

export interface BuildExecutionDeps {
  readonly storage: Storage;
  readonly providerAdapter: import('@finclaw/agent').ProviderAdapter; // ReturnType<typeof createProviderAdapter> 로 대체 가능
  readonly lanes: ConcurrencyLaneManager;
  readonly toolRegistry: import('@finclaw/agent').InMemoryToolRegistry;
  readonly modelCatalog: InMemoryModelCatalog;
  readonly modelAliasIndex: ReturnType<typeof import('@finclaw/agent').buildModelAliasIndex>;
  readonly profileHealth: ProfileHealthMonitor;
  readonly routerLlm: ReturnType<typeof import('@finclaw/agent').createLlmRouter>;
  readonly logger: FinClawLogger;
  readonly defaultModel: ModelRef;
  readonly systemPrompt: string;
}

export interface ExecutionBundle {
  readonly tracer: Tracer;
  readonly runnerFactory: RunnerFactory;
  readonly adapter: RunnerExecutionAdapter;
}

export function buildExecution(deps: BuildExecutionDeps): ExecutionBundle {
  const {
    storage,
    providerAdapter,
    lanes,
    toolRegistry,
    modelCatalog,
    modelAliasIndex,
    profileHealth,
    routerLlm,
    logger,
    defaultModel,
    systemPrompt,
  } = deps;

  const tracer = createTracerLocal(storage); // 아래 주석: 실제로는 createTracer({ db: storage.db })
  const tracerAdapter: RunnerTracerAdapter = {
    withSpan: (name, attrs, fn) => tracer.withSpan(name, attrs, async () => fn()),
  };
  const runnerFactory: RunnerFactory = (dispatcher) =>
    new Runner({
      provider: providerAdapter,
      toolExecutor: dispatcher,
      laneManager: lanes,
      tracer: tracerAdapter,
    });
  const adapter = new RunnerExecutionAdapter({
    runnerFactory,
    defaultModel,
    systemPrompt,
    storage,
    toolRegistry,
    logger,
    modelCatalog,
    modelAliasIndex,
    fallbackChain: DEFAULT_FALLBACK_CHAIN,
    profileHealth,
    profileId: 'default',
    routerLlm,
  });
  return { tracer, runnerFactory, adapter };
}

// ───────────────────────── buildPipeline (593-653) ─────────────────────────

export interface BuildPipelineDeps {
  readonly adapter: RunnerExecutionAdapter;
  readonly toolRegistry: import('@finclaw/agent').InMemoryToolRegistry;
  readonly storage: Storage;
  readonly profileHealth: ProfileHealthMonitor;
  readonly marketHandle: MarketSkillHandle | undefined;
  readonly newsHandle: NewsSkillHandle | undefined;
  readonly embeddingProvider: EmbeddingProvider | undefined;
  readonly finclawConfig: FinClawConfig;
  readonly sdkAdapter: AnthropicAdapter;
  readonly tracer: Tracer;
  readonly logger: FinClawLogger;
  readonly defaultModel: ModelRef;
  readonly channelPluginRegistry: Map<string, ChannelPlugin>;
}

export interface PipelineBundle {
  readonly pipeline: AutoReplyPipeline;
  readonly attachMemoryService: DefaultAttachMemoryService;
  // channelPluginRegistry 는 main 이 소유(discord set 등) → 주입받음, 반환 불필요
}

export function buildPipeline(deps: BuildPipelineDeps): PipelineBundle {
  const {
    adapter,
    toolRegistry,
    storage,
    profileHealth,
    marketHandle,
    newsHandle,
    embeddingProvider,
    finclawConfig,
    sdkAdapter,
    tracer,
    logger,
    defaultModel,
    channelPluginRegistry,
  } = deps;

  const financeCtxProvider = new StubFinanceContextProvider();
  const commandRegistry = new InMemoryCommandRegistry();
  registerBuiltInCommands(commandRegistry, {
    toolRegistry,
    storage,
    profileHealth,
    profileId: 'default',
    defaultModel,
    marketHandle,
    newsHandle,
  });

  const rerankCfg = finclawConfig.rag?.rerank;
  const rerankEnabled = rerankCfg?.enabled !== false;
  const reranker = rerankEnabled ? createRerankerWithFallback(new LocalReranker()) : undefined;

  const { memoryCaptureService, memoryRetrievalService, attachMemoryService } = wireMemoryServices(
    { db: storage.db, embeddingProvider, logger },
    { reranker, rerankTopKFirst: rerankCfg?.topKFirst },
  );

  const summarizer = (text: string) => sdkAdapter.summarize(text, defaultModel.model);

  const pipeline = new AutoReplyPipeline(
    {
      enableAck: true,
      commandPrefix: '!finclaw ',
      maxResponseLength: 2000,
      timeoutMs: 60_000,
      respectMarketHours: false,
    },
    {
      executionAdapter: adapter,
      financeContextProvider: financeCtxProvider,
      commandRegistry,
      logger,
      getChannel: (id) => channelPluginRegistry.get(id),
      memoryCaptureService,
      memoryRetrievalService,
      tracer,
      tokenCounter: approxTokenCount,
      summarizer,
    },
  );

  return { pipeline, attachMemoryService };
}

// ───────────────────────── buildAutomation (698-757) ─────────────────────────

export type DeliveryHook = (args: {
  schedule: Schedule;
  agentRunId: string | null;
  output: string;
  error?: string;
}) => Promise<void>;

export interface BuildAutomationDeps {
  readonly storage: Storage;
  readonly toolRegistry: import('@finclaw/agent').InMemoryToolRegistry;
  readonly runnerFactory: RunnerFactory;
  readonly defaultModel: ModelRef;
  readonly systemPrompt: string;
  readonly logger: FinClawLogger;
  readonly profileHealth: ProfileHealthMonitor;
  readonly routerHelper: RouterHelper;
  readonly modelCatalog: InMemoryModelCatalog;
  readonly modelAliasIndex: ReturnType<typeof import('@finclaw/agent').buildModelAliasIndex>;
  readonly tracer: Tracer;
  readonly embeddingProvider: EmbeddingProvider | undefined;
  readonly lifecycle: { register(fn: () => void | Promise<void>): void };
}

export interface AutomationBundle {
  readonly scheduler: SchedulerService;
  readonly scheduleLane: ConcurrencyLane;
  /** main 이 gateway 생성 후 호출 — 원본 864 의 deliveryHook 대입과 동일 시점. */
  readonly setDeliveryHook: (fn: DeliveryHook) => void;
}

export function buildAutomation(deps: BuildAutomationDeps): AutomationBundle {
  const {
    storage,
    toolRegistry,
    runnerFactory,
    defaultModel,
    systemPrompt,
    logger,
    profileHealth,
    routerHelper,
    modelCatalog,
    modelAliasIndex,
    tracer,
    embeddingProvider,
    lifecycle,
  } = deps;

  // [원본 698-702] schedule 전용 lane (원본 위치: scheduler 직전 — 순서 보존)
  const scheduleLane = new ConcurrencyLane({
    maxConcurrent: 1,
    maxQueueSize: 50,
    waitTimeoutMs: 5 * 60_000,
  });

  // [원본 706-713] deliveryHook lateinit 용 let — main 이 setter 로 대입
  let deliveryHook: DeliveryHook | null = null;
  const setDeliveryHook = (fn: DeliveryHook): void => {
    deliveryHook = fn;
  };

  const maxFailRaw = process.env.AUTOMATION_MAX_CONSECUTIVE_FAILURES;
  const maxConsecutiveFailures = maxFailRaw ? Number(maxFailRaw) : 3;

  // [원본 716-722] news-brief 출력 적재기
  const newsMemorizer = new NewsMemorizer({
    db: storage.db,
    embeddingProvider,
    logger,
    sessionKey: 'news-brief',
  });

  // [원본 723-756] SchedulerService — onRunComplete 가 deliveryHook(위 let) 캡처
  const scheduler = new SchedulerService({
    db: storage.db,
    toolRegistry,
    runnerFactory,
    lane: scheduleLane,
    defaultModel,
    systemPrompt,
    logger,
    profileHealth,
    profileId: 'default',
    router: routerHelper,
    modelCatalog,
    modelAliasIndex,
    fallbackChain: DEFAULT_FALLBACK_CHAIN,
    maxConsecutiveFailures,
    tracer,
    onRunComplete: async (args) => {
      if (deliveryHook) {
        await deliveryHook(args);
      }
      if (args.schedule.id === NEWS_BRIEF_SCHEDULE_ID && !args.error) {
        try {
          await newsMemorizer.absorb({ agentRunId: args.agentRunId, output: args.output });
        } catch (memErr) {
          logger.warn('news_memorizer.failed', {
            event: 'news_memorizer.failed',
            error: (memErr as Error).message,
          });
        }
      }
    },
  });

  // [원본 757] lifecycle ⑤ — scheduler.stop. 원본과 같은 시점(gateway 생성 직전)에 등록.
  lifecycle.register(() => scheduler.stop());

  return { scheduler, scheduleLane, setDeliveryHook };
}
```

> ⚠️ **위 스니펫의 의도적 placeholder 2건은 implementer 가 실제 코드로 교체할 것 (골격 표기상의 약식, 절대 그대로 두지 말 것)**:
>
> - `createTracerLocal(storage)` → 실제는 `import { createTracer } from '../observability/tracer.js'` 후 `const tracer = createTracer({ db: storage.db });` (원본 563 그대로).
> - `DefaultMemoryRetrievalService as _Retrieval` 중복 import 줄은 **삭제** — 위 정식 import 한 줄만 둘 것 (골격 작성 흔적).
>   ⚠️ `NEWS_BRIEF_SCHEDULE_ID` import 추가 필요 (`from '@finclaw/agent'`) — onRunComplete 가 사용. 골격 import 에 빠져 있으니 implementer 가 채울 것.
>   ⚠️ `wireMemoryServices` 는 C2 에서 `composition/memory-services.ts` 로 옮긴다(아래). buildPipeline 이 그걸 import.
>   ⚠️ deps 의 `ProviderAdapter`/`InMemoryToolRegistry` 등 타입은 agent 패키지 export 형태에 맞춰 `ReturnType<typeof ...>` 또는 named type 로 — build green 형태로 implementer 확정. **핵심은 본문 로직 불변**이지 타입 표기 방식이 아니다.
>   ⚠️ **lifecycle ⑤(scheduler.stop, 원본 757) 는 buildAutomation 내부 끝에서 register** — 원본에서 gateway 생성(759) **직전**이었다. main() 은 buildAutomation 호출을 gateway 생성 직전에 배치해 ⑤ 등록 시점을 보존(아래 C4).

### C2. CREATE `packages/server/src/composition/memory-services.ts` — `wireMemoryServices` 이동

main.ts 155-174 의 모듈 레벨 헬퍼 `wireMemoryServices` 를 그대로 이동(plan: "옮겨도 되고 둬도 됨, 순수 이동"). buildPipeline 이 같은 파일/패키지에서 import 하므로 composition 으로 옮기는 게 응집도상 자연스러움. **본문·주석 그대로.**

```ts
// packages/server/src/composition/memory-services.ts
// Phase 36: main.ts 155-174 에서 추출 (순수 이동). Phase 26 의 3-service wire 헬퍼.

import { DefaultAttachMemoryService } from '../auto-reply/agent-memory-hook.js';
import { DefaultMemoryCaptureService } from '../auto-reply/stages/memory-capture.js';
import { DefaultMemoryRetrievalService } from '../auto-reply/stages/memory-retrieval.js';

/**
 * Phase 26: capture / retrieval / attach 3 service 를 동일 deps 로 인스턴스화.
 * ... (원본 주석 그대로) ...
 */
export function wireMemoryServices(
  deps: ConstructorParameters<typeof DefaultMemoryCaptureService>[0],
  retrievalExtras?: {
    reranker?: import('@finclaw/storage').Reranker;
    rerankTopKFirst?: number;
  },
): {
  memoryCaptureService: DefaultMemoryCaptureService;
  memoryRetrievalService: DefaultMemoryRetrievalService;
  attachMemoryService: DefaultAttachMemoryService;
} {
  return {
    memoryCaptureService: new DefaultMemoryCaptureService(deps),
    memoryRetrievalService: new DefaultMemoryRetrievalService({
      ...deps,
      ...retrievalExtras,
    }),
    attachMemoryService: new DefaultAttachMemoryService(deps),
  };
}
```

> 대안: 옮기지 않고 main 에 남긴 뒤 buildPipeline 이 main 에서 주입받는 방식도 순수 이동이지만, 그러면 buildPipeline 시그니처에 헬퍼를 끼워야 해 부자연스럽다. **이동 채택.** (옮기지 않을 거면 이 C2 를 skip 하고 buildPipeline 이 `../main.js` 에서 import — 순환 위험 → 비권장.)

검증: `pnpm --filter @finclaw/server build`

### C3. EDIT `packages/server/src/main.ts` — `wireMemoryServices` 정의 삭제 (C2 로 이동)

main.ts 155-174 의 `function wireMemoryServices(...) {...}` 전체 **삭제**. (정의만 삭제 — 호출부는 어차피 buildPipeline 으로 빠짐.) 관련 import 중 main 의 다른 곳에서 안 쓰게 되는 것 정리: `DefaultMemoryCaptureService`/`DefaultMemoryRetrievalService`/`DefaultAttachMemoryService` (73,80,81) → buildPipeline·memory-services 로 이동했으니 main 에서 미사용이면 제거 (build/lint 판별).

검증: `pnpm --filter @finclaw/server build`

### C4. EDIT `packages/server/src/main.ts` — exec/pipeline/automation 블록 삭제, 3빌더 호출로 치환

원본 561-591(exec) / 593-653(pipeline) / 698-757(automation) 삭제. **gateway 생성(759-816)·MessageRouter(655-668)·gatewayConfig+port assert(671-688)·agentRunLane(690-694)·purge(818-843)·hotReload(845-861)·deliveryHook 대입(863-873)·start(875-880) 은 잔존.**

순서 재배치 핵심 — 원본 흐름:

```
[exec 561-591] → [pipeline 593-653] → [MessageRouter 655-668] → [gatewayConfig 671-678] → [port assert 679-688] → [agentRunLane 690-694] → [scheduleLane 698-702] → [deliveryHook let 706-713] → [scheduler 723-757] → [gateway 759-816] → [purge 818-843] → [hotReload 845-861] → [deliveryHook 대입 864-873] → [start 875-880]
```

치환 후:

```
buildExecution → buildPipeline → MessageRouter(잔존) → gatewayConfig+port assert(잔존) → agentRunLane(잔존) → buildAutomation → gateway(잔존) → purge(잔존) → hotReload(잔존) → setDeliveryHook(...)(잔존,864 위치) → start(잔존)
```

> ⚠️ **buildAutomation 호출 위치**: scheduler 생성(원본 723)이 gateway 생성(759) 앞이었다. 따라서 `buildAutomation` 호출은 **gateway 생성 직전** (agentRunLane 잔존 줄 다음). 이래야 lifecycle ⑤(scheduler.stop) 가 gateway.stop(⑦) 보다 먼저 등록되는 원본 순서가 보존된다. scheduleLane 은 buildAutomation 이 내부 생성하므로 원본 698 위치 소멸 — 무해(scheduler 전용, 다른 소비자 없음).

(1) **삭제** 561-591, **치환**:

```ts
const { tracer, runnerFactory, adapter } = buildExecution({
  storage,
  providerAdapter,
  lanes,
  toolRegistry,
  modelCatalog,
  modelAliasIndex,
  profileHealth,
  routerLlm,
  logger,
  defaultModel: DEFAULT_MODEL,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
});
```

(2) **삭제** 593-653, **치환** (단 `channelPluginRegistry` 는 원본 605 에서 생성되고, 이후 router(664)·discord set(664) 가 main 에서 쓰므로 **main 이 소유** — buildPipeline 에 주입):

```ts
const channelPluginRegistry = new Map<string, ChannelPlugin>();
const { pipeline, attachMemoryService } = buildPipeline({
  adapter,
  toolRegistry,
  storage,
  profileHealth,
  marketHandle,
  newsHandle,
  embeddingProvider,
  finclawConfig,
  sdkAdapter,
  tracer,
  logger,
  defaultModel: DEFAULT_MODEL,
  channelPluginRegistry,
});
```

> ⚠️ `attachMemoryService` 는 gateway `agentDeps.attachMemoryService`(793) 에서 쓰임 → buildPipeline 반환으로 받아 gateway 에 주입. `tracer`/`adapter`/`runnerFactory` 는 buildExecution 반환을 gateway·scheduler 양쪽이 쓰므로 main 스코프에 유지됨(위 (1)에서 const 로 받음).

(3) MessageRouter(655-668)·gatewayConfig+port assert(671-688)·agentRunLane(690-694) **잔존** — 그대로 둔다.

(4) **삭제** 698-757(scheduleLane·deliveryHook let·maxFail·newsMemorizer·scheduler·lifecycle⑤), **치환** (gateway 생성 **직전**):

```ts
const { scheduler, setDeliveryHook } = buildAutomation({
  storage,
  toolRegistry,
  runnerFactory,
  defaultModel: DEFAULT_MODEL,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  logger,
  profileHealth,
  routerHelper,
  modelCatalog,
  modelAliasIndex,
  tracer,
  embeddingProvider,
  lifecycle,
});
```

> ⚠️ gateway 생성 블록(759-816)의 `scheduleDeps: { db: storage.db, scheduler }`(800) 가 이 `scheduler` 를 씀 → 반환받은 scheduler 를 그대로 사용. `agentRunLane`(잔존)·`alertHandleForRpc`(689, 잔존)·`kisEnv`(B 반환, brokerageDeps.env 802)·`brokerageSyncService`(B 반환, 802) 도 gateway 블록이 씀 → main 스코프에 다 있어야 함(B 반환 + 잔존 변수). **확인**: `const alertHandleForRpc = alertHandle;`(689) 잔존, `kisEnv`·`brokerageSyncService` 는 B2 의 registerSkills 반환에서 구조분해로 main 스코프에 있음.

(5) deliveryHook **대입** (원본 863-873) **잔존** — `deliveryHook = ...` 를 `setDeliveryHook(...)` 로 1줄 변경(대입 대상이 빌더 내부 let 으로 바뀌었으므로):

```ts
// Phase 28: gateway 생성 후 delivery hook 활성화. (원본 864 — 시점 동일)
setDeliveryHook((args) =>
  deliverScheduleResult(
    {
      discordClient: discordAdapter.getClient() ?? undefined,
      broadcaster: gateway.ctx.broadcaster,
      connections: gateway.ctx.connections,
      logger,
    },
    args,
  ),
);
```

> ⚠️ 이게 C 의 핵심 1줄. `let deliveryHook` 선언(706-713)은 buildAutomation 으로 갔고, **대입 시점·콜백 본문은 원본 864 그대로**. `Schedule` import 가 main 에서 이 대입에만 쓰였다면 미사용→제거(타입은 이제 buildAutomation 의 DeliveryHook). build/lint 판별.

(6) `lifecycle.init()` / `await gateway.start()` / `scheduler.start()` / `emit` (875-880) **잔존** — `scheduler` 는 buildAutomation 반환. 변경 없음.

(7) 미사용 import 대거 정리: main 에서 이제 안 쓰는 `Runner`, `RunnerTracerAdapter`, `DEFAULT_FALLBACK_CHAIN`, `approxTokenCount`, `createRerankerWithFallback`, `LocalReranker`, `StubFinanceContextProvider`, `InMemoryCommandRegistry`, `registerBuiltInCommands`, `RunnerExecutionAdapter`(타입은 잔존? gateway adapter 인자 타입에 직접 안 쓰면 제거), `RunnerFactory`, `AutoReplyPipeline`, `createTracer`, `SchedulerService`, `NewsMemorizer`, `EmbeddingProvider`(잔존: embedding 블록 240 이 씀 → **남김**) 등. **build + lint 로 정확 판별, 추측 삭제 금지.** `ConcurrencyLane` 은 agentRunLane(690 잔존)이 쓰므로 남김.

검증: `pnpm --filter @finclaw/server build && pnpm typecheck`

### C5. 밀스톤 C 검증

- `pnpm typecheck`
- `pnpm build`
- `pnpm test --run`
- `pnpm test:storage`
- (diff 점검) exec/pipeline/automation 본문 글자 그대로 이동. **순서 보존 집중 확인**:
  - buildAutomation(scheduler 생성) 이 gateway 생성보다 앞 → lifecycle ⑤(scheduler.stop) 가 ⑦(gateway.stop) 보다 먼저 등록.
  - `setDeliveryHook` 호출이 gateway 생성 **뒤**, start **앞** (원본 864 위치).
  - `lifecycle.init → gateway.start → scheduler.start → emit` 순서 불변.
- (LOC 확인) main() 이 ~450 수준으로 감량됐는지 (목표치, 엄격 기준 아님).

→ **여기서 1 커밋** (예: `refactor(phase36): extract buildExecution/buildPipeline/buildAutomation from main(), main() now orchestrates gateway/router/start only`). C 가 결합도로 위험하면 A(+B)만 머지하고 C 분리 가능(plan §부분머지허용).

---

## 최종 검증

phase 전체 완료 후 다음 모두 통과:

- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] `pnpm test --run` (기준 1681 — 증감 없어야 함, 신규 테스트 0)
- [ ] `pnpm test:storage` (기준 151)
- [ ] `pnpm lint`
- [ ] `pnpm format:fix` 후 재-lint (oxfmt 가 새 파일 포맷 정리 — lefthook pre-commit 통과 보장)
- [ ] mock-only 격리: API 키 unset 상태에서 `pnpm test --run` 통과 (registerSkills 의 조건부 skip 경로가 키 없이도 정상 — 이게 기존 동작과 동일해야 함)
- [ ] **순수 이동 diff 리뷰**: 추출된 블록의 코드가 글자 그대로 이동했고, 로직 변경 줄이 0 임을 확인. 인정되는 변경은 (a) 인자화 (b) 반환화 (c) `deliveryHook` 대입→`setDeliveryHook` 1줄 (d) registerGeneralTools↔catalog 상대순서 1건(무해 근거 첨부) (e) 자기 변경이 만든 미사용 import 제거. 그 외 변경이 있으면 되돌릴 것.
- [ ] **잔여 리스크 명시**: 실 키 부팅 e2e 부재 → `main()` 실제 실행 경로는 자동 테스트가 직접 커버하지 않음(`main.test.ts` 는 `createGatewayServer` 만 호출). "동작 불변" 의 마지막 1% 는 키 보유자(사용자)의 수동 `pnpm dev` 부팅 smoke 로만 확정 → review.md 에 기록 + 머지 후 권장.

## 정리

- main.ts 상단의 `wireMemoryServices`(155-174)·`defaultConfig`(97-120)·`DEFAULT_MODEL`(122-127) 정의가 composition 으로 이동해 main.ts 가 import 위주로 슬림해짐. 자기 변경이 만든 고아 import 외에는 손대지 않는다(CLAUDE.md §3).
- `requireEnv`/`MissingEnvError`/`main` 자체는 main.ts 잔존 (test 가 import — 깨면 안 됨).

## 롤백 절차

각 밀스톤 = 독립 커밋 → 단계적 롤백:

- 밀스톤 C 롤백: `git revert {sha-C}` — runtime/pipeline/automation 추출만 되돌림 (A+B 추출 유지).
- 밀스톤 B 롤백: `git revert {sha-C} {sha-B}` — skills 추출까지 되돌림.
- 전체 phase 롤백: `git revert {sha-C} {sha-B} {sha-A}` (역순) 또는 phase36 시작 SHA 로 reset.

순수 구조 리팩토링이라 storage 마이그레이션·SCHEMA_VERSION 변경 없음 → 롤백 시 추가 처리 불필요.

---

## 분해 품질 self-check

- [x] 3 밀스톤 모두 독립 커밋 가능 (A leaf → B skills → C runtime, 각 단계 typecheck/build green 유지)
- [x] 각 밀스톤 끝 검증 단계 (A5/B3/C5)
- [x] CREATE 단계가 import 포함 실행가능 코드 (골격의 명시적 placeholder 2건은 ⚠️로 교체 지시)
- [x] EDIT 단계가 삭제 라인 범위 + 치환 코드 + 순서경고 명시
- [x] plan 범위 외 변경 없음 — 패키지 추출(B/C) 언급 0, gateway/router/start/deliveryHook대입/MessageRouter 잔존 준수
- [x] mock-only 유지, 신규 테스트 0 (순수 이동, 기존 테스트가 안전망)
- [x] 마이그레이션 없음 (구조 리팩토링)
- [x] 롤백 절차 명시
- [x] 모호함 없음 → questions.md 불요 (deliveryHook lateinit 은 plan 의 블록 분담이 setter 방식을 함의 → 자체 결정 근거 명시, 추측 아님)
