# Phase 30 Todo: 관찰성 · 감사 가능성 산업 표준화

> [plan.md](../../plans/phase30/plan.md) 의 4 트랙(A·B·C·D) 을 코드 단위로 분해한 작업 가이드.
> 권장 순서: **트랙 A → C → B → D** (의존: C/D 가 A 의 trace_id / withSpan helper 사용, 스키마 v7→v8(A)→v9(C)→v10(D) 순차).
> 각 트랙은 같은 PR 에 묶지 말 것 — 마이그레이션 단계 분리.
>
> 브랜치: `feature/observability` (현재 브랜치 유지, 신규 브랜치 생성 X)
> 시작 SHA: `ab729b6` (Phase 29 종료 직후)

---

## 사전 준비

### P-1. 작업 트리 / dev DB 백업

```sh
git status                              # clean working tree
git rev-parse HEAD                      # ab729b6 확인

# Phase 30 = v7 → v10 (3 단계) 마이그레이션 — dev DB 백업 필수
DEV_DB="${HOME}/.finclaw/db.sqlite"
[ -f "$DEV_DB" ] && cp "$DEV_DB" "${DEV_DB}.pre-phase30.bak" && echo "backed up to ${DEV_DB}.pre-phase30.bak"

# 감사 결과 백업 (Phase 30 종료 후 비교용; 디렉터리 미존재면 skip)
[ -d _workspace/audit ] && mv _workspace/audit _workspace/audit_phase30_start || true
```

### P-2. 사용자 결정 사항 — 모두 기본값으로 확정 (재확인용)

- (A) OTel backend: **자체 web 뷰만 1차** — OTel SDK 표준 export 인터페이스 유지하되 collector 미연결
- (A) trace ID 형식: **W3C Trace Context** (32 hex traceId, 16 hex spanId)
- (B) structured output 강제 도구 범위: **analysis 역할 도구만** 1차 (fetch/chat/summarize 자유 텍스트 유지)
- (C) access-log retention: **30일** 기본 (`accessLog.retentionDays` config 키로 override)
- (D) re-ranker: **로컬 cross-encoder ONNX** (`Xenova/bge-reranker-v2-m3` 또는 `Xenova/jina-reranker-v2-base-multilingual`). 외부 키 없이 mock fallback 강제.

---

## 밀스톤 A — OpenTelemetry trace + span tree + web 뷰 (스키마 v7 → v8)

> plan.md 트랙 A 전체. 먼저 완료 — C/D 가 trace_id 형식·withSpan helper 에 의존.

### A1. EDIT `packages/server/package.json` — OTel SDK 의존 추가

```sh
pnpm add @opentelemetry/api @opentelemetry/sdk-trace-base --filter @finclaw/server
```

`@opentelemetry/sdk-node` 는 미사용 — Node 자동 instrumentation 비대상. plan.md 의 자체 web 뷰 1차 정책에 부합.

검증: `pnpm install --frozen-lockfile=false` 후 `pnpm format:fix` (oxfmt 가 package.json 키 재정렬).

### A2. CREATE `packages/types/src/trace.ts` — TraceContext / SpanRecord 타입 정의

```ts
// W3C Trace Context — 32 hex traceId, 16 hex spanId
export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
}

export type SpanKind = 'internal' | 'client' | 'server' | 'producer' | 'consumer';
export type SpanStatus = 'unset' | 'ok' | 'error';

export interface SpanEvent {
  readonly name: string;
  readonly ts: bigint;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface SpanRecord {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: SpanKind;
  readonly startNs: bigint;
  readonly endNs?: bigint;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly events: readonly SpanEvent[];
  readonly status: SpanStatus;
  readonly statusMessage?: string;
}
```

EDIT `packages/types/src/index.ts` — re-export 추가:

```ts
export * from './trace.js';
```

검증: `pnpm typecheck`.

### A3. EDIT `packages/storage/src/database.ts` — SCHEMA_VERSION v7 → v8 + spans 테이블

`SCHEMA_VERSION` 상수 변경:

```ts
const SCHEMA_VERSION = 8;
```

`SCHEMA_DDL` 끝(`agent_runs` 인덱스 이후) 에 `spans` 테이블 + `agent_runs` 신규 컬럼 (fresh DB 용) 추가:

```sql
-- Phase 30 A3: agent_runs trace 컬럼 (fresh DB)
-- 기존 v5 DB 의 ALTER 는 MIGRATIONS[8] 에서 수행.

CREATE TABLE IF NOT EXISTS spans (
  trace_id        TEXT NOT NULL,
  span_id         TEXT NOT NULL PRIMARY KEY,
  parent_span_id  TEXT,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  start_ns        INTEGER NOT NULL,
  end_ns          INTEGER,
  attributes      TEXT NOT NULL DEFAULT '{}',
  events          TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'unset',
  status_message  TEXT
);
CREATE INDEX IF NOT EXISTS idx_spans_trace_start ON spans(trace_id, start_ns);
```

`agent_runs` `CREATE TABLE` 에 `trace_id TEXT`, `parent_span_id TEXT` 컬럼 추가 + `CREATE INDEX IF NOT EXISTS idx_agent_runs_trace_id ON agent_runs(trace_id);` (fresh DB 경로).

`MIGRATIONS` 객체에 v8 추가 (기존 v7 함수형 마이그레이션 패턴 그대로):

```ts
  // Phase 30 A3: agent_runs.trace_id / parent_span_id + spans 테이블
  8: (db: DatabaseSync) => {
    const cols = db.prepare(`PRAGMA table_info('agent_runs')`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'trace_id')) {
      db.exec(`ALTER TABLE agent_runs ADD COLUMN trace_id TEXT;`);
    }
    if (!cols.some((c) => c.name === 'parent_span_id')) {
      db.exec(`ALTER TABLE agent_runs ADD COLUMN parent_span_id TEXT;`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_runs_trace_id ON agent_runs(trace_id);`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS spans (
        trace_id        TEXT NOT NULL,
        span_id         TEXT NOT NULL PRIMARY KEY,
        parent_span_id  TEXT,
        name            TEXT NOT NULL,
        kind            TEXT NOT NULL,
        start_ns        INTEGER NOT NULL,
        end_ns          INTEGER,
        attributes      TEXT NOT NULL DEFAULT '{}',
        events          TEXT NOT NULL DEFAULT '[]',
        status          TEXT NOT NULL DEFAULT 'unset',
        status_message  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_spans_trace_start ON spans(trace_id, start_ns);
    `);
  },
```

EDIT `packages/storage/src/database.migration.storage.test.ts` — v7→v8 시뮬레이션 추가 (기존 v6→v7 케이스와 동일한 패턴).

검증: `pnpm test:storage -- database.migration`.

### A4. CREATE `packages/storage/src/spans.ts` — addSpan / listSpansByTrace / getSpanTree

```ts
import type { DatabaseSync } from 'node:sqlite';
import type { SpanRecord, SpanEvent } from '@finclaw/types';

export interface SpanRow {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  start_ns: number; // SQLite INTEGER (8-byte) — ns 안전 범위
  end_ns: number | null;
  attributes: string;
  events: string;
  status: string;
  status_message: string | null;
}

export interface SpanTreeNode extends SpanRecord {
  readonly children: readonly SpanTreeNode[];
}

function rowToSpan(row: SpanRow): SpanRecord {
  return {
    traceId: row.trace_id,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id ?? undefined,
    name: row.name,
    kind: row.kind as SpanRecord['kind'],
    startNs: BigInt(row.start_ns),
    endNs: row.end_ns === null ? undefined : BigInt(row.end_ns),
    attributes: JSON.parse(row.attributes) as Record<string, unknown>,
    events: JSON.parse(row.events) as readonly SpanEvent[],
    status: row.status as SpanRecord['status'],
    statusMessage: row.status_message ?? undefined,
  };
}

export function addSpan(db: DatabaseSync, span: SpanRecord): void {
  db.prepare(
    `INSERT OR REPLACE INTO spans
     (trace_id, span_id, parent_span_id, name, kind, start_ns, end_ns, attributes, events, status, status_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    span.traceId,
    span.spanId,
    span.parentSpanId ?? null,
    span.name,
    span.kind,
    Number(span.startNs),
    span.endNs === undefined ? null : Number(span.endNs),
    JSON.stringify(span.attributes),
    JSON.stringify(span.events),
    span.status,
    span.statusMessage ?? null,
  );
}

