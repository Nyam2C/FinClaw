import { Command } from 'commander';
// packages/server/src/cli/commands/__tests__/agent.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDeps } from '../../__tests__/test-helpers.js';
import type { CliDeps } from '../../deps.js';
import { register } from '../agent.js';

describe('agent command', () => {
  let deps: CliDeps;
  let program: Command;

  beforeEach(() => {
    deps = createTestDeps();
    program = new Command();
    program.exitOverride();
    register(program, deps);
  });

  it('list renders agents from {agents}', async () => {
    // 서버 agent.list 는 {agents:[…]} 반환 (bare array 아님).
    (deps.callGateway as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { agents: [{ id: 'default', name: 'FinClaw', description: 'main', toolCount: 4 }] },
    });

    await program.parseAsync(['agent', 'list'], { from: 'user' });

    expect(deps.callGateway).toHaveBeenCalledWith('agent.list');
    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('FinClaw');
    expect(output).not.toContain('No agents registered');
  });
});
