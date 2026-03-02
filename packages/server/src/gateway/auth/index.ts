// packages/server/src/gateway/auth/index.ts
import type { IncomingMessage } from 'node:http';
import { getEventBus } from '@finclaw/infra';
import type { AuthResult, GatewayServerConfig } from '../rpc/types.js';
import { validateApiKey } from './api-key.js';
import { validateToken } from './token.js';

/**
 * 요청의 인증 정보를 추출하고 검증한다.
 *
 * 우선순위: Bearer token > X-API-Key > none
 */
export async function authenticate(
  req: IncomingMessage,
  config: GatewayServerConfig['auth'],
): Promise<AuthResult> {
  const authorization = req.headers.authorization;
  const apiKey = req.headers['x-api-key'] as string | undefined;
  const ip = req.socket.remoteAddress ?? 'unknown';

  // Bearer 토큰 인증
  if (authorization?.startsWith('Bearer ')) {
    const token = authorization.slice(7);
    const result = validateToken(token, config.jwtSecret);
    if (!result.ok) {
      getEventBus().emit('gateway:auth:failure', ip, result.error);
    }
    return result;
  }

  // API 키 인증
  if (apiKey) {
    const result = validateApiKey(apiKey, config.apiKeys);
    if (!result.ok) {
      getEventBus().emit('gateway:auth:failure', ip, result.error);
    }
    return result;
  }

  // 인증 없음 (public 엔드포인트만 접근 가능)
  return {
    ok: true,
    info: {
      level: 'none',
      permissions: [],
    },
  };
}

/** re-export for convenience */
export { validateApiKey } from './api-key.js';
export { validateToken } from './token.js';
export { AuthRateLimiter, type RateLimiterOptions } from './rate-limit.js';
