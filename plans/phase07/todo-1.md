# Phase 7 TODO-1: 도구 시스템 코어

> Plan Part 1 (기반 타입 & 레지스트리) + Part 2 (정책 & 실행 파이프라인)
>
> 수정 3개 + 소스 5개 + 테스트 4개 = **12 작업**

---

## 사전 준비

- [ ] **Step 0: agent 패키지에 zod 의존성 추가**

  ```bash
  cd packages/agent && pnpm add zod
  ```

  검증: `pnpm ls zod` 에 zod 3.25+ 출력 확인

---

## Part 1: 기반 타입 & 레지스트리

### - [ ] Step 1: FinClawEventMap에 tool:\* 이벤트 9종 추가

파일: `packages/infra/src/events.ts`

기존 `FinClawEventMap` 인터페이스의 마지막 이벤트 뒤에 추가:

```typescript
  // ── Phase 7: Tool events ──
  'tool:register': (name: string, group: string, source: string) => void;
  'tool:unregister': (name: string) => void;
  'tool:execute:start': (name: string, sessionId: string) => void;
  'tool:execute:end': (name: string, sessionId: string, durationMs: number) => void;
  'tool:execute:error': (name: string, sessionId: string, error: string) => void;
  'tool:execute:timeout': (name: string, sessionId: string, timeoutMs: number) => void;
  'tool:policy:verdict': (name: string, verdict: string, stage: string) => void;
  'tool:policy:deny': (name: string, reason: string) => void;
  'tool:circuit:change': (name: string, from: string, to: string) => void;
```

검증: `pnpm typecheck`

---

### - [ ] Step 2: PluginHookName에 도구 훅 2종 추가

파일: `packages/types/src/plugin.ts`

`PluginHookName` 유니온 끝에 추가:

```typescript
export type PluginHookName =
  | 'beforeMessageProcess'
  | 'afterMessageProcess'
  | 'beforeAgentRun'
  | 'afterAgentRun'
  | 'onConfigChange'
  | 'onGatewayStart'
  | 'onGatewayStop'
  | 'onPluginLoaded'
  | 'onPluginUnloaded'
  | 'beforeToolExecute' // Phase 7
  | 'afterToolExecute'; // Phase 7
```

파일: `packages/server/src/plugins/hook-types.ts`

`HookPayloadMap` 인터페이스에 추가 (typecheck 오류 방지):

```typescript
  beforeToolExecute: {
    toolName: string;
    input: Record<string, unknown>;
    context: { sessionId: string; userId: string; channelId: string };
    skip?: boolean;
    skipResult?: { content: string; isError: boolean };
  };
  afterToolExecute: {
    toolName: string;
    input: Record<string, unknown>;
    context: { sessionId: string; userId: string; channelId: string };
    result: { content: string; isError: boolean; wasTruncated: boolean; wasRedacted: boolean; originalSize: number; guardedSize: number };
    durationMs: number;
  };
```

검증: `pnpm typecheck`

---

### - [ ] Step 3: Tool Groups

파일: `packages/agent/src/agents/tools/groups.ts`

```typescript
import type { PolicyVerdict } from './policy.js';

// ── 도구 그룹 식별자 ──

/** 도구 그룹 식별자 */
export type ToolGroupId =
  | 'finance' // 금융 도구 (시세 조회, 차트, 포트폴리오)
  | 'system' // 시스템 도구 (파일, 프로세스)
  | 'web' // 웹 도구 (검색, 페이지 읽기)
  | 'data' // 데이터 도구 (DB 쿼리, 캐시)
  | 'communication' // 커뮤니케이션 (알림, 메시지)
  | 'custom'; // 사용자 정의

// ── 도구 그룹 정의 ──

/** 도구 그룹 정의 */
export interface ToolGroup {
  readonly id: ToolGroupId;
  readonly displayName: string;
  readonly description: string;
  readonly defaultPolicy: PolicyVerdict;
  /** 이 그룹의 도구가 시스템 프롬프트에 포함될 조건 */
  readonly includeInPromptWhen: 'always' | 'on-demand' | 'never';
}

// ── 내장 그룹 ──

export const BUILT_IN_GROUPS = [
  {
    id: 'finance',
    displayName: '금융 도구',
    description: '시세 조회, 포트폴리오 분석, 뉴스 검색, 차트 생성',
    defaultPolicy: 'allow',
    includeInPromptWhen: 'always',
  },
  {
    id: 'system',
    displayName: '시스템 도구',
    description: '파일 시스템, 프로세스 관리, 환경 정보',
    defaultPolicy: 'require-approval',
    includeInPromptWhen: 'on-demand',
  },
  {
    id: 'web',
    displayName: '웹 도구',
    description: '웹 검색, 페이지 읽기, API 호출',
    defaultPolicy: 'allow',
    includeInPromptWhen: 'always',
  },
  {
    id: 'data',
    displayName: '데이터 도구',
    description: '데이터베이스 쿼리, 캐시 관리',
    defaultPolicy: 'require-approval',
    includeInPromptWhen: 'on-demand',
  },
  {
    id: 'communication',
    displayName: '커뮤니케이션 도구',
    description: '알림 발송, 메시지 전달',
    defaultPolicy: 'allow',
    includeInPromptWhen: 'always',
  },
  {
    id: 'custom',
    displayName: '사용자 정의 도구',
    description: '플러그인/스킬이 등록한 커스텀 도구',
    defaultPolicy: 'require-approval',
    includeInPromptWhen: 'on-demand',
  },
] as const satisfies readonly ToolGroup[];
```

검증: `pnpm typecheck`

---

### - [ ] Step 4: Tool Registry 타입 + InMemoryToolRegistry

