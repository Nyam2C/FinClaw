// packages/config/test/zod-schema.test.ts
import { describe, it, expect } from 'vitest';
import { FinClawConfigSchema } from '../src/zod-schema.js';

describe('FinClawConfigSchema', () => {
  it('빈 객체를 허용한다', () => {
    const result = FinClawConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('유효한 전체 설정을 허용한다', () => {
    const config = {
      gateway: { port: 18789, host: 'localhost' },
      agents: {
        defaults: { model: 'claude-sonnet-4-6', provider: 'anthropic' },
        entries: { main: { model: 'claude-sonnet-4-6' } },
      },
      channels: {
        discord: { botToken: 'token', applicationId: 'app-id' },
        cli: { enabled: true },
      },
      session: { mainKey: 'main', resetPolicy: 'idle' as const },
      logging: { level: 'info' as const, file: true },
      models: {
        definitions: {
          sonnet: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        },
        aliases: { default: 'sonnet' },
      },
      plugins: { enabled: ['finance'] },
      finance: {
        portfolios: { main: { name: 'Main', holdings: [{ symbol: 'AAPL', quantity: 10 }] } },
      },
      meta: { lastTouchedVersion: '0.1.0' },
    };
    const result = FinClawConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('알 수 없는 키를 거부한다 (strictObject)', () => {
    const result = FinClawConfigSchema.safeParse({ gatway: {} });
    expect(result.success).toBe(false);
  });

  it('잘못된 포트 범위를 거부한다', () => {
    const result = FinClawConfigSchema.safeParse({
      gateway: { port: 99999 },
    });
    expect(result.success).toBe(false);
  });

  it('잘못된 resetPolicy를 거부한다', () => {
    const result = FinClawConfigSchema.safeParse({
      session: { resetPolicy: 'weekly' },
    });
    expect(result.success).toBe(false);
  });

  it('rag / accessLog / gateway.auth 키를 허용한다 (Phase 37 B)', () => {
    const result = FinClawConfigSchema.safeParse({
      rag: { rerank: { enabled: true, topKFirst: 10, topKFinal: 3 } },
      accessLog: { retentionDays: 7 },
      gateway: { port: 18789, host: 'localhost', auth: { token: 'x' } },
    });
    expect(result.success).toBe(true);
  });

  it('rag.rerank 의 알 수 없는 키를 거부한다 (strictObject 유지)', () => {
    const result = FinClawConfigSchema.safeParse({
      rag: { rerank: { foobar: true } },
    });
    expect(result.success).toBe(false);
  });
});
