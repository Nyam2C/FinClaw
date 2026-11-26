// packages/server/src/agent-runtime/runtime.ts
// 채널 무관 에이전트 런타임 — 세션 줄 세우기·컨텍스트 조립·트랜스크립트 저장·감사 1행을 소유한다.
// 루프(도구 선택·반복·종료)는 드라이버(@finclaw/agent runtime/loop.ts)가 소유한다 (plans/agent-core.md §3).
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  settleDanglingToolUses,
  type AgentDriver,
  type AgentErrorReason,
  type AgentEvent,
  type AgentRunPort,
  type AgentRunRequest,
  type DriverRequest,
  type DriverTool,
  type ProfileHealthMonitor,
  type TerminalEvent,
  type ToolRegistry,
  type TranscriptMessage,
} from '@finclaw/agent';
import { ConcurrencyLane, FinClawError, type FinClawLogger, type LaneHandle } from '@finclaw/infra';
import { addAgentRun } from '@finclaw/storage';
import type {
  ConversationMessage,
  ConversationRecord,
  SessionKey,
  StorageAdapter,
  Timestamp,
} from '@finclaw/types';
import type { MemoryCaptureService } from '../auto-reply/stages/memory-capture.js';
import type { MemoryRetrievalService } from '../auto-reply/stages/memory-retrieval.js';
import { composeContext, prepareTurn, type PreparedTurn } from './prepare-turn.js';

/** 컨텍스트 회전 조건 (plans/agent-core.md §3.3) — 코드 상수. */
const ROTATE_IDLE_MS = 6 * 60 * 60_000;
const ROTATE_CONTEXT_TOKENS = 150_000;
const MAIN_OVERALL_TIMEOUT_MS = 300_000;
const MAIN_MAX_TURNS = 10;
/** run 이 새로 처리하는 토큰(입력+캐시 쓰기+출력) 예산. 넘으면 마무리 호출로 끝낸다. 가격표를 코드에 두지 않으려고 토큰으로 건다. */
const CHAT_TOKEN_BUDGET = 400_000;
const ONESHOT_TOKEN_BUDGET = 200_000;
const GLOBAL_LANE_KEY = 'agent';
const PROFILE_ID = 'default';
/** 도구가 보는 사용자 id. 앱·RPC 가 만든 알림의 소유자와 같아야 `list_alerts` 가 그것을 본다. */
const TOOL_USER_ID = 'default';
const ABORT_DRAIN_MS = 3_000;

/**
 * conversations.metadata 의 컨텍스트 창 상태. 트랜스크립트는 지우지 않고, API 로 보내는 범위만 옮긴다.
 * ponytail: 회전은 요약이 아니라 잘라내기(+직전 대화 recap)다. 긴 맥락이 필요해지면 서버 측 compaction 으로.
 */
interface ContextWindow {
  /** 이 인덱스(rowid 순)부터의 행만 모델에 보낸다. 행은 덧붙이기만 하므로 인덱스는 변하지 않는다. */
  readonly contextStart: number;
  readonly lastTurnAt: number;
  /** 시스템 프롬프트·도구 목록의 해시. 바뀌면(배포·키 추가·플러그인) 예전 thinking 블록이 무효가 되므로 회전. */
  readonly prefixHash: string;
  /** 직전 run 마지막 호출의 프롬프트 크기 (입력+캐시). */
  readonly contextTokens: number;
}

interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  isError?: boolean; // 결과 내용은 싣지 않는다
}

interface Attempt {
  model?: string;
  readonly tools: Map<string, ToolCall>;
}

interface RunContext {
  readonly req: AgentRunRequest;
  readonly runId: string;
  readonly startedAt: number;
  readonly trace?: { readonly traceId: string; readonly spanId: string };
  attempt: Attempt;
  /** undefined = 아직 안 읽음(lane 실패 등) → 창 상태를 덮어쓰지 않는다. null = 행 없음. */
  record?: ConversationRecord | null;
  /** 이번 run 이 쓰는 창 (execute 가 정한다). */
  window?: ContextWindow;
  prepared?: PreparedTurn;
}

