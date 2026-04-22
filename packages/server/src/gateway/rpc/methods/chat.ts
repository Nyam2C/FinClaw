// packages/server/src/gateway/rpc/methods/chat.ts
import type { ModelRef, SessionKey, StorageAdapter } from '@finclaw/types';
import { createSessionKey } from '@finclaw/types';
import { z } from 'zod/v4';
import type { GatewayBroadcaster } from '../../broadcaster.js';
import type { ChatRegistry } from '../../registry.js';
import type { RpcMethodHandler, WsConnection } from '../types.js';
import { registerMethod } from '../index.js';

/**
 * chat.* 메서드가 필요로 하는 공용 의존성.
 * adapter/systemPrompt는 Todo 7에서 executeForTui 배선 시 확장된다.
 */
export interface ChatMethodsDeps {
  readonly registry: ChatRegistry;
  readonly connections: Map<string, WsConnection>;
  readonly broadcaster: GatewayBroadcaster;
  readonly storage: StorageAdapter;
  readonly defaultModel: ModelRef;
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
    authLevel: 'session',
    schema: z.object({
      sessionId: z.string(),
      message: z.string(),
      idempotencyKey: z.string().optional(),
    }),
    async execute(_params) {
      // TODO(phase-21-todo-7): adapter.executeForTui 연동
      throw new Error('chat.send requires execution engine wiring (phase 21 Todo 7)');
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