파일: `packages/agent/src/agents/tools/registry.ts`

```typescript
import { z } from 'zod/v4';
import type { ToolDefinition } from '@finclaw/types/agent.js';
import { getEventBus, createCircuitBreaker, type CircuitBreaker } from '@finclaw/infra';

import type { ToolGroupId } from './groups.js';
import type { PolicyRule } from './policy.js';
import { evaluateToolPolicy } from './policy.js';
import {
  guardToolResult,
  type GuardedToolResult,
  type ResultGuardOptions,
} from './result-guard.js';

// ── 타입 ──

/** 도구 입력 파라미터 스키마 (JSON Schema 서브셋, 문서/검증용) */
export interface ToolInputSchema {
  readonly type: 'object';
  readonly properties: Record<string, ToolPropertySchema>;
  readonly required?: readonly string[];
}

export interface ToolPropertySchema {
  readonly type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  readonly description: string;
  readonly enum?: readonly string[];
  readonly items?: ToolPropertySchema;
  readonly default?: unknown;
}

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

/** RegisteredToolDefinition → ToolDefinition 변환 (LLM API 전송용) */
export function toApiToolDefinition(reg: RegisteredToolDefinition): ToolDefinition {
  return { name: reg.name, description: reg.description, inputSchema: reg.inputSchema };
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
  listByGroup(group: ToolGroupId): readonly RegisteredTool[];
  has(name: string): boolean;
  execute(
    name: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<GuardedToolResult>;
  addPolicyRule(rule: PolicyRule): void;
}

// ── 훅 페이로드 ──

/** beforeToolExecute 훅 페이로드 */
export interface BeforeToolExecutePayload {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly context: ToolExecutionContext;
  /** false로 설정하면 실행을 차단 */
  skip?: boolean;
  /** skip=true일 때 반환할 대체 결과 */
  skipResult?: ToolResult;
}

/** afterToolExecute 훅 페이로드 */
export interface AfterToolExecutePayload {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly context: ToolExecutionContext;
  result: GuardedToolResult;
  readonly durationMs: number;
}

/** 선택적 훅 콜백 (서버의 HookRunner와 나중에 연결) */
export interface ToolRegistryHooks {
  beforeToolExecute?: (payload: BeforeToolExecutePayload) => Promise<BeforeToolExecutePayload>;
  afterToolExecute?: (payload: AfterToolExecutePayload) => Promise<AfterToolExecutePayload>;
}

// ── 루프 감지 ──

const LOOP_THRESHOLD = 5;
const LOOP_WINDOW_MS = 10_000;

function isToolLoop(timestamps: number[]): boolean {
  const now = Date.now();
  const recent = timestamps.filter((t) => now - t < LOOP_WINDOW_MS);
  return recent.length >= LOOP_THRESHOLD;
}

// ── Zod 변환 헬퍼 ──

function jsonSchemaToZod(prop: Record<string, unknown>): z.ZodType {
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
      return z.record(z.unknown());
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
  private readonly callTimestamps = new Map<string, number[]>();
  private readonly hooks?: ToolRegistryHooks;

  constructor(options?: { resultGuard?: Partial<ResultGuardOptions>; hooks?: ToolRegistryHooks }) {
    this.guardOptions = {
      maxContentLength: 100_000,
      redactPatterns: [],
      allowHtml: false,
      redactFinancialData: true,
      ...options?.resultGuard,
    };
    this.hooks = options?.hooks;
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

  listByGroup(group: ToolGroupId): readonly RegisteredTool[] {
    return [...this.tools.values()].filter((t) => t.definition.group === group);
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
      };
      if (rawSchema.properties) {
        const zodShape = Object.fromEntries(
          Object.entries(rawSchema.properties).map(([k, v]) => [k, jsonSchemaToZod(v)]),
        );
        const schema = z.object(zodShape);
        const parsed = schema.safeParse(input);
        if (!parsed.success) {
          return guardToolResult(
            { content: `Invalid input: ${parsed.error.message}`, isError: true },
            this.guardOptions,
          );
        }
      }

      // ② 정책 평가
      const policyResult = evaluateToolPolicy(
        {
          toolName: name,
          toolDefinition: tool.definition,
          userId: context.userId,
          channelId: context.channelId,
          sessionId: context.sessionId,
        },
        this.policyRules,
      );

      bus.emit('tool:policy:verdict', name, policyResult.finalVerdict, policyResult.decidingStage);

      if (policyResult.finalVerdict === 'deny') {
        bus.emit('tool:policy:deny', name, policyResult.reason);
        return guardToolResult(
          { content: `Tool "${name}" denied: ${policyResult.reason}`, isError: true },
          this.guardOptions,
        );
      }

      if (policyResult.finalVerdict === 'require-approval') {
        console.warn(`[ToolRegistry] Tool "${name}" requires approval (auto-approved)`);
      }

      // ③ 루프 감지
      const timestamps = this.callTimestamps.get(name) ?? [];
      timestamps.push(Date.now());
      this.callTimestamps.set(name, timestamps.slice(-LOOP_THRESHOLD));
      if (isToolLoop(timestamps)) {
        console.warn(`[ToolRegistry] Tool loop detected for "${name}", forcing require-approval`);
      }

      // ④ beforeToolExecute 훅
      if (this.hooks?.beforeToolExecute) {
        const payload: BeforeToolExecutePayload = { toolName: name, input, context };
        const modified = await this.hooks.beforeToolExecute(payload);
        if (modified.skip) {
          const guarded = guardToolResult(
            modified.skipResult ?? { content: 'Skipped', isError: false },
            this.guardOptions,
          );
          bus.emit('tool:execute:end', name, context.sessionId, Date.now() - startTime);
          return guarded;
        }
      }

      // ⑤ 타임아웃 설정
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

        // ⑥ 도구 실행 (외부 API 도구는 CircuitBreaker 적용)
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

        let guarded = guardToolResult(result, this.guardOptions);

        // ⑦ afterToolExecute 훅
        if (this.hooks?.afterToolExecute) {
          const durationMs = Date.now() - startTime;
          const payload: AfterToolExecutePayload = {
            toolName: name,
            input,
            context,
            result: guarded,
            durationMs,
          };
          const modified = await this.hooks.afterToolExecute(payload);
          guarded = modified.result;
        }

        bus.emit('tool:execute:end', name, context.sessionId, Date.now() - startTime);
        return guarded;
      } finally {
        clearTimeout(timer);
        context.abortSignal.removeEventListener('abort', onExternalAbort);
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      bus.emit('tool:execute:error', name, context.sessionId, errMsg);
      return guardToolResult(
        { content: `Tool execution failed: ${errMsg}`, isError: true },
        this.guardOptions,
      );
    }
  }
}
```