export function listSpansByTrace(db: DatabaseSync, traceId: string): SpanRecord[] {
  const rows = db
    .prepare('SELECT * FROM spans WHERE trace_id = ? ORDER BY start_ns ASC')
    .all(traceId) as unknown as SpanRow[];
  return rows.map(rowToSpan);
}

export function getSpanTree(db: DatabaseSync, traceId: string): SpanTreeNode[] {
  const spans = listSpansByTrace(db, traceId);
  const byId = new Map<string, SpanRecord & { children: SpanTreeNode[] }>();
  for (const s of spans) {
    byId.set(s.spanId, { ...s, children: [] });
  }
  const roots: SpanTreeNode[] = [];
  for (const node of byId.values()) {
    if (node.parentSpanId && byId.has(node.parentSpanId)) {
      byId.get(node.parentSpanId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
```

EDIT `packages/storage/src/index.ts` — `export * from './spans.js';` 추가.

검증: `pnpm typecheck`.

### A5. CREATE `packages/server/src/observability/tracer.ts` — withSpan helper + SQLite exporter

> OTel API 의 `Tracer` 를 SQLite span exporter 로 wrap. PII redact 는 attributes string 값에 적용.

```ts
import { trace, context, SpanStatusCode, type Span } from '@opentelemetry/api';
import type { DatabaseSync } from 'node:sqlite';
import type { TraceContext, SpanKind, SpanRecord } from '@finclaw/types';
import { addSpan } from '@finclaw/storage';
import { redactPII } from './redact.js';

export interface FinclawTracer {
  withSpan<T>(
    name: string,
    attrs: Readonly<Record<string, unknown>>,
    fn: (ctx: TraceContext) => Promise<T>,
  ): Promise<T>;
  /** 현재 active context 의 traceId/spanId 반환 (없으면 undefined). */
  getCurrentContext(): TraceContext | undefined;
}

export interface CreateTracerOptions {
  readonly db: DatabaseSync;
  readonly serviceName?: string;
  readonly defaultKind?: SpanKind;
}

export function createTracer(options: CreateTracerOptions): FinclawTracer {
  const otelTracer = trace.getTracer(options.serviceName ?? 'finclaw');
  const defaultKind: SpanKind = options.defaultKind ?? 'internal';

  return {
    async withSpan(name, attrs, fn) {
      const redactedAttrs = redactPII(attrs);
      return otelTracer.startActiveSpan(name, async (span: Span) => {
        const startNs = process.hrtime.bigint();
        const ctx = span.spanContext();
        const traceCtx: TraceContext = {
          traceId: ctx.traceId,
          spanId: ctx.spanId,
        };
        for (const [k, v] of Object.entries(redactedAttrs)) {
          span.setAttribute(k, v as never);
        }
        try {
          const result = await fn(traceCtx);
          span.setStatus({ code: SpanStatusCode.OK });
          finalizeSpan(options.db, span, name, defaultKind, redactedAttrs, startNs, 'ok');
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message });
          finalizeSpan(
            options.db,
            span,
            name,
            defaultKind,
            redactedAttrs,
            startNs,
            'error',
            message,
          );
          throw err;
        } finally {
          span.end();
        }
      });
    },
    getCurrentContext() {
      const span = trace.getActiveSpan();
      if (!span) return undefined;
      const c = span.spanContext();
      return { traceId: c.traceId, spanId: c.spanId };
    },
  };
}

function finalizeSpan(
  db: DatabaseSync,
  span: Span,
  name: string,
  kind: SpanKind,
  attributes: Readonly<Record<string, unknown>>,
  startNs: bigint,
  status: 'ok' | 'error',
  message?: string,
): void {
  const ctx = span.spanContext();
  const endNs = process.hrtime.bigint();
  const record: SpanRecord = {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: undefined, // OTel API 가 직접 노출하지 않음 — 활성 컨텍스트는 startActiveSpan 내부 push 로 관리
    name,
    kind,
    startNs,
    endNs,
    attributes,
    events: [],
    status,
    statusMessage: message,
  };
  addSpan(db, record);
}
```

> NOTE: `parent_span_id` 부착이 필요하면 OTel `context.active()` 에서 직전 span 을 추출하는 별도 wrapper 가 필요. 본 1차 구현은 traceId 만 끝까지 동일하게 묶고, parent 링크는 A6/A7 에서 ctx 전파로 보강.

CREATE `packages/server/src/observability/redact.ts`:

```ts
const PATTERNS: Array<[RegExp, string]> = [
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]'],
  [/\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g, '[REDACTED_PHONE]'],
];

export function redactPII<T>(value: T): T {
  if (typeof value === 'string') {
    let out = value;
    for (const [re, sub] of PATTERNS) out = out.replace(re, sub);
    return out as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => redactPII(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactPII(v);
    return out as unknown as T;
  }
  return value;
}
```

검증: `pnpm typecheck`.

### A6. EDIT `packages/server/src/auto-reply/pipeline.ts` — 각 stage 진입 시 withSpan + ctx 전파

`PipelineContext` 인터페이스 (대개 `pipeline-context.ts`) 에 `traceContext?: TraceContext` 추가.

pipeline 이 stage 를 순회하는 루프에서:

```ts
// 기존:
//   await stage.process(ctx);
// 변경 후:
await tracer.withSpan(`stage.${stage.name}`, { sessionKey: ctx.sessionKey }, async (traceCtx) => {
  ctx.traceContext = traceCtx;
  await stage.process(ctx);
});
```

생성자/팩토리에 `tracer: FinclawTracer` 주입 추가. main.ts 에서 `createTracer({ db })` 호출하여 전달.

검증: `pnpm typecheck && pnpm test --run --filter @finclaw/server -- auto-reply/pipeline`.

### A7. EDIT `packages/agent/src/execution/runner.ts` — turn / provider / tool span 부여

각 agent turn 마다:

```ts
// turn 루프 진입부 (의사 코드)
return tracer.withSpan('agent.turn', { turn, agentId }, async () => {
  const stream = await tracer.withSpan(
    'provider.stream',
    { provider: provider.id, model: model.id },
    () => provider.streamCompletion(...),
  );
  // ...
  for (const call of toolCalls) {
    await tracer.withSpan(
      `tool.execute.${call.name}`,
      { input: call.input /* tracer 가 PII redact */ },
      () => toolExecutor.execute(call),
    );
  }
});
```

> 주의: agent 패키지는 server 의 tracer 에 직접 의존하면 역방향. `FinclawTracer` 인터페이스를 `@finclaw/types` 로 옮기거나, runner 가 옵셔널 콜백 타입만 받게 한다. 본 plan 은 후자 — runner 가 `tracer?: { withSpan: ... }` 옵션을 받음.

`packages/agent/src/execution/runner.ts` 의 RunnerOptions:

```ts
export interface RunnerOptions {
  // ... 기존
  readonly tracer?: {
    withSpan<T>(
      name: string,
      attrs: Readonly<Record<string, unknown>>,
      fn: () => Promise<T>,
    ): Promise<T>;
  };
}
```

main.ts 에서 server 의 `FinclawTracer` 를 어댑터 형태로 (ctx 인자 무시) 전달.

검증: `pnpm typecheck && pnpm test --run --filter @finclaw/agent`.

### A8. EDIT `packages/storage/src/agent-runs.ts` — trace_id / parent_span_id 컬럼 처리

`AgentRunRow` 에 컬럼 추가:

```ts
export interface AgentRunRow {
  // ... 기존
  trace_id: string | null;
  parent_span_id: string | null;
}
```

`AddAgentRunInput` 에 추가:

```ts
export interface AddAgentRunInput {
  // ... 기존
  traceId?: string;
  parentSpanId?: string;
}
```

`addAgentRun` INSERT SQL 의 컬럼 리스트와 VALUES 에 `trace_id`, `parent_span_id` 추가 (현재 14개 → 16개):

```ts
db.prepare(
  `INSERT INTO agent_runs
   (id, agent_id, prompt, output, tool_calls_json, tokens_input, tokens_output,
    duration_ms, model_used, role, memory_id, used_memory_ids, error, created_at,
    trace_id, parent_span_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  // ... 기존 14개
  input.traceId ?? null,
  input.parentSpanId ?? null,
);
```

`rowToAgentRun` 에 mapping 추가. `AgentRun` 타입(`packages/types/src/agent.ts`) 에도 `traceId?`, `parentSpanId?` 추가.

`getAgentRun` — 옵션 인자로 spans 동시 반환 (옵션):

```ts
export function getAgentRun(
  db: DatabaseSync,
  id: string,
  opts?: { withSpans?: boolean },
): (AgentRun & { spans?: SpanRecord[] }) | null { ... }
```

검증: `pnpm typecheck && pnpm test --run --filter @finclaw/storage -- agent-runs`.

### A9. CREATE `packages/server/src/gateway/rpc/methods/trace.ts` — trace.get / trace.list RPC

```ts
import { z } from 'zod';
import { listSpansByTrace, getSpanTree, listAgentRuns } from '@finclaw/storage';
// existing pattern: import method type / registry helper

export const traceGetParams = z.object({ traceId: z.string().length(32) });
export const traceListParams = z.object({
  since: z.number().optional(),
  limit: z.number().min(1).max(200).default(50),
});

export const traceMethods = {
  'trace.get': {
    params: traceGetParams,
    authLevel: 'token' as const,
    handler: async (params: z.infer<typeof traceGetParams>, ctx: RpcContext) => {
      const spans = listSpansByTrace(ctx.db.db, params.traceId);
      const tree = getSpanTree(ctx.db.db, params.traceId);
      const runs = ctx.db.db
        .prepare('SELECT * FROM agent_runs WHERE trace_id = ? ORDER BY created_at ASC')
        .all(params.traceId);
      return { traceId: params.traceId, spans, tree, agentRuns: runs };
    },
  },
  'trace.list': {
    params: traceListParams,
    authLevel: 'token' as const,
    handler: async (params: z.infer<typeof traceListParams>, ctx: RpcContext) => {
      // 최근 trace = spans 의 distinct trace_id (start_ns DESC 1행씩)
      const since = params.since ?? 0;
      const rows = ctx.db.db
        .prepare(
          `SELECT trace_id, MIN(start_ns) AS first_ns, MAX(end_ns) AS last_ns, MIN(name) AS root_name
             FROM spans
             WHERE start_ns >= ?
             GROUP BY trace_id
             ORDER BY first_ns DESC
             LIMIT ?`,
        )
        .all(since * 1_000_000, params.limit);
      return { traces: rows };
    },
  },
};
```

EDIT `packages/server/src/gateway/registry.ts` (또는 RPC method 등록 위치) — `traceMethods` 를 등록 테이블에 추가.

검증: `pnpm typecheck`.

### A10. EDIT `packages/types/src/gateway.ts` — RPC 응답 Zod schema

```ts
import { z } from 'zod';

export const SpanRecordSchema = z.object({
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  kind: z.enum(['internal', 'client', 'server', 'producer', 'consumer']),
  startNs: z.bigint(),
  endNs: z.bigint().optional(),
  attributes: z.record(z.string(), z.unknown()),
  events: z.array(
    z.object({
      name: z.string(),
      ts: z.bigint(),
      attributes: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  status: z.enum(['unset', 'ok', 'error']),
  statusMessage: z.string().optional(),
});

export const TraceGetResultSchema = z.object({
  traceId: z.string(),
  spans: z.array(SpanRecordSchema),
  tree: z.array(z.unknown()), // 재귀 트리는 lazy 로 별도 정의
  agentRuns: z.array(z.unknown()),
});

export const TraceListResultSchema = z.object({
  traces: z.array(
    z.object({
      trace_id: z.string(),
      first_ns: z.number(),
      last_ns: z.number().nullable(),
      root_name: z.string(),
    }),
  ),
});
```

검증: `pnpm typecheck`.

### A11. CREATE `packages/web/src/views/trace-view.ts` — trace 목록 + span tree

```ts
// 좌측: trace 목록 (시간 desc, traceId, root span name, duration, status)
// 우측: 선택 trace 의 span tree (들여쓰기 트리; 1차는 단순)
// agent_runs detail panel 과 양방향 링크 (있는 화면이면)

import type { AppGateway } from '../app-gateway.js';

export function renderTraceView(root: HTMLElement, gateway: AppGateway): void {
  // 1차: 들여쓰기 텍스트 트리. flame graph 는 D 종료 후 검토.
  // - gateway.trace.list() 호출 → 좌측 목록
  // - 클릭 시 gateway.trace.get(traceId) → 우측 트리
  // - 각 span 노드: name (kind) [duration_ms]   attributes 토글
  // - status='error' 는 빨강
}
```

> 1차 구현은 들여쓰기 트리 + attributes 펼침/접힘 — flame graph 는 비대상 (Phase 31+).

검증: `pnpm typecheck`.

### A12. EDIT `packages/web/src/app-gateway.ts` — trace.\* 래퍼 추가

```ts
// 기존 패턴 따라 (예: agent.* 래퍼 같은 형태)
trace: {
  list: (params: { since?: number; limit?: number }) =>
    this.call('trace.list', params),
  get: (traceId: string) =>
    this.call('trace.get', { traceId }),
},
```

검증: `pnpm typecheck`.

### A13. CREATE `packages/storage/src/spans.test.ts` — tree 구성 / 시간 정렬

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  openDatabase,
  addSpan,
  listSpansByTrace,
  getSpanTree,
  type Database,
} from '../src/index.js';

describe('spans storage', () => {
  let db: Database;
  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
  });

  it('builds parent-child tree from flat list', () => {
    const traceId = 'a'.repeat(32);
    const root = {
      traceId,
      spanId: 'r'.repeat(16),
      name: 'root',
      kind: 'internal' as const,
      startNs: 1n,
      endNs: 100n,
      attributes: {},
      events: [],
      status: 'ok' as const,
    };
    const child = {
      traceId,
      spanId: 'c'.repeat(16),
      parentSpanId: 'r'.repeat(16),
      name: 'child',
      kind: 'internal' as const,
      startNs: 10n,
      endNs: 50n,
      attributes: {},
      events: [],
      status: 'ok' as const,
    };
    addSpan(db.db, root);
    addSpan(db.db, child);

    const tree = getSpanTree(db.db, traceId);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].name).toBe('child');
  });

  it('orders by start_ns ASC', () => {
    // ... 3 개 삽입 후 listSpansByTrace 가 시간순 반환 검증
  });
});
```

검증: `pnpm test:storage -- spans`.

### A14. CREATE `packages/server/test/observability/tracer.test.ts` — withSpan 중첩 / error / redact

```ts
import { describe, it, expect } from 'vitest';
import { openDatabase } from '@finclaw/storage';
import { createTracer } from '../../src/observability/tracer.js';
import { redactPII } from '../../src/observability/redact.js';

