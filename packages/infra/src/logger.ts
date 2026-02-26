import type { LogLevel } from '@finclaw/types';
// packages/infra/src/logger.ts
import { Logger as TsLogger } from 'tslog';
import { getContext } from './context.js';
import { attachFileTransport, type FileTransportConfig } from './logger-transports.js';

export interface LoggerConfig {
  name: string;
  level?: LogLevel;
  file?: FileTransportConfig;
  console?: {
    enabled: boolean;
    pretty?: boolean; // 기본: !isCI
  };
  redactKeys?: string[];
  autoInjectContext?: boolean; // 기본: true
}

/** 로거 팩토리 인터페이스 — DI/테스트 교체 지점 */
export interface LoggerFactory {
  create(config: LoggerConfig): FinClawLogger;
}

export interface FinClawLogger {
  trace(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  fatal(msg: string, ...args: unknown[]): void;
  child(name: string): FinClawLogger;
  flush(): Promise<void>;
}

const DEFAULT_REDACT_KEYS = [
  'token',
  'password',
  'secret',
  'apiKey',
  'api_key',
  'authorization',
  'cookie',
  'botToken',
];

const LOG_LEVEL_MAP: Record<LogLevel, number> = {
  trace: 1,
  debug: 2,
  info: 3,
  warn: 4,
  error: 5,
  fatal: 6,
};

/** FinClaw 로거 팩토리 (기본 구현) */
export function createLogger(config: LoggerConfig): FinClawLogger {
  const isCI = process.env.CI === 'true';
  const tsLogger = new TsLogger({
    name: config.name,
    minLevel: LOG_LEVEL_MAP[config.level ?? 'info'],
    type: (config.console?.pretty ?? !isCI) ? 'pretty' : 'json',
    maskValuesOfKeys: config.redactKeys ?? DEFAULT_REDACT_KEYS,
    hideLogPositionForProduction: true,
  });

  // 파일 트랜스포트 부착
  if (config.file?.enabled) {
    attachFileTransport(tsLogger, config.file);
  }

  return wrapLogger(tsLogger, config.autoInjectContext ?? true);
}

/** tslog 인스턴스를 FinClawLogger로 래핑 */
function wrapLogger(tsLogger: TsLogger<unknown>, injectContext: boolean): FinClawLogger {
  const withCtx = (args: unknown[]): unknown[] => {
    if (!injectContext) {
      return args;
    }
    const ctx = getContext();
    if (!ctx) {
      return args;
    }
    return [{ _ctx: { requestId: ctx.requestId, sessionKey: ctx.sessionKey } }, ...args];
  };

  const flushCallbacks: (() => Promise<void>)[] = [];

  return {
    trace: (msg, ...args) => tsLogger.trace(msg, ...withCtx(args)),
    debug: (msg, ...args) => tsLogger.debug(msg, ...withCtx(args)),
    info: (msg, ...args) => tsLogger.info(msg, ...withCtx(args)),
    warn: (msg, ...args) => tsLogger.warn(msg, ...withCtx(args)),
    error: (msg, ...args) => tsLogger.error(msg, ...withCtx(args)),
    fatal: (msg, ...args) => tsLogger.fatal(msg, ...withCtx(args)),
    child: (name: string) => {
      const childTsLogger = tsLogger.getSubLogger({ name });
      return wrapLogger(childTsLogger, injectContext);
    },
    flush: async () => {
      await Promise.all(flushCallbacks.map((fn) => fn()));
    },
  };
}

/** 기본 LoggerFactory 구현 */
export const defaultLoggerFactory: LoggerFactory = {
  create: createLogger,
};