검증: `pnpm typecheck`

---

## Part 2: 정책 & 실행 파이프라인

### - [ ] Step 5: Tool Policy 9단계 필터

파일: `packages/agent/src/agents/tools/policy.ts`

```typescript
import type { RegisteredToolDefinition } from './registry.js';

// ── 타입 ──

/** 정책 판정 결과 */
export type PolicyVerdict = 'allow' | 'deny' | 'require-approval';

/** 정책 규칙 */
export interface PolicyRule {
  readonly pattern: string; // 도구 이름 glob 패턴 (e.g., "finance:*")
  readonly verdict: PolicyVerdict;
  readonly reason?: string;
  readonly priority: number; // 높을수록 우선
  /** 적용 범위 필터 — 미지정이면 모든 범위에 적용 */
  readonly scope?: {
    readonly userId?: string;
    readonly channelId?: string;
  };
}

/** 정책 컨텍스트 */
export interface PolicyContext {
  readonly toolName: string;
  readonly toolDefinition: RegisteredToolDefinition;
  readonly userId: string;
  readonly channelId: string;
  readonly sessionId: string;
}

/** 정책 필터 단계 정의 */
export interface PolicyStage {
  readonly name: string;
  readonly evaluate: (ctx: PolicyContext, rules: readonly PolicyRule[]) => PolicyStageResult;
}

export interface PolicyStageResult {
  readonly verdict: PolicyVerdict | 'continue';
  readonly reason: string;
  readonly stage: string;
}

export interface PolicyEvaluationResult {
  readonly finalVerdict: PolicyVerdict;
  readonly stageResults: readonly PolicyStageResult[];
  readonly decidingStage: string;
  readonly reason: string;
}

// ── glob 매칭 ──

/** 간이 glob 매칭 (* 지원) */
export function matchToolPattern(pattern: string, toolName: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2);
    return toolName.startsWith(prefix + ':');
  }
  return pattern === toolName;
}

// ── 9단계 평가 함수 ──

/** 규칙을 priority 내림차순으로 필터링 */
function findMatchingRules(
  rules: readonly PolicyRule[],
  toolName: string,
  filterFn?: (rule: PolicyRule) => boolean,
): PolicyRule[] {
  return rules
    .filter((r) => matchToolPattern(r.pattern, toolName) && (!filterFn || filterFn(r)))
    .sort((a, b) => b.priority - a.priority);
}

/** Stage 1: 글로벌 deny 리스트 */
function evaluateGlobalDeny(ctx: PolicyContext, rules: readonly PolicyRule[]): PolicyStageResult {
  const matched = findMatchingRules(rules, ctx.toolName, (r) => r.verdict === 'deny' && !r.scope);
  if (matched.length > 0) {
    return {
      verdict: 'deny',
      reason: matched[0].reason ?? 'Globally denied',
      stage: 'global-deny',
    };
  }
  return { verdict: 'continue', reason: '', stage: 'global-deny' };
}

/** Stage 2: 글로벌 allow 리스트 */
function evaluateGlobalAllow(ctx: PolicyContext, rules: readonly PolicyRule[]): PolicyStageResult {
  const matched = findMatchingRules(rules, ctx.toolName, (r) => r.verdict === 'allow' && !r.scope);
  if (matched.length > 0) {
    return {
      verdict: 'allow',
      reason: matched[0].reason ?? 'Globally allowed',
      stage: 'global-allow',
    };
  }
  return { verdict: 'continue', reason: '', stage: 'global-allow' };
}

/** Stage 3: 사용자별 deny */
function evaluateUserDeny(ctx: PolicyContext, rules: readonly PolicyRule[]): PolicyStageResult {
  const matched = findMatchingRules(
    rules,
    ctx.toolName,
    (r) => r.verdict === 'deny' && r.scope?.userId === ctx.userId,
  );
  if (matched.length > 0) {
    return { verdict: 'deny', reason: matched[0].reason ?? 'Denied for user', stage: 'user-deny' };
  }
  return { verdict: 'continue', reason: '', stage: 'user-deny' };
}

/** Stage 4: 사용자별 allow */
function evaluateUserAllow(ctx: PolicyContext, rules: readonly PolicyRule[]): PolicyStageResult {
  const matched = findMatchingRules(
    rules,
    ctx.toolName,
    (r) => r.verdict === 'allow' && r.scope?.userId === ctx.userId,
  );
  if (matched.length > 0) {
    return {
      verdict: 'allow',
      reason: matched[0].reason ?? 'Allowed for user',
      stage: 'user-allow',
    };
  }
  return { verdict: 'continue', reason: '', stage: 'user-allow' };
}

/** Stage 5: 채널별 정책 */
function evaluateChannelPolicy(
  ctx: PolicyContext,
  rules: readonly PolicyRule[],
): PolicyStageResult {
  const matched = findMatchingRules(
    rules,
    ctx.toolName,
    (r) => r.scope?.channelId === ctx.channelId,
  );
  if (matched.length > 0) {
    return {
      verdict: matched[0].verdict,
      reason: matched[0].reason ?? 'Channel policy',
      stage: 'channel-policy',
    };
  }
  return { verdict: 'continue', reason: '', stage: 'channel-policy' };
}

/** Stage 6: 그룹별 정책 */
function evaluateGroupPolicy(ctx: PolicyContext, rules: readonly PolicyRule[]): PolicyStageResult {
  // 그룹 패턴: "<group>:*"
  const groupPattern = `${ctx.toolDefinition.group}:*`;
  const matched = findMatchingRules(rules, groupPattern, (r) => !r.scope).filter((r) =>
    matchToolPattern(r.pattern, ctx.toolName),
  );

  if (matched.length > 0) {
    return {
      verdict: matched[0].verdict,
      reason: matched[0].reason ?? 'Group policy',
      stage: 'group-policy',
    };
  }
  return { verdict: 'continue', reason: '', stage: 'group-policy' };
}

/** Stage 7: 도구별 명시적 정책 */
function evaluateToolSpecificPolicy(
  ctx: PolicyContext,
  rules: readonly PolicyRule[],
): PolicyStageResult {
  const matched = findMatchingRules(
    rules,
    ctx.toolName,
    (r) => r.pattern === ctx.toolName && !r.scope,
  );
  if (matched.length > 0) {
    return {
      verdict: matched[0].verdict,
      reason: matched[0].reason ?? 'Tool-specific policy',
      stage: 'tool-policy',
    };
  }
  return { verdict: 'continue', reason: '', stage: 'tool-policy' };
}

/** Stage 8: 금융 안전 정책 (FinClaw 전용) */
function evaluateFinanceSafety(
  ctx: PolicyContext,
  _rules: readonly PolicyRule[],
): PolicyStageResult {
  if (ctx.toolDefinition.isTransactional) {
    return {
      verdict: 'require-approval',
      reason: `Transactional tool "${ctx.toolName}" requires explicit approval`,
      stage: 'finance-safety',
    };
  }
  if (ctx.toolDefinition.accessesSensitiveData) {
    console.warn(
      `[Policy:finance-safety] Tool "${ctx.toolName}" accesses sensitive financial data`,
    );
  }
  return { verdict: 'continue', reason: '', stage: 'finance-safety' };
}

/** Stage 9: 기본 정책 (allow) */
function evaluateDefault(_ctx: PolicyContext, _rules: readonly PolicyRule[]): PolicyStageResult {
  return { verdict: 'allow', reason: 'Default allow', stage: 'default-policy' };
}

// ── 기본 9단계 파이프라인 ──

const DEFAULT_STAGES: readonly PolicyStage[] = [
  { name: 'global-deny', evaluate: evaluateGlobalDeny },
  { name: 'global-allow', evaluate: evaluateGlobalAllow },
  { name: 'user-deny', evaluate: evaluateUserDeny },
  { name: 'user-allow', evaluate: evaluateUserAllow },
  { name: 'channel-policy', evaluate: evaluateChannelPolicy },
  { name: 'group-policy', evaluate: evaluateGroupPolicy },
  { name: 'tool-policy', evaluate: evaluateToolSpecificPolicy },
  { name: 'finance-safety', evaluate: evaluateFinanceSafety },
  { name: 'default-policy', evaluate: evaluateDefault },
];

// ── 메인 함수 ──

/**
 * 9단계 정책 필터 파이프라인
 *
 * - deny → 즉시 중단
 * - require-approval → 누적, 파이프라인 끝에서 적용
 * - allow / continue → 후속 단계 진행 (finance-safety 보장)
 */
export function evaluateToolPolicy(
  ctx: PolicyContext,
  rules: readonly PolicyRule[],
  stages: readonly PolicyStage[] = DEFAULT_STAGES,
): PolicyEvaluationResult {
  const stageResults: PolicyStageResult[] = [];
  let pendingApproval: PolicyStageResult | undefined;

  for (const stage of stages) {
    const result = stage.evaluate(ctx, rules);
    stageResults.push(result);

    switch (result.verdict) {
      case 'deny':
        return {
          finalVerdict: 'deny',
          stageResults,
          decidingStage: stage.name,
          reason: result.reason,
        };

      case 'require-approval':
        pendingApproval ??= result;
        break;

      // allow / continue → 계속
      default:
        break;
    }
  }

  if (pendingApproval) {
    return {
      finalVerdict: 'require-approval',
      stageResults,
      decidingStage: pendingApproval.stage,
      reason: pendingApproval.reason,
    };
  }

  return {
    finalVerdict: 'allow',
    stageResults,
    decidingStage: 'fallthrough',
    reason: 'No matching policy rule found, defaulting to allow',
  };
}
```

