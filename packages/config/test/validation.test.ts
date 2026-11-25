// packages/config/test/validation.test.ts
import { describe, it, expect } from 'vitest';
import { ConfigValidationError } from '../src/errors.js';
import { validateConfig, validateConfigStrict } from '../src/validation.js';

describe('validateConfig', () => {
  it('유효한 설정에 valid: true를 반환한다', () => {
    const result = validateConfig({ accessLog: { retentionDays: 7 } });
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.config).toEqual({ accessLog: { retentionDays: 7 } });
  });

  it('빈 객체에 valid: true를 반환한다', () => {
    const result = validateConfig({});
    expect(result.valid).toBe(true);
  });

  it('잘못된 설정에 valid: false와 issues를 반환한다', () => {
    const result = validateConfig({ gatway: {} });
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0].severity).toBe('error');
  });

  it('중첩된 에러의 경로를 포함한다', () => {
    const result = validateConfig({ accessLog: { retentionDays: 1.5 } });
    expect(result.valid).toBe(false);
    const issue = result.issues.find((i) => i.path === 'accessLog.retentionDays');
    expect(issue).toBeDefined();
  });

  it('제거된 레거시 섹션(gateway.port, agents 등)을 거부한다', () => {
    expect(validateConfig({ gateway: { port: 3000 } }).valid).toBe(false);
    expect(validateConfig({ agents: {} }).valid).toBe(false);
  });
});

describe('validateConfigStrict', () => {
  it('유효한 설정에 config를 반환한다', () => {
    const config = validateConfigStrict({ provider: 'claude-cli' });
    expect(config).toEqual({ provider: 'claude-cli' });
  });

  it('잘못된 설정에 ConfigValidationError를 throw한다', () => {
    expect(() => validateConfigStrict({ unknown_key: true })).toThrow(ConfigValidationError);
  });

  it('rag/accessLog/gateway.auth 포함 config 를 throw 없이 통과 (Phase 37 B 회귀)', () => {
    expect(() =>
      validateConfigStrict({
        rag: { rerank: { enabled: true } },
        accessLog: { retentionDays: 7 },
        gateway: { auth: { token: 'x' } },
      }),
    ).not.toThrow();
  });
});
