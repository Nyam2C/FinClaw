// packages/server/src/cli/__tests__/program.test.ts
import { describe, it, expect } from 'vitest';
import { buildProgram, createProgramContext } from '../program.js';
import { createTestDeps } from './test-helpers.js';

describe('createProgramContext', () => {
  it('returns a version string', () => {
    const ctx = createProgramContext();
    expect(ctx.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('buildProgram', () => {
  const deps = createTestDeps();
  const program = buildProgram(deps);

  it('has correct name', () => {
    expect(program.name()).toBe('finclaw');
  });

  it('has a version', () => {
    expect(program.version()).toBeTruthy();
  });

  it('registers 10 commands', () => {
    // start, stop, config, agent, channel, market, news, alert, health, status
    const names = program.commands.map((c) => c.name());
    expect(names).toContain('start');
    expect(names).toContain('stop');
    expect(names).toContain('health');
    expect(names).toContain('status');
    expect(names).toContain('config');
    expect(names).toContain('agent');
    expect(names).toContain('channel');
    expect(names).toContain('market');
    expect(names).toContain('news');
    expect(names).toContain('alert');
    expect(names).toHaveLength(10);
  });

  it('has global --verbose option', () => {
    const opts = program.options.map((o) => o.long);
    expect(opts).toContain('--verbose');
  });

  it('has global --gateway-url option', () => {
    const opts = program.options.map((o) => o.long);
    expect(opts).toContain('--gateway-url');
  });

  it('outputs help without error', () => {
    const help = program.helpInformation();
    expect(help).toContain('finclaw');
    expect(help).toContain('health');
  });
});
