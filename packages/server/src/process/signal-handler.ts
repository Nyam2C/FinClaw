import type { FinClawLogger } from '@finclaw/infra';
// packages/server/src/process/signal-handler.ts
import type { CleanupFn } from '@finclaw/types';

/**
 * 우아한 종료 핸들러
 *
 * SIGINT/SIGTERM 수신 시:
 * 1. 새 메시지 수신 중단
 * 2. 진행 중인 메시지 처리 완료 대기 (30초 타임아웃)
 * 3. 리소스 정리 (CleanupFn[] 순차 실행)
 * 4. 프로세스 종료
 */
export function setupGracefulShutdown(
  logger: FinClawLogger,
  getCleanupFns: () => CleanupFn[],
): void {
  let shuttingDown = false;

  const handler = async (signal: string) => {
    if (shuttingDown) {
      logger.warn(`Forced exit on second ${signal}`);
      process.exit(1);
    }

    shuttingDown = true;
    logger.info(`Received ${signal}, starting graceful shutdown...`);

    const timeout = setTimeout(() => {
      logger.error('Shutdown timeout (30s), forcing exit');
      process.exit(1);
    }, 30_000);

    try {
      for (const cleanup of getCleanupFns()) {
        try {
          await cleanup();
        } catch (err) {
          logger.error(`Cleanup error: ${String(err)}`);
        }
      }
      logger.info('Graceful shutdown complete');
      clearTimeout(timeout);
      process.exit(0);
    } catch (err) {
      logger.error(`Shutdown error: ${String(err)}`);
      clearTimeout(timeout);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void handler('SIGINT'));
  process.on('SIGTERM', () => void handler('SIGTERM'));
}
