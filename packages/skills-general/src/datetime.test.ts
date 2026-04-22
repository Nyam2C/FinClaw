// packages/skills-general/src/datetime.test.ts
import { InMemoryToolRegistry } from '@finclaw/agent';
import { describe, expect, it } from 'vitest';
import { registerDatetimeTool } from './datetime.js';

function makeCtx() {
  return {
    sessionId: 's1',
    userId: 'u1',
    channelId: 'c1',
    abortSignal: AbortSignal.timeout(1_000),
  };
}

describe('get_current_datetime', () => {
  it('기본 타임존으로 현재 시각을 반환한다', async () => {
    const registry = new InMemoryToolRegistry();
    registerDatetimeTool(registry);

    const result = await registry.execute('get_current_datetime', {}, makeCtx());

    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/Asia\/Seoul/);
    expect(result.content).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('지정된 타임존을 적용한다', async () => {
    const registry = new InMemoryToolRegistry();
    registerDatetimeTool(registry);

    const result = await registry.execute(
      'get_current_datetime',
      { timezone: 'America/New_York' },
      makeCtx(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/America\/New_York/);
  });

  it('잘못된 타임존은 에러로 반환한다', async () => {
    const registry = new InMemoryToolRegistry();
    registerDatetimeTool(registry);

    const result = await registry.execute(
      'get_current_datetime',
      { timezone: 'Not/A_Real_Zone' },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Invalid timezone/i);
  });
});