describe('tracer.withSpan', () => {
  it('nests child spans under parent traceId', async () => {
    const db = openDatabase({ path: ':memory:' });
    const tracer = createTracer({ db: db.db });
    let innerCtx: { traceId: string; spanId: string } | undefined;
    await tracer.withSpan('parent', {}, async () => {
      await tracer.withSpan('child', {}, async (ctx) => {
        innerCtx = ctx;
      });
    });
    expect(innerCtx?.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('marks span status=error on throw', async () => {
    const db = openDatabase({ path: ':memory:' });
    const tracer = createTracer({ db: db.db });
    await expect(
      tracer.withSpan('boom', {}, async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow();
    const rows = db.db.prepare('SELECT status, status_message FROM spans').all();
    expect(rows[0]).toMatchObject({ status: 'error', status_message: 'x' });
  });
});

describe('redactPII', () => {
  it('redacts email / phone / ssn in nested attributes', () => {
    const out = redactPII({ note: 'mail me at foo@bar.com or 010-1234-5678', ssn: '123-45-6789' });
    expect(out).toEqual({
      note: 'mail me at [REDACTED_EMAIL] or [REDACTED_PHONE]',
      ssn: '[REDACTED_SSN]',
    });
  });
});
```

검증: `pnpm test --run --filter @finclaw/server -- observability`.

### A15. CREATE `packages/server/test/auto-reply/trace.e2e.test.ts` — Discord 메시지 1개 → span tree 7+ 노드

```ts
// mock Discord 메시지 1개 → pipeline 전체 실행
// 종료 후:
//   - agent_runs.trace_id 가 set
//   - spans 테이블에 stage 7개 + agent.turn + provider.stream + tool.execute.* (depth ≥ 3)
//   - trace.get(traceId) RPC 호출 → tree 반환
```

검증: `pnpm test --run --filter @finclaw/server -- auto-reply/trace.e2e`.

### A16. 밀스톤 A 검증

다음을 모두 통과해야 다음 밀스톤으로:

```sh
pnpm typecheck
pnpm lint
pnpm test:storage -- 'spans|database.migration'
pnpm test --run --filter @finclaw/server -- 'observability|auto-reply'
pnpm test --run --filter @finclaw/agent
```

plan.md A 완료 조건:

- `agent_runs` 의 모든 새 row 에 `trace_id` non-null
- `spans` 테이블에 stage 7개 + turn N개 + tool M개 모두 기록 (depth ≥ 3)
- web/trace-view 에서 trace 1개 클릭 → span tree 시각화 (수동)
- attributes JSON 에서 PII 패턴 (이메일/전화/SSN) redact 검증 unit test 통과 (A14)

커밋: `feat(server): wire OTel tracer + spans table + trace.* RPC + web/trace-view (Phase 30 A)`

---

## 밀스톤 C — Access-log SQLite + web 뷰 (스키마 v8 → v9)

> plan.md 트랙 C 전체. A 의 trace_id 형식을 사용하므로 A 종료 후 진입.

### C1. EDIT `packages/storage/src/database.ts` — SCHEMA_VERSION v8 → v9 + access_log 테이블

`SCHEMA_VERSION = 9` 로 변경.

`SCHEMA_DDL` 끝에 추가 (fresh DB 용):

```sql
CREATE TABLE IF NOT EXISTS access_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  method       TEXT NOT NULL,
  params_hash  TEXT NOT NULL,
  actor        TEXT,
  ip           TEXT,
  duration_ms  INTEGER NOT NULL,
  status       TEXT NOT NULL,
  error        TEXT,
  trace_id     TEXT
);
CREATE INDEX IF NOT EXISTS idx_access_log_ts ON access_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_access_log_method_ts ON access_log(method, ts DESC);
```

`MIGRATIONS[9]` 추가:

```ts
  9: `
    CREATE TABLE IF NOT EXISTS access_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           INTEGER NOT NULL,
      method       TEXT NOT NULL,
      params_hash  TEXT NOT NULL,
      actor        TEXT,
      ip           TEXT,
      duration_ms  INTEGER NOT NULL,
      status       TEXT NOT NULL,
      error        TEXT,
      trace_id     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_access_log_ts ON access_log(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_access_log_method_ts ON access_log(method, ts DESC);
  `,
```

EDIT `packages/storage/src/database.migration.storage.test.ts` — v8→v9 케이스 추가.

검증: `pnpm test:storage -- database.migration`.

### C2. CREATE `packages/storage/src/access-log.ts` — addAccessLog / listAccessLog / purgeAccessLog

```ts
import type { DatabaseSync } from 'node:sqlite';

export interface AccessLogEntry {
  readonly id?: number;
  readonly ts: number;
  readonly method: string;
  readonly paramsHash: string;
  readonly actor?: string;
  readonly ip?: string;
  readonly durationMs: number;
  readonly status: string;
  readonly error?: string;
  readonly traceId?: string;
}

interface AccessLogRow {
  id: number;
  ts: number;
  method: string;
  params_hash: string;
  actor: string | null;
  ip: string | null;
  duration_ms: number;
  status: string;
  error: string | null;
  trace_id: string | null;
}

function rowTo(row: AccessLogRow): AccessLogEntry {
  return {
    id: row.id,
    ts: row.ts,
    method: row.method,
    paramsHash: row.params_hash,
    actor: row.actor ?? undefined,
    ip: row.ip ?? undefined,
    durationMs: row.duration_ms,
    status: row.status,
    error: row.error ?? undefined,
    traceId: row.trace_id ?? undefined,
  };
}

export function addAccessLog(db: DatabaseSync, entry: AccessLogEntry): void {
  db.prepare(
    `INSERT INTO access_log (ts, method, params_hash, actor, ip, duration_ms, status, error, trace_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.ts,
    entry.method,
    entry.paramsHash,
    entry.actor ?? null,
    entry.ip ?? null,
    entry.durationMs,
    entry.status,
    entry.error ?? null,
    entry.traceId ?? null,
  );
}

export interface ListAccessLogOptions {
  readonly since?: number;
  readonly limit?: number; // default 100, max 500
  readonly method?: string;
  readonly actor?: string;
  readonly status?: string;
}

export function listAccessLog(db: DatabaseSync, opts: ListAccessLogOptions = {}): AccessLogEntry[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (opts.since !== undefined) {
    clauses.push('ts >= ?');
    params.push(opts.since);
  }
  if (opts.method) {
    clauses.push('method = ?');
    params.push(opts.method);
  }
  if (opts.actor) {
    clauses.push('actor = ?');
    params.push(opts.actor);
  }
  if (opts.status) {
    clauses.push('status = ?');
    params.push(opts.status);
  }

  let sql = 'SELECT * FROM access_log';
  if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
  sql += ' ORDER BY ts DESC LIMIT ?';
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as unknown as AccessLogRow[];
  return rows.map(rowTo);
}

/** olderThanDays 보다 오래된 행을 삭제. 삭제된 행 수 반환. */
export function purgeAccessLog(db: DatabaseSync, olderThanDays: number): number {
  const threshold = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const result = db.prepare('DELETE FROM access_log WHERE ts < ?').run(threshold);
  return Number(result.changes);
}
```

EDIT `packages/storage/src/index.ts` — `export * from './access-log.js';`.

검증: `pnpm typecheck`.

### C3. EDIT `packages/server/src/gateway/access-log.ts` — stdout 외 SQLite 동시 기록

> 현재 `createAccessLogger(writer)` 는 단일 LogWriter 받음. **외과적 변경**: stdout writer 는 그대로 유지하고, 옵셔널로 SQLite writer 를 추가 인자로 받음. 기존 호출자(main.ts) 만 인자 추가.

```ts
import { createHash } from 'node:crypto';
import { addAccessLog, type AccessLogEntry as DbEntry } from '@finclaw/storage';
import type { DatabaseSync } from 'node:sqlite';
// ... 기존 import

export interface AccessLoggerOptions {
  readonly writer?: LogWriter;
  readonly db?: DatabaseSync;
  /** 현재 active span 의 traceId 를 가져오는 함수 (옵션). */
  readonly getTraceId?: () => string | undefined;
}

export function createAccessLogger(options: AccessLoggerOptions = {}) {
  const writer = options.writer ?? defaultWriter;
  return function logAccess(req, res, extra) {
    // ... 기존 로직
    res.on('finish', () => {
      const entry: AccessLogEntry = {
        /* 기존 그대로 */
      };
      writer(entry);

      // Phase 30 C3: SQLite 동시 기록
      if (options.db) {
        const dbEntry: DbEntry = {
          ts: Date.now(),
          method: extra?.rpcMethod ?? entry.method,
          paramsHash: hashParams(req, extra),
          actor: extra?.authLevel,
          ip: entry.remoteAddress,
          durationMs: entry.durationMs,
          status: String(entry.statusCode),
          traceId: options.getTraceId?.(),
        };
        try {
          addAccessLog(options.db, dbEntry);
        } catch {
          // best-effort — stdout 은 이미 기록됨
        }
      }
    });
    return requestId;
  };
}

function hashParams(req: IncomingMessage, extra?: { rpcMethod?: string }): string {
  // 본 1차 구현: rpcMethod + sanitized URL 의 sha256 (요청 body 는 stream 이라 직접 read 불가)
  const seed = `${extra?.rpcMethod ?? ''}|${sanitizePath(req.url ?? '')}`;
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}
```

EDIT `packages/server/src/main.ts` — `createAccessLogger({ db: storage.db, getTraceId: () => tracer.getCurrentContext()?.traceId })` 로 호출 변경.

검증: `pnpm typecheck && pnpm test --run --filter @finclaw/server -- gateway/access-log`.

### C4. EDIT `packages/server/src/automation/scheduler.ts` — 일 1회 purgeAccessLog 내부 cron

기존 scheduler 등록부에 internal cron 추가:

```ts
// Phase 30 C4: access-log retention purge — 매일 04:00
scheduler.registerInternal({
  id: '__access_log_purge',
  cron: '0 4 * * *',
  handler: () => {
    const days = config.accessLog?.retentionDays ?? 30;
    const removed = purgeAccessLog(db, days);
    console.log(`[access-log] purged ${removed} rows older than ${days}d`);
  },
});
```

EDIT `packages/config/src/...` — `accessLog.retentionDays?: number` (기본 30) config 키 추가. 기존 config schema 확장.

> NOTE: scheduler 의 internal cron API 가 없으면 직접 setInterval 로 24h 주기. plan.md 가 "internal cron" 만 언급하므로 둘 중 더 적은 코드 변경 선택.

검증: `pnpm typecheck && pnpm test --run --filter @finclaw/server -- automation`.

### C5. CREATE `packages/server/src/gateway/rpc/methods/audit.ts` — audit.list RPC

```ts
import { z } from 'zod';
import { listAccessLog } from '@finclaw/storage';

export const auditListParams = z.object({
  since: z.number().optional(),
  limit: z.number().min(1).max(500).default(100),
  method: z.string().optional(),
  actor: z.string().optional(),
  status: z.string().optional(),
});

export const auditMethods = {
  'audit.list': {
    params: auditListParams,
    authLevel: 'token' as const,
    requiredPermission: 'AUDIT_READ' as const,
    handler: async (params: z.infer<typeof auditListParams>, ctx: RpcContext) =>
      listAccessLog(ctx.db.db, params),
  },
};
```

EDIT `packages/server/src/gateway/auth/permissions.ts` (또는 상응) — `AUDIT_READ` enum 추가. 권한 체크 미들웨어가 `requiredPermission` 메타를 읽도록 확장.

EDIT registry — `auditMethods` 등록.

검증: `pnpm typecheck`.

### C6. EDIT `packages/types/src/gateway.ts` — audit.list Zod schema

```ts
export const AccessLogEntrySchema = z.object({
  id: z.number().optional(),
  ts: z.number(),
  method: z.string(),
  paramsHash: z.string(),
  actor: z.string().optional(),
  ip: z.string().optional(),
  durationMs: z.number(),
  status: z.string(),
  error: z.string().optional(),
  traceId: z.string().optional(),
});

export const AuditListResultSchema = z.array(AccessLogEntrySchema);
```

검증: `pnpm typecheck`.

### C7. CREATE `packages/web/src/views/audit-view.ts` — 테이블 + trace 점프

```ts
// 테이블: 시간 / 메서드 / actor / duration / status / trace
// 필터: method (multi-select), actor, 시간 범위, status
// 행 클릭 시 (traceId 있으면) trace-view 점프
// 페이지네이션 (limit=100 default)

import type { AppGateway } from '../app-gateway.js';

export function renderAuditView(root: HTMLElement, gateway: AppGateway): void {
  // 1차: 단순 HTML 테이블 + 4 필터 드롭다운/입력
  // - gateway.audit.list({ limit: 100, ... }) → 행 렌더
  // - tr.onclick: row.traceId 있으면 navigate to trace-view#{traceId}
}
```

검증: `pnpm typecheck`.

### C8. EDIT `packages/web/src/app-gateway.ts` — audit.\* 래퍼

```ts
audit: {
  list: (params: { since?: number; limit?: number; method?: string; actor?: string; status?: string }) =>
    this.call('audit.list', params),
},
```

검증: `pnpm typecheck`.

### C9. CREATE `packages/storage/src/access-log.test.ts` — insert / list / purge

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, addAccessLog, listAccessLog, purgeAccessLog } from '../src/index.js';

describe('access_log storage', () => {
  let db = openDatabase({ path: ':memory:' });
  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
  });

  it('inserts and lists rows by filter', () => {
    addAccessLog(db.db, {
      ts: 1000,
      method: 'system.ping',
      paramsHash: 'h1',
      durationMs: 5,
      status: '200',
    });
    addAccessLog(db.db, {
      ts: 2000,
      method: 'audit.list',
      paramsHash: 'h2',
      durationMs: 10,
      status: '200',
    });
    expect(listAccessLog(db.db, { method: 'audit.list' })).toHaveLength(1);
  });

  it('purges only rows older than retention', () => {
    const now = Date.now();
    addAccessLog(db.db, {
      ts: now - 31 * 24 * 3600 * 1000,
      method: 'a',
      paramsHash: 'h',
      durationMs: 1,
      status: '200',
    });
    addAccessLog(db.db, {
      ts: now - 1 * 24 * 3600 * 1000,
      method: 'b',
      paramsHash: 'h',
      durationMs: 1,
      status: '200',
    });
    expect(purgeAccessLog(db.db, 30)).toBe(1);
    expect(listAccessLog(db.db)).toHaveLength(1);
  });
});
```

검증: `pnpm test:storage -- access-log`.

### C10. EDIT `packages/server/src/gateway/access-log.test.ts` — RPC → SQLite 기록 검증

기존 access-log.test.ts 확장:

```ts
it('writes to SQLite when db option provided', async () => {
  const db = openDatabase({ path: ':memory:' });
  const log = createAccessLogger({ db: db.db, getTraceId: () => 'aa'.repeat(16) });
  // mock req/res 흐름 → finish 발화
  // ...
  const rows = listAccessLog(db.db);
  expect(rows[0]).toMatchObject({ method: 'system.ping', traceId: 'aa'.repeat(16) });
});
```

검증: `pnpm test --run --filter @finclaw/server -- gateway/access-log`.

### C11. 밀스톤 C 검증

```sh
pnpm typecheck && pnpm lint
pnpm test:storage -- 'access-log|database.migration'
pnpm test --run --filter @finclaw/server -- 'gateway/access-log|automation'

# 운영 검증 (수동)
pnpm dev &
for i in {1..50}; do curl -s http://localhost:8787/jsonrpc -d '{"jsonrpc":"2.0","method":"system.ping","id":'"$i"'}' >/dev/null; done
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8787/jsonrpc \
  -d '{"jsonrpc":"2.0","method":"audit.list","params":{"limit":100},"id":1}' | jq '.result | length'
```

plan.md C 완료 조건:

- 모든 RPC 호출이 SQLite `access_log` 에 1행씩 기록 (sampling X)
- `audit.list` 30일 이상 oldest row 미반환 (purge 동작)
- web/audit-view 에서 trace_id 클릭 → trace-view 점프 (수동)

커밋: `feat(storage): access_log table + audit.* RPC + web/audit-view + retention cron (Phase 30 C)`

---

## 밀스톤 B — Structured output 강제 (스키마 변경 없음)

> plan.md 트랙 B 전체. A/C 와 독립 — 스키마 변경 없음. C 와 병렬 가능하지만 권장 순서는 A→C→B→D.

### B1. EDIT `packages/types/src/skill.ts` (또는 `agent/src/agents/tools/registry.ts` 의 ToolDefinition) — outputSchema / enforceStructuredOutput

```ts
// 기존 ToolDefinition / SkillTool 에 추가
export interface ToolDefinition<I = unknown, O = unknown> {
  // ... 기존: id, name, description, inputSchema, role, ...
  readonly outputSchema?: import('zod').ZodType<O>;
  readonly enforceStructuredOutput?: boolean;
}
```

> 위치는 실제 ToolDefinition 정의 위치를 따름 (`packages/agent/src/agents/tools/registry.ts` 의 `ToolDefinition` 또는 `@finclaw/types` 의 SkillTool). 기존 `inputSchema` 옆에 대칭으로 추가.

검증: `pnpm typecheck`.

### B2. EDIT `packages/agent/src/providers/adapter.ts` — forceToolChoice 옵션

```ts
export interface StreamCompletionOptions {
  // ... 기존
  readonly forceToolChoice?: { name: string };
}
```

검증: `pnpm typecheck`.

### B3. EDIT `packages/agent/src/providers/anthropic.ts` — tool_choice 전달

```ts
// streamCompletion 내부에서 request body 빌드 시:
const body = {
  // ... 기존
  ...(options.forceToolChoice
    ? { tool_choice: { type: 'tool', name: options.forceToolChoice.name } }
    : {}),
};
```

검증: `pnpm test --run --filter @finclaw/agent -- providers/anthropic`.

### B4. EDIT `packages/agent/src/providers/openai.ts` — tool_choice 전달 (Phase 29 산출 위)

```ts
const body = {
  // ... 기존
  ...(options.forceToolChoice
    ? { tool_choice: { type: 'function', function: { name: options.forceToolChoice.name } } }
    : {}),
};
```

검증: `pnpm test --run --filter @finclaw/agent -- providers/openai`.

### B5. EDIT `packages/skills-finance/src/{news,market,alerts}/*.ts` — analysis 도구 outputSchema 정의

`analysis` 역할 매핑된 도구들 (Phase 26 이후 정착) 의 정의에 `outputSchema` + `enforceStructuredOutput: true` 추가. 예시:

```ts
// packages/skills-finance/src/news/analyze.ts (예시)
import { z } from 'zod';

const AnalyzeNewsOutput = z.object({
  summary: z.string(),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  topTickers: z.array(z.string()).max(10),
  citationUrls: z.array(z.string().url()).max(20),
});

export const analyzeNewsTool: ToolDefinition = {
  // ... 기존
  role: 'analysis',
  outputSchema: AnalyzeNewsOutput,
  enforceStructuredOutput: true,
};
```

다른 분석 도구 (`analyze_market`, `analyze_portfolio_risk`, `risk_alert` 등 — 기존 정의 위치 확인 후 동일 패턴):

```ts
// market/analyze.ts
const AnalyzeMarketOutput = z.object({
  trend: z.enum(['up', 'down', 'flat']),
  volatility: z.number(),
  drivers: z.array(z.string()).max(10),
});

// alerts/risk.ts
const RiskAlertOutput = z.object({
  riskScore: z.number().min(0).max(100),
  factors: z.array(z.string()),
  recommendation: z.string(),
});
```

> 적용 대상은 실제 `role: 'analysis'` 인 도구만. fetch/chat/summarize 도구는 손대지 않음 (plan.md B 결정).

검증: `pnpm test --run --filter @finclaw/skills-finance`.

### B6. EDIT `packages/agent/src/execution/runner.ts` — forceToolChoice 전달 + outputSchema 검증 + 1회 retry

분석 역할 호출 시:

```ts
// 의사 코드 — 기존 turn 루프 안
const enforceTool = exposedTools.find((t) => t.role === 'analysis' && t.enforceStructuredOutput);
const streamOpts: StreamCompletionOptions = {
  // ... 기존
  forceToolChoice: enforceTool ? { name: enforceTool.name } : undefined,
};

// tool_result 수신 부:
if (toolDef.outputSchema && toolDef.enforceStructuredOutput) {
  const parsed = toolDef.outputSchema.safeParse(toolOutput);
  if (!parsed.success) {
    if (retryCount < 1) {
      retryCount++;
      // 동일 도구 재호출 — 모델에 schema 위반 메시지 다시 전달
      continue;
    }
    throw new StructuredOutputValidationError(toolDef.name, parsed.error);
  }
  toolOutput = parsed.data;
}
```

CREATE `packages/agent/src/errors.ts` 에 `StructuredOutputValidationError` 추가 (또는 기존 errors.ts 에).

검증: `pnpm typecheck && pnpm test --run --filter @finclaw/agent -- execution`.

### B7. EDIT `packages/agent/src/agents/tools/policy.ts` — require-approval 우선 시 enforceStructuredOutput 무시

```ts
// 기존 9-단계 정책 evaluate 함수 끝부분
// Phase 30 B7: require-approval 결정 시 enforceStructuredOutput 도구도 자유 결정 가능
if (decision.kind === 'require-approval' && tool.enforceStructuredOutput) {
  // 정책 우선 — structured output 강제 미적용 표시
  return { ...decision, structuredOutputBypassed: true };
}
```

검증: `pnpm test --run --filter @finclaw/agent -- tools/policy`.

### B8. CREATE `packages/agent/test/providers/structured-output.test.ts` — mock provider

```ts
import { describe, it, expect, vi } from 'vitest';

describe('forceToolChoice in providers', () => {
  it('Anthropic adapter sends tool_choice: { type: "tool", name }', async () => {
    const fetchMock = vi.fn(/* fetch stub returning streaming response */);
    // ... AnthropicAdapter 호출 → fetch body 검사
    expect(fetchMock.mock.calls[0][1].body).toContain(
      '"tool_choice":{"type":"tool","name":"analyze_news"}',
    );
  });

  it('OpenAI adapter sends tool_choice: { type: "function", function: { name } }', async () => {
    // 동일 패턴
  });
});
```

검증: `pnpm test --run --filter @finclaw/agent -- structured-output`.

### B9. CREATE/EDIT `packages/skills-finance/test/analyze-portfolio-risk.test.ts` — outputSchema 검증

```ts
describe('analyze_portfolio_risk outputSchema', () => {
  it('passes valid output', () => {
    const result = analyzePortfolioRiskTool.outputSchema?.safeParse({
      riskScore: 42,
      factors: ['concentration'],
      recommendation: 'diversify',
    });
    expect(result?.success).toBe(true);
  });

  it('rejects invalid output (missing field)', () => {
    const result = analyzePortfolioRiskTool.outputSchema?.safeParse({ riskScore: 42 });
    expect(result?.success).toBe(false);
  });
});
```

> runner 의 1회 retry → 두 번째 실패 시 `StructuredOutputValidationError` 분기는 별도 runner 단위 테스트에서 다룸 (B6 의 단위 테스트 같은 파일 또는 신규).

검증: `pnpm test --run --filter @finclaw/skills-finance`.

### B10. CREATE `packages/server/test/auto-reply/structured-output.e2e.test.ts` — mock 모델로 강제 호출 흐름

```ts
// mock provider 가 analysis role 메시지 ("내 포트폴리오 리스크 분석해줘") 수신
// → forceToolChoice 받아서 analyze_portfolio_risk 호출 → outputSchema 통과
// → 응답 마크다운 렌더링 (mock 결과를 자연어로 변환하는 후처리 stage 통과)
```

검증: `pnpm test --run --filter @finclaw/server -- structured-output`.

### B11. 밀스톤 B 검증

```sh
pnpm typecheck && pnpm lint
pnpm test --run --filter @finclaw/agent -- providers
pnpm test --run --filter @finclaw/skills-finance
pnpm test --run --filter @finclaw/server -- structured-output
```

plan.md B 완료 조건:

- 분석 도구 (`analysis` 역할) N개 모두 `outputSchema` 정의 + `enforceStructuredOutput: true`
- mock test — 잘못된 schema 출력 시 1회 재시도 → 명확한 에러 분류
- e2e — 실제 API 호출 시 도구가 강제 발생, JSON schema 통과 (수동 OPENAI_API_KEY 환경 — CI 비대상)
- 회귀 0 — fetch/chat/summarize 도구 자유 텍스트 유지

커밋: `feat(agent): structured output forceToolChoice + outputSchema validation (Phase 30 B)`

---

## 밀스톤 D — RAG re-ranking (스키마 v9 → v10)

> plan.md 트랙 D 전체. A 의 trace span attributes 와 C 의 access log 모두 활용 — 마지막 진입.

### D1. EDIT `packages/storage/package.json` — ONNX runtime 의존

```sh
pnpm add @huggingface/transformers --filter @finclaw/storage
```

`@huggingface/transformers` (Xenova) 는 ONNX runtime 자체 번들. CPU 추론 충분. `onnxruntime-node` 직접 사용은 1차 비대상 (transformers.js 가 추상화 제공).

검증: `pnpm install --frozen-lockfile=false && pnpm format:fix`.

### D2. CREATE `packages/storage/src/rerank/index.ts` — Reranker 인터페이스

```ts
export interface Reranker {
  readonly id: string;
  /** 점수 배열 (candidates 와 1:1 대응, 높을수록 관련성↑). */
  rerank(query: string, candidates: readonly string[]): Promise<number[]>;
}
```

CREATE `packages/storage/src/rerank/local.ts`:

```ts
import type { Reranker } from './index.js';

