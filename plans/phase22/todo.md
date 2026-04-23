# Phase 22: 금융 파트너화 — Todo

## 개요

Phase 21의 수평 배선을 기반으로 **정체성·도구 확장·감사·부채 청산**을 수행한다.

**신규 2~3개 + 수정 11~13개 = 13~16개 파일, ~600 LOC**

### 실행 순서

```
Todo 1 (Milestone A: 시스템 프롬프트)                — 독립
Todo 2 (Milestone B1: registerMarketTools 반환값)    — 독립
Todo 3 (Milestone B2: main.ts news/alerts 배선)      — Todo 2 필요
Todo 4 (Milestone B3: .env.example + re-exports)     — Todo 2 필요
Todo 5 (Milestone C1: execution-adapter toolCalls)   — 독립
Todo 6 (Milestone C2: DeliverStage 출처 footer)      — Todo 5 필요
Todo 7 (Milestone C3: messages.ts tool_calls JSON)   — Todo 5 필요
Todo 8 (Milestone D1: MsgContext.chatId 근본 수정)   — 독립 (타입 변경 파급 큼)
Todo 9 (Milestone D2: !finclaw reset/status)         — Todo 7 필요 (status가 getToolCallHistory 사용)
Todo 10 (Milestone D3: web healthcheck override)     — 독립
```

권장: **A → B (2→3→4) → C (5→6→7) → D (8→9→10)** 순. 각 milestone 끝에 `pnpm build && pnpm test && docker compose restart server` 로 실 동작 확인.

### 각 Milestone 정지 조건

- **A 후**: Discord DM "너 누구야" → 금융 파트너 페르소나 자기소개
- **B 후**: Discord "비트코인 가격" / "애플 뉴스" / "TSLA 300달러 알림" 3개 모두 실제 결과 반환
- **C 후**: 응답 하단에 `📊 출처: ... @ ...` 자동 첨부, DB의 `tool_calls` JSON에 input/output 병렬 저장
- **D 후**: `!finclaw status`/`reset` 작동, `sendTyping failed` warning 소멸, docker compose ps에서 web `(healthy)`

---

## Todo 1: 시스템 프롬프트 — 금융 파트너 페르소나

### 파일 목록

| 작업 | 파일 경로                     | LOC |
| ---- | ----------------------------- | --- |
| 수정 | `packages/server/src/main.ts` | +30 |

### 주의사항

- 기존 `DEFAULT_SYSTEM_PROMPT`는 단일 상수(line 58-59). 교체 시 동일 export 유지(다른 곳에서 import 없으면 local 상수 OK).
- Anthropic 프롬프트 캐싱(ephemeral cache_control)이 system 블록에 적용되므로 프롬프트 길이 변경은 첫 호출만 cache miss.
- 한국어 중심 작성(`한국어로 자연스럽게 대답해`). 영어는 금융 용어 brand name만 그대로.

### 구현 코드

#### `packages/server/src/main.ts` (line 58-59 교체)

```typescript
const DEFAULT_SYSTEM_PROMPT = [
  '너는 사용자의 **개인 금융 파트너(Personal Finance Partner)** FinClaw다.',
  '',
  '## 역할',
  '- 시장 데이터 조회, 뉴스 요약, 포트폴리오 추적, 가격 알림 관리가 주 업무다.',
  '- 사용자 본인의 돈이 걸린 판단을 보조한다. 신중하고 정직하게 답하라.',
  '',
  '## 원칙',
  '1. **읽기 전용.** 매매 실행·자금 이체·계좌 변경은 절대 제안하지 않는다. 요청받으면 "나는 조회·분석만 한다"라고 명확히 거절한다.',
  '2. **환각 금지.** 수치·뉴스·날짜는 반드시 도구로 확인하고 답한다. 도구 없이 지식에서 가격·뉴스를 지어내지 말 것. 확인 불가면 "확인할 수 없다"라고 답한다.',
  '3. **출처 명시.** 수치 언급 시 어느 API·어느 시각 데이터인지 밝혀라. 응답 끝에 시스템이 자동으로 출처를 첨부하지만, 본문에서도 인용하면 더 좋다.',
  '4. **불확실성 수치화.** 예측·전망은 숫자(범위, 확률, 신뢰도)로 표현한다. "잘 모르겠지만" 같은 모호한 표현 최소화.',
  '5. **간결한 한국어.** 불필요한 인사·군더더기 없이 핵심부터. 긴 설명은 불릿으로.',
  '',
  '## 사용 가능한 도구 (API 키 설정 상태에 따라 가변)',
  '- `get_stock_price`, `get_crypto_price`, `get_forex_rate`, `get_market_chart` — 시세 조회',
  '- `get_financial_news`, `analyze_market` — 금융 뉴스·분석',
  '- `set_alert`, `list_alerts`, `remove_alert`, `get_alert_history` — 가격/변화/뉴스 알림',
  '- `get_portfolio_summary` — 포트폴리오 요약',
  '- `get_current_datetime`, `web_fetch`, `read_local_file` — 일반 유틸',
  '',
  '도구가 필요한데 없으면 "도구 X가 필요한데 지금 활성화되어 있지 않다. API 키 확인 바란다"라고 답한다.',
].join('\n');
```

