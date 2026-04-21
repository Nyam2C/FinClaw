// packages/skills-general/src/web-fetch.test.ts
import { InMemoryToolRegistry } from '@finclaw/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerWebFetchTool } from './web-fetch.js';

function makeCtx() {
  return {
    sessionId: 's1',
    userId: 'u1',
    channelId: 'c1',
    abortSignal: AbortSignal.timeout(5_000),
  };
}

describe('web_fetch', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('사설 대역(10.x)을 차단한다', async () => {
    const registry = new InMemoryToolRegistry();
    registerWebFetchTool(registry, { maxBytes: 1_000, timeoutMs: 2_000 });

    const result = await registry.execute('web_fetch', { url: 'http://10.0.0.1/' }, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/web_fetch failed/);
  });

  it('localhost 호스트를 차단한다', async () => {
    const registry = new InMemoryToolRegistry();
    registerWebFetchTool(registry, { maxBytes: 1_000, timeoutMs: 2_000 });

    const result = await registry.execute(
      'web_fetch',
      { url: 'http://localhost:8080/' },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/web_fetch failed/);
  });

  it('지원되지 않는 프로토콜을 거부한다', async () => {
    const registry = new InMemoryToolRegistry();
    registerWebFetchTool(registry, { maxBytes: 1_000, timeoutMs: 2_000 });

    const result = await registry.execute('web_fetch', { url: 'ftp://example.com/' }, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Unsupported protocol/);
  });
});