검증: `pnpm typecheck`

---

### - [ ] Step 6: Result Guard

파일: `packages/agent/src/agents/tools/result-guard.ts`

```typescript
import type { ToolResult } from './registry.js';

// ── 타입 ──

/** 가드된 도구 결과 */
export interface GuardedToolResult {
  readonly content: string;
  readonly isError: boolean;
  readonly wasTruncated: boolean;
  readonly wasRedacted: boolean;
  readonly originalSize: number;
  readonly guardedSize: number;
}

/** 결과 가드 옵션 */
export interface ResultGuardOptions {
  readonly maxContentLength: number; // 기본: 100_000 chars
  readonly redactPatterns: readonly RegExp[];
  readonly allowHtml: boolean;
  /** 금융 특화: 계좌번호/카드번호 자동 마스킹 */
  readonly redactFinancialData: boolean;
}

// ── 내장 금융 데이터 마스킹 패턴 ──

export const FINANCIAL_REDACT_PATTERNS: readonly RegExp[] = [
  /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, // 카드번호
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN
  /\b\d{10,14}\b/g, // 계좌번호 (10-14자리)
];

// ── HTML 태그 제거 ──

const HTML_TAG_RE = /<[^>]+>/g;

// ── 메인 함수 ──

/**
 * 도구 실행 결과 가드
 *
 * 1. null/undefined → "[No result returned]"
 * 2. 비문자열 → JSON.stringify
 * 3. JSON 제어 문자 제거 (탭/개행/CR 제외)
 * 4. 크기 제한 → 초과 시 truncation
 * 5. 민감 정보 마스킹
 * 6. HTML 새니타이즈
 * 7. 최종 GuardedToolResult 반환
 */
export function guardToolResult(
  result: ToolResult | null | undefined,
  options: ResultGuardOptions,
): GuardedToolResult {
  // 1. null/undefined 처리
  if (!result) {
    return {
      content: '[No result returned]',
      isError: false,
      wasTruncated: false,
      wasRedacted: false,
      originalSize: 0,
      guardedSize: 22,
    };
  }

  // 2. 문자열 변환
  let content: string;
  if (typeof result.content === 'string') {
    content = result.content;
  } else {
    try {
      content = JSON.stringify(result.content);
    } catch {
      content = String(result.content);
    }
  }

  const originalSize = content.length;
  let wasTruncated = false;
  let wasRedacted = false;

  // 3. JSON 제어 문자 제거 (탭 \t, 개행 \n, 캐리지리턴 \r 제외)
  content = content.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

  // 4. 크기 제한
  if (content.length > options.maxContentLength) {
    content = content.slice(0, options.maxContentLength) + '\n[truncated]';
    wasTruncated = true;
  }

  // 5. 민감 정보 마스킹
  // 5a. 사용자 정의 패턴
  for (const pattern of options.redactPatterns) {
    const re = new RegExp(pattern.source, pattern.flags);
    if (re.test(content)) {
      wasRedacted = true;
      content = content.replace(new RegExp(pattern.source, pattern.flags), '[REDACTED]');
    }
  }

  // 5b. 금융 데이터 마스킹
  if (options.redactFinancialData) {
    for (const pattern of FINANCIAL_REDACT_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags);
      if (re.test(content)) {
        wasRedacted = true;
        content = content.replace(new RegExp(pattern.source, pattern.flags), '[REDACTED]');
      }
    }
  }

  // 6. HTML 새니타이즈
  if (!options.allowHtml) {
    content = content.replace(HTML_TAG_RE, '');
  }

  return {
    content,
    isError: result.isError,
    wasTruncated,
    wasRedacted,
    originalSize,
    guardedSize: content.length,
  };
}
```