export interface LocalRerankerOptions {
  readonly modelId?: string; // default: 'Xenova/bge-reranker-v2-m3'
  readonly cacheDir?: string;
}

export class LocalReranker implements Reranker {
  readonly id: string;
  private pipelinePromise: Promise<unknown> | null = null;

  constructor(private readonly options: LocalRerankerOptions = {}) {
    this.id = options.modelId ?? 'Xenova/bge-reranker-v2-m3';
  }

  async rerank(query: string, candidates: readonly string[]): Promise<number[]> {
    if (!this.pipelinePromise) {
      const { pipeline } = await import('@huggingface/transformers');
      this.pipelinePromise = pipeline('text-classification', this.id, {
        cache_dir: this.options.cacheDir,
      });
    }
    const pipe = (await this.pipelinePromise) as (
      input: unknown,
    ) => Promise<Array<{ score: number }>>;
    const inputs = candidates.map((c) => ({ text: query, text_pair: c }));
    const results = await pipe(inputs);
    return results.map((r) => r.score);
  }
}
```

CREATE `packages/storage/src/rerank/mock.ts`:

```ts
import type { Reranker } from './index.js';

/** 입력 순서를 점수로 보존 (deterministic — 테스트용). */
export class MockReranker implements Reranker {
  readonly id = 'mock-reranker';
  async rerank(_query: string, candidates: readonly string[]): Promise<number[]> {
    return candidates.map((_, i) => candidates.length - i);
  }
}

