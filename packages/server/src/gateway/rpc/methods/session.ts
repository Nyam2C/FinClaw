// packages/server/src/gateway/rpc/methods/session.ts
import { z } from 'zod/v4';
import type { RpcMethodHandler } from '../types.js';
import { registerMethod } from '../index.js';

// -- session.get --

const getHandler: RpcMethodHandler<{ sessionId: string }, unknown> = {
  method: 'session.get',
  description: '세션 정보를 조회합니다',
  authLevel: 'token',
  schema: z.object({ sessionId: z.string() }),
  async execute(_params) {
    // TODO(Phase 10): GatewayServerContext.registry.getSession() 연동
    throw new Error('session.get requires server context wiring');
  },
};

// -- session.reset --

const resetHandler: RpcMethodHandler<{ sessionId: string }, { reset: boolean }> = {
  method: 'session.reset',
  description: '세션을 리셋합니다',
  authLevel: 'token',
  schema: z.object({ sessionId: z.string() }),
  async execute(_params) {
    // TODO(Phase 10): registry.stopSession() + 새 세션 시작
    throw new Error('session.reset requires server context wiring');
  },
};

// -- session.list --

const listHandler: RpcMethodHandler<Record<string, never>, unknown> = {
  method: 'session.list',
  description: '활성 세션 목록을 조회합니다',
  authLevel: 'token',
  schema: z.object({}),
  async execute() {
    // TODO(Phase 10): GatewayServerContext.registry.listSessions() 연동
    throw new Error('session.list requires server context wiring');
  },
};

/** session.* 메서드 일괄 등록 */
export function registerSessionMethods(): void {
  registerMethod(getHandler);
  registerMethod(resetHandler);
  registerMethod(listHandler);
}
