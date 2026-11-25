import type { AgentEvent, AgentRunPort, AgentRunRequest } from '@finclaw/agent';
import { resetEventBus } from '@finclaw/infra';
import type { ModelRef, RpcMethod } from '@finclaw/types';
import { createSessionKey } from '@finclaw/types';
// packages/server/src/gateway/rpc/methods/chat.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GatewayBroadcaster } from '../../broadcaster.js';
import type { GatewayServerContext } from '../../context.js';
import { ChatRegistry } from '../../registry.js';
import { RpcErrors } from '../errors.js';
import { dispatchRpc, MethodRegistry } from '../index.js';
import type { GatewayServerConfig, WsConnection } from '../types.js';
import { registerChatMethods } from './chat.js';

const TEST_MODEL: ModelRef = {
  provider: 'anthropic',
  model: 'claude-test',
};

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function gatedRuntime() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const calls: AgentRunRequest[] = [];
  const runtime: AgentRunPort = {
    async *run(req) {
      calls.push(req);
      yield { type: 'text_delta', text: '안녕' } satisfies AgentEvent;
      await opened;
      yield {
        type: 'done',
        runId: req.runId ?? '',
        cliSessionId: 'c',
        text: '안녕하세요',
        usage: ZERO,
        durationMs: 1,
        numTurns: 1,
      };
    },
    reset: vi.fn().mockResolvedValue(true),
  };
  return { runtime, calls, open: () => open() };
}

function mockConn(
  id = 'conn-1',
): WsConnection & { sent: Array<{ method: string; params: Record<string, unknown> }> } {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    id,
    ws: {
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 0,
      send: (data: string) => sent.push(JSON.parse(data)),
    } as unknown as WsConnection['ws'],
    auth: { level: 'token' as const },
    connectedAt: Date.now(),
    lastPongAt: Date.now(),
    subscriptions: new Set<string>(),
    sent,
  } as WsConnection & { sent: Array<{ method: string; params: Record<string, unknown> }> };
}

function makeServerCtx(): GatewayServerContext {
  const config: GatewayServerConfig = {
    host: '0.0.0.0',
    port: 0,
    auth: { apiKeys: [], jwtSecret: 'test', sessionTtlMs: 60_000 },
    ws: {
      heartbeatIntervalMs: 30_000,
      heartbeatTimeoutMs: 10_000,
      maxPayloadBytes: 1024 * 1024,
      handshakeTimeoutMs: 10_000,
      maxConnections: 100,
    },
    rpc: { maxBatchSize: 10, timeoutMs: 60_000 },
  };
  return {
    config,
    httpServer: {} as GatewayServerContext['httpServer'],
    wss: {} as GatewayServerContext['wss'],
    connections: new Map(),
    registry: new ChatRegistry(60_000),
    methods: new MethodRegistry(), // Phase 35
    broadcaster: new GatewayBroadcaster(),
    isDraining: false,
  };
}

