import type { IncomingMessage, ServerResponse } from 'node:http';
// packages/server/src/gateway/access-log.ts
import { randomUUID } from 'node:crypto';
import type { AccessLogEntry } from './rpc/types.js';

/** 민감 쿼리 파라미터 마스킹 */
const SENSITIVE_PARAMS = new Set(['token', 'key', 'secret', 'password', 'api_key']);

export function sanitizePath(url: string): string {
  const qIdx = url.indexOf('?');
  if (qIdx === -1) {
    return url;
  }

  const path = url.slice(0, qIdx);
  const search = new URLSearchParams(url.slice(qIdx + 1));

  for (const param of SENSITIVE_PARAMS) {
    if (search.has(param)) {
      search.set(param, '***');
    }
  }

  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

type LogWriter = (entry: AccessLogEntry) => void;

/** 기본 writer: stdout JSON */
const defaultWriter: LogWriter = (entry) => {
  process.stdout.write(JSON.stringify(entry) + '\n');
};

/** 로거 팩토리 */
export function createAccessLogger(writer: LogWriter = defaultWriter) {
  return function logAccess(
    req: IncomingMessage,
    res: ServerResponse,
    extra?: { rpcMethod?: string; authLevel?: string },
  ): string {
    const requestId = (req.headers['x-request-id'] as string) ?? randomUUID();
    const startTime = Date.now();

    res.setHeader('X-Request-Id', requestId);

    res.on('finish', () => {
      const entry: AccessLogEntry = {
        requestId,
        timestamp: new Date().toISOString(),
        method: req.method ?? 'UNKNOWN',
        path: sanitizePath(req.url ?? '/'),
        statusCode: res.statusCode,
        durationMs: Date.now() - startTime,
        remoteAddress: req.socket.remoteAddress ?? 'unknown',
        userAgent: (req.headers['user-agent'] as string) ?? '',
        contentLength: Number(res.getHeader('content-length') ?? 0),
        rpcMethod: extra?.rpcMethod,
        authLevel: extra?.authLevel,
      };

      writer(entry);
    });

    return requestId;
  };
}