/** LocalReranker 가 모델 로드 실패 시 fallback. */
export function createRerankerWithFallback(local: Reranker): Reranker {
  return {
    id: local.id,
    async rerank(query, candidates) {
      try {
        return await local.rerank(query, candidates);
      } catch (err) {
        console.warn(`[reranker] ${local.id} failed, falling back to mock:`, err);
        return new MockReranker().rerank(query, candidates);
      }
    },
  };
}
```

EDIT `packages/storage/src/index.ts` — `export * from './rerank/index.js'; export * from './rerank/local.js'; export * from './rerank/mock.js';`.

검증: `pnpm typecheck`.

### D3. EDIT `packages/storage/src/search/hybrid.ts` — topK 옵션 확장 + reranker 통합

`mergeHybridResults` (또는 hybrid search 진입함수) 에 옵션 추가:

```ts
export interface HybridSearchOptions {
  // ... 기존
  readonly reranker?: Reranker;
  readonly topKFirst?: number; // default 10
  readonly topKFinal?: number; // default 3
}

export interface HybridSearchResult {
  readonly chunks: readonly Chunk[];
  // Phase 30 D3: rerank 메타 (호출자가 trace 부착에 사용)
  readonly rerankMeta?: {
    readonly model: string;
    readonly scoresBefore: readonly number[];
    readonly scoresAfter: readonly number[];
    readonly swaps: number;
  };
}