검증: `pnpm typecheck`

---

### - [ ] Step 7: tools/index.ts 배럴

파일: `packages/agent/src/agents/tools/index.ts`

```typescript
// ── groups ──
export type { ToolGroupId, ToolGroup } from './groups.js';
export { BUILT_IN_GROUPS } from './groups.js';

// ── registry ──
export type {
  ToolInputSchema,
  ToolPropertySchema,
  RegisteredToolDefinition,
  ToolExecutor,
  ToolExecutionContext,
  ToolResult,
  RegisteredTool,
  ToolRegistry,
  BeforeToolExecutePayload,
  AfterToolExecutePayload,
  ToolRegistryHooks,
} from './registry.js';
export { toApiToolDefinition, InMemoryToolRegistry } from './registry.js';

// ── policy ──
export type {
  PolicyVerdict,
  PolicyRule,
  PolicyContext,
  PolicyStage,
  PolicyStageResult,
  PolicyEvaluationResult,
} from './policy.js';
export { evaluateToolPolicy, matchToolPattern } from './policy.js';

// ── result guard ──
export type { GuardedToolResult, ResultGuardOptions } from './result-guard.js';
export { guardToolResult, FINANCIAL_REDACT_PATTERNS } from './result-guard.js';
```

검증: `pnpm typecheck`

---

## 테스트

> 테스트 파일은 기존 패턴에 따라 `packages/agent/test/` 에 배치 (vitest.config.ts의 include glob: `packages/*/test/**/*.test.ts`)

### - [ ] Step 8: tool-groups.test.ts

파일: `packages/agent/test/tool-groups.test.ts`

```typescript
import { describe, it, expect } from 'vitest';

import { BUILT_IN_GROUPS } from '../src/agents/tools/groups.js';
import type { ToolGroupId } from '../src/agents/tools/groups.js';

describe('BUILT_IN_GROUPS', () => {
  it('6개 내장 그룹이 정의되어 있다', () => {
    expect(BUILT_IN_GROUPS).toHaveLength(6);
  });

  it('모든 ToolGroupId 값이 포함되어 있다', () => {
    const ids = BUILT_IN_GROUPS.map((g) => g.id);
    const expectedIds: ToolGroupId[] = [
      'finance',
      'system',
      'web',
      'data',
      'communication',
      'custom',
    ];
    expect(ids).toEqual(expectedIds);
  });

  it('각 그룹은 필수 필드를 모두 갖는다', () => {
    for (const group of BUILT_IN_GROUPS) {
      expect(group).toHaveProperty('id');
      expect(group).toHaveProperty('displayName');
      expect(group).toHaveProperty('description');
      expect(group).toHaveProperty('defaultPolicy');
      expect(group).toHaveProperty('includeInPromptWhen');
    }
  });

  it('finance 그룹은 기본 allow, always 포함이다', () => {
    const finance = BUILT_IN_GROUPS.find((g) => g.id === 'finance')!;
    expect(finance.defaultPolicy).toBe('allow');
    expect(finance.includeInPromptWhen).toBe('always');
  });

  it('system 그룹은 기본 require-approval이다', () => {
    const system = BUILT_IN_GROUPS.find((g) => g.id === 'system')!;
    expect(system.defaultPolicy).toBe('require-approval');
    expect(system.includeInPromptWhen).toBe('on-demand');
  });
});
```