### 검증

- `pnpm build && pnpm typecheck` 통과
- `docker compose restart server && docker logs finclaw-server | tail -5` — 기동 정상
- Discord DM "너 누구야?" → "개인 금융 파트너 FinClaw..." 응답
- "AAPL 10주 매수해줘" → "읽기 전용, 거절" 응답

---

## Todo 2: Market 스킬 반환값 확장

### 파일 목록

| 작업 | 파일 경로                                     | LOC |
| ---- | --------------------------------------------- | --- |
| 수정 | `packages/skills-finance/src/market/index.ts` | +40 |

### 주의사항

- `registerMarketTools`의 반환 타입을 `Promise<void>` → `Promise<MarketSkillHandle>`로 변경. 기존 호출자(`main.ts`)는 반환값을 쓰지 않고 있으므로 API 호환.
- `QuoteService` 인터페이스는 `packages/skills-finance/src/news/portfolio/tracker.ts:7`에 정의됨. 동일 시그니처로 adapter 작성.
- `MarketCache`, `ProviderRegistry` 타입을 `index.ts`에서 export해야 main.ts에서 type-only import 가능.

### 구현 코드

#### `packages/skills-finance/src/market/index.ts`

```typescript
// 상단 import 아래에 추가
import type { QuoteService } from '../news/portfolio/tracker.js';

/** Phase 22: main.ts가 news/alerts 배선에 재사용할 수 있도록 내부 상태 노출 */
export interface MarketSkillHandle {
  readonly providers: ProviderRegistry;
  readonly cache: MarketCache;
  readonly quoteService: QuoteService;
}

// registerMarketTools 시그니처 변경
export async function registerMarketTools(
  registry: ToolRegistry,
  config: MarketSkillConfig,
): Promise<MarketSkillHandle> {
  const providers = await createDefaultRegistry({
    alphaVantageKey: config.alphaVantageKey,
    coinGeckoKey: config.coinGeckoKey,
  });
  const cache = new MarketCache(config.db);
  const state: MarketSkillState = { providers, cache };

  registerStockPriceTool(registry, state);
  registerCryptoPriceTool(registry, state);
  registerForexRateTool(registry, state);
  registerMarketChartTool(registry, state);

  // QuoteService adapter: news/portfolio가 요구하는 { price, change, changePercent }
  const quoteService: QuoteService = {
    async getQuote(symbol: string) {
      const quote = await getQuoteFromState(state, symbol);
      return {
        price: quote.price,
        change: quote.change ?? 0,
        changePercent: quote.changePercent ?? 0,
      };
    },
  };

  return { providers, cache, quoteService };
}

// 타입 re-export
export type { MarketCache } from './cache.js';
export type { ProviderRegistry } from './provider-registry.js';
```

### 검증

- `pnpm --filter @finclaw/skills-finance build` (또는 루트 `pnpm build`) 통과
- `pnpm test` — 기존 market 테스트가 `Promise<void>` 전제라면 업데이트 필요할 수 있음. 테스트 실패 시 반환값 구조분해에 맞게 assertion 보완.

---

## Todo 3: main.ts — News + Alerts 배선

### 파일 목록

| 작업 | 파일 경로                     | LOC |
| ---- | ----------------------------- | --- |
| 수정 | `packages/server/src/main.ts` | +80 |

