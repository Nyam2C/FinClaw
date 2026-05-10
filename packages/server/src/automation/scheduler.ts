// packages/server/src/automation/scheduler.ts
// Phase 28 B: 매 분 0초 폴러 → due schedules → agent.run 실행 → agent_runs 영속화.
// delivery 호출은 onRunComplete 콜백으로 외부 주입 (밀스톤 C).

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AliasIndex, ModelCatalog, ProfileHealthMonitor, ToolRegistry } from '@finclaw/agent';
import {
  DEFAULT_FALLBACK_TRIGGERS,
  ModelFloorExhaustedError,
  resolveModel,
  runWithModelFallback,
} from '@finclaw/agent';
import type { ConcurrencyLane, FinClawLogger } from '@finclaw/infra';
import {
  addAgentRun,
  findDueSchedules,
  getSchedule,
  markScheduleRun,
  updateSchedule,
} from '@finclaw/storage';
import type { AgentRunParams, ConversationMessage, ModelRef, Schedule } from '@finclaw/types';
import { createAgentId, createSessionKey } from '@finclaw/types';
import {
  collectToolCalls,
  extractAssistantText,
  type RunnerFactory,
} from '../auto-reply/execution-adapter.js';
import type { RouterHelper } from '../auto-reply/router-helper.js';
import { buildDispatcher } from '../auto-reply/tool-dispatcher-adapter.js';
import type { FinclawTracer } from '../observability/tracer.js';
import { nextRunAt as computeNextRunAt, parseCron } from './cron.js';

export interface SchedulerCallbacks {
  /**
   * agent.run 완료 직후 호출 (성공/실패 모두). delivery 모듈에서 이 시점에 송출.
   * 본 함수가 throw 해도 scheduler 는 계속 동작 (best-effort).
   */
  onRunComplete?(args: {
    schedule: Schedule;
    agentRunId: string | null;
    output: string;
    error?: string;
  }): Promise<void>;
}

export interface SchedulerDeps extends SchedulerCallbacks {
  readonly db: DatabaseSync;
  readonly toolRegistry: ToolRegistry;
  readonly runnerFactory: RunnerFactory;
  /** schedule 동시 실행 1개로 제한하는 lane. main.ts 에서 maxConcurrent:1 로 주입. */
  readonly lane: ConcurrencyLane;
  readonly defaultModel: ModelRef;
  readonly systemPrompt: string;
  readonly logger: FinClawLogger;
  readonly profileHealth: ProfileHealthMonitor;
  readonly profileId?: string;
  readonly router?: RouterHelper;
  readonly modelCatalog?: ModelCatalog;
  readonly modelAliasIndex?: AliasIndex;
  readonly fallbackChain?: readonly string[];
  /** 연속 실패 임계 (3 = AUTOMATION_MAX_CONSECUTIVE_FAILURES). 기본 3. */
  readonly maxConsecutiveFailures?: number;
  /** 기본 timeout (ms). schedule.timeoutMs 가 우선. 기본 60_000. */
  readonly defaultTimeoutMs?: number;
  /**
   * Phase 30 hotfix P0-1: schedule 실행을 새 span 으로 감싸 active trace context 강제.
   * 미주입 시 기존 동작 (agent_runs.trace_id NULL).
   */
  readonly tracer?: FinclawTracer;
}

const POLL_INTERVAL_MS = 60_000;