검증: `pnpm test -- packages/agent/test/tool-groups.test.ts`

---

### - [ ] Step 9: tool-registry.test.ts

파일: `packages/agent/test/tool-registry.test.ts`

```typescript
import { resetEventBus } from '@finclaw/infra';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type {
  RegisteredToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from '../src/agents/tools/registry.js';
import { InMemoryToolRegistry, toApiToolDefinition } from '../src/agents/tools/registry.js';

// ── 헬퍼 ──

function makeDef(overrides?: Partial<RegisteredToolDefinition>): RegisteredToolDefinition {
  return {
    name: 'test-tool',
    description: 'A test tool',
    inputSchema: {},
    group: 'custom',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: false,
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    sessionId: 'sess-1',
    userId: 'user-1',
    channelId: 'ch-1',
    abortSignal: AbortSignal.timeout(5_000),
    ...overrides,
  };
}

const okExecutor = async (): Promise<ToolResult> => ({
  content: 'ok',
  isError: false,
});

const errorExecutor = async (): Promise<ToolResult> => {
  throw new Error('boom');
};

describe('InMemoryToolRegistry', () => {
  let registry: InMemoryToolRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new InMemoryToolRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetEventBus();
  });

  // ── register / get / has / list ──

  it('도구를 등록하고 조회한다', () => {
    const def = makeDef();
    registry.register(def, okExecutor);

    expect(registry.has('test-tool')).toBe(true);
    expect(registry.get('test-tool')?.definition.name).toBe('test-tool');
    expect(registry.list()).toHaveLength(1);
  });

  it('중복 등록 시 에러를 던진다', () => {
    registry.register(makeDef(), okExecutor);
    expect(() => registry.register(makeDef(), okExecutor)).toThrow('already registered');
  });

  it('등록 해제한다', () => {
    registry.register(makeDef(), okExecutor);
    expect(registry.unregister('test-tool')).toBe(true);
    expect(registry.has('test-tool')).toBe(false);
    expect(registry.unregister('nonexistent')).toBe(false);
  });

  it('그룹별로 도구를 조회한다', () => {
    registry.register(makeDef({ name: 'a', group: 'finance' }), okExecutor);
    registry.register(makeDef({ name: 'b', group: 'finance' }), okExecutor);
    registry.register(makeDef({ name: 'c', group: 'system' }), okExecutor);

    expect(registry.listByGroup('finance')).toHaveLength(2);
    expect(registry.listByGroup('system')).toHaveLength(1);
    expect(registry.listByGroup('web')).toHaveLength(0);
  });

  // ── toApiToolDefinition ──

  it('RegisteredToolDefinition을 3필드 ToolDefinition으로 변환한다', () => {
    const reg = makeDef({ name: 'x', group: 'finance', isTransactional: true });
    const api = toApiToolDefinition(reg);

    expect(api).toEqual({ name: 'x', description: 'A test tool', inputSchema: {} });
    expect(api).not.toHaveProperty('group');
    expect(api).not.toHaveProperty('isTransactional');
  });

  // ── execute ──

  it('등록되지 않은 도구 실행 시 에러 결과를 반환한다', async () => {
    const result = await registry.execute('nonexistent', {}, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  it('정상 도구를 실행하고 결과를 가드한다', async () => {
    registry.register(makeDef(), okExecutor);
    const result = await registry.execute('test-tool', {}, makeCtx());

    expect(result.isError).toBe(false);
    expect(result.content).toBe('ok');
  });

  it('도구 실행 중 예외를 잡아 에러 결과로 반환한다', async () => {
    registry.register(makeDef(), errorExecutor);
    const result = await registry.execute('test-tool', {}, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('boom');
  });

  it('deny 정책이 있으면 실행을 차단한다', async () => {
    registry.register(makeDef(), okExecutor);
    registry.addPolicyRule({
      pattern: 'test-tool',
      verdict: 'deny',
      reason: 'Not allowed',
      priority: 100,
    });

    const result = await registry.execute('test-tool', {}, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('denied');
  });

  it('beforeToolExecute 훅으로 실행을 skip할 수 있다', async () => {
    const hookRegistry = new InMemoryToolRegistry({
      hooks: {
        beforeToolExecute: async (payload) => ({
          ...payload,
          skip: true,
          skipResult: { content: 'Hooked!', isError: false },
        }),
      },
    });
    hookRegistry.register(makeDef(), okExecutor);

    const result = await hookRegistry.execute('test-tool', {}, makeCtx());

    expect(result.content).toBe('Hooked!');
  });
});
```

검증: `pnpm test -- packages/agent/test/tool-registry.test.ts`

---

### - [ ] Step 10: tool-policy.test.ts

파일: `packages/agent/test/tool-policy.test.ts`