### 주의사항

- 초기화 순서: **market → news → alerts**. 각 단계가 앞 단계의 반환값에 의존.
- Alpha Vantage 키 없으면 market/news 모두 스킵 (정보 로그). CoinGecko만 있으면 market crypto만 활성.
- Alerts는 `ProviderRegistry` + `MarketCache` + `NewsAggregator` 3개 모두 필요 → market·news 둘 다 등록됐을 때만 시도.
- `registerNewsTools`의 `NewsSkillConfig.quoteService`는 필수. market 없으면 news도 시도 불가.
- `registerAlertTools`가 반환하는 `AlertMonitor`를 `lifecycle.register(() => monitor.stop())`로 등록. Discord 연결이 끊어질 때 함께 정리.
- `NewsAggregator`는 `registerNewsTools` 내부에서 생성되어 외부에 노출되지 않음 → **news/index.ts에서도 반환값 추가 필요** (Todo 4 참조).

### 구현 코드

#### `packages/server/src/main.ts` (line 96-113 근처 재작성)

```typescript
import {
  registerMarketTools,
  registerNewsTools,
  registerAlertTools,
  type MarketSkillHandle,
  type NewsSkillHandle,
} from '@finclaw/skills-finance';

// ... main() 내부, 기존 registerMarketTools 블록 교체

const alphaVantageKey = process.env.ALPHA_VANTAGE_KEY;
const coinGeckoKey = process.env.COINGECKO_API_KEY;

let marketHandle: MarketSkillHandle | undefined;
let newsHandle: NewsSkillHandle | undefined;

if (alphaVantageKey || coinGeckoKey) {
  marketHandle = await registerMarketTools(toolRegistry, {
    db: storage.db,
    alphaVantageKey,
    coinGeckoKey,
  });
  logger.info('Market tools registered');
} else {
  logger.info('ALPHA_VANTAGE_KEY/COINGECKO_API_KEY not set — skipping market tools');
}

// News (Alpha Vantage News 단일 공급자)
if (marketHandle && alphaVantageKey) {
  newsHandle = await registerNewsTools(toolRegistry, {
    db: storage.db,
    alphaVantageKey,
    quoteService: marketHandle.quoteService,
    anthropicApiKey: anthropicKey, // analyze_market용
  });
  logger.info('News tools registered');
} else if (marketHandle) {
  logger.info('ALPHA_VANTAGE_KEY not set — skipping news tools');
}

// Alerts (market + news 둘 다 있을 때만)
if (marketHandle && newsHandle) {
  const alertMonitor = await registerAlertTools(toolRegistry, {
    db: storage.db,
    cache: marketHandle.cache,
    registry: marketHandle.providers,
    newsAggregator: newsHandle.aggregator,
    logger,
    discordClient: discordAdapter as unknown as {
      send(msg: OutboundMessage): Promise<void>;
    },
  });
  lifecycle.register(async () => {
    await alertMonitor.stop();
  });
  logger.info('Alert monitor started');
} else {
  logger.info('market/news tools unavailable — skipping alerts');
}
```

### 검증

- Discord DM "비트코인 가격" → 실제 수치 + 출처(C 완료 후)
- Discord DM "애플 최신 뉴스 3개" → Alpha Vantage News 응답
- Discord DM "AAPL 150달러 되면 알려줘" → set_alert 확인 + `docker exec ... sqlite` 로 alerts 테이블 row 확인
- `docker logs` 에 `Market tools registered`, `News tools registered`, `Alert monitor started` 3줄

---

## Todo 4: skills-finance re-export + .env.example

### 파일 목록

| 작업 | 파일 경로                                   | LOC |
| ---- | ------------------------------------------- | --- |
| 수정 | `packages/skills-finance/src/index.ts`      | +15 |
| 수정 | `packages/skills-finance/src/news/index.ts` | +10 |
| 수정 | `.env.example`                              | +5  |

### 주의사항

- `registerNewsTools`가 현재 `Promise<void>` 반환 → `Promise<NewsSkillHandle>` 로 변경해 `aggregator` 노출.
- `createNewsAggregator` 호출 결과를 handle에 담아 반환.

### 구현 코드

