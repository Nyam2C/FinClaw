// packages/config/test/validation.test.ts
import { describe, it, expect } from 'vitest';
import { ConfigValidationError } from '../src/errors.js';
import { validateConfig, validateConfigStrict } from '../src/validation.js';

describe('validateConfig', () => {
  it('유효한 설정에 valid: true를 반환한다', () => {
    const result = validateConfig({ gateway: { port: 8080 } });
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.config).toEqual({ gateway: { port: 8080 } });
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
    const result = validateConfig({ gateway: { port: -1 } });
    expect(result.valid).toBe(false);
    const portIssue = result.issues.find((i) => i.path.includes('port'));
    expect(portIssue).toBeDefined();
  });
});

describe('validateConfigStrict', () => {
  it('유효한 설정에 config를 반환한다', () => {
    const config = validateConfigStrict({ logging: { level: 'debug' } });
    expect(config).toEqual({ logging: { level: 'debug' } });
  });

  it('잘못된 설정에 ConfigValidationError를 throw한다', () => {
    expect(() => validateConfigStrict({ unknown_key: true })).toThrow(ConfigValidationError);
  });
});