```typescript
import { describe, it, expect } from 'vitest';

import type { PolicyRule, PolicyContext } from '../src/agents/tools/policy.js';
import { evaluateToolPolicy, matchToolPattern } from '../src/agents/tools/policy.js';
import type { RegisteredToolDefinition } from '../src/agents/tools/registry.js';

// ── 헬퍼 ──

function makeCtx(overrides?: Partial<PolicyContext>): PolicyContext {
  return {
    toolName: 'finance:get-price',
    toolDefinition: {
      name: 'finance:get-price',
      description: 'Get stock price',
      inputSchema: {},
      group: 'finance',
      requiresApproval: false,
      isTransactional: false,
      accessesSensitiveData: false,
    } as RegisteredToolDefinition,
    userId: 'user-1',
    channelId: 'ch-1',
    sessionId: 'sess-1',
    ...overrides,
  };
}

describe('matchToolPattern', () => {
  it('와일드카드 * 는 모든 도구에 매칭된다', () => {
    expect(matchToolPattern('*', 'anything')).toBe(true);
  });

  it('접두사:* 패턴으로 그룹 매칭한다', () => {
    expect(matchToolPattern('finance:*', 'finance:get-price')).toBe(true);
    expect(matchToolPattern('finance:*', 'system:ls')).toBe(false);
  });

  it('정확히 일치하는 이름에 매칭된다', () => {
    expect(matchToolPattern('finance:get-price', 'finance:get-price')).toBe(true);
    expect(matchToolPattern('finance:get-price', 'finance:set-price')).toBe(false);
  });
});

describe('evaluateToolPolicy', () => {
  it('규칙 없으면 기본 allow를 반환한다', () => {
    const result = evaluateToolPolicy(makeCtx(), []);

    expect(result.finalVerdict).toBe('allow');
    expect(result.stageResults).toHaveLength(9);
  });

  it('글로벌 deny 규칙이 즉시 중단한다', () => {
    const rules: PolicyRule[] = [
      { pattern: '*', verdict: 'deny', reason: 'All denied', priority: 100 },
    ];
    const result = evaluateToolPolicy(makeCtx(), rules);

    expect(result.finalVerdict).toBe('deny');
    expect(result.decidingStage).toBe('global-deny');
  });

  it('글로벌 deny가 글로벌 allow보다 먼저 평가된다', () => {
    const rules: PolicyRule[] = [
      { pattern: '*', verdict: 'deny', priority: 50 },
      { pattern: '*', verdict: 'allow', priority: 100 },
    ];
    const result = evaluateToolPolicy(makeCtx(), rules);

    // deny 가 Stage 1 에서 먼저 잡힘
    expect(result.finalVerdict).toBe('deny');
    expect(result.decidingStage).toBe('global-deny');
  });

  it('사용자별 deny가 적용된다', () => {
    const rules: PolicyRule[] = [
      {
        pattern: 'finance:get-price',
        verdict: 'deny',
        priority: 50,
        scope: { userId: 'user-1' },
      },
    ];
    const result = evaluateToolPolicy(makeCtx(), rules);

    expect(result.finalVerdict).toBe('deny');
    expect(result.decidingStage).toBe('user-deny');
  });

  it('다른 사용자의 deny 규칙은 무시된다', () => {
    const rules: PolicyRule[] = [
      {
        pattern: 'finance:get-price',
        verdict: 'deny',
        priority: 50,
        scope: { userId: 'user-2' },
      },
    ];
    const result = evaluateToolPolicy(makeCtx(), rules);

    expect(result.finalVerdict).toBe('allow');
  });

  it('isTransactional 도구는 require-approval을 반환한다 (Stage 8)', () => {
    const ctx = makeCtx({
      toolDefinition: {
        name: 'finance:execute-trade',
        description: 'Execute trade',
        inputSchema: {},
        group: 'finance',
        requiresApproval: false,
        isTransactional: true,
        accessesSensitiveData: false,
      } as RegisteredToolDefinition,
    });
    const result = evaluateToolPolicy(ctx, []);

    expect(result.finalVerdict).toBe('require-approval');
    expect(result.decidingStage).toBe('finance-safety');
  });

  it('require-approval은 누적되고 파이프라인 끝에서 적용된다', () => {
    const ctx = makeCtx({
      toolDefinition: {
        name: 'finance:trade',
        description: 'Trade',
        inputSchema: {},
        group: 'finance',
        requiresApproval: false,
        isTransactional: true,
        accessesSensitiveData: false,
      } as RegisteredToolDefinition,
    });
    const result = evaluateToolPolicy(ctx, []);

    expect(result.finalVerdict).toBe('require-approval');
    // 9단계 모두 실행됨 (deny로 중단되지 않았으므로)
    expect(result.stageResults).toHaveLength(9);
  });

  it('deny가 require-approval보다 우선한다', () => {
    const ctx = makeCtx({
      toolDefinition: {
        name: 'finance:trade',
        description: 'Trade',
        inputSchema: {},
        group: 'finance',
        requiresApproval: false,
        isTransactional: true,
        accessesSensitiveData: false,
      } as RegisteredToolDefinition,
    });
    const rules: PolicyRule[] = [
      { pattern: 'finance:trade', verdict: 'deny', reason: 'Blocked', priority: 100 },
    ];
    const result = evaluateToolPolicy(ctx, rules);

    expect(result.finalVerdict).toBe('deny');
  });
});
```

검증: `pnpm test -- packages/agent/test/tool-policy.test.ts`

---

### - [ ] Step 11: result-guard.test.ts

파일: `packages/agent/test/result-guard.test.ts`

