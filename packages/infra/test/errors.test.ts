import { describe, it, expect } from 'vitest';
import {
  FinClawError,
  SsrfBlockedError,
  PortInUseError,
  isFinClawError,
  wrapError,
  extractErrorInfo,
} from '../src/errors.js';

describe('FinClawError', () => {
  it('기본값으로 생성된다', () => {
    const err = new FinClawError('test', 'TEST_CODE');
    expect(err.message).toBe('test');
    expect(err.code).toBe('TEST_CODE');
    expect(err.statusCode).toBe(500);
    expect(err.isOperational).toBe(true);
    expect(err.name).toBe('FinClawError');
  });

  it('옵션으로 커스터마이징된다', () => {
    const cause = new Error('root');
    const err = new FinClawError('test', 'CODE', {
      statusCode: 400,
      isOperational: false,
      cause,
      details: { key: 'value' },
    });
    expect(err.statusCode).toBe(400);
    expect(err.isOperational).toBe(false);
    expect(err.cause).toBe(cause);
    expect(err.details).toEqual({ key: 'value' });
  });

  it('Error를 상속한다', () => {
    const err = new FinClawError('test', 'CODE');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FinClawError);
    expect(err.stack).toBeDefined();
  });
});

describe('SsrfBlockedError', () => {
  it('hostname과 ip를 포함한다', () => {
    const err = new SsrfBlockedError('evil.com', '10.0.0.1');
    expect(err.code).toBe('SSRF_BLOCKED');
    expect(err.statusCode).toBe(403);
    expect(err.details).toEqual({ hostname: 'evil.com', ip: '10.0.0.1' });
    expect(err.name).toBe('SsrfBlockedError');
  });
});

describe('PortInUseError', () => {
  it('포트 정보를 포함한다', () => {
    const err = new PortInUseError(8080, 'node');
    expect(err.code).toBe('PORT_IN_USE');
    expect(err.message).toContain('8080');
    expect(err.message).toContain('node');
  });

  it('occupiedBy 없이 생성 가능하다', () => {
    const err = new PortInUseError(3000);
    expect(err.message).toContain('3000');
    expect(err.message).not.toContain('by');
  });
});

describe('isFinClawError', () => {
  it('FinClawError 인스턴스에 true', () => {
    expect(isFinClawError(new FinClawError('test', 'CODE'))).toBe(true);
  });

  it('하위 클래스에도 true', () => {
    expect(isFinClawError(new SsrfBlockedError('h', '1'))).toBe(true);
  });

  it('일반 Error에 false', () => {
    expect(isFinClawError(new Error('test'))).toBe(false);
  });

  it('non-Error에 false', () => {
    expect(isFinClawError('string')).toBe(false);
    expect(isFinClawError(null)).toBe(false);
  });
});

describe('wrapError', () => {
  it('Error를 cause로 체이닝한다', () => {
    const original = new Error('original');
    const wrapped = wrapError('wrapped', 'WRAP', original);
    expect(wrapped.cause).toBe(original);
    expect(wrapped.code).toBe('WRAP');
  });

  it('non-Error를 Error로 변환하여 cause에 넣는다', () => {
    const wrapped = wrapError('wrapped', 'WRAP', 'string cause');
    expect(wrapped.cause).toBeInstanceOf(Error);
    expect((wrapped.cause as Error).message).toBe('string cause');
  });
});

describe('extractErrorInfo', () => {
  it('FinClawError에서 구조화된 정보를 추출한다', () => {
    const cause = new Error('root');
    const err = new FinClawError('test', 'CODE', { cause });
    const info = extractErrorInfo(err);
    expect(info.code).toBe('CODE');
    expect(info.message).toBe('test');
    expect(info.isOperational).toBe(true);
    expect(info.cause).toBe('root');
  });

  it('일반 Error에서 기본 정보를 추출한다', () => {
    const info = extractErrorInfo(new Error('plain'));
    expect(info.code).toBe('UNKNOWN');
    expect(info.message).toBe('plain');
  });

  it('non-Error를 문자열로 변환한다', () => {
    const info = extractErrorInfo(42);
    expect(info.code).toBe('UNKNOWN');
    expect(info.message).toBe('42');
  });
});
