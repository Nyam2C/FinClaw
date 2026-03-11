import { Command } from 'commander';
// packages/server/src/cli/commands/__tests__/news.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CliDeps } from '../../deps.js';
import { createTestDeps } from '../../__tests__/test-helpers.js';
import { register } from '../news.js';

describe('news command', () => {
  let deps: CliDeps;
  let program: Command;

  beforeEach(() => {
    deps = createTestDeps();
    program = new Command();
    program.exitOverride();
    register(program, deps);
  });

  it('fetches news with query', async () => {
    (deps.callGateway as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: [{ title: 'AAPL earnings beat', source: 'Reuters' }],
    });

    await program.parseAsync(['news', 'AAPL'], { from: 'user' });

    expect(deps.callGateway).toHaveBeenCalledWith('finance.news', { query: 'AAPL' });
    const output = (deps.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain('AAPL earnings beat');
  });

  it('passes symbols filter', async () => {
    (deps.callGateway as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: [{ title: 'Tech rally', source: 'Bloomberg' }],
    });

    await program.parseAsync(['news', '-s', 'AAPL,MSFT'], { from: 'user' });

    expect(deps.callGateway).toHaveBeenCalledWith('finance.news', {
      symbols: ['AAPL', 'MSFT'],
    });
  });

  it('handles gateway error', async () => {
    (deps.callGateway as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: { code: -1, message: 'service unavailable' },
    });

    await program.parseAsync(['news', 'crypto'], { from: 'user' });

    expect(deps.error).toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalled();
  });
});
