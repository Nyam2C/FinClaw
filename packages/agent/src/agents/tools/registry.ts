import { getEventBus, createCircuitBreaker, type CircuitBreaker } from '@finclaw/infra';
import type { ToolDefinition } from '@finclaw/types';
import { z } from 'zod/v4';
import type { ToolGroupId } from './groups.js';
import {
  appendHistory,
  detectToolCallLoop,
  hashToolCall,
  hashToolResult,
  type ToolCallRecord,
} from './loop-detector.js';
import type { PolicyRule } from './policy.js';
import { evaluateToolPolicy } from './policy.js';
import {
  guardToolResult,
  type GuardedToolResult,
  type ResultGuardOptions,
} from './result-guard.js';

// ── 타입 ──

/** Phase 7 확장 도구 정의 — 기존 ToolDefinition 3필드를 상속 */
export interface RegisteredToolDefinition extends ToolDefinition {
  readonly group: ToolGroupId;
  readonly requiresApproval: boolean;
  readonly isTransactional: boolean;
  readonly accessesSensitiveData: boolean;
  /** 도구별 실행 타임아웃 (ms). 미지정 시 기본 30_000 */
  readonly timeoutMs?: number;
  /** 외부 API 호출 도구 여부 (true이면 CircuitBreaker 적용) */
  readonly isExternal?: boolean;
}

/** 도구 실행 함수 */
export type ToolExecutor = (
  input: Record<string, unknown>,
  context: ToolExecutionContext,
) => Promise<ToolResult>;

/** 도구 실행 컨텍스트 */
export interface ToolExecutionContext {
  readonly sessionId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly abortSignal: AbortSignal;
}

/** 도구 실행 결과 */
export interface ToolResult {
  readonly content: string;
  readonly isError: boolean;
  readonly metadata?: Record<string, unknown>;
}

/** 도구 등록 항목 */
export interface RegisteredTool {
  readonly definition: RegisteredToolDefinition;
  readonly executor: ToolExecutor;
  readonly registeredAt: Date;
  readonly source: 'built-in' | 'plugin' | 'skill';
}

