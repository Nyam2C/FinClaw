# Phase 8: 자동 응답 파이프라인

> 복잡도: **L** | 소스 파일: ~13 | 테스트 파일: ~7 | 합계: **~20 파일**

---

## 1. 목표

외부 채널에서 수신한 메시지를 AI 에이전트에게 전달하고, 생성된 응답을 다시 채널로 전송하는 **8단계 선형 파이프라인**을 구현한다. OpenClaw의 auto-reply 시스템(206 파일, 39.4K LOC)의 핵심 흐름을 금융 도메인에 맞게 재설계한다.

### 8단계 파이프라인

| 단계 | 이름          | 설명                                                                          |
| ---- | ------------- | ----------------------------------------------------------------------------- |
| 1    | **Normalize** | 채널별 원시 메시지를 `InboundMessage` 표준 형식으로 정규화                    |
| 2    | **Gating**    | ChatType 해석 + 멘션 게이팅 적용. 봇이 응답해야 하는지 판단                   |
| 3    | **Command**   | 명령어 접두사 파싱 + 제어 명령어 실행. 일반 메시지와 명령어 분리              |
| 4    | **ACK**       | 수신 확인 리액션 추가 (e.g., eyes emoji). 사용자에게 처리 중 알림             |
| 5    | **Context**   | 세션 해석 + MsgContext(60+ 필드) 구축. 대화 맥락, 사용자 정보, 채널 상태 통합 |
| 6    | **Dispatch**  | 큐 모드 선택 + 에이전트 디스패치. 동시 요청 관리                              |
| 7    | **Execute**   | AI 실행 + 스트리밍 응답 처리. 도구 호출 루프 포함                             |
| 8    | **Deliver**   | 응답 포매팅 + 채널별 아웃바운드 전송                                          |

### 핵심 컴포넌트

- **MsgContext**: 60+ 필드를 가진 포괄적 메시지 컨텍스트 객체. 채널/사용자/AI/세션 상태를 단일 구조체로 통합.
- **Command Registry**: 제어 명령어(e.g., `/help`, `/reset`, `/balance`) 등록/해석/실행.
- **Queue Modes**: 6종 큐 모드(steer, followup, collect, interrupt, queue, steer-backlog)로 동시 메시지 처리 전략 결정.
- **AI Control Tokens**: `HEARTBEAT_OK`, `NO_REPLY`, `SILENT_REPLY_TOKEN` -- AI 응답 내 인밴드 시그널링.
- **Response Formatter**: 채널별 출력 형식 변환 (Markdown, 임베드, 코드블록 등).

---

## 2. OpenClaw 참조

| 참조 문서 경로                                         | 적용할 패턴                                       |
| ------------------------------------------------------ | ------------------------------------------------- |
| `openclaw_review/docs/auto-reply/pipeline.md`          | 8단계 선형 파이프라인 아키텍처, 단계별 early exit |
| `openclaw_review/docs/auto-reply/msg-context.md`       | MsgContext 60+ 필드 설계, 컨텍스트 빌더 패턴      |
| `openclaw_review/docs/auto-reply/command-system.md`    | 명령어 레지스트리, 파싱, 실행 패턴                |
| `openclaw_review/deep-dive/queue-modes.md`             | 6종 큐 모드, 동시성 관리, 백프레셔                |
| `openclaw_review/docs/auto-reply/ai-control-tokens.md` | 인밴드 시그널링, HEARTBEAT, NO_REPLY              |
| `openclaw_review/docs/auto-reply/streaming.md`         | 스트리밍 응답, 청크 처리, 타임아웃                |
| `openclaw_review/docs/auto-reply/formatting.md`        | 채널별 응답 포매팅, 메시지 분할                   |

**OpenClaw 대비 FinClaw 간소화 사항:**

- 206 파일 -> ~20 파일로 핵심 흐름만 추출
- 큐 모드 6종 -> 3종으로 초기 제한 (steer, followup, queue)
- 스트리밍은 기본 텍스트 스트리밍만 지원 (이미지/파일 스트리밍 제외)
- 금융 전용 명령어 추가 (`/price`, `/portfolio`, `/alert`)
- MsgContext에 금융 도메인 필드 추가 (marketSession, portfolioSnapshot)

---

## 3. 생성할 파일

### 소스 파일 (13개)

```
src/auto-reply/
├── index.ts                      # 자동 응답 모듈 public API
├── pipeline.ts                   # 파이프라인 오케스트레이터
├── msg-context.ts                # MsgContext 정의 + 빌더
├── control-tokens.ts             # AI 제어 토큰 상수 + 파서
├── queue-modes.ts                # 큐 모드 정의 + 선택 로직
├── response-formatter.ts         # 채널별 응답 포매팅
├── stages/
│   ├── normalize.ts              # Stage 1: 메시지 정규화
│   ├── gating.ts                 # Stage 2: 게이팅 (ChatType + 멘션)
│   ├── command.ts                # Stage 3: 명령어 파싱 + 실행
│   ├── ack.ts                    # Stage 4: 수신 확인 리액션
│   ├── context.ts                # Stage 5: 세션 해석 + MsgContext 구축
│   ├── execute.ts                # Stage 6+7: 디스패치 + AI 실행
│   └── deliver.ts                # Stage 8: 응답 전송
└── commands/
    ├── registry.ts               # 명령어 레지스트리
    └── built-in.ts               # 내장 명령어 (/help, /reset, /price 등)
```

