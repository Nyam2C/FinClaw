// packages/server/src/gateway/router.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GatewayServerContext } from './context.js';
import { handleCors } from './cors.js';
import { createError, RpcErrors } from './rpc/errors.js';
import { dispatchRpc } from './rpc/index.js';

interface Route {
  readonly method: string;
  readonly path: string;
  handler(req: IncomingMessage, res: ServerResponse, ctx: GatewayServerContext): Promise<void>;
}

const routes: Route[] = [
  { method: 'POST', path: '/rpc', handler: handleRpcRequest },
  { method: 'GET', path: '/health', handler: handleHealthRequest },
  { method: 'GET', path: '/info', handler: handleInfoRequest },
];

/** HTTP 요청을 적절한 핸들러로 라우팅 */
export async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayServerContext,
): Promise<void> {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    handleCors(req, res, ctx.config.cors);
    return;
  }

  // CORS 헤더
  handleCors(req, res, ctx.config.cors);

  // 라우트 매칭
  const route = routes.find((r) => r.method === req.method && req.url?.startsWith(r.path));

  if (!route) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return;
  }

  try {
    await route.handler(req, res, ctx);
  } catch {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal Server Error' }));
  }
}

/** POST /rpc — JSON-RPC 엔드포인트 */
async function handleRpcRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayServerContext,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    const errResp = createError(null, RpcErrors.PARSE_ERROR, 'Failed to read request body');
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errResp));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const errResp = createError(null, RpcErrors.PARSE_ERROR, 'Invalid JSON');
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errResp));
    return;
  }

  const response = await dispatchRpc(
    parsed as Parameters<typeof dispatchRpc>[0],
    {
      auth: { level: 'none', permissions: [] },
      remoteAddress: req.socket.remoteAddress ?? 'unknown',
    },
    ctx,
  );

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
}

/** GET /health — 헬스 체크 shortcut */
async function handleHealthRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayServerContext,
): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      connections: ctx.connections.size,
      activeSessions: ctx.registry.activeCount(),
    }),
  );
}

/** GET /info — 서버 정보 */
async function handleInfoRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: GatewayServerContext,
): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      name: 'finclaw-gateway',
      version: '0.1.0',
      capabilities: ['streaming', 'batch', 'subscriptions'],
    }),
  );
}

/** 요청 body 읽기 (스트리밍) */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