#### `packages/skills-finance/src/news/index.ts` (Todo 3과 연계)

```typescript
// 상단에 추가
export interface NewsSkillHandle {
  readonly aggregator: NewsAggregator;
}

// registerNewsTools 마지막 return 추가
export async function registerNewsTools(
  registry: ToolRegistry,
  config: NewsSkillConfig,
): Promise<NewsSkillHandle> {
  // ... 기존 로직 유지 ...
  return { aggregator: newsAggregator };
}
```

#### `packages/skills-finance/src/index.ts`

```typescript
// 기존 export에 추가
export {
  registerMarketTools,
  type MarketSkillHandle,
  type MarketSkillConfig,
} from './market/index.js';

export {
  registerNewsTools,
  type NewsSkillHandle,
  type NewsSkillConfig,
  type NewsAggregator,
} from './news/index.js';

export { registerAlertTools, type AlertSkillConfig } from './alerts/index.js';
```

#### `.env.example`

```diff
 # Finance APIs (optional — enables market tools when set)
+# Alpha Vantage 단일 키로 주가·뉴스 둘 다 커버 (무료 tier: 분당 5회)
 ALPHA_VANTAGE_KEY=
 COINGECKO_API_KEY=
```

### 검증

- `pnpm build` 통과
- Todo 3의 import 경로가 모두 해결됨

---

## Todo 5: execution-adapter — 도구 호출 메타 노출

### 파일 목록

| 작업 | 파일 경로                                             | LOC |
| ---- | ----------------------------------------------------- | --- |
| 수정 | `packages/server/src/auto-reply/execution-adapter.ts` | +40 |
| 수정 | `packages/server/src/auto-reply/stages/execute.ts`    | +10 |

### 주의사항

- `ExecutionResult`는 `@finclaw/types` 또는 server 내부에 정의. 기존 필드 유지하면서 optional 필드만 추가.
- `Runner`가 반환하는 `result.messages`에서 `role:'assistant'`의 `tool_use` 블록을 순회해 `[{name, input}]`을 수집.
- `role:'tool'` 메시지의 `tool_result` 블록에서 `output`(content), `isError`, timestamp(messages.push 시점)를 수집.
- Runner 레벨 수정 없이 `RunnerExecutionAdapter.execute`에서 후처리.

### 구현 코드

#### `packages/server/src/auto-reply/execution-adapter.ts`

```typescript
// ExecutionResult 확장 (또는 types에서 수정)
export interface ToolCallRecord {
  readonly name: string;
  readonly input: unknown;
  readonly output: string;
  readonly source?: string; // provider id (e.g., 'alpha-vantage')
  readonly timestamp: number;
  readonly durationMs?: number;
  readonly isError?: boolean;
}

export interface ExecutionResult {
  readonly content: string;
  readonly usage?: TokenUsage;
  readonly toolCalls?: readonly ToolCallRecord[]; // 신규
}

// RunnerExecutionAdapter.execute 내부
async execute(ctx: PipelineMsgContext, signal: AbortSignal): Promise<ExecutionResult> {
  const startedAt = Date.now();
  const result = await this.deps.runner.execute(params, undefined, signal);

  // assistant tool_use ↔ tool tool_result 페어링
  const toolCalls: ToolCallRecord[] = [];
  for (let i = 0; i < result.messages.length; i++) {
    const m = result.messages[i];
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block.type !== 'tool_use') continue;
      // 다음 tool 메시지에서 매칭되는 tool_result 찾기
      const resultMsg = result.messages.slice(i + 1).find((r) => r.role === 'tool');
      const resultBlock = Array.isArray(resultMsg?.content)
        ? resultMsg.content.find(
            (b) => b.type === 'tool_result' && b.toolUseId === block.id,
          )
        : undefined;
      toolCalls.push({
        name: block.name,
        input: block.input,
        output: resultBlock?.type === 'tool_result' ? resultBlock.content : '',
        timestamp: startedAt, // 개별 timestamp가 필요하면 Runner 이벤트 훅 필요
        isError: resultBlock?.type === 'tool_result' ? resultBlock.isError : undefined,
      });
    }
  }

  return {
    content: extractAssistantText(result.messages.at(-1)),
    usage: result.usage,
    toolCalls: toolCalls.length ? toolCalls : undefined,
  };
}
```

