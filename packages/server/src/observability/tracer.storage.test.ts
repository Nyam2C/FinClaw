import { openDatabase } from '@finclaw/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import { redactPII } from './redact.js';
import { createTracer } from './tracer.js';

describe('tracer.withSpan', () => {
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    db = openDatabase({ path: ':memory:', enableWAL: false });
  });

  it('exposes 32-hex traceId / 16-hex spanId via context', async () => {
    const tracer = createTracer({ db: db.db });
    let captured: { traceId: string; spanId: string } | undefined;
    await tracer.withSpan('parent', {}, async (ctx) => {
      captured = { traceId: ctx.traceId, spanId: ctx.spanId };
    });
    expect(captured?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(captured?.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('writes a row to spans table with status=ok on success', async () => {
    const tracer = createTracer({ db: db.db });
    await tracer.withSpan('s1', { foo: 'bar' }, async () => {
      // no-op
    });
    const rows = db.db.prepare('SELECT * FROM spans').all() as Array<{
      name: string;
      status: string;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.name).toBe('s1');
    expect(rows[0]?.status).toBe('ok');
  });

  it('marks span status=error on throw and rethrows', async () => {
    const tracer = createTracer({ db: db.db });
    await expect(
      tracer.withSpan('boom', {}, async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    const rows = db.db.prepare('SELECT status, status_message FROM spans').all() as Array<{
      status: string;
      status_message: string | null;
    }>;
    expect(rows[0]?.status).toBe('error');
    expect(rows[0]?.status_message).toBe('x');
  });

  it('groups child spans under same trace_id', async () => {
    const tracer = createTracer({ db: db.db });
    let parentTraceId: string | undefined;
    let childTraceId: string | undefined;
    await tracer.withSpan('parent', {}, async (ctx) => {
      parentTraceId = ctx.traceId;
      await tracer.withSpan('child', {}, async (cctx) => {
        childTraceId = cctx.traceId;
      });
    });
    expect(parentTraceId).toBeDefined();
    expect(childTraceId).toBe(parentTraceId);
  });
});

describe('redactPII', () => {
  it('redacts email / phone / ssn in nested attributes', () => {
    const out = redactPII({
      note: 'mail me at foo@bar.com or 010-1234-5678',
      ssn: '123-45-6789',
    });
    expect(out).toEqual({
      note: 'mail me at [REDACTED_EMAIL] or [REDACTED_PHONE]',
      ssn: '[REDACTED_SSN]',
    });
  });

  it('handles arrays and primitive values without modification', () => {
    expect(redactPII([1, 'plain', { e: 'x@y.com' }])).toEqual([
      1,
      'plain',
      { e: '[REDACTED_EMAIL]' },
    ]);
    expect(redactPII(null)).toBeNull();
    expect(redactPII(42)).toBe(42);
  });
});
