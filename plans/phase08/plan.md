# Phase 8: 자동 응답 파이프라인

> 복잡도: **L** | 소스 파일: ~16 | 테스트 파일: ~8 | 합계: **~24 파일**

---

## 1. 목표

외부 채널에서 수신한 메시지를 AI 에이전트에게 전달하고, 생성된 응답을 다시 채널로 전송하는 **6단계 선형 파이프라인**을 구현한다. OpenClaw의 auto-reply 시스템(206 파일, 39.4K LOC)의 핵심 흐름을 금융 도메인에 맞게 재설계한다.

### 6단계 파이프라인

| 단계 | 이름          | 설명                                                                 |
| ---- | ------------- | -------------------------------------------------------------------- |
| 1    | **Normalize** | 멘션/URL 추출 + normalizedBody 생성                                  |
| 2    | **Command**   | 명령어 접두사 파싱 + 제어 명령어 실행. 일반 메시지와 명령어 분리     |
| 3    | **ACK**       | 수신 확인 리액션 추가 (e.g., eyes emoji). 사용자에게 처리 중 알림    |
| 4    | **Context**   | `enrichContext()`로 PipelineMsgContext 확장. 금융 컨텍스트 병렬 로딩 |
| 5    | **Execute**   | ExecutionAdapter를 통한 AI 실행 위임 + 제어 토큰 후처리              |
| 6    | **Deliver**   | 응답 포매팅 + 채널별 아웃바운드 전송                                 |

> **기존 인프라 활용으로 제거된 단계:**
>
> - ~~Gating~~ → 기존 `server/channels/gating/pipeline.ts`의 `composeGates()`에 금융 게이트만 추가
> - ~~Dispatch~~ → 기존 `server/process/message-router.ts`의 `MessageRouter` + `MessageQueue`가 이미 처리

### 핵심 컴포넌트

- **PipelineMsgContext**: 기존 `MsgContext`(`@finclaw/types`)를 확장하여 파이프라인 전용 필드(channelCapabilities, userRoles, 금융 컨텍스트 등)를 추가한 타입.
- **Command Registry**: 제어 명령어(e.g., `/help`, `/reset`, `/balance`) 등록/해석/실행.
- **ExecutionAdapter**: Phase 9 AI 실행 엔진과의 브릿지 인터페이스. Phase 8에서는 MockAdapter 제공.
- **PipelineObserver**: 선택적 관측성 인터페이스. 스테이지별 시작/완료/에러 이벤트 발행.
- **AI Control Tokens**: `HEARTBEAT_OK`, `NO_REPLY`, `SILENT_REPLY` — AI 응답 내 인밴드 시그널링.
- **Response Formatter**: 채널별 출력 형식 변환 (Markdown, 코드블록 등).

---

## 2. OpenClaw 참조

> **주의**: `openclaw_review/` 디렉토리는 현재 레포지토리에 체크인되지 않은 참조 문서이다.
> 향후 생성될 경우 아래 경로에서 확인할 수 있다.

| 참조 문서 경로                                    | 내용                                        |
| ------------------------------------------------- | ------------------------------------------- |
| `openclaw_review/deep-dive/07-auto-reply.md`      | 자동 응답 파이프라인 영문 심층 분석 (258KB) |
| `openclaw_review/docs/07.자동-응답-파이프라인.md` | 자동 응답 파이프라인 한국어 문서 (48KB)     |

**OpenClaw 대비 FinClaw 간소화 사항:**

- 206 파일 → ~24 파일로 핵심 흐름만 추출
- 8단계 → 6단계 (기존 인프라 재활용으로 Gating/Dispatch 제거)
- 스트리밍은 기본 텍스트 스트리밍만 지원 (이미지/파일 스트리밍 제외)
- AI 실행을 ExecutionAdapter로 위임 (Phase 9에서 구현)
- 금융 전용 명령어 추가 (`/price`, `/portfolio`, `/alert`)
- PipelineMsgContext에 금융 도메인 필드 추가 (marketSession, portfolioSnapshot)

---

## 3. 생성할 파일

### 소스 파일 (16개)

```
src/auto-reply/
├── index.ts                      # 자동 응답 모듈 public API
├── pipeline.ts                   # 파이프라인 오케스트레이터
├── pipeline-context.ts           # PipelineMsgContext 정의 + enrichContext()
├── control-tokens.ts             # AI 제어 토큰 상수 + 파서
├── errors.ts                     # PipelineError extends FinClawError
├── observer.ts                   # PipelineObserver 인터페이스 + DefaultPipelineObserver
├── execution-adapter.ts          # ExecutionAdapter 인터페이스 + MockAdapter
├── response-formatter.ts         # 채널별 응답 포매팅
├── stages/
│   ├── normalize.ts              # Stage 1: 멘션/URL 추출 + normalizedBody 생성
│   ├── command.ts                # Stage 2: 명령어 파싱 + 실행
│   ├── ack.ts                    # Stage 3: 수신 확인 리액션
│   ├── context.ts                # Stage 4: enrichContext() 호출
│   ├── execute.ts                # Stage 5: ExecutionAdapter 위임 + 제어 토큰 후처리
│   └── deliver.ts                # Stage 6: 응답 전송
└── commands/
    ├── registry.ts               # 명령어 레지스트리
    └── built-in.ts               # 내장 명령어 (/help, /reset, /price 등)
```

> **기존 인프라 재활용 (별도 파일 생성 불필요):**
>
> - 큐 모드 → `server/process/message-queue.ts` (220줄, QueueMode 6종 + MessageQueue)
> - 게이팅 → `server/channels/gating/pipeline.ts`의 `composeGates()`에 금융 게이트만 추가

### 테스트 파일 (8개)

```
src/auto-reply/__tests__/
├── pipeline.test.ts              # 전체 파이프라인 통합 테스트
├── pipeline-context.test.ts      # enrichContext() 테스트
├── normalize.test.ts             # 정규화 단계 테스트
├── command.test.ts               # 명령어 파싱/실행 테스트
├── control-tokens.test.ts        # 제어 토큰 파싱 테스트
├── deliver.test.ts               # 응답 전송 단계 테스트
├── execution-adapter.test.ts     # ExecutionAdapter + MockAdapter 테스트
└── ack.test.ts                   # ACK 리액션 + TypingController 테스트
```

---

## 4. 핵심 인터페이스/타입

### 4.1 Pipeline 타입

