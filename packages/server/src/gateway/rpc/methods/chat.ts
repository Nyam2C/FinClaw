// packages/server/src/gateway/rpc/methods/chat.ts
import { ModelFloorExhaustedError } from '@finclaw/agent';
import type { FinClawLogger } from '@finclaw/infra';
import type { AgentId, ModelRef, ModelTier, SessionKey, StorageAdapter } from '@finclaw/types';
import { createAgentId, createSessionKey } from '@finclaw/types';
import { z } from 'zod/v4';
import type { RunnerExecutionAdapter } from '../../../auto-reply/execution-adapter.js';
import type { GatewayBroadcaster } from '../../broadcaster.js';
import type { ChatRegistry } from '../../registry.js';
import { registerMethod } from '../index.js';
import type { RpcMethodHandler, WsConnection } from '../types.js';

/** chat.send 타임아웃 — 긴 도구 체인에서도 안전하도록 60초. */
const CHAT_SEND_TIMEOUT_MS = 60_000;

/**
 * chat.* 메서드가 필요로 하는 공용 의존성.
 */
export interface ChatMethodsDeps {
  readonly registry: ChatRegistry;
  readonly connections: Map<string, WsConnection>;
  readonly broadcaster: GatewayBroadcaster;
  readonly storage: StorageAdapter;
  readonly defaultModel: ModelRef;
  readonly adapter: RunnerExecutionAdapter;
  /** Phase 24 D: ModelFloorExhaustedError 캐치 시 구조화 로그용 (선택). */
  readonly logger?: FinClawLogger;
}

/**
 * Phase 24 D: 사용자에게 보이는 한국어 에러 메시지 (B6 — minModel 보호).
 * RPC dispatcher 가 INTERNAL_ERROR 코드로 wrap, message 만 client 에 노출됨.
 */
const FLOOR_EXHAUSTED_MESSAGE = (tier: string): string =>
  `요청에 필요한 모델(${tier} 이상)이 일시적으로 사용 불가합니다. 약 60초 후 다시 시도해 주세요.`;

/**
 * 세션 키 유도 — TUI 사용자 + 에이전트 단위로 대화 이력을 공유.
 * userId가 없는 anonymous 연결은 connectionId를 사용해 격리.
 */
function deriveTuiSessionKey(userId: string | undefined, agentId: string): SessionKey {
  const id = (userId ?? 'anon').toLowerCase().replace(/[^a-z0-9\-_]/g, '_');
  return createSessionKey(`tui:${id}:${agentId}`);
}

export function createChatMethods(deps: ChatMethodsDeps): readonly RpcMethodHandler[] {
  const startHandler: RpcMethodHandler<{ agentId: string; model?: string }, { sessionId: string }> =
    {
      method: 'chat.start',
      description: '새 채팅 세션을 시작합니다',
      authLevel: 'token',
      schema: z.object({
        agentId: z.string(),
        model: z.string().optional(),
      }),
      async execute(params, ctx) {
        if (!ctx.connectionId) {
          throw new Error('chat.start requires WebSocket connection');
        }
        const sessionKey = deriveTuiSessionKey(ctx.auth.userId, params.agentId);
        const model: ModelRef = params.model
          ? { ...deps.defaultModel, model: params.model }
          : deps.defaultModel;
        const session = deps.registry.startSession({
          agentId: params.agentId,
          connectionId: ctx.connectionId,
          model,
          sessionKey,
        });
        return { sessionId: session.sessionId };
      },
    };

  const sendHandler: RpcMethodHandler<
    { sessionId: string; message: string; idempotencyKey?: string; modelHint?: ModelTier },
    { messageId: string }
  > = {
    method: 'chat.send',
    description: '활성 세션에 메시지를 전송합니다',
    authLevel: 'session',
    schema: z.object({
      sessionId: z.string(),
      message: z.string(),
      idempotencyKey: z.string().optional(),
      // Phase 24: 사용자가 모델 선호 표현 가능 (allowClientHint=true 일 때만 유효)
      modelHint: z.enum(['haiku', 'sonnet', 'opus']).optional(),
    }),
    async execute(params) {
      const session = deps.registry.getSession(params.sessionId);
      if (!session) {
        throw new Error('session not found');
      }
      const conn = deps.connections.get(session.connectionId);
      // conn이 없어도 adapter는 실행 — 스트리밍 알림만 drop.
      const listener = conn
        ? (event: import('@finclaw/agent').StreamEvent) =>
            deps.broadcaster.send(conn, session.sessionId, event)
        : undefined;

      const signal = AbortSignal.any([
        session.abortController.signal,
        AbortSignal.timeout(CHAT_SEND_TIMEOUT_MS),
      ]);

      const agentId: AgentId = createAgentId(session.agentId);
      try {
        const result = await deps.adapter.executeForTui(
          {
            sessionKey: session.sessionKey,
            agentId,
            userMessage: params.message,
            model: session.model,
            userHint: params.modelHint,
          },
          listener,
          signal,
        );
        return { messageId: result.messageId };
      } catch (err) {
        if (err instanceof ModelFloorExhaustedError) {
          deps.logger?.warn('chat.send.floor_exhausted', {
            event: 'chat.send.floor_exhausted',
            sessionId: session.sessionId,
            floor: err.floor,
            attempted: err.chainAttempted,
          });
          throw new Error(FLOOR_EXHAUSTED_MESSAGE(err.floor), { cause: err });
        }
        throw err;
      }
    },
  };

  const stopHandler: RpcMethodHandler<{ sessionId: string }, { stopped: boolean }> = {
    method: 'chat.stop',
    description: '활성 세션을 중단합니다',
    authLevel: 'session',
    schema: z.object({
      sessionId: z.string(),
    }),
    async execute(params) {
      return deps.registry.stopSession(params.sessionId);
    },
  };

  const historyHandler: RpcMethodHandler<
    { sessionId: string; limit?: number; before?: string },
    { messages: readonly unknown[] }
  > = {
    method: 'chat.history',
    description: '세션의 대화 이력을 조회합니다',
    authLevel: 'token',
    schema: z.object({
      sessionId: z.string(),
      limit: z.number().int().min(1).max(100).optional(),
      before: z.string().optional(),
    }),
    async execute(params) {
      const session = deps.registry.getSession(params.sessionId);
      if (!session) {
        return { messages: [] };
      }
      const conversation = await deps.storage.getConversation(session.sessionKey);
      const limit = params.limit ?? 100;
      const messages = conversation?.messages ?? [];
      return { messages: messages.slice(-limit) };
    },
  };

  return [startHandler, sendHandler, stopHandler, historyHandler];
}

/** chat.* 메서드 일괄 등록 */
export function registerChatMethods(deps: ChatMethodsDeps): void {
  for (const handler of createChatMethods(deps)) {
    registerMethod(handler);
  }
}
