// packages/server/src/gateway/access-log.test.ts
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { sanitizePath, createAccessLogger } from './access-log.js';

describe('sanitizePath', () => {
  it('쿼리 없는 경로는 그대로 반환', () => {
    expect(sanitizePath('/health')).toBe('/health');
  });

  it('민감 파라미터 마스킹', () => {
    expect(sanitizePath('/api?token=abc123&name=test')).toBe('/api?token=***&name=test');
  });

  it('여러 민감 파라미터 동시 마스킹', () => {
    const result = sanitizePath('/api?key=k1&secret=s1&normal=ok');
    expect(result).toContain('key=***');
    expect(result).toContain('secret=***');
    expect(result).toContain('normal=ok');
  });

  it('민감 파라미터 없으면 그대로', () => {
    expect(sanitizePath('/api?page=1&sort=asc')).toBe('/api?page=1&sort=asc');
  });
});

describe('createAccessLogger', () => {
  function createMockReqRes(method: string, url: string, headers: Record<string, string> = {}) {
    const res = new EventEmitter() as EventEmitter & {
      statusCode: number;
      setHeader: ReturnType<typeof vi.fn>;
      getHeader: ReturnType<typeof vi.fn>;
    };
    res.statusCode = 200;
    res.setHeader = vi.fn();
    res.getHeader = vi.fn().mockReturnValue('0');

    const req = {
      method,
      url,
      headers,
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as import('node:http').IncomingMessage;

    return { req, res: res as unknown as import('node:http').ServerResponse };
  }

  it('requestId를 반환하고 X-Request-Id 헤더를 설정', () => {
    const writer = vi.fn();
    const logger = createAccessLogger(writer);
    const { req, res } = createMockReqRes('GET', '/health');

    const requestId = logger(req, res);

    expect(typeof requestId).toBe('string');
    expect(requestId.length).toBeGreaterThan(0);
    expect(
      (res as unknown as { setHeader: ReturnType<typeof vi.fn> }).setHeader,
    ).toHaveBeenCalledWith('X-Request-Id', requestId);
  });

  it('클라이언트 제공 X-Request-Id 전달', () => {
    const writer = vi.fn();
    const logger = createAccessLogger(writer);
    const { req, res } = createMockReqRes('POST', '/rpc', {
      'x-request-id': 'client-req-123',
    });

    const requestId = logger(req, res);
    expect(requestId).toBe('client-req-123');
  });

  it('res finish 이벤트 시 로그 writer 호출', () => {
    const writer = vi.fn();
    const logger = createAccessLogger(writer);
    const { req, res } = createMockReqRes('GET', '/health');

    logger(req, res);

    // finish 이벤트 발생
    (res as unknown as EventEmitter).emit('finish');

    expect(writer).toHaveBeenCalledTimes(1);
    const entry = writer.mock.calls[0][0];
    expect(entry.method).toBe('GET');
    expect(entry.path).toBe('/health');
    expect(entry.statusCode).toBe(200);
    expect(entry.remoteAddress).toBe('127.0.0.1');
    expect(typeof entry.durationMs).toBe('number');
  });

  it('extra 필드 포함', () => {
    const writer = vi.fn();
    const logger = createAccessLogger(writer);
    const { req, res } = createMockReqRes('POST', '/rpc');

    logger(req, res, { rpcMethod: 'system.ping', authLevel: 'token' });
    (res as unknown as EventEmitter).emit('finish');

    const entry = writer.mock.calls[0][0];
    expect(entry.rpcMethod).toBe('system.ping');
    expect(entry.authLevel).toBe('token');
  });

  it('sanitizePath 적용 확인', () => {
    const writer = vi.fn();
    const logger = createAccessLogger(writer);
    const { req, res } = createMockReqRes('GET', '/api?token=secret123');

    logger(req, res);
    (res as unknown as EventEmitter).emit('finish');

    const entry = writer.mock.calls[0][0];
    expect(entry.path).not.toContain('secret123');
    expect(entry.path).toContain('***');
  });
});