> 주: Stage 6(Dispatch)과 Stage 7(Execute)는 긴밀하게 결합되어 `execute.ts` 하나로 통합한다.

### 테스트 파일 (7개)

```
src/auto-reply/__tests__/
├── pipeline.test.ts              # 전체 파이프라인 통합 테스트
├── msg-context.test.ts           # MsgContext 빌더 테스트
├── normalize.test.ts             # 정규화 단계 테스트
├── gating.test.ts                # 게이팅 단계 테스트
├── command.test.ts               # 명령어 파싱/실행 테스트
├── queue-modes.test.ts           # 큐 모드 선택 테스트
└── control-tokens.test.ts        # 제어 토큰 파싱 테스트
```

---

## 4. 핵심 인터페이스/타입

### 4.1 Pipeline 타입

```typescript
// src/auto-reply/pipeline.ts

/** 파이프라인 단계 인터페이스 */
export interface PipelineStage<TIn, TOut> {
  readonly name: string;
  readonly execute: (input: TIn) => Promise<StageResult<TOut>>;
}

/** 단계 실행 결과 */
export type StageResult<T> =
  | { readonly action: 'continue'; readonly data: T }
  | { readonly action: 'skip'; readonly reason: string }
  | { readonly action: 'abort'; readonly reason: string; readonly error?: Error };

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
  readonly enableAck: boolean; // ACK 리액션 활성화
  readonly commandPrefix: string; // 명령어 접두사 (기본: '/')
  readonly maxResponseLength: number; // 최대 응답 길이
  readonly streamingEnabled: boolean; // 스트리밍 활성화
  readonly timeoutMs: number; // 전체 파이프라인 타임아웃
  /** 금융 특화: 시장 시간 외 자동 응답 비활성화 */
  readonly respectMarketHours: boolean;
}

/**
 * 파이프라인 오케스트레이터
 *
 * 데이터 흐름:
 * InboundMessage
 *   -> [normalize] -> NormalizedMessage
 *   -> [gating]    -> GatedMessage (또는 skip)
 *   -> [command]   -> CommandResult | PassthroughMessage (또는 skip)
 *   -> [ack]       -> AckedMessage
 *   -> [context]   -> MsgContext
 *   -> [execute]   -> AIResponse
 *   -> [deliver]   -> PipelineResult
 */
export class AutoReplyPipeline {
  constructor(config: PipelineConfig, dependencies: PipelineDependencies);

  /** 파이프라인 실행 */
  process(message: InboundMessage): Promise<PipelineResult>;

  /** 특정 단계만 실행 (테스트용) */
  executeStage<TIn, TOut>(stage: PipelineStage<TIn, TOut>, input: TIn): Promise<StageResult<TOut>>;
}

/** 파이프라인 의존성 주입 */
export interface PipelineDependencies {
  readonly channelPlugin: ChannelPlugin;
  readonly toolRegistry: ToolRegistry;
  readonly sessionManager: SessionManager;
  readonly modelResolver: (ref: ModelRef) => ResolvedModel;
  readonly commandRegistry: CommandRegistry;
  readonly hookRunner: HookRunnerSet;
}

/** 훅 러너 집합 */
export interface HookRunnerSet {
  readonly beforeProcess: ModifyingHookRunner<InboundMessage>;
  readonly afterProcess: VoidHookRunner<PipelineResult>;
  readonly beforeSend: ModifyingHookRunner<OutboundMessage>;
  readonly afterSend: VoidHookRunner<SentMessage>;
}
```

### 4.2 MsgContext (60+ 필드)

