import { describe, it, expect } from 'vitest';
import { classifyError } from '../src/unhandled-rejections.js';

describe('classifyError', () => {
  it('AbortError → abort', () => {
    const err = new DOMException('aborted', 'AbortError');
    expect(classifyError(err)).toBe('abort');
  });

  it('Error with name AbortError → abort', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(classifyError(err)).toBe('abort');
  });

  it('OOM → fatal', () => {
    expect(classifyError(new Error('JavaScript heap out of memory'))).toBe('fatal');
  });

  it('stack overflow → fatal', () => {
    expect(classifyError(new Error('Maximum call stack overflow'))).toBe('fatal');
  });

  it('ECONNRESET → transient', () => {
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    expect(classifyError(err)).toBe('transient');
  });

  it('ETIMEDOUT → transient', () => {
    const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    expect(classifyError(err)).toBe('transient');
  });

  it('ECONNREFUSED → transient', () => {
    const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    expect(classifyError(err)).toBe('transient');
  });

  it('invalid config → config', () => {
    expect(classifyError(new Error('Invalid config: missing key'))).toBe('config');
  });

  it('authentication failure → config', () => {
    expect(classifyError(new Error('Authentication failed'))).toBe('config');
  });

  it('unauthorized → config', () => {
    expect(classifyError(new Error('Unauthorized access'))).toBe('config');
  });

  it('invalid token → config', () => {
    expect(classifyError(new Error('Invalid token provided'))).toBe('config');
  });

  it('알 수 없는 에러 → unknown', () => {
    expect(classifyError(new Error('something went wrong'))).toBe('unknown');
  });

  it('non-Error → unknown', () => {
    expect(classifyError('string error')).toBe('unknown');
    expect(classifyError(42)).toBe('unknown');
    expect(classifyError(null)).toBe('unknown');
  });
});
