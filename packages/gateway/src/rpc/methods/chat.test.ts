import type { AgentEvent, AgentRunPort, AgentRunRequest } from '@finclaw/agent';
import { resetEventBus } from '@finclaw/infra';
import type { ConversationMessage, ModelRef, RpcMethod } from '@finclaw/types';
import { createSessionKey } from '@finclaw/types';
// packages/server/src/gateway/rpc/methods/chat.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GatewayBroadcaster } from '../../broadcaster.js';
import type { GatewayServerContext } from '../../context.js';
import { ChatRegistry } from '../../registry.js';
import { RpcErrors } from '../errors.js';
import { dispatchRpc, MethodRegistry } from '../index.js';
import type { GatewayServerConfig, WsConnection } from '../types.js';
import { registerChatMethods, type ChatMethodsDeps } from './chat.js';

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

    it('chat.send rejects empty or over-20,000-char message', async () => {
      for (const message of ['', 'x'.repeat(20_001)]) {
        const result = await dispatchRpc(
          { jsonrpc: '2.0', id: 1, method: 'chat.send', params: { sessionId: 's1', message } },
          { auth: { level: 'token' }, remoteAddress: '127.0.0.1' },
          ctx,
        );
        expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
      }
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

  async function startSession(
    runtime: AgentRunPort,
    conn?: WsConnection,
    storage?: ChatMethodsDeps['storage'],
  ) {
    ctx = makeServerCtx();
    registerChatMethods(
      {
        registry: ctx.registry,
        connections: ctx.connections,
        broadcaster: ctx.broadcaster,
        defaultModel: TEST_MODEL,
        runtime,
        storage,
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

    function signalRuntime() {
      const signals: AbortSignal[] = [];
      const runtime: AgentRunPort = {
        async *run(req) {
          signals.push(req.signal);
          await new Promise((resolve) =>
            req.signal.addEventListener('abort', resolve, { once: true }),
          );
          yield { type: 'error', runId: req.runId ?? '', reason: 'aborted', message: 'aborted' };
        },
        reset: vi.fn().mockResolvedValue(true),
      };
      return { runtime, signals };
    }

    const sendTwice = async (sessionId: string) => {
      const ids: string[] = [];
      for (const message of ['첫 질문', '두 번째 질문']) {
        const res = (await rpc('chat.send', { sessionId, message })) as {
          result: { runId: string };
        };
        ids.push(res.result.runId);
      }
      return ids;
    };

    it('연속 send 2개 → runId 지정 abort 는 그 run 만', async () => {
      const { runtime, signals } = signalRuntime();
      const sessionId = await startSession(runtime, mockConn());
      const [first] = await sendTwice(sessionId);
      await vi.waitFor(() => expect(signals).toHaveLength(2));
      const res = (await rpc('chat.abort', { sessionId, runId: first })) as {
        result: { aborted: boolean };
      };
      expect(res.result.aborted).toBe(true);
      expect(signals.map((s) => s.aborted)).toEqual([true, false]);
      await rpc('chat.abort', { sessionId }); // 정리
    });

    it('연속 send 2개 → runId 생략 abort 는 둘 다, 종료 후 맵에서 제거', async () => {
      const { runtime, signals } = signalRuntime();
      const sessionId = await startSession(runtime, mockConn());
      await sendTwice(sessionId);
      await vi.waitFor(() => expect(signals).toHaveLength(2));
      const res = (await rpc('chat.abort', { sessionId })) as { result: { aborted: boolean } };
      expect(res.result.aborted).toBe(true);
      expect(signals.map((s) => s.aborted)).toEqual([true, true]);
      await vi.waitFor(async () => {
        const again = (await rpc('chat.abort', { sessionId })) as { result: { aborted: boolean } };
        expect(again.result.aborted).toBe(false);
      });
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

  const call = (method: string, params: Record<string, unknown>) =>
    dispatchRpc(
      { jsonrpc: '2.0', id: 1, method: method as RpcMethod, params },
      { auth: { level: 'token' }, remoteAddress: '127.0.0.1' },
      ctx,
    );

  describe('chat.history (phase47)', () => {
    const storageWith = (messages: ConversationMessage[] | null) =>
      ({
        getConversation: vi.fn().mockResolvedValue(
          messages === null
            ? null
            : {
                sessionKey: 'tui:local:default',
                agentId: 'default',
                messages,
                createdAt: 0,
                updatedAt: 0,
              },
        ),
      }) as unknown as NonNullable<ChatMethodsDeps['storage']>;
    const turns = (n: number): ConversationMessage[] =>
      Array.from({ length: n }, (_, i) => ({
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `m${i}`,
      }));
    type History = { result: { messages: Array<{ role: string; text: string }> } };

    it('기본 limit 20 — 최근 20개', async () => {
      const sessionId = await startSession(
        gatedRuntime().runtime,
        undefined,
        storageWith(turns(25)),
      );
      const res = (await call('chat.history', { sessionId })) as History;
      expect(res.result.messages).toHaveLength(20);
      expect(res.result.messages.at(-1)).toEqual({ role: 'user', text: 'm24' });
    });

    it('limit 3 → 최근 3개', async () => {
      const sessionId = await startSession(
        gatedRuntime().runtime,
        undefined,
        storageWith(turns(10)),
      );
      const res = (await call('chat.history', { sessionId, limit: 3 })) as History;
      expect(res.result.messages.map((m) => m.text)).toEqual(['m7', 'm8', 'm9']);
    });

    it('블록 content 는 text 블록만 이어 붙인다', async () => {
      const storage = storageWith([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'a' },
            { type: 'tool_use', id: 't', name: 'x', input: {} },
            { type: 'text', text: 'b' },
          ],
        },
      ]);
      const sessionId = await startSession(gatedRuntime().runtime, undefined, storage);
      const res = (await call('chat.history', { sessionId })) as History;
      expect(res.result.messages).toEqual([{ role: 'assistant', text: 'ab' }]);
    });

    it('text 가 없는 assistant 행(tool_use·thinking 만)은 숨긴다', async () => {
      const storage = storageWith([
        { role: 'user', content: '삼성전자 얼마야?' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: 's' },
            { type: 'tool_use', id: 't', name: 'get_quote', input: {} },
          ] as never,
        },
        {
          role: 'tool',
          content: [{ type: 'tool_result', tool_use_id: 't', content: '70000' }] as never,
        },
        { role: 'assistant', content: [{ type: 'text', text: '7만원입니다' }] },
      ]);
      const sessionId = await startSession(gatedRuntime().runtime, undefined, storage);
      const res = (await call('chat.history', { sessionId })) as History;
      expect(res.result.messages).toEqual([
        { role: 'user', text: '삼성전자 얼마야?' },
        { role: 'assistant', text: '7만원입니다' },
      ]);
    });

    it('도구를 여러 번 부른 턴은 마지막 답 하나만 보인다 (실시간 말풍선과 같게)', async () => {
      const storage = storageWith([
        { role: 'user', content: 'q1' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '조회해 볼게요' },
            { type: 'tool_use', id: 't', name: 'get_quote', input: {} },
          ],
        },
        { role: 'tool', content: [] },
        { role: 'assistant', content: [{ type: 'text', text: '7만원입니다' }] },
        { role: 'user', content: 'q2' },
        { role: 'assistant', content: 'a2' },
      ]);
      const sessionId = await startSession(gatedRuntime().runtime, undefined, storage);
      const res = (await call('chat.history', { sessionId })) as History;
      expect(res.result.messages).toEqual([
        { role: 'user', text: 'q1' },
        { role: 'assistant', text: '7만원입니다' },
        { role: 'user', text: 'q2' },
        { role: 'assistant', text: 'a2' },
      ]);
    });

    it('system / tool role 은 제외', async () => {
      const storage = storageWith([
        { role: 'system', content: 's' },
        { role: 'user', content: 'q' },
        { role: 'tool', content: 't' },
        { role: 'assistant', content: 'a' },
      ]);
      const sessionId = await startSession(gatedRuntime().runtime, undefined, storage);
      const res = (await call('chat.history', { sessionId })) as History;
      expect(res.result.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    });

    it('세션의 sessionKey 로 조회', async () => {
      const storage = storageWith([]);
      const sessionId = await startSession(gatedRuntime().runtime, undefined, storage);
      await call('chat.history', { sessionId });
      // 전체가 아니라 꼬리만 읽는다 (limit 20 × 메시지당 8행)
      expect(storage.getConversation).toHaveBeenCalledWith('tui:local:default', { tail: 160 });
    });

    it('대화 기록 없음 → 빈 배열', async () => {
      const sessionId = await startSession(gatedRuntime().runtime, undefined, storageWith(null));
      const res = (await call('chat.history', { sessionId })) as History;
      expect(res.result.messages).toEqual([]);
    });

    it('없는 세션 → session not found', async () => {
      await startSession(gatedRuntime().runtime, undefined, storageWith([]));
      const res = (await call('chat.history', { sessionId: 'nope' })) as {
        error: { message: string };
      };
      expect(res.error.message).toBe('session not found');
    });

    it('storage 없음 → provider_unavailable', async () => {
      const sessionId = await startSession(gatedRuntime().runtime);
      const res = (await call('chat.history', { sessionId })) as { error: { message: string } };
      expect(res.error.message).toContain('provider_unavailable');
    });

    it('limit 0 · 41 → INVALID_PARAMS', async () => {
      const sessionId = await startSession(gatedRuntime().runtime, undefined, storageWith([]));
      for (const limit of [0, 41]) {
        const res = (await call('chat.history', { sessionId, limit })) as {
          error: { code: number };
        };
        expect(res.error.code).toBe(RpcErrors.INVALID_PARAMS);
      }
    });
  });

  describe('chat.send runId (phase47)', () => {
    const RUN = '3f2b8c1e-9a4d-4c7e-8b1a-2d6e5f7a9c0b'; // v4 UUID

    it('runId 지정 → 응답·runtime·스트림이 그 값', async () => {
      const g = gatedRuntime();
      const conn = mockConn();
      const sessionId = await startSession(g.runtime, conn);
      const res = (await call('chat.send', { sessionId, message: '안녕', runId: RUN })) as {
        result: { runId: string };
      };
      expect(res.result.runId).toBe(RUN);
      expect(g.calls[0]?.runId).toBe(RUN);
      g.open();
      await vi.waitFor(() => expect(conn.sent.map((m) => m.method)).toContain('chat.stream.end'));
      expect(conn.sent.every((m) => m.params.runId === RUN)).toBe(true);
    });

    it('진행 중 같은 runId → duplicate runId', async () => {
      const g = gatedRuntime();
      const sessionId = await startSession(g.runtime, mockConn());
      await call('chat.send', { sessionId, message: '1', runId: RUN });
      const dup = (await call('chat.send', { sessionId, message: '2', runId: RUN })) as {
        error: { message: string };
      };
      expect(dup.error.message).toBe('duplicate runId');
      g.open();
    });

    it('비-UUID runId → INVALID_PARAMS', async () => {
      const sessionId = await startSession(gatedRuntime().runtime, mockConn());
      const res = (await call('chat.send', { sessionId, message: 'x', runId: 'abc' })) as {
        error: { code: number };
      };
      expect(res.error.code).toBe(RpcErrors.INVALID_PARAMS);
    });
  });
});