```typescript
// src/auto-reply/msg-context.ts

/** 포괄적 메시지 컨텍스트 (60+ 필드) */
export interface MsgContext {
  // --- 원본 메시지 정보 (10 필드) ---
  readonly messageId: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly content: string;
  readonly chatType: ChatType;
  readonly timestamp: Date;
  readonly threadId: string | null;
  readonly replyToId: string | null;
  readonly attachments: readonly Attachment[];

  // --- 채널 컨텍스트 (8 필드) ---
  readonly channelType: string;
  readonly channelName: string;
  readonly channelCapabilities: ChannelCapabilities;
  readonly gatingResult: GatingResult;
  readonly isDirectMessage: boolean;
  readonly isThread: boolean;
  readonly channelPlugin: ChannelPlugin;
  readonly dock: ChannelDock;

  // --- 사용자 컨텍스트 (8 필드) ---
  readonly userId: string;
  readonly userDisplayName: string;
  readonly userRoles: readonly string[];
  readonly isAdmin: boolean;
  readonly userPreferences: UserPreferences;
  readonly userHistory: UserInteractionHistory;
  readonly userTimezone: string;
  readonly userLocale: string;

  // --- 세션 컨텍스트 (8 필드) ---
  readonly sessionId: string;
  readonly isNewSession: boolean;
  readonly sessionStartedAt: Date;
  readonly conversationLength: number;
  readonly lastAssistantMessage: string | null;
  readonly transcript: readonly TranscriptEntry[];
  readonly contextTokenCount: number;
  readonly compactionApplied: boolean;

  // --- AI 상태 (8 필드) ---
  readonly resolvedModel: ResolvedModel;
  readonly availableTools: readonly ToolDefinition[];
  readonly systemPrompt: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly stopSequences: readonly string[];
  readonly streamingEnabled: boolean;
  readonly thinkingEnabled: boolean;

  // --- 큐/디스패치 상태 (6 필드) ---
  readonly queueMode: QueueMode;
  readonly queuePosition: number;
  readonly isInterrupt: boolean;
  readonly precedingMessages: number;
  readonly concurrentSessions: number;
  readonly dispatchedAt: Date;

  // --- 금융 도메인 컨텍스트 (12 필드) ---
  readonly marketSession: MarketSession;
  readonly activeAlerts: readonly FinanceAlert[];
  readonly portfolioSnapshot: PortfolioSnapshot | null;
  readonly watchlist: readonly string[];
  readonly riskProfile: InvestmentProfile | null;
  readonly lastQuoteRequest: QuoteRequest | null;
  readonly complianceLevel: string;
  readonly tradingEnabled: boolean;
  readonly preferredCurrency: string;
  readonly preferredMarket: string;
  readonly newsContext: readonly NewsItem[];
  readonly marketSentiment: MarketSentiment | null;
}

/** 시장 세션 상태 */
export interface MarketSession {
  readonly isOpen: boolean;
  readonly market: string; // 'KRX' | 'NYSE' | 'NASDAQ' | ...
  readonly openTime: string; // 'HH:MM' (현지 시간)
  readonly closeTime: string;
  readonly nextOpenAt: Date | null;
  readonly timezone: string;
}

/** 시장 심리 */
export interface MarketSentiment {
  readonly overall: 'bullish' | 'bearish' | 'neutral';
  readonly vixLevel: number;
  readonly fearGreedIndex: number;
  readonly updatedAt: Date;
}

/** 금융 알림 */
export interface FinanceAlert {
  readonly id: string;
  readonly type: 'price-target' | 'volume-spike' | 'news' | 'portfolio-change';
  readonly symbol: string;
  readonly message: string;
  readonly triggeredAt: Date;
  readonly acknowledged: boolean;
}

/** 포트폴리오 스냅샷 */
export interface PortfolioSnapshot {
  readonly totalValue: number;
  readonly currency: string;
  readonly positions: readonly PortfolioPosition[];
  readonly dailyPnl: number;
  readonly dailyPnlPercent: number;
  readonly asOfDate: Date;
}

export interface PortfolioPosition {
  readonly symbol: string;
  readonly quantity: number;
  readonly avgCost: number;
  readonly currentPrice: number;
  readonly unrealizedPnl: number;
}

/** 사용자 선호 설정 */
export interface UserPreferences {
  readonly language: string;
  readonly responseFormat: 'concise' | 'detailed' | 'technical';
  readonly chartStyle: 'candlestick' | 'line' | 'bar';
  readonly defaultTimeframe: string;
}

/** 사용자 상호작용 이력 */
export interface UserInteractionHistory {
  readonly totalMessages: number;
  readonly firstInteraction: Date;
  readonly lastInteraction: Date;
  readonly frequentTopics: readonly string[];
  readonly satisfactionScore: number | null;
}

/**
 * MsgContext 빌더
 *
 * 단계별로 컨텍스트 필드를 채워 최종 MsgContext를 생성한다.
 * 각 스테이지에서 부분적으로 빌드하고, 마지막에 freeze하여 불변 객체로 반환.
 */
export class MsgContextBuilder {
  private partial: Partial<MsgContext> = {};

  withMessage(msg: InboundMessage): this;
  withChannel(plugin: ChannelPlugin): this;
  withUser(userId: string, store: UserStore): this;
  withSession(session: SessionInfo): this;
  withAI(model: ResolvedModel, tools: readonly ToolDefinition[], prompt: string): this;
  withQueue(mode: QueueMode, position: number): this;
  withFinanceContext(ctx: FinanceContextProvider): this;

  build(): MsgContext;
}
```

### 4.3 Command System

```typescript
// src/auto-reply/commands/registry.ts

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
  readonly embeds?: readonly Embed[];
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

### 4.4 Queue Modes

```typescript
// src/auto-reply/queue-modes.ts

/** 큐 모드 */
export type QueueMode =
  | 'steer' // 새 대화 시작, 이전 대화 중단
  | 'followup' // 기존 대화 이어가기
  | 'queue' // 순차 처리 대기열
  | 'collect' // 여러 메시지를 모아서 일괄 처리 (향후)
  | 'interrupt' // 현재 처리를 중단하고 새 메시지 우선 (향후)
  | 'steer-backlog'; // steer + 이전 미처리 메시지 참조 (향후)

