# Phase 8 TODO-3: 통합 + 테스트

> Part 3 (파이프라인 관측성, 오케스트레이터, 배럴 export) + 테스트 8개
>
> 소스 3개 + 테스트 8개 = **11 작업**

---

### - [ ] Step 1: 파이프라인 관측성

파일: `packages/server/src/auto-reply/observer.ts`

```typescript
// packages/server/src/auto-reply/observer.ts
import type { MsgContext } from '@finclaw/types';
import type { FinClawLogger, TypedEmitter, FinClawEventMap } from '@finclaw/infra';
import type { PipelineResult, StageResult } from './pipeline.js';

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
 * FinClawLogger를 활용하여 스테이지별 로깅 + EventBus 이벤트 발행.
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
      success: result.success,
      durationMs: result.durationMs,
      stagesExecuted: result.stagesExecuted,
      abortedAt: result.abortedAt,
      abortReason: result.abortReason,
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

검증: `pnpm typecheck`

---

### - [ ] Step 2: 파이프라인 오케스트레이터

파일: `packages/server/src/auto-reply/pipeline.ts`

```typescript
// packages/server/src/auto-reply/pipeline.ts
import type { MsgContext, OutboundMessage, ChannelPlugin } from '@finclaw/types';
import type { FinClawLogger } from '@finclaw/infra';
import type { BindingMatch } from '../process/binding-matcher.js';
import type { ExecutionAdapter } from './execution-adapter.js';
import type { PipelineObserver } from './observer.js';
import type { CommandRegistry } from './commands/registry.js';
import type { FinanceContextProvider } from './pipeline-context.js';
import { normalizeMessage } from './stages/normalize.js';
import { commandStage } from './stages/command.js';
import { ackStage, type TypingController } from './stages/ack.js';
import { contextStage } from './stages/context.js';
import { executeStage } from './stages/execute.js';
import { deliverResponse } from './stages/deliver.js';

// ── Stage Result types ──

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
  readonly enableAck: boolean;
  readonly commandPrefix: string;
  readonly maxResponseLength: number;
  readonly timeoutMs: number;
  readonly respectMarketHours: boolean;
}

/** 파이프라인 의존성 주입 */
export interface PipelineDependencies {
  readonly executionAdapter: ExecutionAdapter;
  readonly financeContextProvider: FinanceContextProvider;
  readonly commandRegistry: CommandRegistry;
  readonly logger: FinClawLogger;
  readonly observer?: PipelineObserver;
  readonly getChannel: (
    channelId: string,
  ) => Pick<ChannelPlugin, 'send' | 'addReaction' | 'sendTyping'> | undefined;
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
  constructor(
    private readonly config: PipelineConfig,
    private readonly deps: PipelineDependencies,
  ) {}

  /** MessageRouter.onProcess 콜백으로 등록할 진입점 */
  async process(ctx: MsgContext, match: BindingMatch, signal: AbortSignal): Promise<void> {
    const startTime = performance.now();
    const stagesExecuted: string[] = [];

    // AbortSignal.any: 외부 취소 + 파이프라인 타임아웃 결합
    const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);

    this.deps.observer?.onPipelineStart?.(ctx);

    let typing: TypingController | undefined;

