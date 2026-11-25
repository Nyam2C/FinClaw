// packages/server/src/agent-runtime/runtime.ts
// Phase 46 M2: 채널 무관 에이전트 런타임 — 세션 바인딩·컨텍스트 주입·동시성·감사 1행을 소유한다.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AgentDriver,
  AgentErrorReason,
  AgentEvent,
  AgentRunPort,
  AgentRunRequest,
  DriverRequest,
  ProfileHealthMonitor,
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
import { extractCitedMemoryIds } from '../auto-reply/execution-adapter.js';
import type { MemoryCaptureService } from '../auto-reply/stages/memory-capture.js';
import type { MemoryRetrievalService } from '../auto-reply/stages/memory-retrieval.js';
import { composePrompt, prepareTurn, type PreparedTurn } from './prepare-turn.js';

/** D8 수치 — 코드 상수 (config 키 없음). ROTATE_IDLE_MS = 0 이면 매 턴 새 세션(S3 폴백). */
const ROTATE_IDLE_MS = 6 * 60 * 60_000;
const TRANSCRIPT_KEEP = 40;
const MAIN_IDLE_TIMEOUT_MS = 120_000;
const MAIN_OVERALL_TIMEOUT_MS = 300_000;
const MAIN_MAX_TURNS = 10;
const GLOBAL_LANE_KEY = 'agent';
const PROFILE_ID = 'default';

type TerminalEvent = Extract<AgentEvent, { type: 'done' | 'error' }>;

/** conversations.metadata 의 CLI 세션 바인딩 (plan §3-3, 마이그레이션 0). */
interface CliSessionBinding {
  readonly cliSessionId: string;
  readonly lastTurnAt: number;
}

interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  isError?: boolean; // S14: 결과 내용은 싣지 않는다
}

interface Attempt {
  started: boolean;
  cliSessionId?: string;
  model?: string;
  readonly tools: Map<string, ToolCall>;
}

interface RunContext {
  readonly req: AgentRunRequest;
  readonly runId: string;
  readonly startedAt: number;
  readonly trace?: { readonly traceId: string; readonly spanId: string };
  attempt: Attempt;
  /** undefined = 아직 안 읽음(lane 실패 등) → transcript 를 덮어쓰지 않는다. null = 행 없음. */
  record?: ConversationRecord | null;
  prepared?: PreparedTurn;
}

export interface AgentRuntimeDeps {
  readonly driver: AgentDriver;
  readonly storage: StorageAdapter; // getConversation / upsertConversation / deleteConversation
  readonly db: DatabaseSync; // addAgentRun
  readonly systemPrompt: string;
  readonly defaultModel: string;
  /** N3: per-run JWT {sub:'finclaw', sessionId: sessionKey} */
  readonly mcp: { readonly url: string; readonly mintToken: (sessionKey: SessionKey) => string };
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
      // ⑦ agent_runs 1행 + (chat) conversations upsert → ⑧ 종료 이벤트 yield
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

  /** lifecycle 종료 훅 — 진행 중 run 의 내부 controller 일괄 abort. */
  abortAll(): void {
    for (const controller of this.inflight) {
      controller.abort();
    }
  }

