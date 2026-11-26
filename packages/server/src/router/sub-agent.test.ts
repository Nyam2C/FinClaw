// packages/server/src/router/sub-agent.test.ts
// 서브에이전트 1회 호출 — 도구 없음·트랜스크립트 없음.
import type { AgentDriver, AgentEvent, DriverRequest } from '@finclaw/agent';
import { describe, expect, it } from 'vitest';
import { runSubAgent } from './sub-agent.js';

function fake(events: (req: DriverRequest) => AgentEvent[]) {
  const calls: DriverRequest[] = [];
  const driver: AgentDriver = async function* (req) {
    calls.push(req);
    for (const ev of events(req)) {
      yield ev;
    }
  };
  return { driver, calls };
}

const done = (req: DriverRequest, text: string): AgentEvent => ({
  type: 'done',
  runId: req.runId,
  text,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  durationMs: 1,
  numTurns: 1,
});

describe('runSubAgent', () => {
  it('도구 없이 1턴 · 질의는 user 메시지 하나 · 45s/75s', async () => {
    const { driver, calls } = fake((req) => [done(req, '{"ok":1}')]);
    const res = await runSubAgent(driver, {
      systemPrompt: 'ANALYST',
      query: 'Analyze',
      modelId: 'claude-opus-5-5',
    });
    expect(res.text).toBe('{"ok":1}');
    const req = calls[0];
    expect(req).toMatchObject({
      systemPrompt: 'ANALYST',
      messages: [{ role: 'user', content: 'Analyze' }],
      model: 'claude-opus-5-5',
      tools: [],
      maxTurns: 1,
      idleTimeoutMs: 45_000,
      overallTimeoutMs: 75_000,
    });
  });

  it('error 이벤트면 reason 을 담아 throw', async () => {
    const { driver } = fake((req) => [
      { type: 'error', runId: req.runId, reason: 'timeout', message: 'idle' },
    ]);
    await expect(runSubAgent(driver, { systemPrompt: 's', query: 'q' })).rejects.toThrow(
      'sub-agent timeout',
    );
  });

  it('넘긴 signal 을 그대로 드라이버에 전달', async () => {
    const { driver, calls } = fake((req) => [done(req, 'x')]);
    const ac = new AbortController();
    await runSubAgent(driver, { systemPrompt: 's', query: 'q' }, ac.signal);
    expect(calls[0]?.signal).toBe(ac.signal);
  });
});
