// packages/server/src/gateway/auth/token.ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AuthResult, Permission } from '../rpc/types.js';

/**
 * 간이 JWT 검증 (HS256 전용)
 *
 * 보안 체크:
 * 1. 형식 검증 (3-part dot-separated)
 * 2. alg 검증 — HS256만 허용 (alg confusion attack 방어)
 * 3. 서명 검증 — timingSafeEqual (타이밍 공격 방어)
 * 4. 만료 확인 (exp claim)
 */
export function validateToken(token: string, secret: string): AuthResult {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, error: 'Invalid token format', code: 401 };
  }

  const headerB64 = parts[0];
  const payloadB64 = parts[1];
  const signatureB64 = parts[2];

  // alg 검증
  let header: { alg?: string };
  try {
    header = JSON.parse(Buffer.from(headerB64 ?? '', 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'Invalid token header', code: 401 };
  }

  if (header.alg !== 'HS256') {
    return { ok: false, error: `Unsupported algorithm: ${header.alg}`, code: 401 };
  }

  // 서명 검증
  const expectedSig = createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  const sigBuffer = Buffer.from(signatureB64 ?? '', 'base64url');
  const expectedBuffer = Buffer.from(expectedSig, 'base64url');

  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
    return { ok: false, error: 'Invalid token signature', code: 401 };
  }

  // 페이로드 파싱
  let payload: { sub?: string; clientId?: string; permissions?: string[]; exp?: number };
  try {
    payload = JSON.parse(Buffer.from(payloadB64 ?? '', 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'Invalid token payload', code: 401 };
  }

  // 만료 확인
  if (payload.exp && payload.exp < Date.now() / 1000) {
    return { ok: false, error: 'Token expired', code: 401 };
  }

  return {
    ok: true,
    info: {
      level: 'token',
      userId: payload.sub,
      clientId: payload.clientId,
      // TODO(review-2): payload.permissions 각 요소의 유효성 검증 추가 권장 — 현재는 캐스트만 수행
      permissions: (payload.permissions ?? []) as Permission[],
    },
  };
}