```typescript
// src/auto-reply/pipeline.ts

import type { MsgContext, OutboundMessage } from '@finclaw/types';
import type { BindingMatch } from '../process/binding-matcher';
import type { FinClawLogger } from '@finclaw/infra';
import type { ExecutionAdapter } from './execution-adapter';
import type { PipelineObserver } from './observer';
import type { CommandRegistry } from './commands/registry';
import type { FinanceContextProvider } from './pipeline-context';

/** 파이프라인 단계 인터페이스 */
export interface PipelineStage<TIn, TOut> {
  readonly name: string;
  readonly execute: (input: TIn, signal: AbortSignal) => Promise<StageResult<TOut>>;
}

/** 단계 실행 결과 */
export type StageResult<T> =
  | { readonly action: 'continue'; readonly data: T }
  | { readonly action: 'skip'; readonly reason: string }
  | { readonly action: 'abort'; readonly reason: string; readonly error?: Error };

/** StageResult 팩토리 헬퍼 */
export const StageResult = {
  continue: <T>(data: T): StageResult<T> => ({ action: 'continue', data }),
  skip: (reason: string): StageResult<never> => ({ action: 'skip', reason }),
  abort: (reason: string, error?: Error): StageResult<never> => ({
    action: 'abort',
    reason,
    error,
  }),
  isContinue: <T>(r: StageResult<T>): r is { action: 'continue'; data: T } =>
    r.action === 'continue',
} as const;

/** 파이프라인 실행 결과 */
export interface PipelineResult {
  readonly success: boolean;
  readonly stagesExecuted: readonly string[];
  readonly abortedAt?: string;
  readonly abortReason?: string;
  readonly durationMs: number;
  readonly response?: OutboundMessage;
}

/** 파이프라인 설정 */
export interface PipelineConfig {
  readonly enableAck: boolean;
  readonly commandPrefix: string;
  readonly maxResponseLength: number;
  readonly timeoutMs: number;
  /** 금융 특화: 시장 시간 외 자동 응답 비활성화 */
  readonly respectMarketHours: boolean;
}

/**
 * 파이프라인 오케스트레이터
 *
 * 진입점: MessageRouter의 onProcess 콜백
 *
 * 데이터 흐름:
 * MsgContext + BindingMatch + AbortSignal
 *   -> [normalize] -> NormalizedMessage
 *   -> [command]   -> CommandResult | PassthroughMessage (또는 skip)
 *   -> [ack]       -> AckedMessage
 *   -> [context]   -> PipelineMsgContext
 *   -> [execute]   -> ExecuteResult (via ExecutionAdapter)
 *   -> [deliver]   -> PipelineResult
 */
export class AutoReplyPipeline {
  constructor(config: PipelineConfig, deps: PipelineDependencies);

  /** MessageRouter.onProcess 콜백으로 등록할 진입점 */
  process(ctx: MsgContext, match: BindingMatch, signal: AbortSignal): Promise<void>;
}

/** 파이프라인 의존성 주입 */
export interface PipelineDependencies {
  readonly executionAdapter: ExecutionAdapter;
  readonly financeContextProvider: FinanceContextProvider;
  readonly commandRegistry: CommandRegistry;
  readonly logger: FinClawLogger;
  readonly observer?: PipelineObserver;
}
```

> **기존 인프라 직접 사용 (PipelineDependencies에서 제거됨):**
>
> - `channelPlugin` → MessageRouter가 BindingMatch를 통해 제공
> - `toolRegistry` → Phase 9 ExecutionAdapter 내부에서 사용
> - `sessionManager` → MessageRouter가 SessionKey를 MsgContext에 이미 설정
> - `modelResolver` → Phase 9 ExecutionAdapter 내부에서 사용
> - `hookRunner` → 기존 `createHookRunner()` 타입(`VoidHookRunner`, `ModifyingHookRunner`)을 직접 사용

### 4.2 PipelineMsgContext

```typescript
// src/auto-reply/pipeline-context.ts

import type { MsgContext, ChannelCapabilities, Timestamp } from '@finclaw/types';
import type { Portfolio, Alert, NewsItem } from '@finclaw/types';

/**
 * 파이프라인 전용 메시지 컨텍스트
 *
 * 기존 MsgContext(~22필드)를 상속하고, 파이프라인에서 필요한 확장 필드만 추가한다.
 *
 * 상속되는 MsgContext 필드 (from @finclaw/types/message.ts):
 *   body, bodyForAgent, rawBody, commandBody?,
 *   from, senderId, senderName, senderUsername?,
 *   provider, channelId (ChannelId), chatType (ChatType),
 *   sessionKey (SessionKey), parentSessionKey?,
 *   accountId, groupSubject?, groupMembers?,
 *   messageThreadId?, isForum?, media? (MediaAttachment[]),
 *   timestamp (Timestamp),
 *   isHeartbeat?, isCommand?, commandAuthorized?
 */
export interface PipelineMsgContext extends MsgContext {
  // --- 정규화 결과 ---
  readonly normalizedBody: string;
  readonly mentions: readonly string[];
  readonly urls: readonly string[];

  // --- 채널 확장 ---
  readonly channelCapabilities: ChannelCapabilities;

  // --- 사용자 확장 ---
  readonly userRoles: readonly string[];
  readonly isAdmin: boolean;

  // --- AI 확장 ---
  readonly resolvedModel?: string;

  // --- 금융 도메인 컨텍스트 ---
  readonly marketSession?: MarketSession;
  readonly activeAlerts?: readonly Alert[];
  readonly portfolioSnapshot?: Portfolio | null;
  readonly watchlist?: readonly string[];
  readonly newsContext?: readonly NewsItem[];
}

/** 시장 세션 상태 */
export interface MarketSession {
  readonly isOpen: boolean;
  readonly market: string; // 'KRX' | 'NYSE' | 'NASDAQ' | ...
  readonly nextOpenAt: Timestamp | null;
  readonly timezone: string;
}

/**
 * 금융 컨텍스트 프로바이더
 *
 * enrichContext()에서 사용하는 금융 데이터 조회 인터페이스.
 */
export interface FinanceContextProvider {
  getActiveAlerts(senderId: string, signal: AbortSignal): Promise<readonly Alert[]>;
  getPortfolio(senderId: string, signal: AbortSignal): Promise<Portfolio | null>;
  getRecentNews(signal: AbortSignal): Promise<readonly NewsItem[]>;
  getMarketSession(): MarketSession;
  getWatchlist(senderId: string): Promise<readonly string[]>;
}

/**
 * MsgContext → PipelineMsgContext 확장
 *
 * MsgContextBuilder를 사용하지 않고, 순수 함수로 컨텍스트를 확장한다.
 * 금융 데이터는 Promise.allSettled로 병렬 로딩하며, 개별 실패를 허용한다.
 */
export async function enrichContext(
  ctx: MsgContext,
  deps: EnrichContextDeps,
  signal: AbortSignal,
): Promise<PipelineMsgContext>;

export interface EnrichContextDeps {
  readonly financeContextProvider: FinanceContextProvider;
  readonly channelCapabilities: ChannelCapabilities;
}
```

