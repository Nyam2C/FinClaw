import { describe, it, expect } from 'vitest';
import { runWithContext, getContext, getRequestId } from '../src/context.js';

describe('RequestContext (ALS)', () => {
  it('runWithContext 내부에서 getContext로 조회된다', () => {
    const ctx = { requestId: 'req-1', startedAt: Date.now() };
    runWithContext(ctx, () => {
      expect(getContext()).toBe(ctx);
      expect(getRequestId()).toBe('req-1');
    });
  });

  it('runWithContext 외부에서는 undefined이다', () => {
    expect(getContext()).toBeUndefined();
    expect(getRequestId()).toBeUndefined();
  });

  it('중첩 runWithContext에서 내부 컨텍스트가 우선한다', () => {
    const outer = { requestId: 'outer', startedAt: 1 };
    const inner = { requestId: 'inner', startedAt: 2 };

    runWithContext(outer, () => {
      expect(getRequestId()).toBe('outer');
      runWithContext(inner, () => {
        expect(getRequestId()).toBe('inner');
      });
      expect(getRequestId()).toBe('outer');
    });
  });

  it('비동기 콜백에서 컨텍스트가 전파된다', async () => {
    const ctx = { requestId: 'async-req', startedAt: Date.now() };
    await runWithContext(ctx, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(getRequestId()).toBe('async-req');
    });
  });
});
