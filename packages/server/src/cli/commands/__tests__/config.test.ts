import { Command } from 'commander';
// packages/server/src/cli/commands/__tests__/config.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CliDeps } from '../../deps.js';
import { createTestDeps } from '../../__tests__/test-helpers.js';
import { register } from '../config.js';

describe('config command', () => {
  let deps: CliDeps;
  let program: Command;

  beforeEach(() => {
    deps = createTestDeps();
    program = new Command();
    program.exitOverride();
    register(program, deps);
  });

  it('list calls config.get and outputs key-value', async () => {
    (deps.callGateway as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { provider: 'alpha-vantage', interval: '5m' },
    });

    await program.parseAsync(['config', 'list'], { from: 'user' });

    expect(deps.callGateway).toHaveBeenCalledWith('config.get');
    expect(deps.output).toHaveBeenCalled();
    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('provider');
    expect(output).toContain('alpha-vantage');
  });

  it('get <key> calls config.get with key param', async () => {
    (deps.callGateway as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { provider: 'alpha-vantage' },
    });

    await program.parseAsync(['config', 'get', 'provider'], { from: 'user' });

    expect(deps.callGateway).toHaveBeenCalledWith('config.get', { key: 'provider' });
  });

  it('set <key> <value> calls config.update', async () => {
    (deps.callGateway as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: {} });

    await program.parseAsync(['config', 'set', 'interval', '10m'], { from: 'user' });

    expect(deps.callGateway).toHaveBeenCalledWith('config.update', {
      key: 'interval',
      value: '10m',
    });
    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('interval');
    expect(output).toContain('10m');
  });

  it('list handles gateway error', async () => {
    (deps.callGateway as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: { code: -1, message: 'connection refused' },
    });

    await program.parseAsync(['config', 'list'], { from: 'user' });

    expect(deps.error).toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalled();
  });
});
