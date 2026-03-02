import { RPC_ERROR_CODES } from '@finclaw/types';
// packages/server/src/gateway/rpc/errors.test.ts
import { describe, it, expect } from 'vitest';
import { RpcErrors, createError } from './errors.js';

describe('RpcErrors', () => {
  it('includes all standard RPC_ERROR_CODES', () => {
    for (const [key, value] of Object.entries(RPC_ERROR_CODES)) {
      expect(RpcErrors).toHaveProperty(key, value);
    }
  });

  it('defines gateway-specific codes in -32005 ~ -32099 range', () => {
    const gatewayOnly = [
      RpcErrors.AGENT_NOT_FOUND,
      RpcErrors.EXECUTION_ERROR,
      RpcErrors.CONTEXT_OVERFLOW,
    ];
    for (const code of gatewayOnly) {
      expect(code).toBeLessThanOrEqual(-32005);
      expect(code).toBeGreaterThanOrEqual(-32099);
    }
  });

  it('has no duplicate codes', () => {
    const codes = Object.values(RpcErrors);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('createError', () => {
  it('creates JSON-RPC 2.0 error response with id', () => {
    const result = createError(1, RpcErrors.PARSE_ERROR, 'bad json');
    expect(result).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32700, message: 'bad json' },
    });
  });

  it('creates error response with string id', () => {
    const result = createError('abc', RpcErrors.METHOD_NOT_FOUND, 'nope');
    expect(result.id).toBe('abc');
    expect(result.error?.code).toBe(-32601);
  });

  it('uses null id when id is null', () => {
    const result = createError(null, RpcErrors.INTERNAL_ERROR, 'fail');
    expect(result.id).toBeNull();
  });

  it('includes optional data field', () => {
    const result = createError(1, RpcErrors.INVALID_PARAMS, 'bad', { field: 'x' });
    expect(result.error?.data).toEqual({ field: 'x' });
  });

  it('omits data field when undefined', () => {
    const result = createError(1, RpcErrors.INTERNAL_ERROR, 'fail');
    expect(result.error).not.toHaveProperty('data');
  });
});