  private async *execute(
    ctx: RunContext,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, TerminalEvent> {
    const { req } = ctx;
    const now = this.now();
    // ② 세션 바인딩 조회 (chat 만)
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
    const history = ctx.record?.messages ?? [];
    const binding = readBinding(ctx.record?.metadata);
    let session: DriverRequest['session'];
    if (req.mode === 'oneShot') {
      session = { kind: 'none' };
    } else if (binding && now - binding.lastTurnAt < ROTATE_IDLE_MS) {
      session = { kind: 'resume', id: binding.cliSessionId };
    } else {
      session = { kind: 'new', id: randomUUID() }; // 세션 id 선지정 (회전을 정하는 쪽이 id 도 정함)
    }
    // ④ 드라이버 이벤트 패스스루
    let terminal = yield* this.drive(
      ctx,
      this.driverRequest(ctx, prepared, session, history, signal),
    );
    // ⑤ Q3: session_not_found 에서만 새 세션 + recap 으로 1회 재시도.
    //    실패한 resume 은 stdout 이 result 1줄뿐이라 바깥으로 나간 이벤트가 없다 ([L4] §1).
    if (terminal.type === 'error' && terminal.reason === 'session_not_found') {
      this.deps.logger.info('agent.session.not_found', {
        event: 'agent.session.not_found',
        runId: ctx.runId,
        sessionKey: req.sessionKey,
      });
      terminal = yield* this.drive(
        ctx,
        this.driverRequest(ctx, prepared, { kind: 'new', id: randomUUID() }, history, signal),
      );
    }
    return terminal;
  }

  private driverRequest(
    ctx: RunContext,
    prepared: PreparedTurn,
    session: DriverRequest['session'],
    history: readonly ConversationMessage[],
    signal: AbortSignal,
  ): DriverRequest {
    const { req } = ctx;
    return {
      runId: ctx.runId,
      // recap 은 new 세션이고 직전 메시지가 있을 때만 (회전·session_not_found 재시도)
      prompt: composePrompt(prepared.context, session.kind === 'new' ? history : [], req.input),
      systemPrompt: this.deps.systemPrompt,
      model: req.model ?? this.deps.defaultModel,
      session,
      mcp: { url: this.deps.mcp.url, token: this.deps.mcp.mintToken(req.sessionKey) },
      maxTurns: MAIN_MAX_TURNS,
      autocompact: req.mode === 'chat',
      idleTimeoutMs: MAIN_IDLE_TIMEOUT_MS,
      overallTimeoutMs: MAIN_OVERALL_TIMEOUT_MS,
      signal,
    };
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
        if (ev.type === 'start') {
          attempt.started = true;
          attempt.cliSessionId = ev.cliSessionId;
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
      return fail(dreq.runId, 'unknown', errorMessage(err)); // 드라이버 throw 도 정확히 1 종료로
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
        tokensInput: final.usage?.input,
        tokensOutput: final.usage?.output,
        durationMs: endedAt - ctx.startedAt,
        modelUsed: attempt.model ?? req.model ?? this.deps.defaultModel,
        usedMemoryIds:
          final.type === 'done' && final.usedMemoryIds ? [...final.usedMemoryIds] : undefined,
        traceId: ctx.trace?.traceId,
        parentSpanId: ctx.trace?.spanId,
        cliSessionId: attempt.started ? attempt.cliSessionId : undefined,
        error: final.type === 'error' ? `${final.reason}: ${final.message}` : undefined,
      });
    } catch (err) {
      this.deps.logger.warn('agent.run.store_failed', {
        event: 'agent.run.store_failed',
        runId: ctx.runId,
        error: errorMessage(err),
      });
    }
    if (req.mode === 'chat' && ctx.record !== undefined) {
      await this.saveConversation(ctx, final, endedAt);
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
        modelId: attempt.model ?? req.model ?? this.deps.defaultModel,
      });
    }
    return final;
  }

  /** D9: run 종료 시 1회 upsert. 원문은 항상, assistant 는 done 일 때만. 바인딩은 start 를 받았을 때만 갱신. */
  private async saveConversation(
    ctx: RunContext,
    final: TerminalEvent,
    endedAt: number,
  ): Promise<void> {
    const { req, record, attempt } = ctx;
    const messages: ConversationMessage[] = [
      ...(record?.messages ?? []),
      { role: 'user' as const, content: req.input },
      ...(final.type === 'done' ? [{ role: 'assistant' as const, content: final.text }] : []),
    ].slice(-TRANSCRIPT_KEEP);
    const binding: CliSessionBinding | undefined =
      attempt.started && attempt.cliSessionId
        ? { cliSessionId: attempt.cliSessionId, lastTurnAt: endedAt }
        : undefined;
    try {
      await this.deps.storage.upsertConversation({
        sessionKey: req.sessionKey,
        agentId: req.agentId,
        messages,
        createdAt: (record?.createdAt ?? endedAt) as Timestamp,
        updatedAt: endedAt as Timestamp,
        metadata: binding ? { ...record?.metadata, ...binding } : record?.metadata,
      });
    } catch (err) {
      this.deps.logger.warn('agent.conversation.store_failed', {
        event: 'agent.conversation.store_failed',
        sessionKey: req.sessionKey,
        error: errorMessage(err),
      });
    }
  }
}

function newAttempt(): Attempt {
  return { started: false, tools: new Map() };
}

function readBinding(metadata: Record<string, unknown> | undefined): CliSessionBinding | undefined {
  const cliSessionId = metadata?.cliSessionId;
  const lastTurnAt = metadata?.lastTurnAt;
  return typeof cliSessionId === 'string' && typeof lastTurnAt === 'number'
    ? { cliSessionId, lastTurnAt }
    : undefined;
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