```typescript
import { describe, it, expect } from 'vitest';

import {
  guardToolResult,
  FINANCIAL_REDACT_PATTERNS,
  type ResultGuardOptions,
} from '../src/agents/tools/result-guard.js';

const defaultOptions: ResultGuardOptions = {
  maxContentLength: 100_000,
  redactPatterns: [],
  allowHtml: false,
  redactFinancialData: true,
};

describe('guardToolResult', () => {
  it('null 결과를 "[No result returned]"으로 대체한다', () => {
    const result = guardToolResult(null, defaultOptions);

    expect(result.content).toBe('[No result returned]');
    expect(result.isError).toBe(false);
    expect(result.originalSize).toBe(0);
  });

  it('undefined 결과를 "[No result returned]"으로 대체한다', () => {
    const result = guardToolResult(undefined, defaultOptions);

    expect(result.content).toBe('[No result returned]');
  });

  it('정상 결과를 그대로 통과시킨다', () => {
    const result = guardToolResult({ content: 'hello', isError: false }, defaultOptions);

    expect(result.content).toBe('hello');
    expect(result.isError).toBe(false);
    expect(result.wasTruncated).toBe(false);
    expect(result.wasRedacted).toBe(false);
    expect(result.originalSize).toBe(5);
    expect(result.guardedSize).toBe(5);
  });

  it('maxContentLength 초과 시 truncation한다', () => {
    const longContent = 'x'.repeat(200);
    const result = guardToolResult(
      { content: longContent, isError: false },
      { ...defaultOptions, maxContentLength: 100 },
    );

    expect(result.wasTruncated).toBe(true);
    expect(result.content).toContain('[truncated]');
    expect(result.originalSize).toBe(200);
  });

  it('카드번호를 마스킹한다', () => {
    const result = guardToolResult(
      { content: 'Card: 4111-1111-1111-1111', isError: false },
      defaultOptions,
    );

    expect(result.wasRedacted).toBe(true);
    expect(result.content).not.toContain('4111');
    expect(result.content).toContain('[REDACTED]');
  });

  it('SSN을 마스킹한다', () => {
    const result = guardToolResult({ content: 'SSN: 123-45-6789', isError: false }, defaultOptions);

    expect(result.wasRedacted).toBe(true);
    expect(result.content).toContain('[REDACTED]');
  });

  it('redactFinancialData=false이면 금융 데이터를 마스킹하지 않는다', () => {
    const result = guardToolResult(
      { content: 'Card: 4111-1111-1111-1111', isError: false },
      { ...defaultOptions, redactFinancialData: false },
    );

    expect(result.wasRedacted).toBe(false);
    expect(result.content).toContain('4111');
  });

  it('사용자 정의 redact 패턴을 적용한다', () => {
    const result = guardToolResult(
      { content: 'API key: sk-1234abcd', isError: false },
      { ...defaultOptions, redactPatterns: [/sk-[a-zA-Z0-9]+/g] },
    );

    expect(result.wasRedacted).toBe(true);
    expect(result.content).not.toContain('sk-1234abcd');
  });

  it('allowHtml=false이면 HTML 태그를 제거한다', () => {
    const result = guardToolResult(
      { content: '<b>bold</b> <script>alert(1)</script>', isError: false },
      defaultOptions,
    );

    expect(result.content).not.toContain('<b>');
    expect(result.content).not.toContain('<script>');
    expect(result.content).toContain('bold');
  });

  it('allowHtml=true이면 HTML 태그를 유지한다', () => {
    const result = guardToolResult(
      { content: '<b>bold</b>', isError: false },
      { ...defaultOptions, allowHtml: true },
    );

    expect(result.content).toContain('<b>');
  });

  it('JSON 제어 문자를 제거한다 (탭/개행은 유지)', () => {
    const result = guardToolResult(
      { content: 'hello\u0000\tworld\nfoo\u0001bar', isError: false },
      { ...defaultOptions, redactFinancialData: false },
    );

    expect(result.content).toBe('hello\tworld\nfoobar');
  });
});

describe('FINANCIAL_REDACT_PATTERNS', () => {
  it('3종의 패턴이 정의되어 있다', () => {
    expect(FINANCIAL_REDACT_PATTERNS).toHaveLength(3);
  });
});
```

검증: `pnpm test -- packages/agent/test/result-guard.test.ts`

---

## 최종 검증

```bash
# 전체 타입 체크
pnpm typecheck

# todo-1 테스트 실행
pnpm test -- packages/agent/test/tool-groups.test.ts packages/agent/test/tool-registry.test.ts packages/agent/test/tool-policy.test.ts packages/agent/test/result-guard.test.ts

# 린트 (선택)
pnpm lint
```

### 체크리스트 요약

| #   | 파일                                                                         | 유형              |
| --- | ---------------------------------------------------------------------------- | ----------------- |
| 0   | `packages/agent/package.json`                                                | 수정 (zod 추가)   |
| 1   | `packages/infra/src/events.ts`                                               | 수정 (이벤트 9종) |
| 2   | `packages/types/src/plugin.ts` + `packages/server/src/plugins/hook-types.ts` | 수정 (훅 2종)     |
| 3   | `packages/agent/src/agents/tools/groups.ts`                                  | 생성              |
| 4   | `packages/agent/src/agents/tools/registry.ts`                                | 생성              |
| 5   | `packages/agent/src/agents/tools/policy.ts`                                  | 생성              |
| 6   | `packages/agent/src/agents/tools/result-guard.ts`                            | 생성              |
| 7   | `packages/agent/src/agents/tools/index.ts`                                   | 생성              |
| 8   | `packages/agent/test/tool-groups.test.ts`                                    | 생성              |
| 9   | `packages/agent/test/tool-registry.test.ts`                                  | 생성              |
| 10  | `packages/agent/test/tool-policy.test.ts`                                    | 생성              |
| 11  | `packages/agent/test/result-guard.test.ts`                                   | 생성              |
