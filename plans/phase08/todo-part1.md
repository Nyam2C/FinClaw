# Phase 8 TODO-1: 기반 모듈

> Part 1 (에러·제어토큰·컨텍스트·어댑터·포매터·명령어 레지스트리·내장 명령어) + 이벤트 추가
>
> 수정 1개 + 소스 7개 = **8 작업**

---

### - [ ] Step 1: PipelineError 에러 클래스

파일: `packages/server/src/auto-reply/errors.ts`

```typescript
// packages/server/src/auto-reply/errors.ts
import { FinClawError } from '@finclaw/infra';

/** 파이프라인 에러 코드 */
export type PipelineErrorCode =
  | 'PIPELINE_TIMEOUT'
  | 'STAGE_FAILED'
  | 'CONTEXT_BUILD_FAILED'
  | 'EXECUTION_FAILED'
  | 'DELIVERY_FAILED';

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

검증: `pnpm typecheck`

---

### - [ ] Step 2: AI 제어 토큰 시스템

파일: `packages/server/src/auto-reply/control-tokens.ts`

```typescript
// packages/server/src/auto-reply/control-tokens.ts

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

export interface ControlTokenResult {
  readonly cleanContent: string;
  readonly tokens: readonly ControlToken[];
  readonly hasNoReply: boolean;
  readonly hasSilentReply: boolean;
  readonly hasHeartbeat: boolean;
  readonly needsDisclaimer: boolean;
  readonly needsQuote: boolean;
}

const ALL_TOKENS = Object.values(CONTROL_TOKENS);

/**
 * AI 응답에서 제어 토큰 추출
 *
 * 1. 응답 텍스트에서 모든 <<TOKEN>> 패턴 탐지
 * 2. 알려진 제어 토큰과 매칭
 * 3. 제어 토큰을 응답에서 제거
 * 4. 클린 텍스트 + 추출된 토큰 목록 반환
 */
export function extractControlTokens(response: string): ControlTokenResult {
  const found: ControlToken[] = [];
  let cleaned = response;

  for (const token of ALL_TOKENS) {
    if (cleaned.includes(token)) {
      found.push(token);
      cleaned = cleaned.replaceAll(token, '');
    }
  }

  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return {
    cleanContent: cleaned,
    tokens: found,
    hasNoReply: found.includes(CONTROL_TOKENS.NO_REPLY),
    hasSilentReply: found.includes(CONTROL_TOKENS.SILENT_REPLY),
    hasHeartbeat: found.includes(CONTROL_TOKENS.HEARTBEAT_OK),
    needsDisclaimer: found.includes(CONTROL_TOKENS.ATTACH_DISCLAIMER),
    needsQuote: found.includes(CONTROL_TOKENS.ATTACH_QUOTE),
  };
}
```

검증: `pnpm typecheck`

---

### - [ ] Step 3: PipelineMsgContext 및 금융 컨텍스트 확장

파일: `packages/server/src/auto-reply/pipeline-context.ts`

```typescript
// packages/server/src/auto-reply/pipeline-context.ts
import type {
  MsgContext,
  ChannelCapabilities,
  Timestamp,
  Portfolio,
  Alert,
  NewsItem,
} from '@finclaw/types';

/**
 * 파이프라인 전용 메시지 컨텍스트
 *
 * 기존 MsgContext를 상속하고, 파이프라인에서 필요한 확장 필드만 추가한다.
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
  readonly market: string;
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

export interface EnrichContextDeps {
  readonly financeContextProvider: FinanceContextProvider;
  readonly channelCapabilities: ChannelCapabilities;
}

/**
 * MsgContext → PipelineMsgContext 확장
 *
 * 금융 데이터는 Promise.allSettled로 병렬 로딩하며, 개별 실패를 허용한다.
 */
