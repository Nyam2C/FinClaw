// packages/server/src/gateway/rpc/methods/session.ts
import type { StorageAdapter } from '@finclaw/types';
import { z } from 'zod/v4';
import type { ChatRegistry } from '../../registry.js';
import type { RpcMethodHandler } from '../types.js';
import { RpcErrors } from '../errors.js';
import { registerMethod } from '../index.js';

export interface SessionMethodsDeps {
  readonly registry: ChatRegistry;
  readonly storage: StorageAdapter;
}

interface SessionSummary {
  readonly sessionId: string;
  readonly agentId: string;
  readonly model: string;
  readonly status: 'running' | 'paused' | 'stopping';
  readonly startedAt: number;
}

function summarize(session: {
  sessionId: string;
  agentId: string;
  model: { model: string };
  status: 'running' | 'paused' | 'stopping';
  startedAt: number;
}): SessionSummary {
  return {
    sessionId: session.sessionId,
    agentId: session.agentId,
    model: session.model.model,
    status: session.status,
    startedAt: session.startedAt,
  };
}

export function createSessionMethods(deps: SessionMethodsDeps): readonly RpcMethodHandler[] {
  const getHandler: RpcMethodHandler<{ sessionId: string }, SessionSummary> = {
    method: 'session.get',
    description: '세션 정보를 조회합니다',
    authLevel: 'token',
    schema: z.object({ sessionId: z.string() }),
    async execute(params) {
      const session = deps.registry.getSession(params.sessionId);
      if (!session) {
        const err = new Error('session not found');
        (err as Error & { code?: number }).code = RpcErrors.INVALID_PARAMS;
        throw err;
      }
      return summarize(session);
    },
  };

  const resetHandler: RpcMethodHandler<{ sessionId: string }, { reset: boolean }> = {
    method: 'session.reset',
    description: '세션 대화 이력을 초기화합니다',
    authLevel: 'token',
    schema: z.object({ sessionId: z.string() }),
    async execute(params) {
      const session = deps.registry.getSession(params.sessionId);
      if (!session) {
        return { reset: false };
      }
      await deps.storage.deleteConversation(session.sessionKey);
      return { reset: true };
    },
  };

  const listHandler: RpcMethodHandler<
    Record<string, never>,
    { sessions: readonly SessionSummary[] }
  > = {
    method: 'session.list',
    description: '현재 연결의 활성 세션 목록을 조회합니다',
    authLevel: 'token',
    schema: z.object({}),
    async execute(_params, ctx) {
      const sessions = ctx.connectionId
        ? deps.registry.listSessionsByConnection(ctx.connectionId)
        : deps.registry.listSessions();
      return { sessions: sessions.map(summarize) };
    },
  };

  return [getHandler, resetHandler, listHandler];
}

/** session.* 메서드 일괄 등록 */
export function registerSessionMethods(deps: SessionMethodsDeps): void {
  for (const handler of createSessionMethods(deps)) {
    registerMethod(handler);
  }
}