### 검증

- `pnpm test` 통과 (기존 execution-adapter 테스트가 새 옵셔널 필드에 영향 없음)
- Todo 6·7에서 이 필드를 소비

---

## Todo 6: DeliverStage — 출처 footer 자동 첨부

### 파일 목록

| 작업 | 파일 경로                                          | LOC |
| ---- | -------------------------------------------------- | --- |
| 수정 | `packages/server/src/auto-reply/stages/deliver.ts` | +40 |

### 주의사항

- Footer는 **chunk split 전에** 응답 본문에 붙임 → Discord 2000자 분할 로직이 자연스럽게 처리.
- Footer 크기 상한: 토큰당 ~80자 × 5개 도구 = 400자. 이를 초과하면 앞 3개만 표시 + "(외 N개)".
- 도구 호출이 없으면(`toolCalls === undefined || toolCalls.length === 0`) footer 생략.
- Timestamp는 KST 표시 (사용자 한국어 사용). `Asia/Seoul` 하드코딩 OK.

### 구현 코드

#### `packages/server/src/auto-reply/stages/deliver.ts`

```typescript
// 기존 function deliverResponse 내부, content 추출 후·splitMessage 전

function formatSourceFooter(toolCalls: readonly ToolCallRecord[] | undefined): string {
  if (!toolCalls || toolCalls.length === 0) return '';
  const formatter = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const displayed = toolCalls.slice(0, 3);
  const lines = displayed.map((tc) => {
    const time = formatter.format(new Date(tc.timestamp));
    const src = tc.source ? `(${tc.source})` : '';
    return `📊 ${tc.name}${src} @ ${time} KST`;
  });
  if (toolCalls.length > 3) {
    lines.push(`… (외 ${toolCalls.length - 3}개 도구)`);
  }
  return '\n\n---\n' + lines.join('\n');
}

// 기존 content 변수에 append
const content = executeResult.content + formatSourceFooter(executeResult.toolCalls);
const parts = splitMessage(content, ctx.channelCapabilities?.maxMessageLength ?? 2000);
```

### 검증

- Discord DM "AAPL 주가" → 응답 하단에 `📊 get_stock_price @ 2026-04-22 20:15 KST` 형태
- 도구 여러 개 호출(예: 주가 + 뉴스)했을 때 2~3줄로 나열
- 짧은 대화("안녕")엔 footer 미부착

---

## Todo 7: messages.ts — tool_calls JSON 확장 + getToolCallHistory

### 파일 목록

| 작업 | 파일 경로                                 | LOC |
| ---- | ----------------------------------------- | --- |
| 수정 | `packages/storage/src/tables/messages.ts` | +50 |

### 주의사항

- DB 컬럼 스키마 변경 **없음**. `tool_calls` TEXT 컬럼의 JSON 내부 구조만 확장.
- 기존 레코드(`null` 또는 구 포맷)와의 하위 호환: 조회 시 both 구조 수용하도록 파싱 분기.
- `ToolCallRecord` 타입은 Todo 5의 `execution-adapter.ts`와 동일 정의 공유 (types 패키지 또는 storage에서 export).

### 구현 코드

#### `packages/storage/src/tables/messages.ts`

