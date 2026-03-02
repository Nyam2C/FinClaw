// packages/server/src/gateway/rpc/methods/chat.ts
import { z } from 'zod/v4';
import type { RpcMethodHandler } from '../types.js';
import { registerMethod } from '../index.js';

// -- chat.start --

const startHandler: RpcMethodHandler<{ agentId: string; model?: string }, { sessionId: string }> = {
  method: 'chat.start',
  description: '새 채팅 세션을 시작합니다',
  authLevel: 'token',
  schema: z.object({
    agentId: z.string(),
    model: z.string().optional(),
  }),
  async execute(_params, _ctx) {
    // TODO(Phase 10): GatewayServerContext에서 registry 접근
    // const session = serverCtx.registry.startSession({
    //   agentId: params.agentId,
    //   connectionId: ctx.connectionId!,
    //   model: params.model,
    // });
    // return { sessionId: session.sessionId };
    throw new Error('chat.start requires server context wiring — see server.ts');
  },
};

// -- chat.send --

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
  async execute(_params, _ctx) {
    // TODO(Phase 10): Dedupe + Runner 연동
    // 1. idempotencyKey가 있으면 Dedupe<T>로 중복 실행 방지
    // 2. Runner.execute()로 LLM 호출
    // 3. GatewayBroadcaster.send()로 스트리밍 알림 전송
    throw new Error('chat.send requires execution engine wiring');
  },
};

// -- chat.stop --

const stopHandler: RpcMethodHandler<{ sessionId: string }, { stopped: boolean }> = {
  method: 'chat.stop',
  description: '활성 세션을 중단합니다',
  authLevel: 'session',
  schema: z.object({
    sessionId: z.string(),
  }),
  async execute(_params, _ctx) {
    // TODO(Phase 10): GatewayServerContext에서 registry 접근
    // return serverCtx.registry.stopSession(params.sessionId);
    throw new Error('chat.stop requires server context wiring');
  },
};

// -- chat.history --

const historyHandler: RpcMethodHandler<
  { sessionId: string; limit?: number; before?: string },
  { messages: unknown[] }
> = {
  method: 'chat.history',
  description: '세션의 대화 이력을 조회합니다',
  authLevel: 'token',
  schema: z.object({
    sessionId: z.string(),
    limit: z.number().int().min(1).max(100).optional(),
    before: z.string().optional(),
  }),
  async execute(_params, _ctx) {
    // TODO(Phase 10): @finclaw/storage 대화 이력 조회 연동
    return { messages: [] };
  },
};

/** chat.* 메서드 일괄 등록 */
export function registerChatMethods(): void {
  registerMethod(startHandler);
  registerMethod(sendHandler);
  registerMethod(stopHandler);
  registerMethod(historyHandler);
}
