import type { IncomingMessage } from 'node:http';
import { resetEventBus } from '@finclaw/infra';
import { createHmac } from 'node:crypto';
// packages/server/src/gateway/auth/index.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { GatewayServerConfig } from '../rpc/types.js';
import { validateApiKey } from './api-key.js';
import { authenticate } from './index.js';
import { validateToken } from './token.js';

const TEST_SECRET = 'test-jwt-secret-for-unit-tests';
const TEST_API_KEYS = ['valid-key-1', 'valid-key-2'];

/** HS256 JWT 생성 헬퍼 */
function createJwt(payload: Record<string, unknown>, secret: string = TEST_SECRET): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function makeConfig(): GatewayServerConfig['auth'] {
  return {
    apiKeys: TEST_API_KEYS,
    jwtSecret: TEST_SECRET,
    sessionTtlMs: 60_000,
  };
}

function makeReq(headers: Record<string, string> = {}): IncomingMessage {
  return {
    headers,
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;
}

describe('Auth Chain', () => {
  beforeEach(() => {
    resetEventBus();
  });

  describe('authenticate — priority: Bearer > X-API-Key > none', () => {
    it('returns none auth when no credentials provided', async () => {
      const result = await authenticate(makeReq(), makeConfig());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.info.level).toBe('none');
        expect(result.info.permissions).toEqual([]);
      }
    });

    it('authenticates with valid Bearer token', async () => {
      const token = createJwt({
        sub: 'user-1',
        clientId: 'client-1',
        permissions: ['chat:read', 'chat:write'],
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const result = await authenticate(
        makeReq({ authorization: `Bearer ${token}` }),
        makeConfig(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.info.level).toBe('token');
        expect(result.info.userId).toBe('user-1');
      }
    });

    it('rejects expired Bearer token', async () => {
      const token = createJwt({
        sub: 'user-1',
        exp: Math.floor(Date.now() / 1000) - 3600,
      });
      const result = await authenticate(
        makeReq({ authorization: `Bearer ${token}` }),
        makeConfig(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('expired');
      }
    });

    it('authenticates with valid X-API-Key', async () => {
      const result = await authenticate(makeReq({ 'x-api-key': 'valid-key-1' }), makeConfig());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.info.level).toBe('api_key');
      }
    });

    it('rejects invalid X-API-Key', async () => {
      const result = await authenticate(makeReq({ 'x-api-key': 'wrong-key' }), makeConfig());
      expect(result.ok).toBe(false);
    });

    it('prefers Bearer over X-API-Key when both present', async () => {
      const token = createJwt({
        sub: 'user-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const result = await authenticate(
        makeReq({
          authorization: `Bearer ${token}`,
          'x-api-key': 'valid-key-1',
        }),
        makeConfig(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.info.level).toBe('token');
      }
    });
  });
});

describe('validateApiKey', () => {
  it('accepts valid key', () => {
    const result = validateApiKey('valid-key-1', TEST_API_KEYS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info.level).toBe('api_key');
      expect(result.info.clientId).toBeDefined();
      expect(result.info.permissions).toContain('chat:read');
    }
  });

  it('rejects invalid key', () => {
    const result = validateApiKey('bad-key', TEST_API_KEYS);
    expect(result.ok).toBe(false);
  });

  it('rejects empty key', () => {
    const result = validateApiKey('', TEST_API_KEYS);
    expect(result.ok).toBe(false);
  });
});

describe('validateToken', () => {
  it('accepts valid HS256 token', () => {
    const token = createJwt({
      sub: 'user-1',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const result = validateToken(token, TEST_SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info.level).toBe('token');
      expect(result.info.userId).toBe('user-1');
    }
  });

  it('rejects token with wrong secret', () => {
    const token = createJwt({ sub: 'user-1' }, 'wrong-secret');
    const result = validateToken(token, TEST_SECRET);
    expect(result.ok).toBe(false);
  });

  it('rejects non-HS256 algorithm', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64url');
    const token = `${header}.${body}.fakesig`;
    const result = validateToken(token, TEST_SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Unsupported algorithm');
    }
  });

  it('rejects malformed token (not 3 parts)', () => {
    const result = validateToken('not.a-jwt', TEST_SECRET);
    expect(result.ok).toBe(false);
  });

  it('rejects expired token', () => {
    const token = createJwt({
      sub: 'user-1',
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    const result = validateToken(token, TEST_SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('expired');
    }
  });

  it('accepts token without exp (no expiry)', () => {
    const token = createJwt({ sub: 'user-1' });
    const result = validateToken(token, TEST_SECRET);
    expect(result.ok).toBe(true);
  });
});