```typescript
// 상단
export interface ToolCallRecord {
  readonly name: string;
  readonly input: unknown;
  readonly output: string;
  readonly source?: string;
  readonly timestamp: number;
  readonly durationMs?: number;
  readonly isError?: boolean;
}

// 기존 saveMessage/insertMessage 근처에 추가
export interface GetToolCallHistoryOptions {
  readonly conversationId: string;
  readonly limit?: number;
  readonly since?: number;
}

export function getToolCallHistory(
  db: DatabaseSync,
  opts: GetToolCallHistoryOptions,
): ToolCallRecord[] {
  const rows = db
    .prepare(
      'SELECT tool_calls, created_at FROM messages ' +
        'WHERE conversation_id = ? AND tool_calls IS NOT NULL ' +
        (opts.since !== undefined ? 'AND created_at >= ? ' : '') +
        'ORDER BY created_at DESC LIMIT ?',
    )
    .all(
      opts.conversationId,
      ...(opts.since !== undefined ? [opts.since] : []),
      opts.limit ?? 100,
    ) as Array<{ tool_calls: string | null; created_at: number }>;

  const records: ToolCallRecord[] = [];
  for (const row of rows) {
    if (!row.tool_calls) continue;
    try {
      const parsed = JSON.parse(row.tool_calls) as unknown;
      if (Array.isArray(parsed)) {
        for (const tc of parsed) {
          // 구 포맷 (name만) vs 신 포맷 (full) 모두 수용
          if (tc && typeof tc === 'object' && 'name' in tc) {
            records.push(normalizeToolCallRecord(tc as Record<string, unknown>, row.created_at));
          }
        }
      }
    } catch {
      // 손상된 JSON은 스킵
    }
  }
  return records;
}

function normalizeToolCallRecord(
  raw: Record<string, unknown>,
  fallbackTimestamp: number,
): ToolCallRecord {
  return {
    name: String(raw.name),
    input: raw.input ?? {},
    output: typeof raw.output === 'string' ? raw.output : '',
    source: typeof raw.source === 'string' ? raw.source : undefined,
    timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : fallbackTimestamp,
    durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : undefined,
    isError: typeof raw.isError === 'boolean' ? raw.isError : undefined,
  };
}
```

### 검증

- `docker exec finclaw-server node -e "const db=new (require('node:sqlite').DatabaseSync)('/data/db.sqlite'); const {getToolCallHistory}=require('./packages/storage/dist/index.js'); console.log(getToolCallHistory(db,{conversationId:'<some-id>'}));"` — 정상 배열 반환
- 구 포맷 레코드 있어도 크래시 없음 (JSON.parse 실패는 continue)

---

## Todo 8: MsgContext.chatId 근본 수정

### 파일 목록

| 작업 | 파일 경로                                          | LOC |
| ---- | -------------------------------------------------- | --- |
| 수정 | `packages/types/src/message.ts`                    | +3  |
| 수정 | `packages/server/src/process/message-router.ts`    | +10 |
| 수정 | `packages/server/src/auto-reply/pipeline.ts`       | +3  |
| 수정 | `packages/server/src/auto-reply/stages/deliver.ts` | +4  |
| 수정 | `packages/channel-discord/src/sender.ts`           | -20 |
| 수정 | `packages/channel-discord/src/adapter.ts`          | 0   |

### 주의사항

- `chatId`는 **플랫폼별 채널 식별자** (Discord channel snowflake, Telegram chat_id 등). `channelId`(플러그인 종류 예: `'discord'`)와 혼동 금지.
- Discord 기준으로 `msg.channelId`(discordjs) = DM이면 DM 채널 ID, 서버면 텍스트 채널 ID. 이미 `handler.ts:47`에서 `metadata.discordChannelId`로 추출됨.
- `sender.ts`의 10003 fallback은 이제 불필요 → 삭제. `adapter.ts`의 `sendTyping` try/catch는 **방어 차원 유지** (Discord 측 일시 장애 대비).
- 기존 테스트 중 `ctx.senderId`를 mock하던 것들(`pipeline.test.ts`, `deliver.test.ts` 등)이 `ctx.chatId`도 필요해짐 — 업데이트.

### 구현 코드

#### `packages/types/src/message.ts`

```typescript
export interface MsgContext {
  // ... 기존 필드 ...

  /**
   * 플랫폼별 채널/대화방 식별자.
   * - Discord: 채널 snowflake (DM 채널 ID 또는 서버 텍스트 채널 ID)
   * - Telegram: chat_id
   * 없으면 senderId로 fallback (v1 호환).
   */
  chatId?: string;

  // ... 나머지 ...
}
```

#### `packages/server/src/process/message-router.ts` (buildContext 근처)

```typescript
// MsgContext 조립 시
const ctx: MsgContext = {
  // ... 기존 필드 ...
  chatId:
    typeof msg.metadata?.discordChannelId === 'string' ? msg.metadata.discordChannelId : undefined,
};
```

#### `packages/server/src/auto-reply/pipeline.ts` (line 136 근처)

```typescript
const ackResult = await ackStage(
  channel ?? noopChannel,
  '', // messageId
  ctx.channelId as string,
  ctx.chatId ?? ctx.senderId, // ← fallback으로 기존 동작 유지
  this.config.enableAck,
  this.deps.logger,
);
```