describe('chat.* RPC methods', () => {
  let ctx: GatewayServerContext;

  beforeEach(() => {
    resetEventBus();
    ctx = makeServerCtx();
    registerChatMethods(
      {
        registry: ctx.registry,
        connections: ctx.connections,
        broadcaster: ctx.broadcaster,
        defaultModel: TEST_MODEL,
        runtime: gatedRuntime().runtime,
      },
      ctx.methods,
    );
  });

  describe('schema validation', () => {
    it('chat.start rejects missing agentId', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'chat.start', params: {} },
        { auth: { level: 'token' }, remoteAddress: '127.0.0.1' },
        ctx,
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('chat.send rejects missing sessionId', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'chat.send', params: { message: 'hi' } },
        { auth: { level: 'token' }, remoteAddress: '127.0.0.1' }, // ← 'session' → 'token'
        ctx,
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('chat.send rejects missing message', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'chat.send', params: { sessionId: 's1' } },
        { auth: { level: 'token' }, remoteAddress: '127.0.0.1' }, // ← 'session' → 'token'
        ctx,
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });
  });

  describe('auth requirements', () => {
    it('chat.start requires token level', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'chat.start', params: { agentId: 'a' } },
        { auth: { level: 'none' }, remoteAddress: '127.0.0.1' },
        ctx,
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.UNAUTHORIZED);
    });

    it('chat.send accepts token level (rejects below token)', async () => {
      // token 미만(api_key)은 거부
      const denied = await dispatchRpc(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'chat.send',
          params: { sessionId: 's1', message: 'hi' },
        },
        { auth: { level: 'api_key' }, remoteAddress: '127.0.0.1' },
        ctx,
      );
      expect((denied as { error: { code: number } }).error.code).toBe(RpcErrors.UNAUTHORIZED);

      // token 은 auth 게이트 통과 → UNAUTHORIZED 가 아님.
      // 세션 미존재로 INTERNAL_ERROR('session not found') 이 나지만, 그건 auth 통과 후의 핸들러 에러.
      const passed = await dispatchRpc(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'chat.send',
          params: { sessionId: 's1', message: 'hi' },
        },
        { auth: { level: 'token' }, remoteAddress: '127.0.0.1' },
        ctx,
      );
      expect((passed as { error?: { code: number } }).error?.code).not.toBe(RpcErrors.UNAUTHORIZED);
    });
  });

  async function startSession(runtime: AgentRunPort, conn?: WsConnection) {
    ctx = makeServerCtx();
    registerChatMethods(
      {
        registry: ctx.registry,
        connections: ctx.connections,
        broadcaster: ctx.broadcaster,
        defaultModel: TEST_MODEL,
        runtime,
      },
      ctx.methods,
    );
    if (conn) {
      ctx.connections.set(conn.id, conn);
    }
    const session = ctx.registry.startSession({
      agentId: 'default',
      connectionId: conn?.id ?? 'gone',
      model: TEST_MODEL,
      sessionKey: createSessionKey('tui:local:default'),
    });
    return session.sessionId;
  }

  describe('chat.send (D9)', () => {
    const send = (sessionId: string) =>
      dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'chat.send', params: { sessionId, message: '안녕' } },
        { auth: { level: 'token' }, remoteAddress: '127.0.0.1' },
        ctx,
      );

    it('run 종료 전에 {runId} 를 즉시 돌려준다', async () => {
      const g = gatedRuntime();
      const sessionId = await startSession(g.runtime, mockConn());
      const res = (await send(sessionId)) as { result: { runId: string } };
      expect(res.result.runId).toMatch(/[0-9a-f-]{36}/);
      expect(g.calls[0]).toMatchObject({
        mode: 'chat',
        input: '안녕',
        runId: res.result.runId,
        model: 'claude-test',
      });
      g.open();
    });

    it('delta(runId) → end(result.text) 로 브로드캐스트', async () => {
      const g = gatedRuntime();
      const conn = mockConn();
      const sessionId = await startSession(g.runtime, conn);
      const { result } = (await send(sessionId)) as { result: { runId: string } };
      g.open();
      await vi.waitFor(() => expect(conn.sent.map((m) => m.method)).toContain('chat.stream.end'));
      expect(conn.sent[0]).toEqual({
        jsonrpc: '2.0',
        method: 'chat.stream.delta',
        params: { sessionId, runId: result.runId, delta: '안녕' },
      });
      expect(conn.sent.at(-1)?.params).toMatchObject({
        sessionId,
        runId: result.runId,
        result: { text: '안녕하세요' },
      });
    });

    it('연결이 없어도 run 은 끝까지 돈다 (S9)', async () => {
      const g = gatedRuntime();
      const done = vi.fn();
      const runtime: AgentRunPort = {
        async *run(req) {
          for await (const ev of g.runtime.run(req)) {
            yield ev;
          }
          done();
        },
        reset: g.runtime.reset,
      };
      const sessionId = await startSession(runtime);
      await send(sessionId);
      g.open();
      await vi.waitFor(() => expect(done).toHaveBeenCalled());
    });
  });
  describe('chat.abort / chat.reset (M6)', () => {
    function abortableRuntime() {
      const reset = vi.fn().mockResolvedValue(true);
      const runtime: AgentRunPort = {
        async *run(req) {
          yield { type: 'text_delta', text: '분석 중' };
          await new Promise((resolve) =>
            req.signal.addEventListener('abort', resolve, { once: true }),
          );
          yield { type: 'error', runId: req.runId ?? '', reason: 'aborted', message: 'aborted' };
        },
        reset,
      };
      return { runtime, reset };
    }

    const rpc = (method: string, params: Record<string, unknown>) =>
      dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: method as RpcMethod, params },
        { auth: { level: 'token' }, remoteAddress: '127.0.0.1' },
        ctx,
      );

    it('abort → {aborted:true} + chat.stream.error{reason:aborted} 정확히 1회', async () => {
      const { runtime } = abortableRuntime();
      const conn = mockConn();
      const sessionId = await startSession(runtime, conn);
      const { result } = (await rpc('chat.send', { sessionId, message: '길게 분석해줘' })) as {
        result: { runId: string };
      };
      const aborted = (await rpc('chat.abort', { sessionId })) as { result: { aborted: boolean } };
      expect(aborted.result.aborted).toBe(true);
      await vi.waitFor(() =>
        expect(conn.sent.some((m) => m.method === 'chat.stream.error')).toBe(true),
      );
      const errors = conn.sent.filter((m) => m.method === 'chat.stream.error');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.params).toMatchObject({
        sessionId,
        runId: result.runId,
        reason: 'aborted',
      });
    });

    it('runId 가 다르면 {aborted:false}', async () => {
      const { runtime } = abortableRuntime();
      const sessionId = await startSession(runtime, mockConn());
      await rpc('chat.send', { sessionId, message: 'x' });
      const res = (await rpc('chat.abort', { sessionId, runId: 'other' })) as {
        result: { aborted: boolean };
      };
      expect(res.result.aborted).toBe(false);
      await rpc('chat.abort', { sessionId }); // 정리
    });

    it('진행 중 run 이 없으면 {aborted:false}', async () => {
      const { runtime } = abortableRuntime();
      const sessionId = await startSession(runtime, mockConn());
      const res = (await rpc('chat.abort', { sessionId })) as { result: { aborted: boolean } };
      expect(res.result.aborted).toBe(false);
    });

    it('reset → runtime.reset(session.sessionKey)', async () => {
      const { runtime, reset } = abortableRuntime();
      const sessionId = await startSession(runtime, mockConn());
      const res = (await rpc('chat.reset', { sessionId })) as { result: { reset: boolean } };
      expect(res.result.reset).toBe(true);
      expect(reset).toHaveBeenCalledWith('tui:local:default');
    });
  });
});
