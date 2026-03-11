import { Command } from 'commander';
// packages/server/src/cli/commands/__tests__/market.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CliDeps } from '../../deps.js';
import { createTestDeps } from '../../__tests__/test-helpers.js';
import { register } from '../market.js';

describe('market command', () => {
  let deps: CliDeps;
  let program: Command;

  beforeEach(() => {
    deps = createTestDeps();
    program = new Command();
    program.exitOverride();
    register(program, deps);
  });

  it('quote outputs key-value table by default', async () => {
    (deps.callGateway as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { symbol: 'AAPL', price: 150.25, change: '+1.5%' },
    });

    await program.parseAsync(['market', 'quote', 'AAPL'], { from: 'user' });

    expect(deps.callGateway).toHaveBeenCalledWith('finance.quote', {
      symbol: 'AAPL',
      currency: 'USD',
    });
    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('AAPL');
    expect(output).toContain('150.25');
  });

  it('quote --format json outputs JSON', async () => {
    const data = { symbol: 'TSLA', price: 200 };
    (deps.callGateway as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data });

    await program.parseAsync(['market', 'quote', 'TSLA', '-f', 'json'], { from: 'user' });

    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(JSON.parse(output)).toEqual(data);
  });

  it('quote handles gateway error', async () => {
    (deps.callGateway as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: { code: -1, message: 'timeout' },
    });

    await program.parseAsync(['market', 'quote', 'AAPL'], { from: 'user' });

    expect(deps.error).toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalled();
  });
});
