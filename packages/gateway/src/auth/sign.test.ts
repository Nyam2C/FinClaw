import { describe, expect, it } from 'vitest';
import { signToken } from './sign.js';
import { validateToken } from './token.js';

describe('signToken <-> validateToken round-trip', () => {
  const secret = 'test-secret';

  it('signs a token that validateToken accepts, carrying sub + sessionId', () => {
    const token = signToken({ sub: 'user1', sessionId: 'sess1' }, secret);
    const result = validateToken(token, secret);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info.userId).toBe('user1');
      expect(result.info.sessionId).toBe('sess1');
    }
  });

  it('produces an HS256 header (alg confusion 방어 통과)', () => {
    const token = signToken({ sub: 'u' }, secret);
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
    expect(header.alg).toBe('HS256');
  });

  it('rejects a token signed with a different secret', () => {
    const token = signToken({ sub: 'u' }, secret);
    expect(validateToken(token, 'other-secret').ok).toBe(false);
  });

  it('always carries an exp claim (default: issued + 15min, explicit exp kept)', () => {
    const payload = (t: string) =>
      JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8')) as { exp: number };
    const now = Math.floor(Date.now() / 1000);
    expect(payload(signToken({ sub: 'u' }, secret)).exp).toBeGreaterThanOrEqual(now + 15 * 60);
    expect(payload(signToken({ sub: 'u', exp: now + 600 }, secret)).exp).toBe(now + 600);
  });

  it('rejects an expired token', () => {
    const token = signToken({ sub: 'u', exp: Math.floor(Date.now() / 1000) - 10 }, secret);
    expect(validateToken(token, secret).ok).toBe(false);
  });
});
