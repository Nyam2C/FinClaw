# Phase 8 TODO-2: 스테이지 모듈

> Part 2 스테이지 모듈 — 파이프라인의 6개 처리 단계 구현
>
> 소스 6개 = **6 작업**

---

### - [ ] Step 1: 메시지 정규화 스테이지

파일: `packages/server/src/auto-reply/stages/normalize.ts`

```typescript
// packages/server/src/auto-reply/stages/normalize.ts
import type { MsgContext } from '@finclaw/types';
import type { StageResult } from '../pipeline.js';

/**
 * 정규화 결과 필드
 *
 * 봇 필터링, 빈 메시지 필터링, 메시지 dedupe는 MessageRouter가 이미 처리한다.
 * Normalize 스테이지는 멘션/URL 추출과 normalizedBody 생성만 담당한다.
 */
export interface NormalizedMessage {
  readonly ctx: MsgContext;
  readonly normalizedBody: string;
  readonly mentions: readonly string[];
  readonly urls: readonly string[];
}

/**
 * 메시지 정규화
 *
 * 1. 콘텐츠 트림 + 연속 공백 정규화
 * 2. 멘션 태그 추출 (<@userId> 패턴)
 * 3. URL 추출
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

  return {
    action: 'continue',
    data: {
      ctx,
      normalizedBody: body.replace(/\s+/g, ' '),
      mentions,
      urls,
    },
  };
}
```

검증: `pnpm typecheck`

---

### - [ ] Step 2: 명령어 처리 스테이지

파일: `packages/server/src/auto-reply/stages/command.ts`

````typescript
// packages/server/src/auto-reply/stages/command.ts
import type { MsgContext } from '@finclaw/types';
import type { CommandRegistry, CommandResult } from '../commands/registry.js';
import type { StageResult } from '../pipeline.js';

export interface CommandStageResult {
  readonly handled: boolean;
  readonly commandResult?: CommandResult;
}