/** 큐 모드 판정 컨텍스트 */
export interface QueueModeContext {
  readonly hasActiveSession: boolean;
  readonly isOngoingGeneration: boolean;
  readonly timeSinceLastMessage: number; // ms
  readonly pendingMessageCount: number;
  readonly isDirectMessage: boolean;
  readonly chatType: ChatType;
}

/**
 * 큐 모드 선택 알고리즘
 *
 * 판정 로직:
 * 1. 활성 세션 없음 -> 'steer' (새 대화)
 * 2. AI가 현재 생성 중이 아님 + 마지막 메시지 30초 이내 -> 'followup'
 * 3. AI가 현재 생성 중 + DM -> 'steer' (새 대화로 전환)
 * 4. AI가 현재 생성 중 + 채널 -> 'queue' (대기열에 추가)
 * 5. 대기 메시지가 3개 이상 -> 'queue'
 * 6. 기본 -> 'followup'
 */
export function selectQueueMode(ctx: QueueModeContext): QueueMode;

/** 큐 관리자 */
export class MessageQueue {
  constructor(maxSize?: number);

  /** 메시지를 대기열에 추가 */
  enqueue(message: InboundMessage, mode: QueueMode): void;

  /** 다음 처리할 메시지 가져오기 */
  dequeue(): InboundMessage | undefined;

  /** 대기열 크기 */
  get size(): number;

  /** 대기열 비우기 */
  clear(): void;

  /** 특정 세션의 대기 메시지만 가져오기 */
  getBySession(sessionId: string): readonly InboundMessage[];
}
```

### 4.5 AI Control Tokens

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

### 4.6 Response Formatter

```typescript
// src/auto-reply/response-formatter.ts

/** 포매팅 옵션 */
export interface FormatOptions {
  readonly maxLength: number;
  readonly supportedFormats: readonly SupportedFormat[];
  readonly embedSupported: boolean;
  readonly codeBlockStyle: 'fenced' | 'indented';
  /** 금융 특화: 숫자 포매팅 로케일 */
  readonly numberLocale: string;
  /** 금융 특화: 통화 기호 */
  readonly currencySymbol: string;
}

export type SupportedFormat = 'markdown' | 'plain-text' | 'html' | 'embed';

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
  readonly embed?: Embed;
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
 * 6. 임베드 변환 (지원 시)
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
      { name: 'gating', fn: this.gatingStage.bind(this) },
      { name: 'command', fn: this.commandStage.bind(this) },
      { name: 'ack', fn: this.ackStage.bind(this) },
      { name: 'context', fn: this.contextStage.bind(this) },
      { name: 'execute', fn: this.executeStage.bind(this) },
      { name: 'deliver', fn: this.deliverStage.bind(this) },
    ];
  }

  async process(message: InboundMessage): Promise<PipelineResult> {
    const startTime = performance.now();
    const stagesExecuted: string[] = [];

    // 타임아웃 설정
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    // 훅: before-process
    const processed = await this.deps.hookRunner.beforeProcess.fire(message);

    let current: unknown = processed;

    try {
      for (const stage of this.stages) {
        // AbortSignal 체크
        if (controller.signal.aborted) {
          return {
            success: false,
            stagesExecuted,
            abortedAt: stage.name,
            abortReason: 'Pipeline timeout exceeded',
            durationMs: performance.now() - startTime,
          };
        }

        const result = await stage.fn(current);
        stagesExecuted.push(stage.name);

        switch (result.action) {
          case 'continue':
            current = result.data;
            break;
          case 'skip':
            // skip은 파이프라인을 성공으로 종료 (응답 불필요)
            return {
              success: true,
              stagesExecuted,
              durationMs: performance.now() - startTime,
            };
          case 'abort':
            return {
              success: false,
              stagesExecuted,
              abortedAt: stage.name,
              abortReason: result.reason,
              durationMs: performance.now() - startTime,
            };
        }
      }

      const pipelineResult: PipelineResult = {
        success: true,
        stagesExecuted,
        durationMs: performance.now() - startTime,
        response: current as OutboundMessage,
      };

      // 훅: after-process
      await this.deps.hookRunner.afterProcess.fire(pipelineResult);

      return pipelineResult;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ... 각 스테이지 구현은 아래에서 상세히 설명
}

interface PipelineStageEntry {
  readonly name: string;
  readonly fn: (input: unknown) => Promise<StageResult<unknown>>;
}
```

### 5.2 Stage 1: Normalize

```typescript
// src/auto-reply/stages/normalize.ts

/** 정규화된 메시지 (표준 형식 보장) */
export interface NormalizedMessage extends InboundMessage {
  readonly normalizedContent: string; // 트림 + 공백 정규화
  readonly mentions: readonly string[]; // 추출된 멘션 ID 목록
  readonly urls: readonly string[]; // 추출된 URL 목록
  readonly isBot: boolean; // 봇 메시지 여부
}

/**
 * 메시지 정규화
 *
 * 처리:
 * 1. 봇 메시지 필터링 (자기 자신에게 응답 방지)
 * 2. 빈 메시지 필터링
 * 3. 콘텐츠 트림 + 연속 공백 정규화
 * 4. 멘션 태그 추출 (<@userId> 패턴)
 * 5. URL 추출
 * 6. 채널별 특수 마크업 제거
 */
export function normalizeMessage(
  message: InboundMessage,
  botUserId: string,
): StageResult<NormalizedMessage> {
  // 봇 메시지는 무시
  if (message.authorId === botUserId) {
    return { action: 'skip', reason: 'Self-message ignored' };
  }

  // 빈 메시지 필터링
  const trimmed = message.content.trim();
  if (trimmed.length === 0 && message.attachments.length === 0) {
    return { action: 'skip', reason: 'Empty message' };
  }

  // 멘션 추출
  const mentionPattern = /<@!?(\d+)>/g;
  const mentions: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(trimmed)) !== null) {
    mentions.push(match[1]);
  }

  // URL 추출
  const urlPattern = /https?:\/\/[^\s<>]+/g;
  const urls = trimmed.match(urlPattern) ?? [];

  const normalized: NormalizedMessage = {
    ...message,
    normalizedContent: trimmed.replace(/\s+/g, ' '),
    mentions,
    urls,
    isBot: false,
  };

  return { action: 'continue', data: normalized };
}
```

### 5.3 Stage 3: Command Parse + Gate

```typescript
// src/auto-reply/stages/command.ts

