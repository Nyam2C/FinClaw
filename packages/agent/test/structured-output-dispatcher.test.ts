// packages/agent/test/structured-output-dispatcher.test.ts
// Phase 30 B10 (단위 e2e): ExecutionToolDispatcher 가 outputSchema 위반을
// structuredOutputViolation 플래그로 정확히 표시하는지.

import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import type { ToolHandler } from '../src/execution/tool-executor.js';
import { ExecutionToolDispatcher } from '../src/execution/tool-executor.js';

const ValidOutputSchema = z.object({
  trend: z.enum(['up', 'down', 'flat']),
  volatility: z.number(),
});

describe('Phase 30 B10 — dispatcher outputSchema enforcement', () => {
  it('passes valid JSON output through without flag', async () => {
    const dispatcher = new ExecutionToolDispatcher();
    const handler: ToolHandler = {
      execute: async () => JSON.stringify({ trend: 'up', volatility: 0.5 }),
      outputSchema: ValidOutputSchema,
      enforceStructuredOutput: true,
    };
    dispatcher.register('analyze_market', handler);

    const results = await dispatcher.executeAll([{ id: 'c1', name: 'analyze_market', input: {} }]);
    expect(results[0]?.isError).toBe(false);
    expect(results[0]?.structuredOutputViolation).toBeUndefined();
  });

  it('flags structuredOutputViolation when output JSON does not match schema', async () => {
    const dispatcher = new ExecutionToolDispatcher();
    const handler: ToolHandler = {
      execute: async () => JSON.stringify({ trend: 'sideways', volatility: 0 }),
      outputSchema: ValidOutputSchema,
      enforceStructuredOutput: true,
    };
    dispatcher.register('analyze_market', handler);

    const results = await dispatcher.executeAll([{ id: 'c1', name: 'analyze_market', input: {} }]);
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.structuredOutputViolation).toBe(true);
    expect(results[0]?.content).toContain('schema violation');
  });

  it('flags structuredOutputViolation when output is not JSON', async () => {
    const dispatcher = new ExecutionToolDispatcher();
    const handler: ToolHandler = {
      execute: async () => 'free text not JSON',
      outputSchema: ValidOutputSchema,
      enforceStructuredOutput: true,
    };
    dispatcher.register('analyze_market', handler);

    const results = await dispatcher.executeAll([{ id: 'c1', name: 'analyze_market', input: {} }]);
    expect(results[0]?.structuredOutputViolation).toBe(true);
  });

  it('skips schema check when enforceStructuredOutput is false', async () => {
    const dispatcher = new ExecutionToolDispatcher();
    const handler: ToolHandler = {
      execute: async () => 'free text not JSON',
      outputSchema: ValidOutputSchema,
      enforceStructuredOutput: false,
    };
    dispatcher.register('analyze_market', handler);

    const results = await dispatcher.executeAll([{ id: 'c1', name: 'analyze_market', input: {} }]);
    expect(results[0]?.isError).toBe(false);
    expect(results[0]?.structuredOutputViolation).toBeUndefined();
  });

  it('skips schema check when outputSchema is undefined', async () => {
    const dispatcher = new ExecutionToolDispatcher();
    const handler: ToolHandler = {
      execute: async () => 'free text not JSON',
    };
    dispatcher.register('analyze_market', handler);

    const results = await dispatcher.executeAll([{ id: 'c1', name: 'analyze_market', input: {} }]);
    expect(results[0]?.isError).toBe(false);
  });
});