    try {
      // Stage 1: Normalize
      if (combinedSignal.aborted) {
        this.emitAbort(ctx, stagesExecuted, 'normalize', startTime);
        return;
      }
      this.deps.observer?.onStageStart?.('normalize', ctx);
      const normalizeResult = normalizeMessage(ctx);
      stagesExecuted.push('normalize');
      this.deps.observer?.onStageComplete?.('normalize', normalizeResult);

      if (normalizeResult.action !== 'continue') return;
      const normalized = normalizeResult.data;

      // Stage 2: Command
      if (combinedSignal.aborted) {
        this.emitAbort(ctx, stagesExecuted, 'command', startTime);
        return;
      }
      this.deps.observer?.onStageStart?.('command', ctx);
      const cmdResult = await commandStage(
        normalized.normalizedBody,
        this.deps.commandRegistry,
        this.config.commandPrefix,
        ctx,
      );
      stagesExecuted.push('command');
      this.deps.observer?.onStageComplete?.('command', cmdResult);

      if (cmdResult.action !== 'continue') {
        this.emitComplete(ctx, stagesExecuted, startTime);
        return;
      }

      // Stage 3: ACK
      if (combinedSignal.aborted) {
        this.emitAbort(ctx, stagesExecuted, 'ack', startTime);
        return;
      }
      this.deps.observer?.onStageStart?.('ack', ctx);
      const channel = this.deps.getChannel(ctx.channelId as string);
      const noopChannel = { send: undefined, addReaction: undefined, sendTyping: undefined };
      const ackResult = await ackStage(
        channel ?? noopChannel,
        '', // messageId — MsgContext에 없으므로 빈 문자열
        ctx.channelId as string,
        ctx.senderId,
        this.config.enableAck,
        this.deps.logger,
      );
      stagesExecuted.push('ack');
      this.deps.observer?.onStageComplete?.('ack', ackResult);

      if (ackResult.action === 'continue') {
        typing = ackResult.data.typing;
      }

      // Stage 4: Context
      if (combinedSignal.aborted) {
        typing?.seal();
        this.emitAbort(ctx, stagesExecuted, 'context', startTime);
        return;
      }
      this.deps.observer?.onStageStart?.('context', ctx);
      const channelCaps = channel
        ? {
            supportsMarkdown: true,
            supportsImages: true,
            supportsAudio: false,
            supportsVideo: false,
            supportsButtons: false,
            supportsThreads: true,
            supportsReactions: true,
            supportsEditing: true,
            maxMessageLength: 2000,
          }
        : {
            supportsMarkdown: false,
            supportsImages: false,
            supportsAudio: false,
            supportsVideo: false,
            supportsButtons: false,
            supportsThreads: false,
            supportsReactions: false,
            supportsEditing: false,
            maxMessageLength: 2000,
          };

      const ctxResult = await contextStage(
        ctx,
        normalized,
        {
          financeContextProvider: this.deps.financeContextProvider,
          channelCapabilities: channelCaps,
        },
        combinedSignal,
      );
      stagesExecuted.push('context');
      this.deps.observer?.onStageComplete?.('context', ctxResult);

      if (ctxResult.action !== 'continue') {
        typing?.seal();
        if (ctxResult.action === 'abort') {
          this.deps.observer?.onPipelineComplete?.(ctx, {
            success: false,
            stagesExecuted,
            abortedAt: 'context',
            abortReason: ctxResult.reason,
            durationMs: performance.now() - startTime,
          });
        }
        return;
      }
      const enrichedCtx = ctxResult.data;

      // Stage 5: Execute
      if (combinedSignal.aborted) {
        typing?.seal();
        this.emitAbort(ctx, stagesExecuted, 'execute', startTime);
        return;
      }
      this.deps.observer?.onStageStart?.('execute', ctx);
      const execResult = await executeStage(
        enrichedCtx,
        this.deps.executionAdapter,
        combinedSignal,
      );
      stagesExecuted.push('execute');
      this.deps.observer?.onStageComplete?.('execute', execResult);

      if (execResult.action !== 'continue') {
        typing?.seal();
        this.emitComplete(ctx, stagesExecuted, startTime);
        return;
      }

      // Stage 6: Deliver
      typing?.seal();
      if (combinedSignal.aborted) {
        this.emitAbort(ctx, stagesExecuted, 'deliver', startTime);
        return;
      }
      this.deps.observer?.onStageStart?.('deliver', ctx);
      const deliverResult = await deliverResponse(
        execResult.data,
        enrichedCtx,
        channel ?? noopChannel,
        this.deps.logger,
      );
      stagesExecuted.push('deliver');
      this.deps.observer?.onStageComplete?.('deliver', deliverResult);

      const response = deliverResult.action === 'continue' ? deliverResult.data : undefined;
      this.deps.observer?.onPipelineComplete?.(ctx, {
        success: true,
        stagesExecuted,
        durationMs: performance.now() - startTime,
        response,
      });
    } catch (error) {
      typing?.seal();
      this.deps.observer?.onPipelineError?.(ctx, error as Error);
      throw error;
    }
  }

  private emitAbort(
    ctx: MsgContext,
    stagesExecuted: string[],
    stage: string,
    startTime: number,
  ): void {
    this.deps.logger.warn('Pipeline aborted', { stage });
    this.deps.observer?.onPipelineComplete?.(ctx, {
      success: false,
      stagesExecuted,
      abortedAt: stage,
      abortReason: 'Signal aborted',
      durationMs: performance.now() - startTime,
    });
  }

  private emitComplete(ctx: MsgContext, stagesExecuted: string[], startTime: number): void {
    this.deps.observer?.onPipelineComplete?.(ctx, {
      success: true,
      stagesExecuted,
      durationMs: performance.now() - startTime,
    });
  }
}
```

검증: `pnpm typecheck`

---

### - [ ] Step 3: 배럴 export

파일: `packages/server/src/auto-reply/index.ts`

```typescript
// packages/server/src/auto-reply/index.ts — barrel export

// Pipeline orchestrator
export { AutoReplyPipeline } from './pipeline.js';
export type {
  PipelineConfig,
  PipelineDependencies,
  PipelineResult,
  StageResult,
} from './pipeline.js';

// Errors
export { PipelineError } from './errors.js';
export type { PipelineErrorCode } from './errors.js';

// Pipeline context
export { enrichContext } from './pipeline-context.js';
export type {
  PipelineMsgContext,
  MarketSession,
  FinanceContextProvider,
  EnrichContextDeps,
} from './pipeline-context.js';

// Execution adapter
export { MockExecutionAdapter } from './execution-adapter.js';
export type { ExecutionAdapter, ExecutionResult } from './execution-adapter.js';

// Control tokens
export { CONTROL_TOKENS, extractControlTokens } from './control-tokens.js';
export type { ControlToken, ControlTokenResult } from './control-tokens.js';

// Response formatter
export { formatResponse, formatFinancialNumber, splitMessage } from './response-formatter.js';
export type {
  FormatOptions,
  SupportedFormat,
  FormattedResponse,
  ResponsePart,
} from './response-formatter.js';

// Commands
export { InMemoryCommandRegistry } from './commands/registry.js';
export { registerBuiltInCommands } from './commands/built-in.js';
export type {
  CommandRegistry,
  CommandDefinition,
  CommandExecutor,
  CommandResult,
  ParsedCommand,
  CommandCategory,
} from './commands/registry.js';

// Observer
export { DefaultPipelineObserver } from './observer.js';
export type { PipelineObserver } from './observer.js';

// Stages
export { normalizeMessage } from './stages/normalize.js';
export type { NormalizedMessage } from './stages/normalize.js';
export { commandStage } from './stages/command.js';
export { ackStage, createTypingController } from './stages/ack.js';
export type { TypingController } from './stages/ack.js';
export { contextStage } from './stages/context.js';
export { executeStage } from './stages/execute.js';
export type { ExecuteStageResult } from './stages/execute.js';
export { deliverResponse } from './stages/deliver.js';
```

검증: `pnpm typecheck`

---

### - [ ] Step 4: 제어 토큰 테스트

파일: `packages/server/src/auto-reply/__tests__/control-tokens.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { CONTROL_TOKENS, extractControlTokens } from '../control-tokens.js';

