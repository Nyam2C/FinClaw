import type { DatabaseSync } from 'node:sqlite';
import type { SpanRecord } from '@finclaw/types';

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
