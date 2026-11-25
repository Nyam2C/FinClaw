// packages/config/test/zod-schema.test.ts
import { describe, it, expect } from 'vitest';
import { FinClawConfigSchema } from '../src/zod-schema.js';

describe('FinClawConfigSchema', () => {
  it('빈 객체를 허용한다', () => {
    const result = FinClawConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('유효한 전체 설정을 허용한다', () => {
    const result = FinClawConfigSchema.safeParse({
      gateway: { auth: { token: 'x' } },
      accessLog: { retentionDays: 7 },
      rag: { rerank: { enabled: true, topKFirst: 10 } },
      provider: 'claude-cli',
      cliBackend: { command: 'claude' },
    });
    expect(result.success).toBe(true);
  });

  it('phase46: cliBackend.timeoutMs·watchdog 는 거부된다 (strict, S12)', () => {
    expect(FinClawConfigSchema.safeParse({ cliBackend: { timeoutMs: 60_000 } }).success).toBe(
      false,
    );
    expect(
      FinClawConfigSchema.safeParse({
        cliBackend: { watchdog: { fresh: { noOutputTimeoutRatio: 0.5 } } },
      }).success,
    ).toBe(false);
  });

  it('알 수 없는 키를 거부한다 (strictObject)', () => {
    const result = FinClawConfigSchema.safeParse({ gatway: {} });
    expect(result.success).toBe(false);
  });

  it('claude-cli 외 provider 를 거부한다', () => {
    const result = FinClawConfigSchema.safeParse({ provider: 'anthropic-sdk' });
    expect(result.success).toBe(false);
  });

  it('rag.rerank 의 알 수 없는 키를 거부한다 (strictObject 유지)', () => {
    const result = FinClawConfigSchema.safeParse({
      rag: { rerank: { foobar: true } },
    });
    expect(result.success).toBe(false);
  });
});
