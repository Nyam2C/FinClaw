// packages/gateway/src/auth/sign.ts
import { createHmac } from 'node:crypto';

export interface SignTokenClaims {
  /** subject = userId */
  readonly sub: string;
  /** CLI spawn 별 sessionId (MCP ctx 조립용) */
  readonly sessionId?: string;
  /** 만료 (epoch seconds). 미지정 시 발급 + 15분. */
  readonly exp?: number;
}

/**
 * 간이 JWT 발급 (HS256). validateToken (token.ts) 과 대칭. 로컬 클라이언트용 토큰 발급에 쓴다.
 */
export function signToken(claims: SignTokenClaims, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const exp = claims.exp ?? Math.floor(Date.now() / 1000) + 15 * 60;
  const payload = base64url(
    JSON.stringify({
      sub: claims.sub,
      ...(claims.sessionId ? { sessionId: claims.sessionId } : {}),
      exp,
    }),
  );
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function base64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}