/**
 * 명령어 단계
 *
 * 처리:
 * 1. 메시지가 명령어 접두사로 시작하는지 확인
 * 2. 접두사 이후 첫 단어를 명령어 이름으로 파싱
 * 3. CommandRegistry에서 명령어 조회
 * 4. 매칭되면: 명령어 실행 -> skip (AI 호출 불필요)
 * 5. 미매칭이면: continue (일반 메시지로 AI에 전달)
 */
export async function commandStage(
  message: NormalizedMessage,
  registry: CommandRegistry,
  prefix: string,
  ctx: Partial<MsgContext>,
): Promise<StageResult<NormalizedMessage | CommandResult>> {
  const parsed = registry.parse(message.normalizedContent, prefix);

  if (!parsed) {
    return { action: 'continue', data: message };
  }

  const command = registry.get(parsed.name);
  if (!command) {
    // 알 수 없는 명령어 -> 도움말 힌트와 함께 skip
    return {
      action: 'continue',
      data: message, // AI에게 전달하여 자연어로 처리
    };
  }

  // 권한 검사
  if (command.definition.requiredRoles?.length) {
    const hasRole = command.definition.requiredRoles.some((role) =>
      (ctx as any).userRoles?.includes(role),
    );
    if (!hasRole) {
      return {
        action: 'skip',
        reason: `Insufficient permissions for command: ${parsed.name}`,
      };
    }
  }

  // 명령어 실행
  const result = await command.executor(parsed.args, ctx as MsgContext);

  // 명령어 응답을 채널에 전송 (deliver 스테이지를 거치지 않고 직접)
  return { action: 'skip', reason: `Command executed: ${parsed.name}` };
}
```

### 5.4 Stage 5: Context Building

```typescript
// src/auto-reply/stages/context.ts

/**
 * 컨텍스트 구축 단계
 *
 * MsgContext의 60+ 필드를 단계적으로 채운다:
 * 1. 메시지 기본 정보 (10 필드)
 * 2. 채널 컨텍스트 (8 필드) -- ChannelDock에서 추출
 * 3. 사용자 컨텍스트 (8 필드) -- 사용자 저장소에서 조회
 * 4. 세션 컨텍스트 (8 필드) -- 세션 매니저에서 조회/생성
 * 5. AI 상태 (8 필드) -- 모델 해석, 도구 목록, 시스템 프롬프트
 * 6. 큐 상태 (6 필드) -- 큐 모드 선택
 * 7. 금융 컨텍스트 (12 필드) -- 시장 상태, 포트폴리오, 알림
 */