> **타입 필드명 불일치 수정 (기존 plan.md 대비):**
>
> | 기존 plan.md (잘못됨)        | 실제 @finclaw/types         | 비고                        |
> | ---------------------------- | --------------------------- | --------------------------- |
> | `messageId: string`          | `id: string`                | InboundMessage              |
> | `channelId: string`          | `channelId: ChannelId`      | Brand 타입                  |
> | `authorId` / `authorName`    | `senderId` / `senderName`   | InboundMessage + MsgContext |
> | `content: string`            | `body: string`              | MsgContext + InboundMessage |
> | `attachments: Attachment[]`  | `media?: MediaAttachment[]` | 선택적 + 다른 타입명        |
> | `timestamp: Date`            | `timestamp: Timestamp`      | Brand\<number\> 타입        |
> | `chatType: 'direct-message'` | `chatType: 'direct'`        | ChatType 리터럴 값          |

### 4.3 Command System

```typescript
// src/auto-reply/commands/registry.ts

import type { MsgContext } from '@finclaw/types';

/** 명령어 정의 */
export interface CommandDefinition {
  readonly name: string; // e.g., 'help', 'price', 'portfolio'
  readonly aliases: readonly string[];
  readonly description: string;
  readonly usage: string; // e.g., '/price AAPL'
  readonly category: CommandCategory;
  readonly requiredRoles?: readonly string[];
  readonly cooldownMs?: number;
}

export type CommandCategory =
  | 'general' // 일반 (/help, /reset)
  | 'finance' // 금융 (/price, /portfolio, /alert)
  | 'admin' // 관리 (/config, /status)
  | 'debug'; // 디버그 (/debug, /context)

/** 명령어 실행 함수 */
export type CommandExecutor = (args: readonly string[], ctx: MsgContext) => Promise<CommandResult>;

/** 명령어 실행 결과 */
export interface CommandResult {
  readonly content: string;
  readonly ephemeral: boolean; // 명령어 실행자에게만 표시
}

/** 파싱된 명령어 */
export interface ParsedCommand {
  readonly name: string;
  readonly args: readonly string[];
  readonly raw: string;
}

/** 명령어 레지스트리 인터페이스 */
export interface CommandRegistry {
  register(definition: CommandDefinition, executor: CommandExecutor): void;
  unregister(name: string): boolean;
  get(name: string): { definition: CommandDefinition; executor: CommandExecutor } | undefined;
  list(): readonly CommandDefinition[];
  listByCategory(category: CommandCategory): readonly CommandDefinition[];

  /** 명령어 파싱 */
  parse(content: string, prefix: string): ParsedCommand | null;

  /** 명령어 실행 */
  execute(parsed: ParsedCommand, ctx: MsgContext): Promise<CommandResult>;
}
```

### 4.4 AI Control Tokens

```typescript
// src/auto-reply/control-tokens.ts

/**
 * AI 응답 내 인밴드 제어 토큰
 *
 * AI가 응답에 이 토큰들을 포함시켜 파이프라인에 특수 동작을 요청한다.
 * 제어 토큰은 최종 사용자에게는 노출되지 않는다.
 */
export const CONTROL_TOKENS = {
  /** 생성이 정상적으로 진행 중임을 표시 (long-running 작업) */
  HEARTBEAT_OK: '<<HEARTBEAT_OK>>',

  /** 이 메시지에 응답하지 않겠다는 AI의 명시적 결정 */
  NO_REPLY: '<<NO_REPLY>>',

  /** 응답은 하지만 채널에 메시지를 보내지 않음 (로깅만) */
  SILENT_REPLY: '<<SILENT_REPLY>>',

  /** 사용자에게 추가 입력을 요청 */
  NEED_INPUT: '<<NEED_INPUT>>',

  /** 금융 특화: 면책 조항 자동 첨부 플래그 */
  ATTACH_DISCLAIMER: '<<ATTACH_DISCLAIMER>>',

  /** 금융 특화: 이 응답에 실시간 시세를 첨부 */
  ATTACH_QUOTE: '<<ATTACH_QUOTE>>',
} as const;

export type ControlToken = (typeof CONTROL_TOKENS)[keyof typeof CONTROL_TOKENS];

/**
 * AI 응답에서 제어 토큰 추출
 *
 * 알고리즘:
 * 1. 응답 텍스트에서 모든 <<TOKEN>> 패턴 탐지
 * 2. 알려진 제어 토큰과 매칭
 * 3. 제어 토큰을 응답에서 제거
 * 4. 클린 텍스트 + 추출된 토큰 목록 반환
 */
export function extractControlTokens(response: string): ControlTokenResult;

export interface ControlTokenResult {
  readonly cleanContent: string;
  readonly tokens: readonly ControlToken[];
  readonly hasNoReply: boolean;
  readonly hasSilentReply: boolean;
  readonly hasHeartbeat: boolean;
  readonly needsDisclaimer: boolean;
  readonly needsQuote: boolean;
}
```

### 4.5 Response Formatter

```typescript
// src/auto-reply/response-formatter.ts

/** 포매팅 옵션 */
export interface FormatOptions {
  readonly maxLength: number;
  readonly supportedFormats: readonly SupportedFormat[];
  readonly codeBlockStyle: 'fenced' | 'indented';
  /** 금융 특화: 숫자 포매팅 로케일 */
  readonly numberLocale: string;
  /** 금융 특화: 통화 기호 */
  readonly currencySymbol: string;
}

export type SupportedFormat = 'markdown' | 'plain-text' | 'html';

/** 포매팅된 응답 */
export interface FormattedResponse {
  readonly parts: readonly ResponsePart[];
  readonly totalLength: number;
  readonly wasSplit: boolean;
}

/** 응답 파트 (긴 응답을 분할할 때 사용) */
export interface ResponsePart {
  readonly content: string;
  readonly index: number;
  readonly isLast: boolean;
}

/**
 * 채널별 응답 포매팅
 *
 * 처리 단계:
 * 1. 제어 토큰 제거 (이미 extractControlTokens에서 처리)
 * 2. 금융 데이터 포매팅 (숫자 소수점, 통화, 퍼센트)
 * 3. 코드블록 변환 (채널 지원 여부에 따라)
 * 4. 메시지 길이 검사 -> 초과 시 분할
 * 5. 면책 조항 첨부 (needsDisclaimer일 때)
 */
export function formatResponse(
  content: string,
  controlTokens: ControlTokenResult,
  options: FormatOptions,
): FormattedResponse;

/** 금융 숫자 포매팅 */
export function formatFinancialNumber(
  value: number,
  options: {
    locale?: string;
    currency?: string;
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
    showSign?: boolean;
  },
): string;

/** 긴 메시지 분할 */
export function splitMessage(content: string, maxLength: number): readonly string[];
```

