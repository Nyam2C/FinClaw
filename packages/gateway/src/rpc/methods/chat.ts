// packages/server/src/gateway/rpc/methods/chat.ts
import { randomUUID } from 'node:crypto';
import type { AgentRunPort } from '@finclaw/agent';
import type { FinClawLogger } from '@finclaw/infra';
import type { ModelRef, SessionKey } from '@finclaw/types';
import { createAgentId, createSessionKey } from '@finclaw/types';
import { z } from 'zod/v4';
import type { GatewayBroadcaster } from '../../broadcaster.js';
import type { ChatRegistry } from '../../registry.js';
import type { MethodRegistry } from '../index.js';
import type { ActiveSession, RpcMethodHandler, WsConnection } from '../types.js';

/**
 * chat.* 메서드가 필요로 하는 공용 의존성.
 */
export interface ChatMethodsDeps {
  readonly registry: ChatRegistry;
  readonly connections: Map<string, WsConnection>;
  readonly broadcaster: GatewayBroadcaster;
  readonly defaultModel: ModelRef;
  /** Phase 46: ChatExecutionPort 대체 — AgentRuntime 포트. */
  readonly runtime: AgentRunPort;
  readonly logger?: FinClawLogger;
}

/** D9: 진행 중·대기 중 run (실행 직렬화는 runtime per-session lane). chat.abort(M6)가 controller 를 쓴다. */
interface ActiveRun {
  readonly runId: string;
  readonly sessionId: string;
  readonly controller: AbortController;
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
  const activeRuns = new Map<string, ActiveRun>(); // key = runId

  /** run 을 끝까지 소비하며 WS 로 중계. 연결은 이벤트마다 조회 — 끊겨도 run 은 끝까지 돌아 저장된다 (S9). */
  async function streamRun(session: ActiveSession, message: string, run: ActiveRun): Promise<void> {
    try {
      for await (const ev of deps.runtime.run({
        sessionKey: session.sessionKey,
        agentId: createAgentId(session.agentId),
        input: message,
        mode: 'chat',
        model: session.model.model,
        runId: run.runId,
        // 세션 stop·서버 종료(registry.abortAll) 또는 chat.abort 로만 중단
        signal: AbortSignal.any([session.abortController.signal, run.controller.signal]),
      })) {
        const conn = deps.connections.get(session.connectionId);
        if (conn) {
          deps.broadcaster.send(conn, session.sessionId, run.runId, ev);
        }
      }
    } catch (err) {
      deps.logger?.error('chat.run.failed', {
        event: 'chat.run.failed',
        runId: run.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      activeRuns.delete(run.runId);
      deps.registry.runEnded(session.sessionId);
    }
  }

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
    { runId: string }
  > = {
    method: 'chat.send',
    description: '활성 세션에 메시지를 전송합니다 (실행은 백그라운드 — 진행·결과는 chat.stream.*)',
    authLevel: 'token', // ← 'session' 에서 강등 (Phase 37 A: session 레벨은 부여 코드 부재 → 영구 도달 불가)
    schema: z.object({
      sessionId: z.string(),
      // argv 단일 인자 한도(Linux 128KiB) 안쪽: 한글 3B × 20,000 = 60KB + <context>·recap 여유
      message: z.string().min(1).max(20_000),
      idempotencyKey: z.string().optional(),
    }),
    async execute(params) {
      const session = deps.registry.getSession(params.sessionId);
      if (!session) {
        throw new Error('session not found');
      }
      const run: ActiveRun = {
        runId: randomUUID(),
        sessionId: session.sessionId,
        controller: new AbortController(),
      };
      activeRuns.set(run.runId, run);
      deps.registry.runStarted(session.sessionId);
      // D9: 즉시 반환 — Web/TUI 는 chat.send 를 30s 요청 타임아웃으로 await 한다 (app-gateway.ts:177, gateway-client.ts:153)
      void streamRun(session, params.message, run);
      return { runId: run.runId };
    },
  };

  const abortHandler: RpcMethodHandler<
    { sessionId: string; runId?: string },
    { aborted: boolean }
  > = {
    method: 'chat.abort',
    description:
      '진행 중인 채팅 실행을 중단합니다 (종료 신호는 chat.stream.error{reason:aborted} 1회)',
    authLevel: 'token',
    schema: z.object({ sessionId: z.string(), runId: z.string().optional() }),
    async execute(params) {
      // runId 지정 시 그 run, 생략 시 그 세션의 진행 중·대기 중 run 전부
      let aborted = false;
      for (const run of activeRuns.values()) {
        if (
          run.sessionId === params.sessionId &&
          (params.runId === undefined || params.runId === run.runId)
        ) {
          run.controller.abort(); // → driver SIGINT → 2s → SIGKILL → runtime 이 error{aborted} 1회 (I11)
          aborted = true;
        }
      }
      return { aborted };
    },
  };

  const resetHandler: RpcMethodHandler<{ sessionId: string }, { reset: boolean }> = {
    method: 'chat.reset',
    description: '세션의 대화·CLI 세션 바인딩을 초기화합니다',
    authLevel: 'token',
    schema: z.object({ sessionId: z.string() }),
    async execute(params) {
      const session = deps.registry.getSession(params.sessionId);
      if (!session) {
        throw new Error('session not found');
      }
      // Q14: per-session lane 경유 — 진행 중 run 의 종료 기록 뒤에 삭제된다
      return { reset: await deps.runtime.reset(session.sessionKey) };
    },
  };

  return [startHandler, sendHandler, abortHandler, resetHandler];
}

/** chat.* 메서드 일괄 등록 */
export function registerChatMethods(deps: ChatMethodsDeps, registry: MethodRegistry): void {
  for (const handler of createChatMethods(deps)) {
    registry.register(handler);
  }
}