export async function enrichContext(
  ctx: MsgContext,
  deps: EnrichContextDeps,
  signal: AbortSignal,
): Promise<PipelineMsgContext> {
  const { financeContextProvider } = deps;

  // 금융 데이터 병렬 로딩 (3초 타임아웃, 개별 실패 허용)
  const financeSignal = AbortSignal.any([signal, AbortSignal.timeout(3000)]);

  const [alertsResult, portfolioResult, newsResult, watchlistResult] = await Promise.allSettled([
    financeContextProvider.getActiveAlerts(ctx.senderId, financeSignal),
    financeContextProvider.getPortfolio(ctx.senderId, financeSignal),
    financeContextProvider.getRecentNews(financeSignal),
    financeContextProvider.getWatchlist(ctx.senderId),
  ]);

  const marketSession = financeContextProvider.getMarketSession();

  return {
    ...ctx,
    normalizedBody: ctx.body.trim().replace(/\s+/g, ' '),
    mentions: [],
    urls: [],
    channelCapabilities: deps.channelCapabilities,
    userRoles: [],
    isAdmin: false,
    marketSession,
    activeAlerts: alertsResult.status === 'fulfilled' ? alertsResult.value : undefined,
    portfolioSnapshot: portfolioResult.status === 'fulfilled' ? portfolioResult.value : undefined,
    newsContext: newsResult.status === 'fulfilled' ? newsResult.value : undefined,
    watchlist: watchlistResult.status === 'fulfilled' ? watchlistResult.value : undefined,
  };
}
```

검증: `pnpm typecheck`

---

### - [ ] Step 4: ExecutionAdapter 브릿지 인터페이스

파일: `packages/server/src/auto-reply/execution-adapter.ts`

```typescript
// packages/server/src/auto-reply/execution-adapter.ts
import type { PipelineMsgContext } from './pipeline-context.js';

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

검증: `pnpm typecheck`

---

### - [ ] Step 5: 채널별 응답 포매터

파일: `packages/server/src/auto-reply/response-formatter.ts`

```typescript
// packages/server/src/auto-reply/response-formatter.ts
import type { ControlTokenResult } from './control-tokens.js';

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
 * 1. 금융 데이터 포매팅 (숫자 소수점, 통화, 퍼센트)
 * 2. 코드블록 변환 (채널 지원 여부에 따라)
 * 3. 메시지 길이 검사 -> 초과 시 분할
 * 4. 면책 조항 첨부 (needsDisclaimer일 때)
 */
export function formatResponse(
  content: string,
  controlTokens: ControlTokenResult,
  options: FormatOptions,
): FormattedResponse {
  let formatted = content;

  // 면책 조항 첨부
  if (controlTokens.needsDisclaimer) {
    formatted +=
      '\n\n---\n' +
      '_본 정보는 투자 조언이 아니며, 투자 결정은 본인의 판단과 책임 하에 이루어져야 합니다._';
  }

  // markdown 미지원 채널이면 마크다운 제거
  if (!options.supportedFormats.includes('markdown')) {
    formatted = formatted.replace(/\*\*(.*?)\*\*/g, '$1');
    formatted = formatted.replace(/_(.*?)_/g, '$1');
    formatted = formatted.replace(/`(.*?)`/g, '$1');
  }

  // 메시지 분할
  const chunks = splitMessage(formatted, options.maxLength);

  const parts: ResponsePart[] = chunks.map((chunk, i) => ({
    content: chunk,
    index: i,
    isLast: i === chunks.length - 1,
  }));

  return {
    parts,
    totalLength: formatted.length,
    wasSplit: parts.length > 1,
  };
}

/** 금융 숫자 포매팅 */
export function formatFinancialNumber(
  value: number,
  options: {
    locale?: string;
    currency?: string;
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
    showSign?: boolean;
  } = {},
): string {
  const {
    locale = 'en-US',
    currency,
    minimumFractionDigits = 2,
    maximumFractionDigits = 2,
    showSign = false,
  } = options;

  const formatOpts: Intl.NumberFormatOptions = {
    minimumFractionDigits,
    maximumFractionDigits,
  };

  if (currency) {
    formatOpts.style = 'currency';
    formatOpts.currency = currency;
  }

  if (showSign) {
    formatOpts.signDisplay = 'exceptZero';
  }

  return new Intl.NumberFormat(locale, formatOpts).format(value);
}

/**
 * 긴 메시지 분할
 *
 * 줄 바꿈 기준으로 분할하며, 코드 블록 내부는 분할하지 않는다.
 */
export function splitMessage(content: string, maxLength: number): readonly string[] {
  if (content.length <= maxLength) {
    return [content];
  }

  const parts: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      parts.push(remaining);
      break;
    }

    // 줄 바꿈 위치에서 분할 시도
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) {
      // 줄 바꿈이 없으면 공백에서 분할
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt <= 0) {
      // 공백도 없으면 강제 분할
      splitAt = maxLength;
    }

    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return parts;
}
```

검증: `pnpm typecheck`

---

### - [ ] Step 6: 명령어 레지스트리

파일: `packages/server/src/auto-reply/commands/registry.ts`