describe('extractControlTokens', () => {
  it('토큰이 없는 응답에서 빈 결과를 반환한다', () => {
    const result = extractControlTokens('안녕하세요, 도움이 필요하신가요?');

    expect(result.tokens).toHaveLength(0);
    expect(result.cleanContent).toBe('안녕하세요, 도움이 필요하신가요?');
    expect(result.hasNoReply).toBe(false);
    expect(result.hasSilentReply).toBe(false);
    expect(result.hasHeartbeat).toBe(false);
    expect(result.needsDisclaimer).toBe(false);
    expect(result.needsQuote).toBe(false);
  });

  it('NO_REPLY 토큰을 추출한다', () => {
    const result = extractControlTokens(`${CONTROL_TOKENS.NO_REPLY}`);

    expect(result.hasNoReply).toBe(true);
    expect(result.tokens).toContain(CONTROL_TOKENS.NO_REPLY);
    expect(result.cleanContent).toBe('');
  });

  it('SILENT_REPLY 토큰을 추출한다', () => {
    const result = extractControlTokens(`응답 내용${CONTROL_TOKENS.SILENT_REPLY}`);

    expect(result.hasSilentReply).toBe(true);
    expect(result.cleanContent).toBe('응답 내용');
  });

  it('HEARTBEAT_OK 토큰을 추출한다', () => {
    const result = extractControlTokens(`처리 중${CONTROL_TOKENS.HEARTBEAT_OK}입니다`);

    expect(result.hasHeartbeat).toBe(true);
    expect(result.cleanContent).toBe('처리 중입니다');
  });

  it('ATTACH_DISCLAIMER 토큰을 추출한다', () => {
    const result = extractControlTokens(`AAPL 주가 분석${CONTROL_TOKENS.ATTACH_DISCLAIMER}`);

    expect(result.needsDisclaimer).toBe(true);
    expect(result.cleanContent).toBe('AAPL 주가 분석');
  });

  it('ATTACH_QUOTE 토큰을 추출한다', () => {
    const result = extractControlTokens(`시세 정보${CONTROL_TOKENS.ATTACH_QUOTE}`);

    expect(result.needsQuote).toBe(true);
  });

  it('복합 토큰을 모두 추출한다', () => {
    const input = `분석 결과${CONTROL_TOKENS.ATTACH_DISCLAIMER}${CONTROL_TOKENS.ATTACH_QUOTE}입니다`;
    const result = extractControlTokens(input);

    expect(result.tokens).toHaveLength(2);
    expect(result.needsDisclaimer).toBe(true);
    expect(result.needsQuote).toBe(true);
    expect(result.cleanContent).toBe('분석 결과입니다');
  });

  it('토큰 제거 후 과도한 줄바꿈을 정리한다', () => {
    const input = `첫 줄\n\n\n${CONTROL_TOKENS.HEARTBEAT_OK}\n\n\n두 번째 줄`;
    const result = extractControlTokens(input);

    expect(result.cleanContent).toBe('첫 줄\n\n두 번째 줄');
  });
});
```

검증: `pnpm test -- packages/server/src/auto-reply/__tests__/control-tokens.test.ts`

---

### - [ ] Step 5: 정규화 스테이지 테스트

파일: `packages/server/src/auto-reply/__tests__/normalize.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeMessage } from '../stages/normalize.js';
import type { MsgContext } from '@finclaw/types';
import { createTimestamp, createSessionKey, createChannelId } from '@finclaw/types';

function makeCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    body: 'hello world',
    bodyForAgent: 'hello world',
    rawBody: 'hello world',
    from: 'user1',
    senderId: 'user1',
    senderName: 'User One',
    provider: 'discord',
    channelId: createChannelId('discord'),
    chatType: 'direct',
    sessionKey: createSessionKey('test-session'),
    accountId: 'user1',
    timestamp: createTimestamp(Date.now()),
    ...overrides,
  };
}