export interface AgentRuntimeDeps {
  readonly driver: AgentDriver;
  readonly storage: StorageAdapter; // getConversation / appendMessages / deleteConversation
  readonly db: DatabaseSync; // addAgentRun
  readonly systemPrompt: string;
  readonly defaultModel: string;
  /** 도구 레지스트리 — 루프가 프로세스 안에서 직접 부른다 (정책·검증·타임아웃·결과 가드는 레지스트리가 한다). */
  readonly tools: Pick<ToolRegistry, 'list' | 'execute'>;
  readonly capture?: MemoryCaptureService;
  readonly retrieval?: MemoryRetrievalService;
  readonly profileHealth?: ProfileHealthMonitor;
  readonly tracer?: { getCurrentContext(): { traceId: string; spanId: string } | undefined }; // agent_runs.trace_id
  readonly logger: FinClawLogger;
  readonly now?: () => number; // 테스트용 시계
}

export class AgentRuntime implements AgentRunPort {
  // D6: 기존 infra lane 재사용 (새 lock 코드 0). 획득 순서 session → 전역.
  // ponytail: 대기열 20·대기 타임아웃 고정 — 초과 시 error{timeout}. 부하가 생기면 상수 조정.
  private readonly globalLane = new ConcurrencyLane({
    maxConcurrent: 2,
    maxQueueSize: 20,
    waitTimeoutMs: 300_000,
  });
  private readonly sessionLane = new ConcurrencyLane({
    maxConcurrent: 1,
    maxQueueSize: 20,
    waitTimeoutMs: 600_000,
  });
  private readonly inflight = new Set<AbortController>();
  private readonly now: () => number;

  constructor(private readonly deps: AgentRuntimeDeps) {
    this.now = deps.now ?? Date.now;
  }

  async *run(req: AgentRunRequest): AsyncGenerator<AgentEvent> {
    const ctx: RunContext = {
      req,
      runId: req.runId ?? randomUUID(), // D1
      startedAt: this.now(),
      trace: this.deps.tracer?.getCurrentContext(),
      attempt: newAttempt(),
    };
    const internal = new AbortController(); // abortAll() 용
    this.inflight.add(internal);
    const signal = AbortSignal.any([req.signal, internal.signal]);
    const handles: LaneHandle[] = [];
    try {
      let terminal: TerminalEvent;
      try {
        // ① chat 만 per-session lane (oneShot 키는 run 마다 고유라 불필요) → 최상위 run 전역 lane
        if (req.mode === 'chat') {
          handles.push(await this.sessionLane.acquire(req.sessionKey));
        }
        handles.push(await this.globalLane.acquire(GLOBAL_LANE_KEY));
        if (signal.aborted) {
          terminal = fail(ctx.runId, 'aborted', 'aborted before start');
        } else {
          terminal = yield* this.execute(ctx, signal);
        }
      } catch (err) {
        // lane 대기 실패(LANE_TIMEOUT/LANE_QUEUE_FULL) → timeout, 그 외 준비 단계 예외 → unknown (I11)
        terminal = fail(ctx.runId, isLaneError(err) ? 'timeout' : 'unknown', errorMessage(err));
      }
      // ⑦ agent_runs 1행 + (chat) 창 상태 갱신 → ⑧ 종료 이벤트 yield
      yield await this.finish(ctx, terminal);
    } finally {
      // ⑨ 드라이버를 끝까지 소비(= exit 이후)한 뒤에만 도달. 전역 → 세션 순 해제.
      for (const handle of handles.toReversed()) {
        handle.release();
      }
      this.inflight.delete(internal);
    }
  }

  /** Q14: per-session lane 경유 — 진행 중 run 의 종료 기록 뒤에 삭제되어 바인딩이 되살아나지 않는다. */
  async reset(sessionKey: SessionKey): Promise<boolean> {
    const handle = await this.sessionLane.acquire(sessionKey);
    try {
      return await this.deps.storage.deleteConversation(sessionKey);
    } finally {
      handle.release();
    }
  }