---

## 5. 구현 상세

### 5.1 Pipeline Orchestrator

```typescript
// src/auto-reply/pipeline.ts

import type { MsgContext, OutboundMessage } from '@finclaw/types';
import type { BindingMatch } from '../process/binding-matcher';
import { PipelineError } from './errors';

export class AutoReplyPipeline {
  private readonly stages: PipelineStageEntry[];

  constructor(
    private readonly config: PipelineConfig,
    private readonly deps: PipelineDependencies,
  ) {
    this.stages = this.buildStages();
  }

  private buildStages(): PipelineStageEntry[] {
    return [
      { name: 'normalize', fn: this.normalizeStage.bind(this) },
      { name: 'command', fn: this.commandStage.bind(this) },
      { name: 'ack', fn: this.ackStage.bind(this) },
      { name: 'context', fn: this.contextStage.bind(this) },
      { name: 'execute', fn: this.executeStage.bind(this) },
      { name: 'deliver', fn: this.deliverStage.bind(this) },
    ];
  }

  /**
   * MessageRouter.onProcess 콜백으로 등록할 진입점
   *
   * AbortSignal.any()로 외부 시그널(Router 취소)과 파이프라인 타임아웃을 결합.
   * 기존 infra/fetch.ts의 AbortSignal 패턴 재사용.
   */
  async process(ctx: MsgContext, match: BindingMatch, signal: AbortSignal): Promise<void> {
    const startTime = performance.now();
    const stagesExecuted: string[] = [];

    // AbortSignal.any: 외부 취소 + 파이프라인 타임아웃 결합
    const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);

    this.deps.observer?.onPipelineStart?.(ctx);

    let current: unknown = ctx;

    try {
      for (const stage of this.stages) {
        if (combinedSignal.aborted) {
          const result: PipelineResult = {
            success: false,
            stagesExecuted,
            abortedAt: stage.name,
            abortReason: 'Signal aborted',
            durationMs: performance.now() - startTime,
          };
          this.deps.logger.warn('Pipeline aborted', { stage: stage.name });
          this.deps.observer?.onPipelineComplete?.(ctx, result);
          return;
        }

        this.deps.observer?.onStageStart?.(stage.name, ctx);

        const result = await stage.fn(current, combinedSignal);
        stagesExecuted.push(stage.name);

        switch (result.action) {
          case 'continue':
            current = result.data;
            this.deps.observer?.onStageComplete?.(stage.name, result);
            break;
          case 'skip':
            this.deps.observer?.onStageComplete?.(stage.name, result);
            this.deps.observer?.onPipelineComplete?.(ctx, {
              success: true,
              stagesExecuted,
              durationMs: performance.now() - startTime,
            });
            return;
          case 'abort':
            this.deps.observer?.onStageComplete?.(stage.name, result);
            this.deps.observer?.onPipelineComplete?.(ctx, {
              success: false,
              stagesExecuted,
              abortedAt: stage.name,
              abortReason: result.reason,
              durationMs: performance.now() - startTime,
            });
            return;
        }
      }

      this.deps.observer?.onPipelineComplete?.(ctx, {
        success: true,
        stagesExecuted,
        durationMs: performance.now() - startTime,
        response: current as OutboundMessage,
      });
    } catch (error) {
      this.deps.observer?.onPipelineError?.(ctx, error as Error);
      throw error;
    }
  }

  // ... 각 스테이지 구현은 아래에서 상세히 설명
}

interface PipelineStageEntry {
  readonly name: string;
  readonly fn: (input: unknown, signal: AbortSignal) => Promise<StageResult<unknown>>;
}
```

### 5.2 Stage 1: Normalize

```typescript
// src/auto-reply/stages/normalize.ts

import type { MsgContext } from '@finclaw/types';

/**
 * 정규화 결과 필드
 *
 * 주의: 봇 필터링, 빈 메시지 필터링, 메시지 dedupe는 MessageRouter가 이미 처리한다.
 * Normalize 스테이지는 멘션/URL 추출과 normalizedBody 생성만 담당한다.
 *
 * 필드명은 @finclaw/types의 실제 타입을 따른다:
 * - ctx.body (not ctx.content)
 * - ctx.senderId (not ctx.authorId)
 * - ctx.media (not ctx.attachments)
 */
export interface NormalizedMessage {
  readonly normalizedBody: string; // 트림 + 공백 정규화
  readonly mentions: readonly string[]; // 추출된 멘션 ID 목록
  readonly urls: readonly string[]; // 추출된 URL 목록
}

/**
 * 메시지 정규화
 *
 * 처리:
 * 1. 콘텐츠 트림 + 연속 공백 정규화
 * 2. 멘션 태그 추출 (<@userId> 패턴)
 * 3. URL 추출
 * 4. 채널별 특수 마크업 제거
 */
export function normalizeMessage(ctx: MsgContext): StageResult<NormalizedMessage> {
  const body = ctx.body.trim();

  // 멘션 추출
  const mentionPattern = /<@!?(\d+)>/g;
  const mentions: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(body)) !== null) {
    mentions.push(match[1]);
  }

  // URL 추출
  const urlPattern = /https?:\/\/[^\s<>]+/g;
  const urls = body.match(urlPattern) ?? [];

  return StageResult.continue({
    normalizedBody: body.replace(/\s+/g, ' '),
    mentions,
    urls,
  });
}
```

### 5.3 Stage 2: Command

````typescript
// src/auto-reply/stages/command.ts

import type { MsgContext } from '@finclaw/types';

/**
 * 명령어 단계
 *
 * 처리:
 * 1. 메시지가 명령어 접두사로 시작하는지 확인
 * 2. 코드 펜스 내부의 명령어는 무시 (isInsideCodeFence)
 * 3. CommandRegistry에서 명령어 조회
 * 4. 매칭되면: 명령어 실행 -> skip (AI 호출 불필요)
 * 5. 미매칭이면: continue (일반 메시지로 AI에 전달)
 */
