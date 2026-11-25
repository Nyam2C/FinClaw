import type { SpanRecord } from '@finclaw/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { addSpan, openDatabase, type Database } from './index.js';

describe('spans storage', () => {
  let db: Database;
  beforeEach(() => {
    db = openDatabase({ path: ':memory:', enableWAL: false });
  });

  const span: SpanRecord = {
    traceId: 'a'.repeat(32),
    spanId: 'c'.repeat(16),
    parentSpanId: 'r'.repeat(16),
    name: 'child',
    kind: 'internal',
    startNs: 10n,
    attributes: { k: 1 },
    events: [],
    status: 'ok',
  };

  it('addSpan 이 컬럼을 매핑해 저장한다 (endNs 미지정 → NULL)', () => {
    addSpan(db.db, span);
    const row = db.db.prepare('SELECT * FROM spans').get() as Record<string, unknown>;
    expect(row).toMatchObject({
      trace_id: span.traceId,
      span_id: span.spanId,
      parent_span_id: span.parentSpanId,
      name: 'child',
      start_ns: 10,
      end_ns: null,
      attributes: '{"k":1}',
      status: 'ok',
    });
  });

  it('같은 span 재기록은 덮어쓴다 (INSERT OR REPLACE)', () => {
    addSpan(db.db, span);
    addSpan(db.db, { ...span, endNs: 50n });
    const rows = db.db.prepare('SELECT end_ns FROM spans').all() as Array<{ end_ns: number }>;
    expect(rows).toEqual([{ end_ns: 50 }]);
  });
});
