// Phase 30 A5: OTel API wrapper + SQLite span exporter.
//
// 본 1차 구현 — withSpan 만 노출. parentSpanId 는 OTel 의 trace.getActiveSpan()
// 으로부터 호출 시점 직전 active span 을 추출 (startActiveSpan 이 새 span 을 push 하기 전).
// flame graph / event 부착은 Phase 31+ 에서 보강.

import type { DatabaseSync } from 'node:sqlite';
import { addSpan } from '@finclaw/storage';
import type { SpanKind, SpanRecord, TraceContext } from '@finclaw/types';
import { context, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { redactPII } from './redact.js';

let globalProviderRegistered = false;

function ensureGlobalProvider(): void {
  if (globalProviderRegistered) {
    return;
  }
  // ContextManager 먼저 등록해야 startActiveSpan 의 child span 이 부모 trace 에 묶임.
  // (NoopContextManager 가 default 이므로 등록 없이는 모든 span 이 root.)
  const ctxMgr = new AsyncLocalStorageContextManager();
  ctxMgr.enable();
  context.setGlobalContextManager(ctxMgr);
  // 자체 web 뷰만 1차 — collector 미연결. SpanProcessor 미부착 (SQLite 는 withSpan 종료 시 직접 export).
  const provider = new BasicTracerProvider();
  trace.setGlobalTracerProvider(provider);
  globalProviderRegistered = true;
}

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
  ensureGlobalProvider();
  const otelTracer = trace.getTracer(options.serviceName ?? 'finclaw');
  const defaultKind: SpanKind = options.defaultKind ?? 'internal';

  return {
    async withSpan(name, attrs, fn) {
      const redactedAttrs = redactPII(attrs);
      // startActiveSpan 호출 직전 active span 이 있으면 그것이 곧 parent.
      const parentSpanId = trace.getActiveSpan()?.spanContext().spanId;
      return otelTracer.startActiveSpan(name, async (span: Span) => {
        const startNs = process.hrtime.bigint();
        const ctx = span.spanContext();
        const traceCtx: TraceContext = {
          traceId: ctx.traceId,
          spanId: ctx.spanId,
          parentSpanId,
        };
        for (const [k, v] of Object.entries(redactedAttrs)) {
          span.setAttribute(k, v as never);
        }
        try {
          const result = await fn(traceCtx);
          span.setStatus({ code: SpanStatusCode.OK });
          finalizeSpan(
            options.db,
            span,
            name,
            defaultKind,
            redactedAttrs,
            startNs,
            'ok',
            parentSpanId,
          );
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
            parentSpanId,
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
      if (!span) {
        return undefined;
      }
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
  parentSpanId: string | undefined,
  message?: string,
): void {
  const ctx = span.spanContext();
  const endNs = process.hrtime.bigint();
  const record: SpanRecord = {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId,
    name,
    kind,
    startNs,
    endNs,
    attributes,
    events: [],
    status,
    statusMessage: message,
  };
  try {
    addSpan(db, record);
  } catch {
    // best-effort — 본체 동작에는 영향 없음
  }
}
