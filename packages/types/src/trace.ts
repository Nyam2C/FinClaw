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