  /** lifecycle 종료 훅 — 진행 중 run 을 abort 하고 종료 기록(finish → agent_runs)까지 최대 3s 기다린다. */
  async abortAll(): Promise<void> {
    for (const controller of this.inflight) {
      controller.abort();
    }
    // ponytail: 50ms 폴링 — 종료 시 1회라 drain promise 배선 불필요
    const deadline = Date.now() + ABORT_DRAIN_MS;
    while (this.inflight.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private async *execute(
    ctx: RunContext,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, TerminalEvent> {
    const { req } = ctx;
    const now = this.now();
    const model = req.model ?? this.deps.defaultModel;
    // ② 트랜스크립트 조회 (chat 만)
    if (req.mode === 'chat') {
      ctx.record = await this.deps.storage.getConversation(req.sessionKey);
    }
    // ③ prepareTurn — capture·retrieval·시각
    const prepared = await prepareTurn({
      input: req.input,
      sessionKey: req.sessionKey,
      mode: req.mode,
      now,
      capture: this.deps.capture,
      retrieval: this.deps.retrieval,
      logger: this.deps.logger,
      traceId: ctx.trace?.traceId,
    });
    ctx.prepared = prepared;

    // ④ 컨텍스트 창: 6h 유휴 · 직전 프롬프트가 큼 · 프리픽스(시스템 프롬프트·도구) 변경이면 회전.
    //    원문은 그대로 두고 시작점만 옮긴다.
    const tools = this.toolDefinitions();
    const prefixHash = hashPrefix(this.deps.systemPrompt, tools);
    const stored = (ctx.record?.messages ?? []) as readonly TranscriptMessage[];
    const prev = readWindow(ctx.record?.metadata);
    const rotate =
      !prev ||
      now - prev.lastTurnAt >= ROTATE_IDLE_MS ||
      prev.contextTokens > ROTATE_CONTEXT_TOKENS ||
      prev.prefixHash !== prefixHash;
    let window: ContextWindow = {
      contextStart: rotate ? stored.length : prev.contextStart,
      lastTurnAt: prev?.lastTurnAt ?? now,
      prefixHash,
      contextTokens: rotate ? 0 : prev.contextTokens,
    };
    ctx.window = window;
    const carried = stored.slice(window.contextStart);
    // 이어 가는 창에 결과 없는 tool_use 가 남았으면(중단·크래시) 짝을 닫는다.
    const settled = settleDanglingToolUses(carried);
    const turn: TranscriptMessage[] = [
      // 회전 직후에는 직전 대화 몇 개를 recap 으로 컨텍스트에 싣는다
      { role: 'system', content: composeContext(prepared.context, rotate ? stored : []) },
      { role: 'user', content: req.input },
    ];
    // ⑤ user 턴은 모델 호출보다 먼저 저장한다
    await this.append(ctx, [...(settled ? [settled] : []), ...turn], now);

    const dreq: DriverRequest = {
      runId: ctx.runId,
      systemPrompt: this.deps.systemPrompt,
      messages: [...carried, ...(settled ? [settled] : []), ...turn],
      model,
      tools,
      runTool: async (name, input, toolSignal) => {
        const result = await this.deps.tools.execute(name, input as Record<string, unknown>, {
          sessionId: req.sessionKey,
          userId: TOOL_USER_ID,
          channelId: 'agent',
          abortSignal: toolSignal,
        });
        return { content: result.content, isError: result.isError };
      },
      maxTurns: MAIN_MAX_TURNS,
      tokenBudget: req.mode === 'chat' ? CHAT_TOKEN_BUDGET : ONESHOT_TOKEN_BUDGET,
      overallTimeoutMs: MAIN_OVERALL_TIMEOUT_MS,
      signal,
    };
    let terminal = yield* this.drive(ctx, dreq);
    // ⑥ 저장된 트랜스크립트를 API 가 거절하면(400) 같은 본문은 다시 보내도 실패한다. 창을 이번 턴에서
    //    새로 열어 1회만 재시도한다 — 안 하면 그 대화는 6h 유휴까지 매 턴 실패한다.
    if (terminal.type === 'error' && terminal.reason === 'invalid_request' && carried.length > 0) {
      this.deps.logger.warn('agent.context.reset', {
        event: 'agent.context.reset',
        runId: ctx.runId,
        sessionKey: req.sessionKey,
        cause: terminal.message,
      });
      window = { ...window, contextStart: stored.length + (settled ? 1 : 0), contextTokens: 0 };
      ctx.window = window;
      await this.append(ctx, [], this.now());
      terminal = yield* this.drive(ctx, { ...dreq, messages: turn });
    }
    return terminal;
  }

  private toolDefinitions(): DriverTool[] {
    return this.deps.tools.list().map((t) => ({
      name: t.definition.name,
      description: t.definition.description,
      inputSchema: t.definition.inputSchema,
    }));
  }

  /** 트랜스크립트에 행을 덧붙인다 (chat 만). 창 상태(metadata)도 함께 쓴다. */
  private async append(
    ctx: RunContext,
    messages: readonly TranscriptMessage[],
    at: number,
    window: ContextWindow | undefined = ctx.window,
  ): Promise<void> {
    if (ctx.req.mode !== 'chat') {
      return;
    }
    await this.deps.storage.appendMessages({
      sessionKey: ctx.req.sessionKey,
      agentId: ctx.req.agentId,
      messages: messages as readonly ConversationMessage[],
      at: at as Timestamp,
      metadata: window ? { ...window } : undefined,
    });
  }

  private async *drive(
    ctx: RunContext,
    dreq: DriverRequest,
  ): AsyncGenerator<AgentEvent, TerminalEvent> {
    const attempt = newAttempt();
    ctx.attempt = attempt;
    try {
      for await (const ev of this.deps.driver(dreq)) {
        if (ev.type === 'done' || ev.type === 'error') {
          return ev;
        }
        if (ev.type === 'message') {
          // 루프는 이 await 가 끝나야 다음 줄(도구 실행)로 넘어간다 — 저장이 부수효과보다 먼저다.
          await this.append(ctx, [ev.message], this.now());
          continue; // 채널로는 내보내지 않는다
        }
        if (ev.type === 'start') {
          attempt.model = ev.model;
        } else if (ev.type === 'tool_use') {
          attempt.tools.set(ev.id, { id: ev.id, name: ev.name, input: ev.input });
        } else if (ev.type === 'tool_result') {
          const call = attempt.tools.get(ev.id);
          if (call) {
            call.isError = ev.isError;
          }
        }
        yield ev;
      }
      return fail(dreq.runId, 'unknown', 'driver ended without terminal event');
    } catch (err) {
      return fail(dreq.runId, 'unknown', errorMessage(err)); // 드라이버·저장 throw 도 정확히 1 종료로
    }
  }

  private async finish(ctx: RunContext, terminal: TerminalEvent): Promise<TerminalEvent> {
    const { req, attempt } = ctx;
    const endedAt = this.now();
    let final: TerminalEvent = terminal;
    if (terminal.type === 'done') {
      // ⑥ 인용 추출·capture 꼬리표 부착
      const used = ctx.prepared ? extractCitedMemoryIds(terminal.text, ctx.prepared.snippets) : [];
      const captured = ctx.prepared?.captured;
      final = {
        ...terminal,
        ...(used.length > 0 ? { usedMemoryIds: used } : {}),
        ...(captured ? { captured } : {}),
      };
    }
    try {
      addAgentRun(this.deps.db, {
        id: ctx.runId,
        agentId: req.agentId,
        prompt: req.input,
        output: final.type === 'done' ? final.text : '',
        toolCalls: attempt.tools.size > 0 ? JSON.stringify([...attempt.tools.values()]) : undefined,
        // 프롬프트 전체 (캐시 읽기·쓰기 포함) — 캐시가 맞으면 usage.input 은 몇 토큰뿐이라 감사에 쓸 수 없다
        tokensInput: final.usage
          ? final.usage.input + final.usage.cacheRead + final.usage.cacheWrite
          : undefined,
        tokensOutput: final.usage?.output,
        durationMs: endedAt - ctx.startedAt,
        modelUsed: attempt.model || req.model || this.deps.defaultModel,
        usedMemoryIds:
          final.type === 'done' && final.usedMemoryIds ? [...final.usedMemoryIds] : undefined,
        traceId: ctx.trace?.traceId,
        parentSpanId: ctx.trace?.spanId,
        error: final.type === 'error' ? `${final.reason}: ${final.message}` : undefined,
      });
    } catch (err) {
      this.deps.logger.warn('agent.run.store_failed', {
        event: 'agent.run.store_failed',
        runId: ctx.runId,
        error: errorMessage(err),
      });
    }
    const usage = final.usage;
    if (usage) {
      // 캐시 적중 확인용 — cacheRead 가 0 으로 이어지면 프리픽스가 깨진 것이다.
      this.deps.logger.info('agent.run.usage', {
        event: 'agent.run.usage',
        runId: ctx.runId,
        mode: req.mode,
        turns: final.numTurns,
        ...usage,
      });
    }
    if (ctx.window) {
      await this.saveWindow(ctx, final, endedAt);
    }
    if (final.type === 'error') {
      this.deps.logger.warn('agent.run.error', {
        event: 'agent.run.error',
        runId: ctx.runId,
        mode: req.mode,
        reason: final.reason,
        message: final.message,
      });
    }
    if (final.type === 'done' || final.reason !== 'aborted') {
      this.deps.profileHealth?.recordResult(PROFILE_ID, {
        success: final.type === 'done',
        modelId: attempt.model || req.model || this.deps.defaultModel,
      });
    }
    return final;
  }

  /** run 종료 시 창 상태 갱신: 마지막 대화 시각과 마지막 호출의 프롬프트 크기 (다음 턴의 회전 판정용). */
  private async saveWindow(ctx: RunContext, final: TerminalEvent, endedAt: number): Promise<void> {
    const window = ctx.window as ContextWindow;
    // 컨텍스트 초과·거절로 끝난 창은 다음 턴에 이어 보내도 같은 결과가 난다 → 반드시 회전.
    const poisoned =
      final.type === 'error' && (final.reason === 'context_overflow' || final.reason === 'refusal');
    const contextTokens = poisoned
      ? ROTATE_CONTEXT_TOKENS + 1
      : (final.contextTokens ?? window.contextTokens);
    try {
      await this.append(ctx, [], endedAt, { ...window, lastTurnAt: endedAt, contextTokens });
    } catch (err) {
      this.deps.logger.warn('agent.conversation.store_failed', {
        event: 'agent.conversation.store_failed',
        sessionKey: ctx.req.sessionKey,
        error: errorMessage(err),
      });
    }
  }
}

function newAttempt(): Attempt {
  return { tools: new Map() };
}

function readWindow(metadata: Record<string, unknown> | undefined): ContextWindow | undefined {
  const m = metadata ?? {};
  return typeof m.contextStart === 'number' &&
    typeof m.lastTurnAt === 'number' &&
    typeof m.prefixHash === 'string' &&
    typeof m.contextTokens === 'number'
    ? {
        contextStart: m.contextStart,
        lastTurnAt: m.lastTurnAt,
        prefixHash: m.prefixHash,
        contextTokens: m.contextTokens,
      }
    : undefined; // 예전(CLI 세션) 대화 포함 — 첫 턴에 회전해 새 창을 연다
}

/** 캐시 프리픽스(시스템 프롬프트 + 이름순 도구 정의)의 지문. */
function hashPrefix(systemPrompt: string, tools: readonly DriverTool[]): string {
  const sorted = tools.toSorted((a, b) => a.name.localeCompare(b.name));
  return createHash('sha256')
    .update(systemPrompt)
    .update(JSON.stringify(sorted))
    .digest('hex')
    .slice(0, 16);
}

function fail(runId: string, reason: AgentErrorReason, message: string): TerminalEvent {
  return { type: 'error', runId, reason, message };
}

function isLaneError(err: unknown): boolean {
  return (
    err instanceof FinClawError && (err.code === 'LANE_TIMEOUT' || err.code === 'LANE_QUEUE_FULL')
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Phase 29 B: 응답 텍스트의 `[mem:xxxxxx]` 마커 (id 첫 6-8자, 또는 콤마 구분 다중)
 * 를 추출하여 candidates 의 실제 id 와 prefix-match. (phase46 M5: 옛 실행 어댑터에서 이동)
 *
 * - 마커가 없으면 빈 배열.
 * - 같은 id 가 여러 마커에 매칭돼도 한 번만 결과에 포함.
 * - candidates 순서를 유지.
 */
export function extractCitedMemoryIds(
  text: string,
  candidates: ReadonlyArray<{ readonly id: string }>,
): string[] {
  const prefixes = new Set<string>();
  const re = /\[mem:([a-f0-9]{6,8}(?:,[a-f0-9]{6,8})*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    for (const p of m[1].split(',')) {
      prefixes.add(p);
    }
  }
  const matched: string[] = [];
  for (const c of candidates) {
    for (const p of prefixes) {
      if (c.id.startsWith(p)) {
        matched.push(c.id);
        break;
      }
    }
  }
  return matched;
}