/**
 * 명령어 단계
 *
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
): Promise<StageResult<MsgContext>> {
  // 코드 펜스 내부의 명령어는 무시
  if (isInsideCodeFence(normalizedBody, prefix)) {
    return { action: 'continue', data: ctx };
  }

  const parsed = registry.parse(normalizedBody, prefix);
  if (!parsed) {
    return { action: 'continue', data: ctx };
  }

  const command = registry.get(parsed.name);
  if (!command) {
    return { action: 'continue', data: ctx };
  }

  // 권한 검사
  if (command.definition.requiredRoles?.length) {
    return { action: 'skip', reason: `Insufficient permissions for command: ${parsed.name}` };
  }

  // 명령어 실행
  await command.executor(parsed.args, ctx);

  return { action: 'skip', reason: `Command executed: ${parsed.name}` };
}

/** 코드 펜스(```) 내부에 있는 명령어인지 판별 */
function isInsideCodeFence(body: string, prefix: string): boolean {
  const prefixIndex = body.indexOf(prefix);
  if (prefixIndex === -1) return false;

  const beforePrefix = body.slice(0, prefixIndex);
  const fenceCount = (beforePrefix.match(/```/g) ?? []).length;
  return fenceCount % 2 === 1;
}
````

검증: `pnpm typecheck`

---

### - [ ] Step 3: ACK 및 타이핑 스테이지

파일: `packages/server/src/auto-reply/stages/ack.ts`

```typescript
// packages/server/src/auto-reply/stages/ack.ts
import type { ChannelPlugin } from '@finclaw/types';
import type { FinClawLogger } from '@finclaw/infra';
import { startTyping, type TypingHandle } from '../../channels/typing.js';
import type { StageResult } from '../pipeline.js';

type TypingState = 'idle' | 'active' | 'sealed';

/** 3-상태 타이핑 컨트롤러 */
export interface TypingController {
  start(): void;
  seal(): void;
  readonly state: TypingState;
}

/**
 * TypingController 생성
 *
 * active → processing → sealed
 * - active: 타이핑 인디케이터 표시 중
 * - sealed: 파이프라인 완료 후 재시작 방지
 */
export function createTypingController(
  channel: Pick<ChannelPlugin, 'sendTyping'>,
  channelId: string,
  chatId: string,
  options: { intervalMs?: number; ttlMs?: number } = {},
): TypingController {
  const { intervalMs = 5000, ttlMs = 120_000 } = options;
  let state: TypingState = 'idle';
  let handle: TypingHandle | undefined;
  let ttlTimer: ReturnType<typeof setTimeout> | undefined;

  return {
    get state() {
      return state;
    },
    start() {
      if (state !== 'idle') return;
      state = 'active';
      handle = startTyping(channel, channelId, chatId, intervalMs);

      // TTL 보호: 최대 시간 후 자동 seal
      ttlTimer = setTimeout(() => {
        if (state === 'active') {
          handle?.stop();
          state = 'sealed';
        }
      }, ttlMs);
    },
    seal() {
      if (state === 'sealed') return;
      state = 'sealed';
      handle?.stop();
      if (ttlTimer) clearTimeout(ttlTimer);
    },
  };
}

export interface AckResult {
  readonly typing: TypingController;
}

/**
 * ACK 스테이지
 *
 * 1. addReaction으로 수신 확인
 * 2. TypingController 시작
 */
export async function ackStage(
  channel: Pick<ChannelPlugin, 'addReaction' | 'sendTyping'>,
  messageId: string,
  channelId: string,
  chatId: string,
  enableAck: boolean,
  logger: FinClawLogger,
): Promise<StageResult<AckResult>> {
  // ACK 리액션
  if (enableAck && channel.addReaction) {
    try {
      await channel.addReaction(messageId, '👀');
    } catch (error) {
      logger.warn('Failed to add ACK reaction', { error });
    }
  }

  // 타이핑 시작
  const typing = createTypingController(channel, channelId, chatId);
  typing.start();

  return { action: 'continue', data: { typing } };
}
```

검증: `pnpm typecheck`

---

### - [ ] Step 4: 컨텍스트 확장 스테이지

파일: `packages/server/src/auto-reply/stages/context.ts`

```typescript
// packages/server/src/auto-reply/stages/context.ts
import type { MsgContext } from '@finclaw/types';
import type { PipelineMsgContext, EnrichContextDeps } from '../pipeline-context.js';
import { enrichContext } from '../pipeline-context.js';
import type { NormalizedMessage } from './normalize.js';
import type { StageResult } from '../pipeline.js';

/**
 * 컨텍스트 확장 단계
 *
 * MsgContext → PipelineMsgContext 확장.
 * 금융 데이터는 enrichContext() 내부에서 Promise.allSettled로 병렬 로딩한다.
 */
export async function contextStage(
  ctx: MsgContext,
  normalized: NormalizedMessage,
  deps: EnrichContextDeps,
  signal: AbortSignal,
): Promise<StageResult<PipelineMsgContext>> {
  try {
    const enriched = await enrichContext(ctx, deps, signal);

    return {
      action: 'continue',
      data: {
        ...enriched,
        normalizedBody: normalized.normalizedBody,
        mentions: normalized.mentions,
        urls: normalized.urls,
      },
    };
  } catch (error) {
    return {
      action: 'abort',
      reason: `Failed to enrich context: ${(error as Error).message}`,
      error: error as Error,
    };
  }
}
```

검증: `pnpm typecheck`

---

### - [ ] Step 5: AI 실행 스테이지

파일: `packages/server/src/auto-reply/stages/execute.ts`

```typescript
// packages/server/src/auto-reply/stages/execute.ts
import type { ExecutionAdapter } from '../execution-adapter.js';
import type { PipelineMsgContext } from '../pipeline-context.js';
import { extractControlTokens, type ControlTokenResult } from '../control-tokens.js';
import type { StageResult } from '../pipeline.js';

export interface ExecuteStageResult {
  readonly content: string;
  readonly controlTokens: ControlTokenResult;
  readonly usage?: { inputTokens: number; outputTokens: number };
}

/**
 * AI 실행 단계
 *
 * Phase 8 책임: ExecutionAdapter에 위임 + 제어 토큰 후처리
 * Phase 9 책임: AI API 호출, 도구 루프, 세션 write lock, 스트리밍
 */
export async function executeStage(
  ctx: PipelineMsgContext,
  adapter: ExecutionAdapter,
  signal: AbortSignal,
): Promise<StageResult<ExecuteStageResult>> {
  const raw = await adapter.execute(ctx, signal);

  // 제어 토큰 추출
  const tokenResult = extractControlTokens(raw.content);

  if (tokenResult.hasNoReply) {
    return { action: 'skip', reason: 'AI decided not to reply (NO_REPLY token)' };
  }

  return {
    action: 'continue',
    data: {
      content: tokenResult.cleanContent,
      controlTokens: tokenResult,
      usage: raw.usage,
    },
  };
}
```

검증: `pnpm typecheck`

---

### - [ ] Step 6: 응답 전송 스테이지

파일: `packages/server/src/auto-reply/stages/deliver.ts`

```typescript
// packages/server/src/auto-reply/stages/deliver.ts
import type { OutboundMessage, ReplyPayload, ChannelPlugin } from '@finclaw/types';
import type { FinClawLogger } from '@finclaw/infra';
import type { PipelineMsgContext } from '../pipeline-context.js';
import type { ExecuteStageResult } from './execute.js';
import { splitMessage } from '../response-formatter.js';
import type { StageResult } from '../pipeline.js';

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
    return { action: 'skip', reason: 'Silent reply (logged only)' };
  }

  let content = executeResult.content;

  // 면책 조항 첨부
  if (executeResult.controlTokens.needsDisclaimer) {
    content +=
      '\n\n---\n' +
      '_본 정보는 투자 조언이 아니며, 투자 결정은 본인의 판단과 책임 하에 이루어져야 합니다._';
  }

  // 메시지 분할
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
      }
    }
  }

  return { action: 'continue', data: outbound };
}
```

검증: `pnpm typecheck`

---

## 최종 검증

```bash
# 전체 타입 체크
pnpm typecheck
```

### 체크리스트 요약

| #   | 파일                                                 | 유형 |
| --- | ---------------------------------------------------- | ---- |
| 1   | `packages/server/src/auto-reply/stages/normalize.ts` | 생성 |
| 2   | `packages/server/src/auto-reply/stages/command.ts`   | 생성 |
| 3   | `packages/server/src/auto-reply/stages/ack.ts`       | 생성 |
| 4   | `packages/server/src/auto-reply/stages/context.ts`   | 생성 |
| 5   | `packages/server/src/auto-reply/stages/execute.ts`   | 생성 |
| 6   | `packages/server/src/auto-reply/stages/deliver.ts`   | 생성 |
