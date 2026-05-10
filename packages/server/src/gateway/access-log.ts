// packages/server/src/gateway/access-log.ts
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { addAccessLog, type AccessLogEntry as DbAccessLogEntry } from '@finclaw/storage';
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

/**
 * Phase 30 C3: SQLite dual-write 옵션. db 미주입 시 stdout 만 (이전 동작 유지).
 *
 * 본 옵션은 외부 호환성 보존을 위해 단일 LogWriter signature 도 그대로 받는다 —
 * `createAccessLogger()` / `createAccessLogger(customWriter)` 둘 다 작동.
 */
export interface AccessLoggerOptions {
  readonly writer?: LogWriter;
  readonly db?: DatabaseSync;
  /** 현재 active span 의 traceId 를 가져오는 함수 (옵션). */
  readonly getTraceId?: () => string | undefined;
}

function hashParams(req: IncomingMessage, extra?: { rpcMethod?: string }): string {
  // 1차 구현: rpcMethod + sanitized URL 의 sha256(앞 16 hex). 요청 body 는 stream 이라 직접 read 불가.
  const seed = `${extra?.rpcMethod ?? ''}|${sanitizePath(req.url ?? '')}`;
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

/**
 * 로거 팩토리 — backward-compat: 인자가 함수면 LogWriter, 객체면 옵션.
 */
export function createAccessLogger(arg?: LogWriter | AccessLoggerOptions) {
  const options: AccessLoggerOptions = typeof arg === 'function' ? { writer: arg } : (arg ?? {});
  const writer = options.writer ?? defaultWriter;

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

      // Phase 30 C3: SQLite 동시 기록 (best-effort — stdout 는 이미 나갔음).
      if (options.db) {
        const dbEntry: DbAccessLogEntry = {
          ts: Date.now(),
          method: extra?.rpcMethod ?? entry.method,
          paramsHash: hashParams(req, extra),
          actor: extra?.authLevel,
          ip: entry.remoteAddress,
          durationMs: entry.durationMs,
          status: String(entry.statusCode),
          traceId: options.getTraceId?.(),
        };
        try {
          addAccessLog(options.db, dbEntry);
        } catch {
          // best-effort
        }
      }
    });

    return requestId;
  };
}
