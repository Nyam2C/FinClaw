// packages/server/src/gateway/rpc/methods/session.ts
import { z } from 'zod/v4';
import type { ChatRegistry } from '../../registry.js';
import { RpcErrors } from '../errors.js';
import type { MethodRegistry } from '../index.js';
import type { RpcMethodHandler } from '../types.js';

export interface SessionMethodsDeps {
  readonly registry: ChatRegistry;
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

  return [getHandler];
}

/** session.* 메서드 일괄 등록 */
export function registerSessionMethods(deps: SessionMethodsDeps, registry: MethodRegistry): void {
  for (const handler of createSessionMethods(deps)) {
    registry.register(handler);
  }
}
