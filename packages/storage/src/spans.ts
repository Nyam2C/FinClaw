import type { DatabaseSync } from 'node:sqlite';
import type { SpanEvent, SpanRecord } from '@finclaw/types';

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
    if (node.parentSpanId !== undefined && byId.has(node.parentSpanId)) {
      const parent = byId.get(node.parentSpanId);
      if (parent) {
        parent.children.push(node);
      }
    } else {
      roots.push(node);
    }
  }
  return roots;
}