export async function buildContext(
  message: NormalizedMessage,
  deps: ContextDependencies,
): Promise<StageResult<MsgContext>> {
  const builder = new MsgContextBuilder();

  try {
    // 1. 메시지 정보
    builder.withMessage(message);

    // 2. 채널 컨텍스트
    builder.withChannel(deps.channelPlugin);

    // 3. 사용자 컨텍스트
    await builder.withUser(message.authorId, deps.userStore);

    // 4. 세션 해석 (기존 세션 또는 새 세션 생성)
    const session = await deps.sessionManager.resolveOrCreate(message.authorId, message.channelId);
    builder.withSession(session);

    // 5. AI 상태
    const model = deps.modelResolver({ raw: deps.config.defaultModel });
    const tools = deps.toolRegistry.list().map((t) => t.definition);
    const prompt = buildSystemPrompt({
      userId: message.authorId,
      channelId: message.channelId,
      chatType: message.chatType,
      availableTools: tools,
      modelCapabilities: model.entry.capabilities,
    });
    builder.withAI(model, tools, prompt);

    // 6. 큐 모드 선택
    const queueMode = selectQueueMode({
      hasActiveSession: !session.isNew,
      isOngoingGeneration: deps.isGenerating(session.id),
      timeSinceLastMessage: Date.now() - (session.lastActivityAt?.getTime() ?? 0),
      pendingMessageCount: deps.messageQueue.getBySession(session.id).length,
      isDirectMessage: message.chatType === 'direct-message',
      chatType: message.chatType,
    });
    builder.withQueue(queueMode, deps.messageQueue.size);

    // 7. 금융 컨텍스트
    await builder.withFinanceContext(deps.financeContextProvider);

    return { action: 'continue', data: builder.build() };
  } catch (error) {
    return {
      action: 'abort',
      reason: `Failed to build context: ${(error as Error).message}`,
      error: error as Error,
    };
  }
}

export interface ContextDependencies {
  readonly channelPlugin: ChannelPlugin;
  readonly userStore: UserStore;
  readonly sessionManager: SessionManager;
  readonly modelResolver: (ref: ModelRef) => ResolvedModel;
  readonly toolRegistry: ToolRegistry;
  readonly messageQueue: MessageQueue;
  readonly financeContextProvider: FinanceContextProvider;
  readonly isGenerating: (sessionId: string) => boolean;
  readonly config: { defaultModel: string };
}
```

### 5.5 Stage 6+7: Dispatch + Execute

```typescript
// src/auto-reply/stages/execute.ts

/**
 * AI 실행 단계 (디스패치 + 실행 통합)
 *
 * 처리:
 * 1. 큐 모드에 따른 디스패치 결정
 *    - 'steer': 기존 생성 중단 -> 새 실행
 *    - 'followup': 기존 컨텍스트에 메시지 추가 -> 실행
 *    - 'queue': 대기열에 추가 -> 순차 실행
 * 2. 세션 write lock 획득
 * 3. AI API 호출 (스트리밍 모드)
 * 4. 도구 호출 루프:
 *    a. AI 응답에 tool_use가 포함되어 있으면
 *    b. 도구 실행 -> 결과를 transcript에 추가
 *    c. AI에게 tool_result 전달 -> 재호출
 *    d. tool_use가 없을 때까지 반복 (최대 10회)
 * 5. 제어 토큰 추출
 * 6. NO_REPLY 토큰이면 skip
 * 7. write lock 해제
 */
export async function executeAI(
  ctx: MsgContext,
  deps: ExecuteDependencies,
): Promise<StageResult<ExecuteResult>> {
  // Write lock 획득
  const lock = await acquireWriteLock({
    sessionDir: deps.sessionDir,
    sessionId: ctx.sessionId,
  });

  if (!lock.acquired) {
    return {
      action: 'abort',
      reason: `Could not acquire session lock for ${ctx.sessionId}`,
    };
  }

  try {
    // AI API 호출
    const response = await deps.aiClient.createMessage({
      model: ctx.resolvedModel.modelId,
      system: ctx.systemPrompt,
      messages: ctx.transcript,
      tools: ctx.availableTools,
      maxTokens: ctx.maxTokens,
      temperature: ctx.temperature,
      stream: ctx.streamingEnabled,
    });

    // 도구 호출 루프
    let currentResponse = response;
    let toolCallCount = 0;
    const MAX_TOOL_CALLS = 10;

    while (hasToolUse(currentResponse) && toolCallCount < MAX_TOOL_CALLS) {
      const toolUses = extractToolUses(currentResponse);

      const toolResults = await Promise.all(
        toolUses.map(async (tu) => {
          const result = await deps.toolRegistry.execute(tu.name, tu.input, {
            sessionId: ctx.sessionId,
            userId: ctx.userId,
            channelId: ctx.channelId,
            abortSignal: AbortSignal.timeout(30_000),
          });
          return { toolUseId: tu.id, ...result };
        }),
      );

      // Tool results를 transcript에 추가하고 재호출
      currentResponse = await deps.aiClient.createMessage({
        model: ctx.resolvedModel.modelId,
        system: ctx.systemPrompt,
        messages: [
          ...ctx.transcript,
          { role: 'assistant', content: currentResponse.content },
          ...toolResults.map((tr) => ({
            role: 'tool' as const,
            toolUseId: tr.toolUseId,
            content: tr.content,
          })),
        ],
        tools: ctx.availableTools,
        maxTokens: ctx.maxTokens,
        stream: ctx.streamingEnabled,
      });

      toolCallCount++;
    }

    // 제어 토큰 추출
    const tokenResult = extractControlTokens(currentResponse.textContent);

    // NO_REPLY 처리
    if (tokenResult.hasNoReply) {
      return { action: 'skip', reason: 'AI decided not to reply (NO_REPLY token)' };
    }

    return {
      action: 'continue',
      data: {
        content: tokenResult.cleanContent,
        controlTokens: tokenResult,
        usage: currentResponse.usage,
        toolCallCount,
      },
    };
  } finally {
    await lock.release();
  }
}