describe('normalizeMessage', () => {
  it('공백을 정규화한다', () => {
    const ctx = makeCtx({ body: '  hello   world  ' });
    const result = normalizeMessage(ctx);

    expect(result.action).toBe('continue');
    if (result.action !== 'continue') return;
    expect(result.data.normalizedBody).toBe('hello world');
  });

  it('멘션을 추출한다', () => {
    const ctx = makeCtx({ body: '<@123456> hello <@!789>' });
    const result = normalizeMessage(ctx);

    expect(result.action).toBe('continue');
    if (result.action !== 'continue') return;
    expect(result.data.mentions).toEqual(['123456', '789']);
  });

  it('URL을 추출한다', () => {
    const ctx = makeCtx({
      body: 'Check https://example.com and http://test.org/path',
    });
    const result = normalizeMessage(ctx);

    expect(result.action).toBe('continue');
    if (result.action !== 'continue') return;
    expect(result.data.urls).toEqual(['https://example.com', 'http://test.org/path']);
  });

  it('멘션도 URL도 없는 메시지를 처리한다', () => {
    const ctx = makeCtx({ body: '일반 메시지' });
    const result = normalizeMessage(ctx);

    expect(result.action).toBe('continue');
    if (result.action !== 'continue') return;
    expect(result.data.mentions).toEqual([]);
    expect(result.data.urls).toEqual([]);
    expect(result.data.normalizedBody).toBe('일반 메시지');
  });

  it('원본 ctx를 보존한다', () => {
    const ctx = makeCtx({ body: 'test' });
    const result = normalizeMessage(ctx);

    expect(result.action).toBe('continue');
    if (result.action !== 'continue') return;
    expect(result.data.ctx).toBe(ctx);
  });
});
```

검증: `pnpm test -- packages/server/src/auto-reply/__tests__/normalize.test.ts`

---

### - [ ] Step 6: 명령어 스테이지 테스트

파일: `packages/server/src/auto-reply/__tests__/command.test.ts`

````typescript
import { describe, it, expect, vi } from 'vitest';
import { commandStage } from '../stages/command.js';
import { InMemoryCommandRegistry } from '../commands/registry.js';
import { registerBuiltInCommands } from '../commands/built-in.js';
import type { MsgContext } from '@finclaw/types';
import { createTimestamp, createSessionKey, createChannelId } from '@finclaw/types';

function makeCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    body: '',
    bodyForAgent: '',
    rawBody: '',
    from: 'user1',
    senderId: 'user1',
    senderName: 'User One',
    provider: 'discord',
    channelId: createChannelId('discord'),
    chatType: 'direct',
    sessionKey: createSessionKey('test-session'),
    accountId: 'user1',
    timestamp: createTimestamp(Date.now()),
    ...overrides,
  };
}

describe('commandStage', () => {
  it('명령어가 아닌 메시지는 continue를 반환한다', async () => {
    const registry = new InMemoryCommandRegistry();
    const result = await commandStage('hello world', registry, '/', makeCtx());

    expect(result.action).toBe('continue');
  });

  it('등록된 명령어를 파싱하고 skip을 반환한다', async () => {
    const registry = new InMemoryCommandRegistry();
    registerBuiltInCommands(registry);

    const result = await commandStage('/help', registry, '/', makeCtx());

    expect(result.action).toBe('skip');
    if (result.action !== 'skip') return;
    expect(result.reason).toContain('help');
  });

  it('등록되지 않은 명령어는 continue를 반환한다', async () => {
    const registry = new InMemoryCommandRegistry();
    const result = await commandStage('/unknown', registry, '/', makeCtx());

    expect(result.action).toBe('continue');
  });

  it('코드 펜스 내부의 명령어는 무시한다', async () => {
    const registry = new InMemoryCommandRegistry();
    registerBuiltInCommands(registry);

    const body = '```\n/help\n```';
    const result = await commandStage(body, registry, '/', makeCtx());

    expect(result.action).toBe('continue');
  });

  it('별칭으로 명령어를 실행한다', async () => {
    const registry = new InMemoryCommandRegistry();
    registerBuiltInCommands(registry);

    const result = await commandStage('/h', registry, '/', makeCtx());

    expect(result.action).toBe('skip');
    if (result.action !== 'skip') return;
    expect(result.reason).toContain('h');
  });

  it('requiredRoles가 있으면 skip (권한 부족)을 반환한다', async () => {
    const registry = new InMemoryCommandRegistry();
    registry.register(
      {
        name: 'admin',
        aliases: [],
        description: 'Admin command',
        usage: '/admin',
        category: 'admin',
        requiredRoles: ['admin'],
      },
      vi.fn(),
    );

    const result = await commandStage('/admin', registry, '/', makeCtx());

    expect(result.action).toBe('skip');
    if (result.action !== 'skip') return;
    expect(result.reason).toContain('permissions');
  });
});

describe('InMemoryCommandRegistry', () => {
  it('명령어를 등록하고 조회한다', () => {
    const registry = new InMemoryCommandRegistry();
    const executor = vi.fn();
    registry.register(
      {
        name: 'test',
        aliases: ['t'],
        description: 'Test command',
        usage: '/test',
        category: 'general',
      },
      executor,
    );

    const entry = registry.get('test');
    expect(entry).toBeDefined();
    expect(entry?.definition.name).toBe('test');
  });

  it('별칭으로 명령어를 조회한다', () => {
    const registry = new InMemoryCommandRegistry();
    registry.register(
      {
        name: 'test',
        aliases: ['t'],
        description: 'Test',
        usage: '/test',
        category: 'general',
      },
      vi.fn(),
    );

    expect(registry.get('t')).toBeDefined();
    expect(registry.get('t')?.definition.name).toBe('test');
  });

  it('명령어를 해제한다', () => {
    const registry = new InMemoryCommandRegistry();
    registry.register(
      {
        name: 'test',
        aliases: ['t'],
        description: 'Test',
        usage: '/test',
        category: 'general',
      },
      vi.fn(),
    );

    expect(registry.unregister('test')).toBe(true);
    expect(registry.get('test')).toBeUndefined();
    expect(registry.get('t')).toBeUndefined();
  });

  it('카테고리별로 명령어를 필터링한다', () => {
    const registry = new InMemoryCommandRegistry();
    registerBuiltInCommands(registry);

    const finance = registry.listByCategory('finance');
    expect(finance.length).toBeGreaterThan(0);
    for (const cmd of finance) {
      expect(cmd.category).toBe('finance');
    }
  });

  it('명령어를 파싱한다', () => {
    const registry = new InMemoryCommandRegistry();
    const parsed = registry.parse('/price AAPL', '/');

    expect(parsed).toEqual({
      name: 'price',
      args: ['AAPL'],
      raw: '/price AAPL',
    });
  });

  it('명령어 접두사가 아니면 null을 반환한다', () => {
    const registry = new InMemoryCommandRegistry();
    expect(registry.parse('hello', '/')).toBeNull();
  });
});
````

검증: `pnpm test -- packages/server/src/auto-reply/__tests__/command.test.ts`

---

### - [ ] Step 7: 파이프라인 컨텍스트 테스트

파일: `packages/server/src/auto-reply/__tests__/pipeline-context.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest';
import { enrichContext, type FinanceContextProvider } from '../pipeline-context.js';
import type { MsgContext, ChannelCapabilities } from '@finclaw/types';
import { createTimestamp, createSessionKey, createChannelId } from '@finclaw/types';

function makeCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    body: 'test message',
    bodyForAgent: 'test message',
    rawBody: 'test message',
    from: 'user1',
    senderId: 'user1',
    senderName: 'User One',
    provider: 'discord',
    channelId: createChannelId('discord'),
    chatType: 'direct',
    sessionKey: createSessionKey('test-session'),
    accountId: 'user1',
    timestamp: createTimestamp(Date.now()),
    ...overrides,
  };
}

const defaultCaps: ChannelCapabilities = {
  supportsMarkdown: true,
  supportsImages: true,
  supportsAudio: false,
  supportsVideo: false,
  supportsButtons: false,
  supportsThreads: true,
  supportsReactions: true,
  supportsEditing: true,
  maxMessageLength: 2000,
};

function makeProvider(overrides: Partial<FinanceContextProvider> = {}): FinanceContextProvider {
  return {
    getActiveAlerts: vi.fn().mockResolvedValue([]),
    getPortfolio: vi.fn().mockResolvedValue(null),
    getRecentNews: vi.fn().mockResolvedValue([]),
    getMarketSession: vi.fn().mockReturnValue({
      isOpen: true,
      market: 'NYSE',
      nextOpenAt: null,
      timezone: 'America/New_York',
    }),
    getWatchlist: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('enrichContext', () => {
  it('MsgContext를 PipelineMsgContext로 확장한다', async () => {
    const ctx = makeCtx();
    const provider = makeProvider();
    const result = await enrichContext(
      ctx,
      { financeContextProvider: provider, channelCapabilities: defaultCaps },
      AbortSignal.timeout(5000),
    );

    expect(result.body).toBe(ctx.body);
    expect(result.senderId).toBe(ctx.senderId);
    expect(result.channelCapabilities).toBe(defaultCaps);
    expect(result.marketSession?.isOpen).toBe(true);
    expect(result.activeAlerts).toEqual([]);
    expect(result.portfolioSnapshot).toBeNull();
    expect(result.newsContext).toEqual([]);
  });

  it('금융 데이터 개별 실패 시 undefined로 degraded된다', async () => {
    const provider = makeProvider({
      getActiveAlerts: vi.fn().mockRejectedValue(new Error('alerts failed')),
      getPortfolio: vi.fn().mockRejectedValue(new Error('portfolio failed')),
    });

    const result = await enrichContext(
      makeCtx(),
      { financeContextProvider: provider, channelCapabilities: defaultCaps },
      AbortSignal.timeout(5000),
    );

    // 개별 실패 시 undefined
    expect(result.activeAlerts).toBeUndefined();
    expect(result.portfolioSnapshot).toBeUndefined();
    // 성공한 것은 정상 반환
    expect(result.newsContext).toEqual([]);
    expect(result.marketSession).toBeDefined();
  });

  it('모든 금융 프로바이더를 병렬 호출한다', async () => {
    const provider = makeProvider();
    await enrichContext(
      makeCtx(),
      { financeContextProvider: provider, channelCapabilities: defaultCaps },
      AbortSignal.timeout(5000),
    );

    expect(provider.getActiveAlerts).toHaveBeenCalledTimes(1);
    expect(provider.getPortfolio).toHaveBeenCalledTimes(1);
    expect(provider.getRecentNews).toHaveBeenCalledTimes(1);
    expect(provider.getWatchlist).toHaveBeenCalledTimes(1);
    expect(provider.getMarketSession).toHaveBeenCalledTimes(1);
  });
});
```

검증: `pnpm test -- packages/server/src/auto-reply/__tests__/pipeline-context.test.ts`

---

### - [ ] Step 8: 실행 어댑터 테스트

파일: `packages/server/src/auto-reply/__tests__/execution-adapter.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { MockExecutionAdapter } from '../execution-adapter.js';
import type { PipelineMsgContext } from '../pipeline-context.js';
import { createTimestamp, createSessionKey, createChannelId } from '@finclaw/types';

function makePipelineCtx(): PipelineMsgContext {
  return {
    body: 'test',
    bodyForAgent: 'test',
    rawBody: 'test',
    from: 'user1',
    senderId: 'user1',
    senderName: 'User',
    provider: 'discord',
    channelId: createChannelId('discord'),
    chatType: 'direct',
    sessionKey: createSessionKey('test'),
    accountId: 'user1',
    timestamp: createTimestamp(Date.now()),
    normalizedBody: 'test',
    mentions: [],
    urls: [],
    channelCapabilities: {
      supportsMarkdown: true,
      supportsImages: false,
      supportsAudio: false,
      supportsVideo: false,
      supportsButtons: false,
      supportsThreads: false,
      supportsReactions: false,
      supportsEditing: false,
      maxMessageLength: 2000,
    },
    userRoles: [],
    isAdmin: false,
  };
}

describe('MockExecutionAdapter', () => {
  it('기본 응답을 반환한다', async () => {
    const adapter = new MockExecutionAdapter();
    const result = await adapter.execute(makePipelineCtx(), AbortSignal.timeout(5000));

    expect(result.content).toBe('Mock response');
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('커스텀 응답을 반환한다', async () => {
    const adapter = new MockExecutionAdapter('Custom answer');
    const result = await adapter.execute(makePipelineCtx(), AbortSignal.timeout(5000));

    expect(result.content).toBe('Custom answer');
  });
});
```

검증: `pnpm test -- packages/server/src/auto-reply/__tests__/execution-adapter.test.ts`

---

### - [ ] Step 9: ACK 스테이지 테스트

파일: `packages/server/src/auto-reply/__tests__/ack.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ackStage, createTypingController } from '../stages/ack.js';
import type { FinClawLogger } from '@finclaw/infra';

function makeLogger(): FinClawLogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    flush: vi.fn().mockResolvedValue(undefined),
  } as unknown as FinClawLogger;
}

describe('createTypingController', () => {
  it('idle → active → sealed 상태 전이', () => {
    const channel = { sendTyping: vi.fn() };
    const controller = createTypingController(channel, 'ch1', 'chat1');

    expect(controller.state).toBe('idle');

    controller.start();
    expect(controller.state).toBe('active');

    controller.seal();
    expect(controller.state).toBe('sealed');
  });

  it('sealed 상태에서 start()는 무시된다', () => {
    const channel = { sendTyping: vi.fn() };
    const controller = createTypingController(channel, 'ch1', 'chat1');

    controller.start();
    controller.seal();
    controller.start(); // sealed 상태에서 재시작 시도

    expect(controller.state).toBe('sealed');
  });

  it('이미 active인 상태에서 start()는 무시된다', () => {
    const channel = { sendTyping: vi.fn() };
    const controller = createTypingController(channel, 'ch1', 'chat1');

    controller.start();
    controller.start(); // 중복 시작

    expect(controller.state).toBe('active');
  });

  it('TTL 보호로 자동 seal된다', () => {
    vi.useFakeTimers();
    const channel = { sendTyping: vi.fn() };
    const controller = createTypingController(channel, 'ch1', 'chat1', { ttlMs: 100 });

    controller.start();
    expect(controller.state).toBe('active');

    vi.advanceTimersByTime(150);
    expect(controller.state).toBe('sealed');
  });
});

describe('ackStage', () => {
  it('ACK 활성화 시 addReaction을 호출한다', async () => {
    const channel = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn(),
    };
    const logger = makeLogger();

    const result = await ackStage(channel, 'msg1', 'ch1', 'chat1', true, logger);

    expect(channel.addReaction).toHaveBeenCalledWith('msg1', '👀');
    expect(result.action).toBe('continue');
    if (result.action !== 'continue') return;
    expect(result.data.typing.state).toBe('active');
  });

  it('ACK 비활성화 시 addReaction을 호출하지 않는다', async () => {
    const channel = {
      addReaction: vi.fn(),
      sendTyping: vi.fn(),
    };
    const logger = makeLogger();

    await ackStage(channel, 'msg1', 'ch1', 'chat1', false, logger);

    expect(channel.addReaction).not.toHaveBeenCalled();
  });

  it('addReaction 실패 시 warn 로깅 후 계속 진행한다', async () => {
    const channel = {
      addReaction: vi.fn().mockRejectedValue(new Error('reaction failed')),
      sendTyping: vi.fn(),
    };
    const logger = makeLogger();

    const result = await ackStage(channel, 'msg1', 'ch1', 'chat1', true, logger);

    expect(logger.warn).toHaveBeenCalled();
    expect(result.action).toBe('continue');
  });
});
```

검증: `pnpm test -- packages/server/src/auto-reply/__tests__/ack.test.ts`

---

### - [ ] Step 10: 전송 스테이지 테스트

파일: `packages/server/src/auto-reply/__tests__/deliver.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest';
import { deliverResponse } from '../stages/deliver.js';
import type { ExecuteStageResult } from '../stages/execute.js';
import type { PipelineMsgContext } from '../pipeline-context.js';
import type { FinClawLogger } from '@finclaw/infra';
import { createTimestamp, createSessionKey, createChannelId } from '@finclaw/types';

