// packages/server/src/gateway/auth/api-key.ts
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AuthResult } from '../rpc/types.js';

/**
 * API 키 인증
 *
 * 1. 클라이언트 키와 허용 키 모두 SHA-256 해시
 * 2. timingSafeEqual로 비교 (Buffer 길이 동일 보장)
 * 3. 일치하면 api_key 레벨 AuthInfo 반환
 */
export function validateApiKey(key: string, allowedKeys: readonly string[]): AuthResult {
  const keyHash = createHash('sha256').update(key).digest();

  const found = allowedKeys.some((allowed) => {
    const allowedHash = createHash('sha256').update(allowed).digest();
    return keyHash.length === allowedHash.length && timingSafeEqual(keyHash, allowedHash);
  });

  if (!found) {
    return { ok: false, error: 'Invalid API key', code: 401 };
  }

  return {
    ok: true,
    info: {
      level: 'api_key',
      clientId: keyHash.toString('hex').slice(0, 8),
      permissions: ['chat:read', 'chat:write', 'chat:execute'],
    },
  };
}
