import { describe, it, expect, beforeEach } from 'vitest';
import { runWithContext } from '../src/context.js';
import { createLogger, type FinClawLogger } from '../src/logger.js';

describe('createLogger', () => {
  let logger: FinClawLogger;

  beforeEach(() => {
    logger = createLogger({
      name: 'test',
      level: 'trace',
      console: { enabled: true, pretty: false },
    });
  });

  it('모든 레벨 메서드를 가진다', () => {
    expect(typeof logger.trace).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.fatal).toBe('function');
  });

  it('에러 없이 로그를 기록한다', () => {
    expect(() => logger.info('test message')).not.toThrow();
    expect(() => logger.error('error message', { key: 'value' })).not.toThrow();
  });

  it('child 로거를 생성한다', () => {
    const child = logger.child('sub');
    expect(typeof child.info).toBe('function');
    expect(() => child.info('child message')).not.toThrow();
  });

  it('flush가 정상 resolve된다', async () => {
    await expect(logger.flush()).resolves.toBeUndefined();
  });
});

describe('ALS 컨텍스트 자동 주입', () => {
  it('runWithContext 내에서 로그 시 에러 없이 동작한다', () => {
    const logger = createLogger({
      name: 'ctx-test',
      level: 'trace',
      console: { enabled: true, pretty: false },
      autoInjectContext: true,
    });

    const ctx = { requestId: 'req-123', startedAt: Date.now() };
    runWithContext(ctx, () => {
      expect(() => logger.info('with context')).not.toThrow();
    });
  });

  it('autoInjectContext: false에서도 동작한다', () => {
    const logger = createLogger({
      name: 'no-ctx-test',
      level: 'trace',
      console: { enabled: true, pretty: false },
      autoInjectContext: false,
    });

    expect(() => logger.info('without context')).not.toThrow();
  });
});