function makeLogger(): FinClawLogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    flush: vi.fn().mockResolvedValue(undefined),
  } as unknown as FinClawLogger;
}

function makePipelineCtx(overrides: Partial<PipelineMsgContext> = {}): PipelineMsgContext {
  return {
    body: 'test',
    bodyForAgent: 'test',
    rawBody: 'test',
    from: 'user1',
    senderId: 'user1',
    senderName: 'User',
    provider: 'discord',
    channelId: createChannelId('discord'),
    chatType: 'direct',
    sessionKey: createSessionKey('test'),
    accountId: 'user1',
    timestamp: createTimestamp(Date.now()),
    normalizedBody: 'test',
    mentions: [],
    urls: [],
    channelCapabilities: {
      supportsMarkdown: true,
      supportsImages: false,
      supportsAudio: false,
      supportsVideo: false,
      supportsButtons: false,
      supportsThreads: false,
      supportsReactions: false,
      supportsEditing: false,
      maxMessageLength: 2000,
    },
    userRoles: [],
    isAdmin: false,
    ...overrides,
  };
}

function makeExecResult(overrides: Partial<ExecuteStageResult> = {}): ExecuteStageResult {
  return {
    content: 'Hello, this is a response.',
    controlTokens: {
      cleanContent: 'Hello, this is a response.',
      tokens: [],
      hasNoReply: false,
      hasSilentReply: false,
      hasHeartbeat: false,
      needsDisclaimer: false,
      needsQuote: false,
    },
    ...overrides,
  };
}