// 본문:
// 1. 기존 hybrid 검색으로 topKFirst (기본 10) 후보 추출
// 2. reranker 미주입 → 상위 topKFinal 만 잘라서 반환 (rerankMeta 없음)
// 3. reranker 주입 → reranker.rerank(query, texts) → 점수 desc 정렬 → topKFinal 반환
//    - swaps = 1차 순서와 최종 순서 사이의 inversion count (또는 단순 "topKFinal 안에서 1차 순서가 변한 횟수")
```

config 키:

- `rag.rerank.enabled` (기본 true)
- `rag.rerank.topKFirst` (기본 10)
- `rag.rerank.topKFinal` (기본 3)

EDIT `packages/config/src/...` — 위 키 추가.

검증: `pnpm typecheck && pnpm test --run --filter @finclaw/storage -- search/hybrid`.

### D4. EDIT `packages/storage/src/database.ts` — SCHEMA_VERSION v9 → v10 + agent_runs.rerank_meta

`SCHEMA_VERSION = 10`.

`SCHEMA_DDL` 의 `agent_runs` 정의에 `rerank_meta TEXT` 컬럼 추가 (fresh DB).

`MIGRATIONS[10]`:

```ts
  10: (db: DatabaseSync) => {
    const cols = db.prepare(`PRAGMA table_info('agent_runs')`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'rerank_meta')) {
      db.exec(`ALTER TABLE agent_runs ADD COLUMN rerank_meta TEXT;`);
    }
  },
