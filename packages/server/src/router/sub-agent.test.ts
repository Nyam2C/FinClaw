// packages/server/src/router/sub-agent.test.ts
// Phase 46 M3: 서브에이전트 1-shot 격리 (N1) — MCP 없음·비영속·내장 도구 0·무승인 플래그 없음.
import {
  buildCliArgs,
  type AgentDriver,
  type AgentEvent,
  type DriverRequest,
} from '@finclaw/agent';
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
  cliSessionId: 'x',
  text,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  durationMs: 1,
  numTurns: 1,
});

describe('runSubAgent', () => {
  it('N1: session none · MCP 없음 · maxTurns 없음 · 45s/75s, argv 에 --tools "" + --no-session-persistence', async () => {
    const { driver, calls } = fake((req) => [done(req, '{"ok":1}')]);
    const res = await runSubAgent(driver, {
      systemPrompt: 'ANALYST',
      query: 'Analyze',
      modelId: 'claude-opus-4-7',
    });
    expect(res.text).toBe('{"ok":1}');
    const req = calls[0];
    expect(req?.session).toEqual({ kind: 'none' });
    expect(req?.mcp).toBeUndefined();
    expect(req?.maxTurns).toBeUndefined();
    expect(req?.idleTimeoutMs).toBe(45_000);
    expect(req?.overallTimeoutMs).toBe(75_000);
    const args = buildCliArgs(req as DriverRequest);
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--no-session-persistence');
    for (const banned of [
      '--mcp-config',
      '--allowedTools',
      '--dangerously-skip-permissions',
      '--append-system-prompt',
    ]) {
      expect(args).not.toContain(banned);
    }
  });

  it('error 이벤트면 reason 을 담아 throw', async () => {
    const { driver } = fake((req) => [
      { type: 'error', runId: req.runId, reason: 'timeout', message: 'idle' },
    ]);
    await expect(runSubAgent(driver, { systemPrompt: 's', query: 'q' })).rejects.toThrow(
      'sub-agent timeout',
    );
  });

  it('D2: 넘긴 signal 을 그대로 드라이버에 전달', async () => {
    const { driver, calls } = fake((req) => [done(req, 'x')]);
    const ac = new AbortController();
    await runSubAgent(driver, { systemPrompt: 's', query: 'q' }, ac.signal);
    expect(calls[0]?.signal).toBe(ac.signal);
  });
});