export class SchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTickTimer: ReturnType<typeof setTimeout> | null = null;
  private active = new Set<string>();
  private stopping = false;

  constructor(private readonly deps: SchedulerDeps) {}

  /** 1분 폴러 시작. 다음 분 경계까지 대기 후 첫 tick. */
  start(): void {
    if (this.timer || this.firstTickTimer) {
      return;
    }
    const now = Date.now();
    const nextMinute = Math.ceil(now / POLL_INTERVAL_MS) * POLL_INTERVAL_MS;
    const firstDelay = nextMinute - now;
    this.firstTickTimer = setTimeout(() => {
      this.firstTickTimer = null;
      void this.tick();
      this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    }, firstDelay);
    this.deps.logger.info('scheduler.started', {
      event: 'scheduler.started',
      firstTickInMs: firstDelay,
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.firstTickTimer) {
      clearTimeout(this.firstTickTimer);
      this.firstTickTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 현재 진행 중 run 들 완료 대기 — 60초 강제 timeout.
    const deadline = Date.now() + 60_000;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.deps.logger.info('scheduler.stopped', {
      event: 'scheduler.stopped',
      forcedExit: this.active.size > 0,
      remaining: this.active.size,
    });
  }

  /** UI 의 schedule.runNow RPC 가 호출. lane 통과 + agent.run 즉시 실행. */
  async triggerNow(scheduleId: string): Promise<{ runId: string | null }> {
    const s = getSchedule(this.deps.db, scheduleId);
    if (!s) {
      throw new Error(`not_found: schedule ${scheduleId}`);
    }
    return this.runOne(s, { manual: true });
  }

  private async tick(): Promise<void> {
    if (this.stopping) {
      return;
    }
    const now = Date.now();
    let due: Schedule[];
    try {
      due = findDueSchedules(this.deps.db, now);
    } catch (err) {
      this.deps.logger.warn('scheduler.tick_failed', {
        event: 'scheduler.tick_failed',
        error: (err as Error).message,
      });
      return;
    }
    for (const s of due) {
      // 이미 진행 중인 schedule 은 lane 으로 직렬화되지만, 같은 schedule 이 다음 tick 까지 안 끝났으면 skip.
      if (this.active.has(s.id)) {
        this.deps.logger.info('scheduler.tick_skipped_active', {
          event: 'scheduler.tick_skipped_active',
          scheduleId: s.id,
          name: s.name,
        });
        try {
          const cron = parseCron(s.cron);
          const next = computeNextRunAt(cron, now);
          markScheduleRun(this.deps.db, s.id, s.lastRunId ?? null, s.lastRunAt ?? now, next);
        } catch {
          /* swallow */
        }
        continue;
      }
      void this.runOne(s, { manual: false });
    }
  }

  private async runOne(s: Schedule, opts: { manual: boolean }): Promise<{ runId: string | null }> {
    if (this.active.has(s.id)) {
      return { runId: null };
    }
    this.active.add(s.id);
    const handle = await this.deps.lane.acquire(s.id);
    const startedAt = Date.now();
    let runId: string | null = null;
    let output = '';
    let error: string | undefined;
    // Phase 30 hotfix P0-1: schedule 실행을 새 trace 로 감싸 trace_id 가 agent_runs 에 비어있지 않게.
    // tracer 미주입 시 traceCtx 는 빈 객체 — addAgentRun 의 traceId 부착도 자연 skip.
    const tracer = this.deps.tracer;
    const withSchedSpan = <T>(
      fn: (ctx?: { traceId: string; parentSpanId?: string }) => Promise<T>,
    ): Promise<T> => {
      if (!tracer) {
        return fn(undefined);
      }
      return tracer.withSpan(
        'scheduler.run',
        { scheduleId: s.id, agentId: s.agentId as string, manual: opts.manual },
        async (ctx) => fn({ traceId: ctx.traceId, parentSpanId: ctx.spanId }),
      );
    };
    return withSchedSpan(async (traceCtx) => {
      try {
        const sessionKey = createSessionKey(`schedule-${s.id}-${randomUUID()}`);
        const agentIdBrand = createAgentId(s.agentId as string);
        const { dispatcher, toolDefinitions } = buildDispatcher(this.deps.toolRegistry, {
          sessionId: sessionKey as string,
          userId: 'scheduler',
          channelId: 'scheduler',
        });
        const runner = this.deps.runnerFactory(dispatcher);
        const userMsg: ConversationMessage = { role: 'user', content: s.prompt };
        const abortController = new AbortController();
        const timeoutMs = s.timeoutMs ?? this.deps.defaultTimeoutMs ?? 60_000;
        const timer = setTimeout(() => abortController.abort(), timeoutMs);

        const role = 'analysis' as const;
        const decision = this.deps.router
          ? this.deps.router({ role, toolNames: toolDefinitions.map((t) => t.name) })
          : undefined;
        const exposedTools = decision
          ? toolDefinitions.filter((t) => decision.allowedToolNames.includes(t.name))
          : toolDefinitions;
        const buildParams = (model: ModelRef): AgentRunParams => ({
          agentId: agentIdBrand,
          sessionKey,
          model,
          systemPrompt: this.deps.systemPrompt,
          messages: [userMsg],
          tools: exposedTools.length > 0 ? [...exposedTools] : undefined,
          abortSignal: abortController.signal,
        });

        let usedModelId: string | undefined;
        try {
          let result;
          if (decision && this.deps.modelCatalog && this.deps.modelAliasIndex) {
            const others = (this.deps.fallbackChain ?? []).filter((m) => m !== decision.modelId);
            const chain = [decision.modelId, ...others];
            const catalog = this.deps.modelCatalog;
            const aliasIndex = this.deps.modelAliasIndex;
            const fallback = await runWithModelFallback(
              {
                models: chain.map((raw) => ({ raw })),
                maxRetriesPerModel: 1,
                retryBaseDelayMs: 500,
                fallbackOn: DEFAULT_FALLBACK_TRIGGERS,
                abortSignal: abortController.signal,
                floor: decision.decision.floor,
              },
              async (resolved) =>
                runner.execute(
                  buildParams({
                    ...this.deps.defaultModel,
                    provider: resolved.provider,
                    model: resolved.modelId,
                    contextWindow: resolved.entry.contextWindow,
                    maxOutputTokens: Math.min(
                      resolved.entry.maxOutputTokens,
                      this.deps.defaultModel.maxOutputTokens,
                    ),
                  }),
                ),
              (ref) => resolveModel(ref, catalog, aliasIndex),
            );
            result = fallback.result;
            usedModelId = fallback.modelUsed.modelId;
          } else {
            const modelRef: ModelRef = decision
              ? { ...this.deps.defaultModel, model: decision.modelId }
              : this.deps.defaultModel;
            result = await runner.execute(buildParams(modelRef));
          }
          output = extractAssistantText(result.messages);
          const toolCalls = collectToolCalls(result.messages, startedAt);
          const durationMs = Date.now() - startedAt;
          const inserted = addAgentRun(this.deps.db, {
            agentId: agentIdBrand,
            prompt: s.prompt,
            output,
            toolCalls: JSON.stringify(toolCalls),
            tokensInput: result.usage.inputTokens,
            tokensOutput: result.usage.outputTokens,
            durationMs,
            modelUsed: usedModelId ?? this.deps.defaultModel.model,
            role,
            // Phase 30 hotfix P0-1: schedule 실행이 자체 trace 의 root, agent_runs 가 그 아래.
            traceId: traceCtx?.traceId,
            parentSpanId: traceCtx?.parentSpanId,
          });
          runId = inserted.id;
          this.deps.db
            .prepare('UPDATE agent_runs SET schedule_id = ? WHERE id = ?')
            .run(s.id, runId);
          this.deps.profileHealth.recordResult(this.deps.profileId ?? 'default', true);
        } catch (runErr) {
          if (runErr instanceof ModelFloorExhaustedError) {
            error = `model_floor_exhausted: ${runErr.floor}`;
          } else {
            error = (runErr as Error).message;
          }
          const durationMs = Date.now() - startedAt;
          const inserted = addAgentRun(this.deps.db, {
            agentId: agentIdBrand,
            prompt: s.prompt,
            output: '',
            durationMs,
            modelUsed: this.deps.defaultModel.model,
            role,
            error,
            // Phase 30 hotfix P0-1: traceId / parentSpanId 부착 (성공/실패 동일).
            traceId: traceCtx?.traceId,
            parentSpanId: traceCtx?.parentSpanId,
          });
          runId = inserted.id;
          this.deps.db
            .prepare('UPDATE agent_runs SET schedule_id = ? WHERE id = ?')
            .run(s.id, runId);
          this.deps.profileHealth.recordResult(this.deps.profileId ?? 'default', false);
        } finally {
          clearTimeout(timer);
        }

        // schedule.last_run + next_run_at 갱신.
        let nextMs: number | null = null;
        try {
          const cron = parseCron(s.cron);
          nextMs = computeNextRunAt(cron, Date.now());
        } catch (cronErr) {
          this.deps.logger.warn('scheduler.cron_invalid', {
            event: 'scheduler.cron_invalid',
            scheduleId: s.id,
            cron: s.cron,
            error: (cronErr as Error).message,
          });
        }
        markScheduleRun(this.deps.db, s.id, runId, Date.now(), nextMs);

        // 연속 실패 추적 + auto-disable.
        const max = this.deps.maxConsecutiveFailures ?? 3;
        const fresh = getSchedule(this.deps.db, s.id);
        if (!fresh) {
          // 레이스: 삭제된 schedule. 갱신만 skip.
        } else if (error) {
          const failures = fresh.consecutiveFailures + 1;
          const shouldDisable = failures >= max;
          updateSchedule(this.deps.db, s.id, {
            consecutiveFailures: failures,
            status: shouldDisable ? 'disabled' : 'failing',
            ...(shouldDisable ? { enabled: false } : {}),
          });
        } else if (fresh.consecutiveFailures > 0 || fresh.status !== 'active') {
          updateSchedule(this.deps.db, s.id, {
            consecutiveFailures: 0,
            status: 'active',
          });
        }

        this.deps.logger.info(error ? 'schedule.failed' : 'schedule.triggered', {
          event: error ? 'schedule.failed' : 'schedule.triggered',
          scheduleId: s.id,
          name: s.name,
          agentRunId: runId,
          durationMs: Date.now() - startedAt,
          manual: opts.manual,
          error,
        });

        if (this.deps.onRunComplete) {
          try {
            await this.deps.onRunComplete({
              schedule: fresh ?? s,
              agentRunId: runId,
              output,
              error,
            });
          } catch (deliveryErr) {
            this.deps.logger.warn('schedule.delivery_failed', {
              event: 'schedule.delivery_failed',
              scheduleId: s.id,
              error: (deliveryErr as Error).message,
            });
          }
        }
        return { runId };
      } finally {
        handle.release();
        this.active.delete(s.id);
      }
    });
  }
}