```

EDIT `packages/storage/src/agent-runs.ts`:

- `AgentRunRow` 에 `rerank_meta: string | null` 추가
- `AddAgentRunInput` 에 `rerankMeta?: { model: string; scoresBefore: number[]; scoresAfter: number[]; swaps: number }` 추가
- `addAgentRun` INSERT 컬럼 + VALUES 에 `rerank_meta` 추가 (`JSON.stringify(rerankMeta) ?? null`)
- `rowToAgentRun` mapping 추가

EDIT `packages/storage/src/database.migration.storage.test.ts` — v9→v10 케이스 추가.

검증: `pnpm typecheck && pnpm test:storage -- 'database.migration|agent-runs'`.

### D5. EDIT `packages/server/src/auto-reply/stages/memory-retrieval.ts` — rerank 호출 + trace 부착 + agent_runs 메타 기록

```ts
// 의사 코드
const reranker = config.rag.rerank.enabled
  ? createRerankerWithFallback(new LocalReranker())
  : undefined;

const result = await ctx.tracer.withSpan(
  'rag.retrieval',
  { sessionKey: ctx.sessionKey, rerank: !!reranker },
  async () =>
    hybridSearch(query, {
      reranker,
      topKFirst: config.rag.rerank.topKFirst ?? 10,
      topKFinal: config.rag.rerank.topKFinal ?? 3,
    }),
);

// citation 형식 (Phase 29 B) 은 result.chunks 의 ID 그대로 (re-rank 후의 ID)
ctx.usedMemoryIds = result.chunks.map((c) => c.memoryId);