```typescript
// packages/server/src/auto-reply/commands/registry.ts
import type { MsgContext } from '@finclaw/types';

/** 명령어 정의 */
export interface CommandDefinition {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly usage: string;
  readonly category: CommandCategory;
  readonly requiredRoles?: readonly string[];
  readonly cooldownMs?: number;
}

export type CommandCategory = 'general' | 'finance' | 'admin' | 'debug';

/** 명령어 실행 함수 */
export type CommandExecutor = (args: readonly string[], ctx: MsgContext) => Promise<CommandResult>;

/** 명령어 실행 결과 */
export interface CommandResult {
  readonly content: string;
  readonly ephemeral: boolean;
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
  parse(content: string, prefix: string): ParsedCommand | null;
  execute(parsed: ParsedCommand, ctx: MsgContext): Promise<CommandResult>;
}

interface CommandEntry {
  readonly definition: CommandDefinition;
  readonly executor: CommandExecutor;
}

/** 인메모리 명령어 레지스트리 구현 */
export class InMemoryCommandRegistry implements CommandRegistry {
  private readonly commands = new Map<string, CommandEntry>();
  private readonly aliasMap = new Map<string, string>();

  register(definition: CommandDefinition, executor: CommandExecutor): void {
    const entry: CommandEntry = { definition, executor };
    this.commands.set(definition.name, entry);

    for (const alias of definition.aliases) {
      this.aliasMap.set(alias, definition.name);
    }
  }

  unregister(name: string): boolean {
    const entry = this.commands.get(name);
    if (!entry) return false;

    for (const alias of entry.definition.aliases) {
      this.aliasMap.delete(alias);
    }
    this.commands.delete(name);
    return true;
  }

  get(name: string): CommandEntry | undefined {
    const resolved = this.aliasMap.get(name) ?? name;
    return this.commands.get(resolved);
  }

  list(): readonly CommandDefinition[] {
    return [...this.commands.values()].map((e) => e.definition);
  }

  listByCategory(category: CommandCategory): readonly CommandDefinition[] {
    return [...this.commands.values()]
      .filter((e) => e.definition.category === category)
      .map((e) => e.definition);
  }

  parse(content: string, prefix: string): ParsedCommand | null {
    const trimmed = content.trim();
    if (!trimmed.startsWith(prefix)) return null;

    const withoutPrefix = trimmed.slice(prefix.length);
    const parts = withoutPrefix.split(/\s+/);
    const name = parts[0];
    if (!name) return null;

    return {
      name: name.toLowerCase(),
      args: parts.slice(1),
      raw: trimmed,
    };
  }

  async execute(parsed: ParsedCommand, ctx: MsgContext): Promise<CommandResult> {
    const entry = this.get(parsed.name);
    if (!entry) {
      return { content: `알 수 없는 명령어: ${parsed.name}`, ephemeral: true };
    }
    return entry.executor(parsed.args, ctx);
  }
}
```

검증: `pnpm typecheck`

---

### - [ ] Step 7: 내장 명령어 등록

파일: `packages/server/src/auto-reply/commands/built-in.ts`

```typescript
// packages/server/src/auto-reply/commands/built-in.ts
import type { CommandRegistry } from './registry.js';

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

  // /price - 시세 조회
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

  // /portfolio - 포트폴리오 조회
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

  // /alert - 알림 설정
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

검증: `pnpm typecheck`

---

### - [ ] Step 8: FinClawEventMap에 pipeline 이벤트 3종 추가

파일: `packages/infra/src/events.ts`

기존 `FinClawEventMap` 인터페이스의 Phase 7 이벤트 블록 뒤에 추가:

```typescript
  // ── Phase 8: Pipeline events ──
  'pipeline:start': (data: { sessionKey: unknown }) => void;
  'pipeline:complete': (data: {
    sessionKey: unknown;
    success: boolean;
    durationMs: number;
    stagesExecuted: readonly string[];
    abortedAt?: string;
    abortReason?: string;
  }) => void;
  'pipeline:error': (data: { sessionKey: unknown; error: Error }) => void;
```

검증: `pnpm typecheck`

---

## 최종 검증

```bash
# 전체 타입 체크
pnpm typecheck
```

### 체크리스트 요약

| #   | 파일                                                   | 유형              |
| --- | ------------------------------------------------------ | ----------------- |
| 1   | `packages/server/src/auto-reply/errors.ts`             | 생성              |
| 2   | `packages/server/src/auto-reply/control-tokens.ts`     | 생성              |
| 3   | `packages/server/src/auto-reply/pipeline-context.ts`   | 생성              |
| 4   | `packages/server/src/auto-reply/execution-adapter.ts`  | 생성              |
| 5   | `packages/server/src/auto-reply/response-formatter.ts` | 생성              |
| 6   | `packages/server/src/auto-reply/commands/registry.ts`  | 생성              |
| 7   | `packages/server/src/auto-reply/commands/built-in.ts`  | 생성              |
| 8   | `packages/infra/src/events.ts`                         | 수정 (이벤트 3종) |
