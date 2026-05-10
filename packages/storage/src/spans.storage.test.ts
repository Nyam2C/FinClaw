import type { SpanRecord } from '@finclaw/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { addSpan, getSpanTree, listSpansByTrace, openDatabase, type Database } from './index.js';

describe('spans storage', () => {
  let db: Database;
  beforeEach(() => {
    db = openDatabase({ path: ':memory:', enableWAL: false });
  });

  it('builds parent-child tree from flat list', () => {
    const traceId = 'a'.repeat(32);
    const root: SpanRecord = {
      traceId,
      spanId: 'r'.repeat(16),
      name: 'root',
      kind: 'internal',
      startNs: 1n,
      endNs: 100n,
      attributes: {},
      events: [],
      status: 'ok',
    };
    const child: SpanRecord = {
      traceId,
      spanId: 'c'.repeat(16),
      parentSpanId: 'r'.repeat(16),
      name: 'child',
      kind: 'internal',
      startNs: 10n,
      endNs: 50n,
      attributes: {},
      events: [],
      status: 'ok',
    };
    addSpan(db.db, root);
    addSpan(db.db, child);

    const tree = getSpanTree(db.db, traceId);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children).toHaveLength(1);
    expect(tree[0]?.children[0]?.name).toBe('child');
  });

  it('orders by start_ns ASC', () => {
    const traceId = 'b'.repeat(32);
    for (const [i, startNs] of [
      ['1', 30n],
      ['2', 10n],
      ['3', 20n],
    ] as const) {
      addSpan(db.db, {
        traceId,
        spanId: `s${i}`.padEnd(16, '0'),
        name: `span${i}`,
        kind: 'internal',
        startNs,
        endNs: startNs + 5n,
        attributes: {},
        events: [],
        status: 'ok',
      });
    }
    const list = listSpansByTrace(db.db, traceId);
    expect(list.map((s) => s.name)).toEqual(['span2', 'span3', 'span1']);
  });

  it('roots include orphans whose parentSpanId is missing in trace', () => {
    const traceId = 'c'.repeat(32);
    addSpan(db.db, {
      traceId,
      spanId: 'orphan'.padEnd(16, '0'),
      parentSpanId: 'missing'.padEnd(16, '0'),
      name: 'orphan',
      kind: 'internal',
      startNs: 1n,
      endNs: 2n,
      attributes: {},
      events: [],
      status: 'ok',
    });
    const tree = getSpanTree(db.db, traceId);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.name).toBe('orphan');
  });
});
