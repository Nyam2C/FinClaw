// packages/server/src/gateway/rpc/methods/chat.ts
import type { ChatExecutionPort } from '@finclaw/agent';
import type { FinClawLogger } from '@finclaw/infra';
import type { AgentId, ModelRef, SessionKey } from '@finclaw/types';
import { createAgentId, createSessionKey } from '@finclaw/types';
import { z } from 'zod/v4';
import type { GatewayBroadcaster } from '../../broadcaster.js';
import type { ChatRegistry } from '../../registry.js';
import type { MethodRegistry } from '../index.js';
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
  readonly defaultModel: ModelRef;
  readonly adapter: ChatExecutionPort;
  readonly logger?: FinClawLogger;
}

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
    { sessionId: string; message: string; idempotencyKey?: string },
    { messageId: string }
  > = {
    method: 'chat.send',
    description: '활성 세션에 메시지를 전송합니다',
    authLevel: 'token', // ← 'session' 에서 강등 (Phase 37 A: session 레벨은 부여 코드 부재 → 영구 도달 불가)
    schema: z.object({
      sessionId: z.string(),
      message: z.string(),
      idempotencyKey: z.string().optional(),
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
      const result = await deps.adapter.executeForTui(
        {
          sessionKey: session.sessionKey,
          agentId,
          userMessage: params.message,
          model: session.model,
        },
        listener,
        signal,
      );
      return { messageId: result.messageId };
    },
  };

  return [startHandler, sendHandler];
}

/** chat.* 메서드 일괄 등록 */
export function registerChatMethods(deps: ChatMethodsDeps, registry: MethodRegistry): void {
  for (const handler of createChatMethods(deps)) {
    registry.register(handler);
  }
}
