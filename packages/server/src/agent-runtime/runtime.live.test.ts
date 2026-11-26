// packages/server/src/agent-runtime/runtime.live.test.ts
// 실키 스모크 (`pnpm test:live`): 자체 루프가 실제 Messages API 로 도구를 부르고, 트랜스크립트를 쌓고,
// 2턴째에 프리픽스 캐시를 읽는지 본다. 레포 루트 `.env` 의 ANTHROPIC_API_KEY 를 직접 읽는다 — 없으면 건너뜀.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAnthropicDriver, InMemoryToolRegistry, type AgentEvent } from '@finclaw/agent';
import type { FinClawLogger } from '@finclaw/infra';
import { registerDatetimeTool } from '@finclaw/skills-general';
import { createStorage } from '@finclaw/storage';
import { createAgentId, createSessionKey } from '@finclaw/types';
import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from './runtime.js';

function readDotEnv(key: string): string | undefined {
  const path = join(process.cwd(), '.env');
  if (!existsSync(path)) {
    return undefined;
  }
  const line = readFileSync(path, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim() || undefined;
}

const apiKey = readDotEnv('ANTHROPIC_API_KEY');
const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
  flush: vi.fn(),
} as unknown as FinClawLogger;

describe.skipIf(!apiKey)('AgentRuntime (live, Anthropic API)', () => {
  it('도구를 부르고, 트랜스크립트를 쌓고, 2턴째에 캐시를 읽는다', async () => {
    const storage = createStorage({ dbPath: ':memory:', enableWAL: false });
    const tools = new InMemoryToolRegistry();
    registerDatetimeTool(tools);
    const systemPrompt = readFileSync(
      join(process.cwd(), 'packages/server/prompts/finclaw.system.ko.md'),
      'utf8',
    );
    const runtime = new AgentRuntime({
      driver: createAnthropicDriver({ apiKey }),
      storage,
      db: storage.db,
      systemPrompt,
      defaultModel: 'claude-opus-5-5',
      tools,
      logger,
    });
    const sessionKey = createSessionKey('live-smoke');
    const ask = async (input: string): Promise<AgentEvent[]> => {
      const events: AgentEvent[] = [];
      for await (const ev of runtime.run({
        sessionKey,
        agentId: createAgentId('finclaw-partner'),
        input,
        mode: 'chat',
        signal: new AbortController().signal,
      })) {
        events.push(ev);
      }
      return events;
    };

    const first = await ask('get_current_datetime 도구로 지금 시각을 확인해서 한 문장으로 알려줘.');
    const done1 = first.at(-1);
    expect(done1, JSON.stringify(done1)).toMatchObject({ type: 'done' });
    expect(first.some((e) => e.type === 'tool_use' && e.name === 'get_current_datetime')).toBe(
      true,
    );
    expect(first.some((e) => e.type === 'text_delta')).toBe(true);

    const second = await ask('방금 알려준 시각을 그대로 한 번 더 말해줘.');
    const done2 = second.at(-1);
    expect(done2, JSON.stringify(done2)).toMatchObject({ type: 'done' });

    const record = await storage.getConversation(sessionKey);
    const roles = record?.messages.map((m) => m.role) ?? [];
    // 1턴: system·user·assistant(tool_use)·tool·assistant / 2턴: system·user·assistant
    expect(roles.slice(0, 4)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(roles.at(-1)).toBe('assistant');
    expect(roles.filter((r) => r === 'user')).toHaveLength(2);

    const usage2 = done2?.type === 'done' ? done2.usage : undefined;
    // eslint-disable-next-line no-console -- 라이브 스모크의 관측값
    console.log('live usage', {
      first: done1?.type === 'done' ? done1.usage : null,
      second: usage2,
    });
    expect(usage2?.cacheRead ?? 0).toBeGreaterThan(0);
    await storage.close();
  }, 120_000);
});