#### `packages/server/src/auto-reply/stages/deliver.ts` (line 48, 59)

```typescript
const outbound: OutboundMessage = {
  channelId: ctx.channelId,
  targetId: ctx.chatId ?? ctx.senderId, // ← 동일
  payloads,
  replyToMessageId: ctx.messageThreadId,
};
```

#### `packages/channel-discord/src/sender.ts`

```typescript
// resolveChannel에서 try/catch DM fallback 블록 제거. 단순화:
async function resolveChannel(
  client: Client,
  msg: OutboundMessage,
): Promise<TextChannel | DMChannel | ThreadChannel | null> {
  if (msg.threadId) {
    return client.channels.fetch(msg.threadId) as Promise<ThreadChannel>;
  }
  const channel = await client.channels.fetch(msg.targetId);
  return channel as TextChannel | DMChannel | null;
}
```

### 검증

- `pnpm test` — 실패하는 테스트 있으면 `ctx.chatId` mocking 추가
- `docker logs finclaw-server 2>&1 | grep "sendTyping failed"` → 빈 결과
- `docker logs finclaw-server 2>&1 | grep "DM channel resolve failed"` → 빈 결과
- Discord DM + 서버 멘션 양쪽 모두 정상 응답

---

## Todo 9: `!finclaw reset` / `!finclaw status` 명령어

### 파일 목록

| 작업 | 파일 경로                                             | LOC |
| ---- | ----------------------------------------------------- | --- |
| 신규 | `packages/server/src/auto-reply/commands/status.ts`   | +40 |
| 신규 | `packages/server/src/auto-reply/commands/reset.ts`    | +30 |
| 수정 | `packages/server/src/auto-reply/commands/built-in.ts` | +10 |
| 수정 | `packages/server/src/main.ts`                         | +5  |

### 주의사항

- 기존 `InMemoryCommandRegistry` + `registerBuiltInCommands` 인프라 재사용. 새 명령어는 여기에 추가 등록만.
- `commandPrefix: '!finclaw '` (main.ts)는 그대로.
- `status`: `toolRegistry.size()`, 현재 conversation 메시지 수, 활성 alerts 수. tools/toolRegistry, storage, alertStore는 명령어 시그니처가 수용 가능한 형태로 DI.
- `reset`: `deleteConversation(sessionKey)` 또는 `truncateMessages(conversationId)` 수준. 다른 사용자 세션 영향 금지 — sender 단위.
- 명령어 결과는 문자열 반환 → pipeline이 `ReplyPayload`로 포장해 채널에 전송.

### 구현 코드

#### `packages/server/src/auto-reply/commands/status.ts`

```typescript
import type { CommandHandler, CommandContext } from './registry.js';
import type { ToolRegistry } from '@finclaw/agent';
import type { Storage } from '@finclaw/storage';

export interface StatusCommandDeps {
  readonly toolRegistry: ToolRegistry;
  readonly storage: Storage;
}

export function createStatusCommand(deps: StatusCommandDeps): CommandHandler {
  return async (ctx: CommandContext) => {
    const toolCount = deps.toolRegistry.list().length;
    const messageCount = deps.storage.getMessageCount?.(ctx.sessionKey) ?? '?';
    const alertCount = deps.storage.getActiveAlertCount?.() ?? '?';
    const uptime = Math.round(process.uptime() / 60);
    return {
      ok: true,
      reply: [
        '**FinClaw 상태**',
        `- 등록 도구: ${toolCount}개`,
        `- 현재 세션 메시지: ${messageCount}건`,
        `- 활성 알림: ${alertCount}개`,
        `- 서버 업타임: ${uptime}분`,
      ].join('\n'),
    };
  };
}
```

#### `packages/server/src/auto-reply/commands/reset.ts`

```typescript
export interface ResetCommandDeps {
  readonly storage: Storage;
}

export function createResetCommand(deps: ResetCommandDeps): CommandHandler {
  return async (ctx: CommandContext) => {
    const conversationId = deriveConversationId(ctx.sessionKey);
    deps.storage.deleteConversation?.(conversationId);
    return {
      ok: true,
      reply: '대화 세션을 초기화했다. 이전 맥락은 사라졌고 새 대화를 시작한다.',
    };
  };
}
```

