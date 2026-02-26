// packages/infra/src/unhandled-rejections.ts
import { getEventBus } from './events.js';

/**
 * L1: AbortError → warn
 * L2: Fatal (OOM, 시스템) → exit
 * L3: Config (설정/인증) → exit
 * L4: Transient (네트워크) → warn
 * L5: 기타 → exit
 */
export function setupUnhandledRejectionHandler(logger: {
  warn: (msg: string) => void;
  error: (msg: string) => void;
}): void {
  process.on('unhandledRejection', (reason: unknown) => {
    const level = classifyError(reason);
    getEventBus().emit('system:unhandledRejection', level, reason);

    switch (level) {
      case 'abort':
      case 'transient':
        logger.warn(`Unhandled rejection (${level}): ${formatReason(reason)}`);
        break;
      default:
        logger.error(`Fatal unhandled rejection (${level}): ${formatReason(reason)}`);
        process.exit(1);
    }
  });
}

export type ErrorLevel = 'abort' | 'fatal' | 'config' | 'transient' | 'unknown';

/** 에러 분류 (테스트에서도 사용) */
export function classifyError(err: unknown): ErrorLevel {
  if (isAbortError(err)) {
    return 'abort';
  }
  if (isFatalError(err)) {
    return 'fatal';
  }
  if (isConfigError(err)) {
    return 'config';
  }
  if (isTransientError(err)) {
    return 'transient';
  }
  return 'unknown';
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') {
    return true;
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return true;
  }
  return false;
}

function isFatalError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const msg = err.message.toLowerCase();
  return (
    msg.includes('out of memory') ||
    msg.includes('heap') ||
    msg.includes('stack overflow') ||
    (err as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY'
  );
}

function isConfigError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const msg = err.message.toLowerCase();
  return (
    msg.includes('invalid config') ||
    msg.includes('authentication') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('invalid token')
  );
}

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as NodeJS.ErrnoException).code;
  return TRANSIENT_CODES.has(code ?? '');
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

function formatReason(reason: unknown): string {
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}`;
  }
  return String(reason);
}