/** 도구 레지스트리 인터페이스 */
export interface ToolRegistry {
  register(
    definition: RegisteredToolDefinition,
    executor: ToolExecutor,
    source?: RegisteredTool['source'],
  ): void;
  unregister(name: string): boolean;
  get(name: string): RegisteredTool | undefined;
  list(): readonly RegisteredTool[];
  has(name: string): boolean;
  execute(
    name: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<GuardedToolResult>;
  addPolicyRule(rule: PolicyRule): void;
}

// ── Zod 변환 헬퍼 ──

/**
 * JSON Schema 서브셋의 단일 property → Zod 타입. ToolDefinition.inputSchema 검증의 단일 소스.
 * Phase 40 follow-up: MCP 브리지(gateway)가 이 함수를 직접 import 해 도구 입력 schema 를
 * 동일하게 변환한다 — 사본을 두면 drift 시 MCP 입력검증이 조용히 어긋나므로 단일 소스 강제.
 */
export function jsonSchemaToZod(prop: Record<string, unknown>): z.ZodType {
  switch (prop.type) {
    case 'string':
      return prop.enum ? z.enum(prop.enum as [string, ...string[]]) : z.string();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array':
      return z.array(
        prop.items ? jsonSchemaToZod(prop.items as Record<string, unknown>) : z.unknown(),
      );
    case 'object':
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}

// ── InMemoryToolRegistry ──

export class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly policyRules: PolicyRule[] = [];
  private readonly guardOptions: ResultGuardOptions;
  private readonly breakers = new Map<string, CircuitBreaker>();
  private callHistory: ToolCallRecord[] = [];
  private readonly warningKeysSeen = new Set<string>();

  constructor(options?: { resultGuard?: Partial<ResultGuardOptions> }) {
    this.guardOptions = {
      maxContentLength: 100_000,
      redactPatterns: [],
      allowHtml: false,
      redactFinancialData: true,
      ...options?.resultGuard,
    };
  }

  register(
    definition: RegisteredToolDefinition,
    executor: ToolExecutor,
    source: RegisteredTool['source'] = 'built-in',
  ): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool already registered: ${definition.name}`);
    }
    this.tools.set(definition.name, {
      definition,
      executor,
      registeredAt: new Date(),
      source,
    });
    getEventBus().emit('tool:register', definition.name, definition.group, source);
  }

  unregister(name: string): boolean {
    const deleted = this.tools.delete(name);
    if (deleted) {
      getEventBus().emit('tool:unregister', name);
    }
    return deleted;
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(): readonly RegisteredTool[] {
    return [...this.tools.values()];
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  addPolicyRule(rule: PolicyRule): void {
    this.policyRules.push(rule);
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<GuardedToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return guardToolResult(
        { content: `Tool not found: ${name}`, isError: true },
        this.guardOptions,
      );
    }

    const bus = getEventBus();
    bus.emit('tool:execute:start', name, context.sessionId);
    const startTime = Date.now();

    try {
      // ① Zod 입력 검증
      const rawSchema = tool.definition.inputSchema as {
        properties?: Record<string, Record<string, unknown>>;
        required?: readonly string[];
      };
      if (rawSchema.properties) {
        const requiredFields = new Set(rawSchema.required ?? []);
        const zodShape = Object.fromEntries(
          Object.entries(rawSchema.properties).map(([k, v]) => {
            const base = jsonSchemaToZod(v);
            return [k, requiredFields.has(k) ? base : base.optional()];
          }),
        );
        const schema = z.object(zodShape);
        const parsed = schema.safeParse(input);
        if (!parsed.success) {
          bus.emit('tool:execute:end', name, context.sessionId, Date.now() - startTime);
          return guardToolResult(
            { content: `Invalid input: ${parsed.error.message}`, isError: true },
            this.guardOptions,
          );
        }
      }

      // ② 정책 평가
      let policyResult = evaluateToolPolicy(
        {
          toolName: name,
          toolDefinition: tool.definition,
          userId: context.userId,
          channelId: context.channelId,
          sessionId: context.sessionId,
        },
        this.policyRules,
      );

      // ③ 루프 감지 (sha256 hash + circuit breaker) — verdict emit 직전이어야 다운스트림이
      // 최종 verdict 를 정확히 관찰. OpenClaw tool-loop-detection.ts generic_repeat + circuit_breaker.
      const loopResult = detectToolCallLoop(this.callHistory, name, input);
      if (loopResult.stuck) {
        const dedupeKey = loopResult.warningKey ?? '';
        if (!this.warningKeysSeen.has(dedupeKey)) {
          this.warningKeysSeen.add(dedupeKey);
          bus.emit('tool:loop:detected', name, loopResult.detector, loopResult.count);
        }
        if (loopResult.level === 'critical') {
          // global_circuit_breaker / repeat-critical — 차단. verdict 도 'deny' 강제.
          bus.emit('tool:policy:verdict', name, 'deny', 'loop-detector');
          bus.emit('tool:policy:deny', name, loopResult.message);
          this.callHistory = appendHistory(this.callHistory, {
            toolName: name,
            argsHash: hashToolCall(name, input),
            resultHash: hashToolResult(undefined, new Error(loopResult.message)),
          });
          bus.emit('tool:execute:end', name, context.sessionId, Date.now() - startTime);
          return guardToolResult({ content: loopResult.message, isError: true }, this.guardOptions);
        }
        // warning — 9-stage 결과를 require-approval 로 override.
        policyResult = {
          ...policyResult,
          finalVerdict: 'require-approval',
          decidingStage: 'loop-detector',
          reason: loopResult.message,
        };
      }

      bus.emit('tool:policy:verdict', name, policyResult.finalVerdict, policyResult.decidingStage);

      if (policyResult.finalVerdict === 'deny') {
        bus.emit('tool:policy:deny', name, policyResult.reason);
        bus.emit('tool:execute:end', name, context.sessionId, Date.now() - startTime);
        return guardToolResult(
          { content: `Tool "${name}" denied: ${policyResult.reason}`, isError: true },
          this.guardOptions,
        );
      }

      // ④ 타임아웃 설정
      const toolTimeout = tool.definition.timeoutMs ?? 30_000;
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
        bus.emit('tool:execute:timeout', name, context.sessionId, toolTimeout);
      }, toolTimeout);

      const onExternalAbort = () => controller.abort();
      context.abortSignal.addEventListener('abort', onExternalAbort, { once: true });

      try {
        const mergedCtx: ToolExecutionContext = { ...context, abortSignal: controller.signal };

        // ⑤ 도구 실행 (외부 API 도구는 CircuitBreaker 적용)
        let result: ToolResult;
        if (tool.definition.isExternal) {
          let breaker = this.breakers.get(name);
          if (!breaker) {
            breaker = createCircuitBreaker();
            this.breakers.set(name, breaker);
          }
          result = await breaker.execute(() => tool.executor(input, mergedCtx));
        } else {
          result = await tool.executor(input, mergedCtx);
        }

        const guarded = guardToolResult(result, this.guardOptions);

        // ⑥ Phase 31 D — 루프 감지용 호출 이력 기록.
        this.callHistory = appendHistory(this.callHistory, {
          toolName: name,
          argsHash: hashToolCall(name, input),
          resultHash: guarded.isError
            ? hashToolResult(undefined, new Error(guarded.content))
            : hashToolResult(guarded.content, undefined),
        });

        bus.emit('tool:execute:end', name, context.sessionId, Date.now() - startTime);
        return guarded;
      } finally {
        clearTimeout(timer);
        context.abortSignal.removeEventListener('abort', onExternalAbort);
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.callHistory = appendHistory(this.callHistory, {
        toolName: name,
        argsHash: hashToolCall(name, input),
        resultHash: hashToolResult(undefined, error),
      });
      bus.emit('tool:execute:error', name, context.sessionId, errMsg);
      bus.emit('tool:execute:end', name, context.sessionId, Date.now() - startTime);
      return guardToolResult(
        { content: `Tool execution failed: ${errMsg}`, isError: true },
        this.guardOptions,
      );
    }
  }
}
