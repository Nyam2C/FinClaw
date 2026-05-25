// packages/server/src/gateway/cors.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GatewayServerConfig } from './rpc/types.js';

type CorsConfig = GatewayServerConfig['cors'];

/** CORS 헤더 설정 + OPTIONS preflight 처리 */
export function handleCors(req: IncomingMessage, res: ServerResponse, config: CorsConfig): void {
  const origin = req.headers.origin;

  if (!origin || !config?.origins.length) {
    return;
  }

  const allowed = config.origins.includes('*') || config.origins.includes(origin);
  if (!allowed) {
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (config.maxAge) {
    res.setHeader('Access-Control-Max-Age', String(config.maxAge));
  }

  // OPTIONS preflight → 204 No Content
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
  }
}