// agent_runs.rerank_meta 는 runner 가 addAgentRun 호출 시 전달 — pipeline-context 에 부착
if (result.rerankMeta) {
  ctx.rerankMeta = result.rerankMeta;
}
```

EDIT `packages/server/src/auto-reply/pipeline-context.ts` — `rerankMeta?` 필드 추가.
EDIT runner / agent-memory-hook 의 `addAgentRun` 호출부 — `ctx.rerankMeta` 를 input 에 전달.

검증: `pnpm typecheck && pnpm test --run --filter @finclaw/server -- auto-reply`.

### D6. CREATE `scripts/download-rerank-model.mjs` — HF Hub 1회 다운로드

```js
#!/usr/bin/env node
// 사용자 1회 모델 다운로드
import { pipeline } from '@huggingface/transformers';
import { homedir } from 'node:os';
import { join } from 'node:path';

const modelId = process.env.RERANK_MODEL_ID ?? 'Xenova/bge-reranker-v2-m3';
const cacheDir = join(homedir(), '.cache', 'finclaw', 'models', 'rerank');

console.log(`Downloading ${modelId} to ${cacheDir} ...`);
try {
  await pipeline('text-classification', modelId, { cache_dir: cacheDir });
  console.log('OK — re-ranker model ready');
} catch (err) {
  console.error('Download failed:', err.message);
  console.error('FinClaw will fall back to MockReranker (deterministic, no quality gain).');
  process.exit(1);
}
```

검증 (수동, CI 비대상): `pnpm tsx scripts/download-rerank-model.mjs`.

### D7. CREATE `packages/storage/src/rerank/local.test.ts` — 모델 미존재 fallback / mock 점수 순서

```ts
import { describe, it, expect } from 'vitest';
import { LocalReranker, MockReranker, createRerankerWithFallback } from '../src/index.js';

describe('Reranker fallback', () => {
  it('MockReranker preserves input order via descending scores', async () => {
    const m = new MockReranker();
    const scores = await m.rerank('q', ['a', 'b', 'c']);
    expect(scores).toEqual([3, 2, 1]);
  });

  it('createRerankerWithFallback falls back to mock on local failure', async () => {
    const broken = { id: 'x', rerank: () => Promise.reject(new Error('no model')) };
    const r = createRerankerWithFallback(broken);
    const scores = await r.rerank('q', ['a', 'b']);
    expect(scores).toEqual([2, 1]); // mock fallback
  });
});
```

> LocalReranker 자체는 외부 모델 다운로드 없이 import 만으로 통과해야 함 — 실제 `rerank()` 호출은 fallback 경로로 mock 점수 반환.

검증: `pnpm test:storage -- rerank` (외부 모델 다운로드 없이 통과).

### D8. EDIT `packages/storage/src/search/hybrid.test.ts` — rerank 활성/비활성 toggle

```ts
it('returns top-K-final without reranker', async () => {
  const result = await hybridSearch('q', { topKFirst: 10, topKFinal: 3 });
  expect(result.chunks).toHaveLength(3);
  expect(result.rerankMeta).toBeUndefined();
});

it('reorders with mock reranker (reverse) — topKFinal returned in mock-reverse order', async () => {
  const reverseReranker = {
    id: 'mock-reverse',
    rerank: async (_q: string, cs: readonly string[]) => cs.map((_, i) => i), // ASC
  };
  const result = await hybridSearch('q', {
    reranker: reverseReranker,
    topKFirst: 10,
    topKFinal: 3,
  });
  expect(result.rerankMeta?.swaps).toBeGreaterThan(0);
});
```

검증: `pnpm test:storage -- search/hybrid`.

### D9. CREATE `packages/server/test/auto-reply/rerank.e2e.test.ts` — swap > 0 + rerank_meta 기록

```ts
// MockReranker (역순) 주입 → memory-retrieval 단계 진입
// → agent_runs.rerank_meta.swaps > 0 검증
// → citation 형식이 최종 top-3 ID 기준
```

검증: `pnpm test --run --filter @finclaw/server -- rerank`.

### D10. 밀스톤 D 검증

```sh
pnpm typecheck && pnpm lint
pnpm test:storage -- 'rerank|search/hybrid|database.migration|agent-runs'
pnpm test --run --filter @finclaw/server -- 'auto-reply/rerank'

# 운영 검증 (수동)
pnpm tsx scripts/download-rerank-model.mjs
pnpm dev &
# Discord 또는 web 에서 동일 주제 다른 표현 질문 → trace-view 에서 rerank.swaps 관찰
```

plan.md D 완료 조건:

- 외부 키 없이 (mock reranker) 모든 vitest 통과 ✓
- 실제 모델 1회 다운로드 후 e2e 통과 (수동)
- agent_runs.rerank_meta 에 swap 통계 기록
- citation 형식 (Phase 29 B) 회귀 0

커밋: `feat(storage): RAG re-ranker (local ONNX + mock) + agent_runs.rerank_meta (Phase 30 D)`

---

## 최종 검증

### 1. 전체 테스트

```sh
pnpm format:fix
pnpm lint
pnpm typecheck
pnpm test:all   # = unit + storage + e2e + auto-reply 4-tier
```

모두 통과.

### 2. Phase 30 e2e 시나리오 일괄

```sh
pnpm test --run --filter @finclaw/server -- 'auto-reply/trace.e2e'
pnpm test --run --filter @finclaw/server -- 'structured-output'
pnpm test --run --filter @finclaw/server -- 'rerank'
# C 50 RPC 시나리오는 수동 (운영 검증)
```

### 3. 마이그레이션 시뮬레이션 v7 → v10

```sh
pnpm test:storage -- database.migration
```

v7 → v8 → v9 → v10 순차 통과.

### 4. 재감사 (사용자가 수동 트리거)

```
Phase 30 종료 — finclaw-openclaw-similarity 재실행
```

검증 목표:

- 종합 평균 ≥ **4.0**
- Runtime 2.5 (관찰성) = 5/5
- Runtime 2.6 (프롬프트) ≥ 4.5/5
- Memory 3.3 (RAG) ≥ 4.5/5
- Interface 4.2 (게이트웨이) ≥ 4.5/5
- 회귀 0 — Phase 29 후 점수 유지

### 5. review.md 작성

`finclaw-phase-finalize` 자동 연쇄 호출. plans/phase30/review.md 초안 → 사용자 승인 후 머지.

---

## 롤백 절차

각 트랙(밀스톤) 이 독립 커밋이라면 단계적 롤백 가능:

```sh
# 트랙 D 만 되돌리기 (스키마 v10 → v9 는 수동 — agent_runs.rerank_meta 컬럼 보존, 기록 중단으로 충분)
git revert <D 커밋 SHA>

# 트랙 C 도 되돌리기 (스키마 v9 → v8 — access_log 테이블은 DROP 하지 않고 기록 중단)
git revert <C 커밋 SHA>

# 트랙 B (스키마 무관)
git revert <B 커밋 SHA>

# 트랙 A 까지 (스키마 v8 → v7 — spans 테이블/컬럼 보존, 기록 중단)
git revert <A 커밋 SHA>
```

> **주의**: SCHEMA_VERSION 다운그레이드 마이그레이션은 작성하지 않음. revert 시 dev DB 의 v10 메타는 그대로 두고 코드만 돌아감 — `openDatabase` 가 `currentVersion < SCHEMA_VERSION` 만 체크하므로 미래 버전 DB 도 동작 (단, 신규 컬럼/테이블은 사용 안 함). dev DB 백업(P-1) 으로 완전 복구 가능.

---

## 종료 체크리스트

- [ ] 사용자 결정 사항 5건 확정 (모두 기본값)
- [ ] 트랙 A 완료 (A1-A16) — 스키마 v8
- [ ] 트랙 C 완료 (C1-C11) — 스키마 v9
- [ ] 트랙 B 완료 (B1-B11) — 스키마 변경 없음
- [ ] 트랙 D 완료 (D1-D10) — 스키마 v10
- [ ] 마이그레이션 시뮬레이션 v7→v10 통과
- [ ] 통합 검증 1-3 통과
- [ ] 재감사 종합 평균 ≥ 4.0
- [ ] review.md 작성 (`finclaw-phase-finalize` 연쇄)
- [ ] CLAUDE.md 변경 이력에 Phase 30 행 추가