export interface ExecuteResult {
  readonly content: string;
  readonly controlTokens: ControlTokenResult;
  readonly usage: NormalizedUsage;
  readonly toolCallCount: number;
}

export interface ExecuteDependencies {
  readonly aiClient: AIClient;
  readonly toolRegistry: ToolRegistry;
  readonly sessionDir: string;
}
```

### 5.6 Stage 8: Deliver

```typescript
// src/auto-reply/stages/deliver.ts

/**
 * 응답 전송 단계
 *
 * 처리:
 * 1. SILENT_REPLY 토큰이면 로깅만 하고 전송 안 함
 * 2. 응답 포매팅 (채널 capabilities에 맞게)
 * 3. 면책 조항 첨부 (ATTACH_DISCLAIMER 토큰일 때)
 * 4. 메시지 길이 초과 시 분할
 * 5. 훅: before-send 실행
 * 6. 채널 플러그인을 통해 전송
 * 7. 훅: after-send 실행
 * 8. 전송 결과 반환
 */
export async function deliverResponse(
  executeResult: ExecuteResult,
  ctx: MsgContext,
  deps: DeliverDependencies,
): Promise<StageResult<OutboundMessage>> {
  // SILENT_REPLY 처리
  if (executeResult.controlTokens.hasSilentReply) {
    console.info(`[Deliver] Silent reply for session ${ctx.sessionId}`);
    return { action: 'skip', reason: 'Silent reply (logged only)' };
  }

  // 포매팅
  const formatOptions: FormatOptions = {
    maxLength: ctx.channelCapabilities.maxMessageLength,
    supportedFormats: ['markdown'], // 채널에 따라 동적 결정
    embedSupported: ctx.channelCapabilities.supportsEmbeds,
    codeBlockStyle: 'fenced',
    numberLocale: ctx.userLocale,
    currencySymbol: ctx.preferredCurrency,
  };

  let content = executeResult.content;

  // 면책 조항 첨부
  if (executeResult.controlTokens.needsDisclaimer) {
    content +=
      '\n\n---\n' +
      '_본 정보는 투자 조언이 아니며, 투자 결정은 본인의 판단과 책임 하에 이루어져야 합니다._';
  }

  const formatted = formatResponse(content, executeResult.controlTokens, formatOptions);

  // 분할 전송
  for (const part of formatted.parts) {
    const outbound: OutboundMessage = {
      content: part.content,
      replyToId: ctx.messageId,
      threadId: ctx.threadId ?? undefined,
      embeds: part.embed ? [part.embed] : undefined,
    };

    // 훅: before-send
    const modified = await deps.hookRunner.beforeSend.fire(outbound);

    // 채널 전송
    const sent = await ctx.channelPlugin.sendMessage(ctx.channelId, modified);

    // 훅: after-send
    await deps.hookRunner.afterSend.fire(sent);
  }

  return {
    action: 'continue',
    data: {
      content: formatted.parts.map((p) => p.content).join(''),
      replyToId: ctx.messageId,
    },
  };
}

