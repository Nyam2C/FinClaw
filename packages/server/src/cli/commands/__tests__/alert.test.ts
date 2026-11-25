import { Command } from 'commander';
// packages/server/src/cli/commands/__tests__/alert.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDeps } from '../../__tests__/test-helpers.js';
import type { CliDeps } from '../../deps.js';
import { register } from '../alert.js';

describe('alert command', () => {
  let deps: CliDeps;
  let program: Command;

  beforeEach(() => {
    deps = createTestDeps();
    program = new Command();
    program.exitOverride();
    register(program, deps);
  });

  it('add maps CLI args onto finance.alert.create schema', async () => {
    (deps.callGateway as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { alertId: 'a1', createdAt: 0, immediateTrigger: false },
    });

    await program.parseAsync(['alert', 'add', '-t', 'AAPL', '-c', 'below', '-p', '180'], {
      from: 'user',
    });

    expect(deps.callGateway).toHaveBeenCalledWith('finance.alert.create', {
      symbol: 'AAPL',
      condition: 'price_below',
      threshold: 180,
    });
    expect((deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      'Alert created: AAPL below 180',
    );
  });

  it('list renders rows from {alerts,total}', async () => {
    (deps.callGateway as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { alerts: [{ id: 'a1', ticker: 'AAPL', enabled: true }], total: 1 },
    });

    await program.parseAsync(['alert', 'list'], { from: 'user' });

    expect(deps.callGateway).toHaveBeenCalledWith('finance.alert.list');
    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('AAPL');
  });
});