describe('deliverResponse', () => {
  it('일반 응답을 전송한다', async () => {
    const channel = { send: vi.fn().mockResolvedValue(undefined) };
    const logger = makeLogger();
    const ctx = makePipelineCtx();

    const result = await deliverResponse(makeExecResult(), ctx, channel, logger);

    expect(result.action).toBe('continue');
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('SILENT_REPLY 시 skip을 반환한다', async () => {
    const channel = { send: vi.fn() };
    const logger = makeLogger();
    const execResult = makeExecResult({
      controlTokens: {
        cleanContent: 'test',
        tokens: [],
        hasNoReply: false,
        hasSilentReply: true,
        hasHeartbeat: false,
        needsDisclaimer: false,
        needsQuote: false,
      },
    });

    const result = await deliverResponse(execResult, makePipelineCtx(), channel, logger);

    expect(result.action).toBe('skip');
    expect(channel.send).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it('면책 조항을 첨부한다', async () => {
    const channel = { send: vi.fn().mockResolvedValue(undefined) };
    const logger = makeLogger();
    const execResult = makeExecResult({
      controlTokens: {
        cleanContent: 'AAPL analysis',
        tokens: [],
        hasNoReply: false,
        hasSilentReply: false,
        hasHeartbeat: false,
        needsDisclaimer: true,
        needsQuote: false,
      },
    });

    const result = await deliverResponse(execResult, makePipelineCtx(), channel, logger);

    expect(result.action).toBe('continue');
    if (result.action !== 'continue') return;
    const text = result.data.payloads[0].text!;
    expect(text).toContain('투자 조언이 아니며');
  });

  it('긴 메시지를 분할 전송한다', async () => {
    const channel = { send: vi.fn().mockResolvedValue(undefined) };
    const logger = makeLogger();
    const longContent = 'A'.repeat(3000);
    const execResult = makeExecResult({ content: longContent });
    const ctx = makePipelineCtx();

    const result = await deliverResponse(execResult, ctx, channel, logger);

    expect(result.action).toBe('continue');
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  it('개별 전송 실패 시 나머지 파트는 계속 전송한다', async () => {
    const channel = {
      send: vi.fn().mockRejectedValueOnce(new Error('send failed')).mockResolvedValue(undefined),
    };
    const logger = makeLogger();
    const longContent = 'A'.repeat(3000);
    const execResult = makeExecResult({ content: longContent });

    const result = await deliverResponse(execResult, makePipelineCtx(), channel, logger);

    expect(result.action).toBe('continue');
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('send가 없는 채널에서도 정상 동작한다', async () => {
    const channel = { send: undefined };
    const logger = makeLogger();

    const result = await deliverResponse(makeExecResult(), makePipelineCtx(), channel, logger);

    expect(result.action).toBe('continue');
  });
});
```

검증: `pnpm test -- packages/server/src/auto-reply/__tests__/deliver.test.ts`

---

### - [ ] Step 11: 파이프라인 통합 테스트

파일: `packages/server/src/auto-reply/__tests__/pipeline.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest';
import { AutoReplyPipeline, type PipelineConfig, type PipelineDependencies } from '../pipeline.js';
import { MockExecutionAdapter } from '../execution-adapter.js';
import { InMemoryCommandRegistry } from '../commands/registry.js';
import { registerBuiltInCommands } from '../commands/built-in.js';
import { CONTROL_TOKENS } from '../control-tokens.js';
import type { FinanceContextProvider } from '../pipeline-context.js';
import type { PipelineObserver } from '../observer.js';
import type { MsgContext, ChannelPlugin } from '@finclaw/types';
import type { FinClawLogger } from '@finclaw/infra';
import type { BindingMatch } from '../../process/binding-matcher.js';
import { createTimestamp, createSessionKey, createChannelId, createAgentId } from '@finclaw/types';

function makeLogger(): FinClawLogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    flush: vi.fn().mockResolvedValue(undefined),
  } as unknown as FinClawLogger;
}

function makeCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    body: 'hello finclaw',
    bodyForAgent: 'hello finclaw',
    rawBody: 'hello finclaw',
    from: 'user1',
    senderId: 'user1',
    senderName: 'User',
    provider: 'discord',
    channelId: createChannelId('discord'),
    chatType: 'direct',
    sessionKey: createSessionKey('test-session'),
    accountId: 'user1',
    timestamp: createTimestamp(Date.now()),
    ...overrides,
  };
}

function makeMatch(): BindingMatch {
  return {
    agentId: createAgentId('default'),
    rule: {
      agentId: createAgentId('default'),
      priority: 0,
    },
    matchTier: 'default',
  };
}

function makeChannel(): Pick<ChannelPlugin, 'send' | 'addReaction' | 'sendTyping'> {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
  };
}

function makeProvider(): FinanceContextProvider {
  return {
    getActiveAlerts: vi.fn().mockResolvedValue([]),
    getPortfolio: vi.fn().mockResolvedValue(null),
    getRecentNews: vi.fn().mockResolvedValue([]),
    getMarketSession: vi.fn().mockReturnValue({
      isOpen: true,
      market: 'NYSE',
      nextOpenAt: null,
      timezone: 'America/New_York',
    }),
    getWatchlist: vi.fn().mockResolvedValue([]),
  };
}

function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    enableAck: true,
    commandPrefix: '/',
    maxResponseLength: 2000,
    timeoutMs: 30_000,
    respectMarketHours: false,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<PipelineDependencies> = {}): PipelineDependencies {
  const channel = makeChannel();
  const registry = new InMemoryCommandRegistry();
  registerBuiltInCommands(registry);

  return {
    executionAdapter: new MockExecutionAdapter('AI response'),
    financeContextProvider: makeProvider(),
    commandRegistry: registry,
    logger: makeLogger(),
    getChannel: () => channel,
    ...overrides,
  };
}

describe('AutoReplyPipeline', () => {
  it('전체 6단계를 정상 실행한다', async () => {
    const observer: PipelineObserver = {
      onPipelineStart: vi.fn(),
      onPipelineComplete: vi.fn(),
      onStageStart: vi.fn(),
      onStageComplete: vi.fn(),
    };
    const deps = makeDeps({ observer });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    await pipeline.process(makeCtx(), makeMatch(), AbortSignal.timeout(10_000));

    expect(observer.onPipelineStart).toHaveBeenCalledTimes(1);
    expect(observer.onPipelineComplete).toHaveBeenCalledTimes(1);

    const completeCall = vi.mocked(observer.onPipelineComplete!).mock.calls[0];
    expect(completeCall[1].success).toBe(true);
    expect(completeCall[1].stagesExecuted).toEqual([
      'normalize',
      'command',
      'ack',
      'context',
      'execute',
      'deliver',
    ]);
  });

  it('명령어 메시지 시 command 스테이지에서 skip한다', async () => {
    const observer: PipelineObserver = {
      onPipelineStart: vi.fn(),
      onPipelineComplete: vi.fn(),
      onStageStart: vi.fn(),
      onStageComplete: vi.fn(),
    };
    const deps = makeDeps({ observer });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    await pipeline.process(makeCtx({ body: '/help' }), makeMatch(), AbortSignal.timeout(10_000));

    const completeCall = vi.mocked(observer.onPipelineComplete!).mock.calls[0];
    expect(completeCall[1].stagesExecuted).toEqual(['normalize', 'command']);
  });

  it('NO_REPLY 토큰 시 execute 스테이지에서 skip한다', async () => {
    const observer: PipelineObserver = {
      onPipelineStart: vi.fn(),
      onPipelineComplete: vi.fn(),
      onStageStart: vi.fn(),
      onStageComplete: vi.fn(),
    };
    const adapter = new MockExecutionAdapter(CONTROL_TOKENS.NO_REPLY);
    const deps = makeDeps({ executionAdapter: adapter, observer });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    await pipeline.process(makeCtx(), makeMatch(), AbortSignal.timeout(10_000));

    const completeCall = vi.mocked(observer.onPipelineComplete!).mock.calls[0];
    expect(completeCall[1].stagesExecuted).toContain('execute');
    expect(completeCall[1].stagesExecuted).not.toContain('deliver');
  });

  it('SILENT_REPLY 토큰 시 deliver 스테이지에서 skip한다', async () => {
    const channel = makeChannel();
    const adapter = new MockExecutionAdapter(`response${CONTROL_TOKENS.SILENT_REPLY}`);
    const deps = makeDeps({ executionAdapter: adapter, getChannel: () => channel });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    await pipeline.process(makeCtx(), makeMatch(), AbortSignal.timeout(10_000));

    expect(channel.send).not.toHaveBeenCalled();
  });

  it('채널이 없어도 정상 동작한다', async () => {
    const deps = makeDeps({ getChannel: () => undefined });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    // 에러 없이 완료
    await pipeline.process(makeCtx(), makeMatch(), AbortSignal.timeout(10_000));
  });

  it('ACK 비활성화 시 addReaction을 호출하지 않는다', async () => {
    const channel = makeChannel();
    const deps = makeDeps({ getChannel: () => channel });
    const pipeline = new AutoReplyPipeline(makeConfig({ enableAck: false }), deps);

    await pipeline.process(makeCtx(), makeMatch(), AbortSignal.timeout(10_000));

    expect(channel.addReaction).not.toHaveBeenCalled();
  });

  it('이미 abort된 signal로 호출 시 즉시 종료한다', async () => {
    const observer: PipelineObserver = {
      onPipelineStart: vi.fn(),
      onPipelineComplete: vi.fn(),
      onStageStart: vi.fn(),
      onStageComplete: vi.fn(),
    };
    const deps = makeDeps({ observer });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    const controller = new AbortController();
    controller.abort();

    await pipeline.process(makeCtx(), makeMatch(), controller.signal);

    const completeCall = vi.mocked(observer.onPipelineComplete!).mock.calls[0];
    expect(completeCall[1].success).toBe(false);
    expect(completeCall[1].abortReason).toBe('Signal aborted');
  });

  it('ExecutionAdapter 에러 시 예외를 전파한다', async () => {
    const adapter = {
      execute: vi.fn().mockRejectedValue(new Error('AI error')),
    };
    const observer: PipelineObserver = {
      onPipelineError: vi.fn(),
    };
    const deps = makeDeps({ executionAdapter: adapter, observer });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    await expect(
      pipeline.process(makeCtx(), makeMatch(), AbortSignal.timeout(10_000)),
    ).rejects.toThrow('AI error');

    expect(observer.onPipelineError).toHaveBeenCalledTimes(1);
  });
});
```

검증: `pnpm test -- packages/server/src/auto-reply/__tests__/pipeline.test.ts`

---

## 최종 검증

```bash
# 전체 타입 체크
pnpm typecheck

# Part 3 테스트 실행
pnpm test -- packages/server/src/auto-reply/__tests__/*.test.ts
```

### 체크리스트 요약

| #   | 파일                                                                 | 유형 |
| --- | -------------------------------------------------------------------- | ---- |
| 1   | `packages/server/src/auto-reply/observer.ts`                         | 생성 |
| 2   | `packages/server/src/auto-reply/pipeline.ts`                         | 생성 |
| 3   | `packages/server/src/auto-reply/index.ts`                            | 생성 |
| 4   | `packages/server/src/auto-reply/__tests__/control-tokens.test.ts`    | 생성 |
| 5   | `packages/server/src/auto-reply/__tests__/normalize.test.ts`         | 생성 |
| 6   | `packages/server/src/auto-reply/__tests__/command.test.ts`           | 생성 |
| 7   | `packages/server/src/auto-reply/__tests__/pipeline-context.test.ts`  | 생성 |
| 8   | `packages/server/src/auto-reply/__tests__/execution-adapter.test.ts` | 생성 |
| 9   | `packages/server/src/auto-reply/__tests__/ack.test.ts`               | 생성 |
| 10  | `packages/server/src/auto-reply/__tests__/deliver.test.ts`           | 생성 |
| 11  | `packages/server/src/auto-reply/__tests__/pipeline.test.ts`          | 생성 |