export interface DeliverDependencies {
  readonly hookRunner: HookRunnerSet;
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
    async (args, ctx) => {
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
      const grouped = groupBy(commands, (c) => c.category);
      let output = '**사용 가능한 명령어:**\n\n';
      for (const [category, cmds] of Object.entries(grouped)) {
        output += `**${category}**\n`;
        for (const cmd of cmds) {
          output += `  \`/${cmd.name}\` - ${cmd.description}\n`;
        }
        output += '\n';
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
    async (_args, ctx) => {
      // 세션 매니저를 통해 세션 리셋 (향후 구현)
      return {
        content: '대화 세션이 초기화되었습니다. 새로운 대화를 시작해 주세요.',
        ephemeral: false,
      };
    },
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
    async (args, ctx) => {
      if (args.length === 0) {
        return { content: '종목 심볼을 입력해 주세요. 예: `/price AAPL`', ephemeral: true };
      }
      // 실제 시세 조회는 skills-finance 패키지에서 처리 (향후 연동)
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
    async (_args, ctx) => {
      return {
        content: '포트폴리오 조회 기능은 skills-finance 모듈 연동 후 활성화됩니다.',
        ephemeral: false,
      };
    },
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
    async (args, ctx) => {
      if (args.length < 3) {
        return {
          content: '사용법: `/alert 종목 조건 가격`\n예: `/alert AAPL > 200`',
          ephemeral: true,
        };
      }
      return {
        content: `알림 설정 기능은 skills-finance 모듈 연동 후 활성화됩니다.`,
        ephemeral: false,
      };
    },
  );
}
```

---

## 6. 선행 조건

| Phase                   | 구체적 산출물                                                                                                   | 필요 이유                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Phase 1 (타입 시스템)   | `InboundMessage`, `OutboundMessage`, `SentMessage`, `ChatType`, `Attachment`, `Embed` 타입                      | 파이프라인 전체의 입출력 타입                           |
| Phase 2 (인프라)        | `Logger`, `FinClawError`, 타이머 유틸리티                                                                       | 단계별 로깅, 에러 처리, 타임아웃                        |
| Phase 3 (설정)          | `PipelineConfig`, `CommandConfig` zod 스키마                                                                    | 파이프라인 설정, 명령어 접두사                          |
| Phase 4 (메시지 라우팅) | `MessageRouter` -- 채널에서 수신한 메시지를 파이프라인으로 전달                                                 | 파이프라인 진입점                                       |
| Phase 5 (채널/플러그인) | `ChannelDock` (게이팅 규칙), `ChannelPlugin` (sendMessage, addReaction), Hook system (`message:before-process`) | 게이팅 단계, ACK 리액션, 전송 단계, 훅                  |
| Phase 6 (모델 선택)     | `resolveModel()`, `NormalizedResponse`, `NormalizedUsage`                                                       | AI 실행 단계의 모델 해석, 응답 정규화                   |
| Phase 7 (도구/세션)     | `ToolRegistry.execute()`, `acquireWriteLock()`, `buildSystemPrompt()`, `compactContext()`                       | 도구 호출 루프, 세션 잠금, 프롬프트 생성, 컨텍스트 압축 |

---

## 7. 산출물 및 검증

### 테스트 가능한 결과물

| #   | 산출물                                | 검증 방법                                                             |
| --- | ------------------------------------- | --------------------------------------------------------------------- |
| 1   | `AutoReplyPipeline.process()`         | 통합 테스트: 전체 8단계 정상 흐름, mock 채널/AI                       |
| 2   | Stage 1: `normalizeMessage()`         | 단위 테스트: 봇 메시지 무시, 빈 메시지 필터, 멘션/URL 추출            |
| 3   | Stage 2: 게이팅 통합                  | 단위 테스트: 멘션 필수 채널에서 멘션 없는 메시지 -> skip              |
| 4   | Stage 3: 명령어 파싱/실행             | 단위 테스트: `/help`, `/price AAPL`, 알 수 없는 명령어, 권한 검사     |
| 5   | Stage 4: ACK 리액션                   | 단위 테스트: addReaction 호출 확인, 비활성화 시 건너뜀                |
| 6   | Stage 5: `MsgContextBuilder`          | 단위 테스트: 60+ 필드 완전성, 누락 필드 시 기본값                     |
| 7   | Stage 6+7: AI 실행 + 도구 루프        | 통합 테스트: 단순 응답, 도구 1회 호출, 다중 도구 호출, 최대 횟수 초과 |
| 8   | Stage 8: `deliverResponse()`          | 단위 테스트: 일반 전송, SILENT_REPLY, 메시지 분할, 면책 조항 첨부     |
| 9   | `extractControlTokens()`              | 단위 테스트: 각 토큰 추출, 복합 토큰, 토큰 없는 응답                  |
| 10  | `selectQueueMode()`                   | 단위 테스트: 6종 모드 선택 시나리오                                   |
| 11  | `CommandRegistry`                     | 단위 테스트: 등록, 해제, 별칭 조회, 카테고리 필터                     |
| 12  | `formatResponse()` + `splitMessage()` | 단위 테스트: 길이 제한 분할, 금융 숫자 포매팅, 코드블록 보존          |
| 13  | Pipeline early exit                   | 통합 테스트: 각 단계에서 skip/abort 시 정상 종료 확인                 |
| 14  | Pipeline 타임아웃                     | 단위 테스트: 타임아웃 초과 시 abort 결과 반환                         |

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

| 항목            | 값                                          |
| --------------- | ------------------------------------------- |
| **복잡도**      | **L**                                       |
| **소스 파일**   | 13개 (`stages/` 7 + `commands/` 2 + 루트 4) |
| **테스트 파일** | 7개                                         |
| **총 파일 수**  | **~20개**                                   |
| **예상 LOC**    | 소스 ~2,000 / 테스트 ~1,500 / 합계 ~3,500   |
| **새 의존성**   | 없음 (Phase 5-7 의존성 재활용)              |
| **예상 소요**   | 3-4일                                       |

### 복잡도 근거 (L)

- 8단계 파이프라인은 각 단계가 독립적이나, 전체 흐름 통합 테스트가 까다로움
- MsgContext 60+ 필드는 빌더 패턴으로 관리하나 금융 도메인 필드의 비동기 조회 필요
- 도구 호출 루프(최대 10회)는 다양한 에지 케이스 존재 (도구 실패, 타임아웃, 무한 루프 방지)
- 큐 모드 선택은 동시성 시나리오별 상태 조합이 복잡
- 제어 토큰 파싱은 단순하나, 응답 내 토큰 위치/중복/중첩 케이스 처리 필요
- Phase 4~7의 모든 산출물에 의존하므로 통합 지점이 가장 많은 phase
- OpenClaw에서 206 파일/39.4K LOC에 해당하는 기능을 20 파일로 압축하므로, 각 파일의 책임 범위가 넓음
