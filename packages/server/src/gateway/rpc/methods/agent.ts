// packages/server/src/gateway/rpc/methods/agent.ts
import { z } from 'zod/v4';
import type { RpcMethodHandler } from '../types.js';
import { registerMethod } from '../index.js';

// -- agent.status --

const statusHandler: RpcMethodHandler<{ agentId: string }, unknown> = {
  method: 'agent.status',
  description: '에이전트 상태를 조회합니다',
  authLevel: 'token',
  schema: z.object({ agentId: z.string() }),
  async execute(params) {
    // TODO(Phase 10): @finclaw/agent 에이전트 상태 조회 연동
    return {
      agentId: params.agentId,
      status: 'idle',
      activeSessions: 0,
    };
  },
};

// -- agent.list --

const listHandler: RpcMethodHandler<Record<string, never>, unknown> = {
  method: 'agent.list',
  description: '등록된 에이전트 목록을 조회합니다',
  authLevel: 'token',
  schema: z.object({}),
  async execute() {
    // TODO(Phase 10): @finclaw/agent 에이전트 레지스트리 연동
    return { agents: [] };
  },
};

// -- agent.capabilities (agent.run 메서드명으로 등록 — 기존 RpcMethod union에 있음) --

const capabilitiesHandler: RpcMethodHandler<{ agentId: string }, unknown> = {
  method: 'agent.run',
  description: '에이전트 실행을 시작합니다',
  authLevel: 'token',
  schema: z.object({ agentId: z.string() }),
  async execute(_params) {
    // TODO(Phase 10): Runner 연동
    throw new Error('agent.run requires execution engine wiring');
  },
};

/** agent.* 메서드 일괄 등록 */
export function registerAgentMethods(): void {
  registerMethod(statusHandler);
  registerMethod(listHandler);
  registerMethod(capabilitiesHandler);
}
