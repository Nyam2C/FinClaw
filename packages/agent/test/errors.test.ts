import { FinClawError } from '@finclaw/infra';
import { describe, it, expect } from 'vitest';
import { FailoverError, classifyFallbackError, maskApiKey } from '../src/errors.js';

describe('FailoverError', () => {
  it('FinClawError를 상속한다', () => {
    const err = new FailoverError('rate limited', 'rate-limit', { statusCode: 429 });
    expect(err).toBeInstanceOf(FinClawError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('FailoverError');
    expect(err.fallbackReason).toBe('rate-limit');
    expect(err.code).toBe('FAILOVER_RATE_LIMIT');
    expect(err.statusCode).toBe(429);
  });

  it('cause를 체이닝한다', () => {
    const cause = new Error('original');
    const err = new FailoverError('wrapped', 'server-error', { cause });
    expect(err.cause).toBe(cause);
  });
});

describe('classifyFallbackError', () => {
  it('FailoverError → 직접 reason 반환', () => {
    const err = new FailoverError('test', 'timeout');
    expect(classifyFallbackError(err)).toBe('timeout');
  });

  it('FinClawError statusCode 429 → rate-limit', () => {
    const err = new FinClawError('limit', 'RATE', { statusCode: 429 });
    expect(classifyFallbackError(err)).toBe('rate-limit');
  });

  it('SDK .status 500 → server-error', () => {
    const err = Object.assign(new Error('internal'), { status: 500 });
    expect(classifyFallbackError(err)).toBe('server-error');
  });

  it('SDK .status 529 → model-unavailable', () => {
    const err = Object.assign(new Error('overloaded'), { status: 529 });
    expect(classifyFallbackError(err)).toBe('model-unavailable');
  });

  it('AbortError → null', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(classifyFallbackError(err)).toBeNull();
  });

  it('401 → null (인증 에러는 폴백 불가)', () => {
    const err = Object.assign(new Error('unauthorized'), { status: 401 });
    expect(classifyFallbackError(err)).toBeNull();
  });

  it('403 → null', () => {
    const err = Object.assign(new Error('forbidden'), { status: 403 });
    expect(classifyFallbackError(err)).toBeNull();
  });

  it('ECONNRESET → timeout', () => {
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    expect(classifyFallbackError(err)).toBe('timeout');
  });

  it('ETIMEDOUT → timeout', () => {
    const err = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    expect(classifyFallbackError(err)).toBe('timeout');
  });

  it('context length 메시지 → context-overflow', () => {
    const err = new Error('maximum context length exceeded');
    expect(classifyFallbackError(err)).toBe('context-overflow');
  });

  it('분류 불가 에러 → null', () => {
    const err = new Error('unknown error');
    expect(classifyFallbackError(err)).toBeNull();
  });
});

describe('maskApiKey', () => {
  it('긴 키를 마스킹한다', () => {
    expect(maskApiKey('sk-1234567890abcdef')).toBe('sk-...cdef');
  });

  it('짧은 키는 ***로 대체한다', () => {
    expect(maskApiKey('short')).toBe('***');
    expect(maskApiKey('12345678')).toBe('***');
  });

  it('9자 이상이면 마스킹 적용', () => {
    expect(maskApiKey('123456789')).toBe('123...6789');
  });
});
