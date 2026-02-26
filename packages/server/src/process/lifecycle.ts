import type { FinClawLogger } from '@finclaw/infra';
// packages/server/src/process/lifecycle.ts
import type { CleanupFn } from '@finclaw/types';
import { setupGracefulShutdown } from './signal-handler.js';

export interface ProcessLifecycleDeps {
  logger: FinClawLogger;
}

/**
 * 프로세스 라이프사이클 관리자
 *
 * - CleanupFn 등록/해제
 * - 시그널 핸들러 연동
 * - 정리 함수를 등록 역순으로 실행 (LIFO)
 */
export class ProcessLifecycle {
  private readonly cleanupFns: CleanupFn[] = [];
  private readonly logger: FinClawLogger;
  private initialized = false;

  constructor(deps: ProcessLifecycleDeps) {
    this.logger = deps.logger;
  }

  /** 정리 함수 등록 (LIFO 순서로 실행됨) */
  register(fn: CleanupFn): void {
    this.cleanupFns.push(fn);
  }

  /** 시그널 핸들러 초기화 (한 번만 호출) */
  init(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    // 시그널 발생 시점에 최신 배열을 읽도록 getter 전달
    setupGracefulShutdown(this.logger, () => [...this.cleanupFns].toReversed());
    this.logger.info('Process lifecycle initialized');
  }

  /** 수동 종료 (테스트 등에서 사용) */
  async shutdown(): Promise<void> {
    this.logger.info('Manual shutdown initiated');
    const reversed = [...this.cleanupFns].toReversed();
    for (const cleanup of reversed) {
      try {
        await cleanup();
      } catch (err) {
        this.logger.error(`Cleanup error: ${String(err)}`);
      }
    }
  }
}