export async function commandStage(
  normalizedBody: string,
  registry: CommandRegistry,
  prefix: string,
  ctx: MsgContext,
): Promise<StageResult<MsgContext | CommandResult>> {
  // 코드 펜스 내부의 명령어는 무시
  if (isInsideCodeFence(normalizedBody, prefix)) {
    return StageResult.continue(ctx);
  }

  const parsed = registry.parse(normalizedBody, prefix);

  if (!parsed) {
    return StageResult.continue(ctx);
  }

  const command = registry.get(parsed.name);
  if (!command) {
    return StageResult.continue(ctx); // AI에게 전달하여 자연어로 처리
  }

  // 권한 검사
  if (command.definition.requiredRoles?.length) {
    // 권한 부족 시 skip
    return StageResult.skip(`Insufficient permissions for command: ${parsed.name}`);
  }

  // 명령어 실행
  const result = await command.executor(parsed.args, ctx);

  // 명령어 응답을 채널에 전송 (deliver 스테이지를 거치지 않고 직접)
  return StageResult.skip(`Command executed: ${parsed.name}`);
}

/** 코드 펜스(```) 내부에 있는 명령어인지 판별 */
function isInsideCodeFence(body: string, prefix: string): boolean {
  const prefixIndex = body.indexOf(prefix);
  if (prefixIndex === -1) return false;

  const beforePrefix = body.slice(0, prefixIndex);
  const fenceCount = (beforePrefix.match(/```/g) ?? []).length;
  return fenceCount % 2 === 1; // 홀수개 = 열린 코드 펜스 안
}
````

### 5.4 Stage 4: Context

```typescript
// src/auto-reply/stages/context.ts

import type { MsgContext } from '@finclaw/types';
import type { PipelineMsgContext, EnrichContextDeps } from '../pipeline-context';
import { enrichContext } from '../pipeline-context';
import type { NormalizedMessage } from './normalize';

/**
 * 컨텍스트 확장 단계
 *
 * MsgContext → PipelineMsgContext 확장.
 * 금융 데이터는 enrichContext() 내부에서 Promise.allSettled로 병렬 로딩한다
 * (3초 타임아웃, 개별 실패 허용).
 */
export async function contextStage(
  ctx: MsgContext,
  normalized: NormalizedMessage,
  deps: EnrichContextDeps,
  signal: AbortSignal,
): Promise<StageResult<PipelineMsgContext>> {
  try {
    const enriched = await enrichContext(ctx, deps, signal);

    return StageResult.continue({
      ...enriched,
      normalizedBody: normalized.normalizedBody,
      mentions: normalized.mentions,
      urls: normalized.urls,
    });
  } catch (error) {
    return StageResult.abort(
      `Failed to enrich context: ${(error as Error).message}`,
      error as Error,
    );
  }
}
```

> **`enrichContext()` 내부의 금융 데이터 로딩:**
>
> ```typescript
> // Promise.allSettled + 3초 타임아웃 + 개별 실패 허용
> const financeSignal = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
>
> const [alertsResult, portfolioResult, newsResult] = await Promise.allSettled([
>   deps.financeContextProvider.getActiveAlerts(ctx.senderId, financeSignal),
>   deps.financeContextProvider.getPortfolio(ctx.senderId, financeSignal),
>   deps.financeContextProvider.getRecentNews(financeSignal),
> ]);
>
> // 개별 실패 시 undefined로 degraded — 파이프라인은 계속 진행
> ```

### 5.5 Stage 5: Execute

```typescript
// src/auto-reply/stages/execute.ts

import type { ExecutionAdapter } from '../execution-adapter';
import type { PipelineMsgContext } from '../pipeline-context';
import { extractControlTokens, type ControlTokenResult } from '../control-tokens';

/**
 * AI 실행 단계
 *
 * Phase 8 책임: ExecutionAdapter에 위임 + 제어 토큰 후처리
 * Phase 9 책임: AI API 호출, 도구 루프, 세션 write lock, 스트리밍
 *
 * 기존 plan의 AI 직접 호출/도구 루프/write lock 코드(~100줄)를 모두 제거.
 * ExecutionAdapter.execute(ctx, signal) 한 줄로 위임.
 */
export async function executeStage(
  ctx: PipelineMsgContext,
  adapter: ExecutionAdapter,
  signal: AbortSignal,
): Promise<StageResult<ExecuteStageResult>> {
  const raw = await adapter.execute(ctx, signal);

  // 제어 토큰 추출 (Phase 8 책임)
  const tokenResult = extractControlTokens(raw.content);

  if (tokenResult.hasNoReply) {
    return StageResult.skip('AI decided not to reply (NO_REPLY token)');
  }

  return StageResult.continue({
    content: tokenResult.cleanContent,
    controlTokens: tokenResult,
    usage: raw.usage,
  });
}

export interface ExecuteStageResult {
  readonly content: string;
  readonly controlTokens: ControlTokenResult;
  readonly usage?: { inputTokens: number; outputTokens: number };
}
```

### 5.6 Stage 6: Deliver

```typescript
// src/auto-reply/stages/deliver.ts

import type { OutboundMessage, ReplyPayload, ChannelPlugin } from '@finclaw/types';
import type { FinClawLogger } from '@finclaw/infra';
import type { PipelineMsgContext } from '../pipeline-context';
import type { ExecuteStageResult } from './execute';
import { splitMessage } from '../response-formatter';

/**
 * 응답 전송 단계
 *
 * OutboundMessage 구조: { channelId, targetId, payloads: [{ text, replyToId }] }
 * 직렬 디스패치 (Promise chain): 순서 보장 + 개별 실패 격리
 */
export async function deliverResponse(
  executeResult: ExecuteStageResult,
  ctx: PipelineMsgContext,
  channel: Pick<ChannelPlugin, 'send'>,
  logger: FinClawLogger,
): Promise<StageResult<OutboundMessage>> {
  // SILENT_REPLY 처리
  if (executeResult.controlTokens.hasSilentReply) {
    logger.info('Silent reply — logged only', { sessionKey: ctx.sessionKey });
    return StageResult.skip('Silent reply (logged only)');
  }

  let content = executeResult.content;

  // 면책 조항 첨부
  if (executeResult.controlTokens.needsDisclaimer) {
    content +=
      '\n\n---\n' +
      '_본 정보는 투자 조언이 아니며, 투자 결정은 본인의 판단과 책임 하에 이루어져야 합니다._';
  }

  // 메시지 분할 (채널 maxMessageLength 기반)
  const parts = splitMessage(content, ctx.channelCapabilities?.maxMessageLength ?? 2000);

  // OutboundMessage 조립
  const payloads: ReplyPayload[] = parts.map((text) => ({
    text,
    replyToId: ctx.messageThreadId,
  }));

  const outbound: OutboundMessage = {
    channelId: ctx.channelId,
    targetId: ctx.senderId,
    payloads,
    replyToMessageId: ctx.messageThreadId,
  };

  // 직렬 전송 — 순서 보장 + 개별 실패 격리
  if (channel.send) {
    for (const [i, payload] of payloads.entries()) {
      try {
        await channel.send({
          channelId: ctx.channelId,
          targetId: ctx.senderId,
          payloads: [payload],
        });
      } catch (error) {
        logger.error(`Deliver failed for part ${i + 1}/${payloads.length}`, { error });
        // 개별 실패 격리 — 나머지 파트는 계속 전송
      }
    }
  }

  return StageResult.continue(outbound);
}
```

### 5.7 Command Registry 내장 명령어

```typescript
// src/auto-reply/commands/built-in.ts

/** 내장 명령어 등록 */
export function registerBuiltInCommands(registry: CommandRegistry): void {
  // /help - 도움말
  registry.register(
    {
      name: 'help',
      aliases: ['h', '도움말'],
      description: '사용 가능한 명령어 목록을 표시합니다',
      usage: '/help [명령어]',
      category: 'general',
    },
    async (args) => {
      if (args.length > 0) {
        const cmd = registry.get(args[0]);
        if (cmd) {
          return {
            content: `**/${cmd.definition.name}**\n${cmd.definition.description}\n사용법: \`${cmd.definition.usage}\``,
            ephemeral: true,
          };
        }
        return { content: `알 수 없는 명령어: ${args[0]}`, ephemeral: true };
      }
      const commands = registry.list();
      let output = '**사용 가능한 명령어:**\n\n';
      for (const cmd of commands) {
        output += `  \`/${cmd.name}\` - ${cmd.description}\n`;
      }
      return { content: output, ephemeral: true };
    },
  );

  // /reset - 세션 초기화
  registry.register(
    {
      name: 'reset',
      aliases: ['clear', '초기화'],
      description: '현재 대화 세션을 초기화합니다',
      usage: '/reset',
      category: 'general',
    },
    async () => ({
      content: '대화 세션이 초기화되었습니다. 새로운 대화를 시작해 주세요.',
      ephemeral: false,
    }),
  );

  // /price - 시세 조회 (금융 특화)
  registry.register(
    {
      name: 'price',
      aliases: ['시세', 'quote'],
      description: '종목의 현재 시세를 조회합니다',
      usage: '/price AAPL (또는 /price 삼성전자)',
      category: 'finance',
    },
    async (args) => {
      if (args.length === 0) {
        return { content: '종목 심볼을 입력해 주세요. 예: `/price AAPL`', ephemeral: true };
      }
      return {
        content: `${args[0]} 시세 조회 기능은 skills-finance 모듈 연동 후 활성화됩니다.`,
        ephemeral: false,
      };
    },
  );

  // /portfolio - 포트폴리오 조회 (금융 특화)
  registry.register(
    {
      name: 'portfolio',
      aliases: ['포트폴리오', 'pf'],
      description: '현재 포트폴리오 요약을 표시합니다',
      usage: '/portfolio',
      category: 'finance',
    },
    async () => ({
      content: '포트폴리오 조회 기능은 skills-finance 모듈 연동 후 활성화됩니다.',
      ephemeral: false,
    }),
  );

  // /alert - 알림 설정 (금융 특화)
  registry.register(
    {
      name: 'alert',
      aliases: ['알림'],
      description: '가격 알림을 설정합니다',
      usage: '/alert AAPL > 200 (AAPL이 $200 이상일 때 알림)',
      category: 'finance',
    },
    async (args) => {
      if (args.length < 3) {
        return {
          content: '사용법: `/alert 종목 조건 가격`\n예: `/alert AAPL > 200`',
          ephemeral: true,
        };
      }
      return {
        content: '알림 설정 기능은 skills-finance 모듈 연동 후 활성화됩니다.',
        ephemeral: false,
      };
    },
  );
}
```

---

## 6. 선행 조건

| Phase                   | 구체적 산출물                                                                    | 필요 이유                                            |
| ----------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Phase 1 (타입 시스템)   | `InboundMessage`, `OutboundMessage`, `MsgContext`, `ChatType`, `MediaAttachment` | 파이프라인 전체의 입출력 타입                        |
| Phase 2 (인프라)        | `FinClawLogger`, `FinClawError`, `EventBus`, `AbortSignal.any()` 패턴            | 로깅, 에러 처리, 이벤트 발행, 타임아웃               |
| Phase 3 (설정)          | `PipelineConfig`, `CommandConfig` zod 스키마                                     | 파이프라인 설정, 명령어 접두사                       |
| Phase 4 (메시지 라우팅) | `MessageRouter` (onProcess 콜백), `MessageQueue`, `Dedupe`, `BindingMatch`       | 파이프라인 진입점, 큐 관리, 중복 방지                |
| Phase 5 (채널/플러그인) | `ChannelPlugin` (send, addReaction, sendTyping), `composeGates()`, Hook system   | 게이팅, ACK 리액션, 전송, 훅                         |
| Phase 6 (모델 선택)     | `resolveModel()`, 정규화된 응답 타입                                             | AI 실행 시 모델 해석 (Phase 9 ExecutionAdapter 내부) |
| Phase 7 (도구/세션)     | `ToolRegistry`, `acquireWriteLock()`, `buildSystemPrompt()`, `compactContext()`  | Phase 9 ExecutionAdapter 내부에서 사용               |

---

## 7. 산출물 및 검증

### 테스트 가능한 결과물

| #   | 산출물                                | 검증 방법                                                               |
| --- | ------------------------------------- | ----------------------------------------------------------------------- |
| 1   | `AutoReplyPipeline.process()`         | 통합 테스트: 전체 6단계 정상 흐름, mock 채널/ExecutionAdapter           |
| 2   | Stage 1: `normalizeMessage()`         | 단위 테스트: 멘션/URL 추출, normalizedBody 생성                         |
| 3   | Stage 2: 명령어 파싱/실행             | 단위 테스트: `/help`, `/price AAPL`, 코드 펜스 내 명령어 무시, 권한     |
| 4   | Stage 3: ACK 리액션                   | 단위 테스트: addReaction 호출, TypingController 3-상태, TTL 보호        |
| 5   | Stage 4: `enrichContext()`            | 단위 테스트: 금융 데이터 병렬 로딩, 개별 실패 시 degraded 동작          |
| 6   | Stage 5: Execute (ExecutionAdapter)   | 단위 테스트: MockAdapter, 제어 토큰 후처리, NO_REPLY → skip             |
| 7   | Stage 6: `deliverResponse()`          | 단위 테스트: 일반 전송, SILENT_REPLY, 메시지 분할, 면책 조항, 직렬 전송 |
| 8   | `extractControlTokens()`              | 단위 테스트: 각 토큰 추출, 복합 토큰, 토큰 없는 응답                    |
| 9   | `CommandRegistry`                     | 단위 테스트: 등록, 해제, 별칭 조회, 카테고리 필터                       |
| 10  | `formatResponse()` + `splitMessage()` | 단위 테스트: 길이 제한 분할, 금융 숫자 포매팅, 코드블록 보존            |
| 11  | Pipeline early exit                   | 통합 테스트: 각 단계에서 skip/abort 시 정상 종료 확인                   |
| 12  | Pipeline 타임아웃                     | 단위 테스트: AbortSignal.any() 타임아웃 시 abort 결과 반환              |
| 13  | `PipelineError`                       | 단위 테스트: 에러 코드 분류, FinClawError 상속 확인                     |
| 14  | `PipelineObserver`                    | 단위 테스트: 스테이지별 이벤트 발행, DefaultPipelineObserver 로깅       |

### 검증 명령어

```bash
# 단위 테스트
pnpm test -- --filter='src/auto-reply/__tests__/**'

# 통합 테스트 (파이프라인 전체 흐름)
pnpm test -- --filter='src/auto-reply/__tests__/pipeline.test.ts'

# 타입 체크
pnpm typecheck

# 커버리지 (목표: branches 75%+, 통합 테스트 위주)
pnpm test:coverage -- --filter='src/auto-reply/**'
```

---

## 8. 복잡도 및 예상 파일 수

| 항목            | 값                                            |
| --------------- | --------------------------------------------- |
| **복잡도**      | **L**                                         |
| **소스 파일**   | 16개 (`루트` 8 + `stages/` 6 + `commands/` 2) |
| **테스트 파일** | 8개                                           |
| **총 파일 수**  | **~24개**                                     |
| **예상 LOC**    | 소스 ~1,500 / 테스트 ~1,200 / 합계 ~2,700     |
| **새 의존성**   | 없음 (Phase 2-7 의존성 재활용)                |

### 복잡도 근거 (L)

- 6단계 파이프라인은 각 단계가 독립적이나, 전체 흐름 통합 테스트가 까다로움
- 기존 인프라(MessageRouter, MessageQueue, Gating, Hooks)와의 통합 지점이 많음
- 금융 도메인 컨텍스트의 비동기 병렬 로딩 + 개별 실패 허용 로직
- ExecutionAdapter 인터페이스 설계는 Phase 9와의 계약이므로 신중한 설계 필요
- 제어 토큰 파싱은 단순하나, 응답 내 토큰 위치/중복/중첩 케이스 처리 필요
- Phase 2~7의 산출물에 의존하므로 통합 지점이 가장 많은 phase

---

## 9. 보강 사항

### 9.1 Phase 8 ↔ Phase 9 책임 경계

```typescript
// src/auto-reply/execution-adapter.ts

import type { PipelineMsgContext } from './pipeline-context';

/**
 * Phase 9 AI 실행 엔진과의 브릿지 인터페이스
 *
 * Phase 8은 "무엇을 실행할지" 결정하고, Phase 9는 "어떻게 실행할지" 담당한다.
 */
export interface ExecutionAdapter {
  execute(ctx: PipelineMsgContext, signal: AbortSignal): Promise<ExecutionResult>;
}

export interface ExecutionResult {
  readonly content: string;
  readonly usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Phase 8 테스트용 Mock 어댑터
 * Phase 9 구현 전까지 사용.
 */
export class MockExecutionAdapter implements ExecutionAdapter {
  constructor(private readonly defaultResponse: string = 'Mock response') {}

  async execute(_ctx: PipelineMsgContext, _signal: AbortSignal): Promise<ExecutionResult> {
    return {
      content: this.defaultResponse,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}
```

**책임 분리 테이블:**

| 책임                 | Phase 8 (파이프라인) | Phase 9 (실행 엔진) |
| -------------------- | :------------------: | :-----------------: |
| 메시지 정규화        |          O           |                     |
| 명령어 파싱/실행     |          O           |                     |
| ACK 리액션           |          O           |                     |
| 컨텍스트 확장        |          O           |                     |
| AI API 호출          |                      |          O          |
| 도구 호출 루프       |                      |          O          |
| 세션 write lock      |                      |          O          |
| 스트리밍 처리        |                      |          O          |
| 제어 토큰 후처리     |          O           |                     |
| 응답 포매팅/전송     |          O           |                     |
| 모델 해석            |                      |          O          |
| 시스템 프롬프트 생성 |                      |          O          |

### 9.2 에러 핸들링 전략

```typescript
// src/auto-reply/errors.ts

import { FinClawError } from '@finclaw/infra';

/** 파이프라인 에러 코드 */
export type PipelineErrorCode =
  | 'PIPELINE_TIMEOUT' // 전체 파이프라인 타임아웃
  | 'STAGE_FAILED' // 개별 스테이지 실패
  | 'CONTEXT_BUILD_FAILED' // 컨텍스트 구축 실패
  | 'EXECUTION_FAILED' // ExecutionAdapter 실행 실패
  | 'DELIVERY_FAILED'; // 응답 전송 실패

export class PipelineError extends FinClawError {
  constructor(
    message: string,
    code: PipelineErrorCode,
    opts?: { cause?: Error; details?: Record<string, unknown> },
  ) {
    super(message, code, {
      statusCode: 500,
      isOperational: true,
      ...opts,
    });
    this.name = 'PipelineError';
  }
}
```

**3-계층 에러 분류:**

| 계층        | 동작                         | 예시                             |
| ----------- | ---------------------------- | -------------------------------- |
| Recoverable | 재시도 또는 fallback         | 금융 API 타임아웃 → 캐시 사용    |
| Degradable  | 기능 축소 후 계속            | 포트폴리오 로딩 실패 → 없이 진행 |
| Fatal       | 파이프라인 abort + 에러 로깅 | 채널 전송 불가 → abort           |

**사용자 대면 메시지 매핑:**

| PipelineErrorCode  | 사용자 메시지                                     |
| ------------------ | ------------------------------------------------- |
| `PIPELINE_TIMEOUT` | "처리 시간이 초과되었습니다. 다시 시도해 주세요." |
| `EXECUTION_FAILED` | "응답 생성 중 문제가 발생했습니다."               |
| `DELIVERY_FAILED`  | (전송 불가이므로 사용자에게 도달 불가 — 로깅만)   |

### 9.3 관측성 (PipelineObserver)

```typescript
// src/auto-reply/observer.ts

import type { MsgContext } from '@finclaw/types';
import type { FinClawLogger, TypedEmitter, FinClawEventMap } from '@finclaw/infra';
import type { PipelineResult, StageResult } from './pipeline';

/**
 * 파이프라인 관측성 인터페이스
 *
 * 선택적(optional) DI — deps.observer? 로 주입.
 * 구현하지 않으면 관측 이벤트가 무시된다.
 */
export interface PipelineObserver {
  onPipelineStart?(ctx: MsgContext): void;
  onPipelineComplete?(ctx: MsgContext, result: PipelineResult): void;
  onPipelineError?(ctx: MsgContext, error: Error): void;
  onStageStart?(stageName: string, ctx: MsgContext): void;
  onStageComplete?(stageName: string, result: StageResult<unknown>): void;
}

/**
 * 기본 PipelineObserver 구현
 *
 * 기존 FinClawLogger를 활용하여 스테이지별 로깅 + EventBus 이벤트 발행.
 */
export class DefaultPipelineObserver implements PipelineObserver {
  constructor(
    private readonly logger: FinClawLogger,
    private readonly eventBus?: TypedEmitter<FinClawEventMap>,
  ) {}

  onPipelineStart(ctx: MsgContext): void {
    this.logger.debug('Pipeline started', { sessionKey: ctx.sessionKey });
    this.eventBus?.emit('pipeline:start', { sessionKey: ctx.sessionKey });
  }

  onPipelineComplete(ctx: MsgContext, result: PipelineResult): void {
    this.logger.info('Pipeline completed', {
      sessionKey: ctx.sessionKey,
      success: result.success,
      durationMs: result.durationMs,
      stages: result.stagesExecuted,
    });
    this.eventBus?.emit('pipeline:complete', {
      sessionKey: ctx.sessionKey,
      ...result,
    });
  }

  onPipelineError(ctx: MsgContext, error: Error): void {
    this.logger.error('Pipeline error', { sessionKey: ctx.sessionKey, error });
    this.eventBus?.emit('pipeline:error', { sessionKey: ctx.sessionKey, error });
  }

  onStageStart(stageName: string, ctx: MsgContext): void {
    this.logger.debug(`Stage ${stageName} started`, { sessionKey: ctx.sessionKey });
  }

  onStageComplete(stageName: string, result: StageResult<unknown>): void {
    this.logger.debug(`Stage ${stageName} completed`, { action: result.action });
  }
}
```

> **EventBus 이벤트 추가 (FinClawEventMap에 등록):**
>
> - `pipeline:start` — `{ sessionKey }`
> - `pipeline:complete` — `{ sessionKey, success, durationMs, stages }`
> - `pipeline:error` — `{ sessionKey, error }`

### 9.4 타이핑 컨트롤러 (ACK 스테이지 보강)

기존 `server/channels/typing.ts`의 `startTyping()`을 래핑하여 3-상태 관리 추가:

```
active → processing → sealed
```

- **active**: 타이핑 인디케이터 표시 중
- **processing**: AI 실행 중 (타이핑 유지)
- **sealed**: 파이프라인 완료 후 재시작 방지

```typescript
// ACK 스테이지에서 사용
const typing = createTypingController(channel, channelId, chatId, {
  intervalMs: 5000,
  ttlMs: 120_000, // 2분 TTL 보호
});

typing.start(); // → active
// ... AI 실행 ...
typing.seal(); // → sealed (이후 start() 호출 무시)
```

### 9.5 기존 인프라 재활용 매핑

| 기존 컴포넌트                      | 경로                                 | Phase 8에서의 사용                             |
| ---------------------------------- | ------------------------------------ | ---------------------------------------------- |
| `MessageRouter`                    | `server/process/message-router.ts`   | 파이프라인 진입점 (onProcess 콜백)             |
| `MessageQueue` + `QueueMode`       | `server/process/message-queue.ts`    | 큐 관리 — 별도 구현 불필요                     |
| `composeGates()` + `Gate`          | `server/channels/gating/pipeline.ts` | 금융 게이트만 추가                             |
| `createHookRunner()`               | `server/plugins/hooks.ts`            | VoidHookRunner / ModifyingHookRunner 직접 사용 |
| `HookPayloadMap`                   | `server/plugins/hook-types.ts`       | beforeMessageProcess 등 기존 훅 타입 사용      |
| `startTyping()` + `TypingHandle`   | `server/channels/typing.ts`          | ACK 스테이지에서 래핑 사용                     |
| `FinClawError`                     | `infra/errors.ts`                    | PipelineError의 상위 클래스                    |
| `FinClawLogger` + `createLogger()` | `infra/logger.ts`                    | 파이프라인 전반 로깅                           |
| `EventBus` + `FinClawEventMap`     | `infra/events.ts`                    | pipeline:start/complete/error 이벤트           |
| `Dedupe`                           | `infra/dedupe.ts`                    | MessageRouter에서 이미 사용 — 중복 구현 불필요 |
| `ConcurrencyLaneManager`           | `infra/concurrency-lane.ts`          | MessageRouter에서 이미 사용 — 중복 구현 불필요 |
| `AbortSignal.any()` 패턴           | `infra/fetch.ts`                     | 파이프라인 타임아웃 결합                       |
| `deriveRoutingSessionKey()`        | `server/process/session-key.ts`      | MessageRouter에서 이미 처리                    |

### 9.6 구현 순서 제안

**Week 1: 기반**

1. `errors.ts` — PipelineError + PipelineErrorCode
2. `pipeline-context.ts` — PipelineMsgContext + enrichContext()
3. `execution-adapter.ts` — ExecutionAdapter + MockAdapter
4. `commands/registry.ts` + `commands/built-in.ts` — 명령어 시스템
5. `control-tokens.ts` — 제어 토큰 상수 + 파서

**Week 2: 스테이지 + 통합**

1. `stages/normalize.ts` — 정규화
2. `stages/command.ts` — 명령어 파싱
3. `stages/ack.ts` — ACK + TypingController
4. `stages/context.ts` — 컨텍스트 확장
5. `stages/execute.ts` — ExecutionAdapter 위임
6. `stages/deliver.ts` — 응답 전송
7. `observer.ts` — PipelineObserver + DefaultPipelineObserver
8. `pipeline.ts` — 오케스트레이터 통합
9. `__tests__/` — 8개 테스트 파일

### 9.7 하지 말아야 할 것

- **타입 재정의 금지**: `@finclaw/types`의 `MsgContext`, `InboundMessage`, `OutboundMessage`를 재정의하지 말 것. 확장(`extends`)만 허용.
- **인프라 재구현 금지**: `MessageQueue`, `Dedupe`, `ConcurrencyLaneManager`, `composeGates()`, `createHookRunner()` 등 이미 구현된 인프라를 중복 구현하지 말 것.
- **외부 프레임워크 금지**: 파이프라인 프레임워크(RxJS, fp-ts 등)를 도입하지 말 것. 순수 TypeScript로 구현.
- **AI 직접 호출 금지**: Phase 8에서는 AI API를 직접 호출하지 말 것. ExecutionAdapter를 통해서만 접근.