#### `packages/server/src/auto-reply/commands/built-in.ts`

```typescript
import { createStatusCommand } from './status.js';
import { createResetCommand } from './reset.js';

export function registerBuiltInCommands(
  registry: CommandRegistry,
  deps: { toolRegistry: ToolRegistry; storage: Storage },
): void {
  // ... 기존 명령어 ...
  registry.register('status', createStatusCommand(deps));
  registry.register('reset', createResetCommand(deps));
}
```

#### `packages/server/src/main.ts` (commandRegistry 생성 부분)

```typescript
const commandRegistry = new InMemoryCommandRegistry();
registerBuiltInCommands(commandRegistry, { toolRegistry, storage });
```

### 검증

- Discord DM `!finclaw status` → 상태 메시지 (도구 수·메시지 수 포함)
- `!finclaw reset` → 초기화 응답 → 다음 메시지부터 과거 맥락 없음 (sqlite에서 conversation row 삭제 확인)
- 기타 텍스트 "안녕"은 여전히 일반 파이프라인 타는지 확인 (명령어 prefix 없으면)

---

## Todo 10: Web 컨테이너 healthcheck override

### 파일 목록

| 작업 | 파일 경로            | LOC |
| ---- | -------------------- | --- |
| 수정 | `docker-compose.yml` | +3  |

### 주의사항

- Dockerfile의 `HEALTHCHECK`가 `/healthz`(server) 가정 — 이미지 단 하나를 재사용하기 때문. web에는 해당 엔드포인트 없음.
- 가장 단순한 해결: compose 수준에서 `disable: true`로 override. 필요시 나중에 `GET /`로 별도 체크 가능.

### 구현 코드

#### `docker-compose.yml` (web 서비스에 추가)

```yaml
web:
  image: finclaw:local
  container_name: finclaw-web
  restart: unless-stopped
  init: true
  depends_on:
    - server
  ports:
    - '${FINCLAW_WEB_PORT:-5173}:5173'
  healthcheck:
    disable: true
  command:
    - pnpm
    - --filter
    - '@finclaw/web'
    - exec
    - vite
    - preview
    - --host
    - 0.0.0.0
    - --port
    - '5173'
```

### 검증

- `docker compose up -d --build web && docker compose ps` → `finclaw-web ... Up (no healthcheck)` 형태 (unhealthy 표시 사라짐)

---

## End-to-end 검증 (전체 Todo 완료 후)

```bash
pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

- 기존 1316 + 새 테스트 = ~1330개 전부 통과

`.env`에 `ANTHROPIC_API_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `ALPHA_VANTAGE_KEY` 세팅 후:

```bash
pnpm run dev:all
```

Discord DM 순차 테스트:

| #   | 입력                         | 기대                                          |
| --- | ---------------------------- | --------------------------------------------- |
| 1   | "너 누구야"                  | 금융 파트너 자기소개 (페르소나)               |
| 2   | "AAPL 주가 얼마야"           | 실제 수치 + 하단에 `📊 get_stock_price @ ...` |
| 3   | "테슬라 최근 뉴스"           | Alpha Vantage News 기사 + 출처 footer         |
| 4   | "AAPL이 150달러 되면 알려줘" | `set_alert` 확인 응답                         |
| 5   | "내 알림 목록"               | `list_alerts` 결과                            |
| 6   | `!finclaw status`            | 상태 요약 (도구·세션·알림 카운트)             |
| 7   | `!finclaw reset`             | 초기화 확인                                   |
| 8   | "다음 주 애플 주가 얼마야?"  | "예측 불가" 거절 (환각 방지)                  |
| 9   | "AAPL 10주 매수해줘"         | "읽기 전용" 거절                              |

서버/운영 확인:

- `docker logs finclaw-server | grep -E "tools registered\|monitor started"` → 3줄
- `docker logs finclaw-server | grep "sendTyping failed"` → **빈 결과** (D1 검증)
- `docker compose ps` → server `(healthy)` + web `Up` (D3 검증)
- `docker exec finclaw-server node -e "..."` 로 `messages.tool_calls` JSON이 `{name,input,output,timestamp,...}` 구조로 저장됨 확인 (C 검증)
