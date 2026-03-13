import type { HookRegistry } from './registry.js';
// packages/server/src/services/hooks/runner.ts
import type { HookEntry, HookEvent, HookRunner, HookRunnerOptions } from './types.js';

/**
 * 훅 러너 생성.
 *
 * 실행 모드:
 * - parallel: Promise.allSettled로 동시 실행. 빠르지만 순서 보장 없음.
 * - sequential: 순차 실행. 에러 격리.
 * - sync: 동기적 순차 실행. async 핸들러의 Promise는 무시.
 */
export function createServiceHookRunner(
  registry: HookRegistry,
  options: HookRunnerOptions = { mode: 'parallel' },
): HookRunner {
  const { mode, timeoutMs = 30_000, onError } = options;

  function collectHandlers(event: HookEvent): HookEntry[] {
    return [
      ...registry.getHandlers(event.type),
      ...registry.getHandlers(`${event.type}:${event.action}`),
    ].filter((h) => h.enabled);
  }

  return {
    mode,
    async trigger(event: HookEvent): Promise<void> {
      const handlers = collectHandlers(event);

      switch (mode) {
        case 'parallel':
          await runParallel(handlers, event, timeoutMs, onError);
          break;
        case 'sequential':
          await runSequential(handlers, event, timeoutMs, onError);
          break;
        case 'sync':
          runSync(handlers, event, onError);
          break;
      }
    },
  };
}

async function runParallel(
  handlers: HookEntry[],
  event: HookEvent,
  timeoutMs: number,
  onError?: (error: Error, handler: HookEntry) => void,
): Promise<void> {
  const results = await Promise.allSettled(
    handlers.map((h) => {
      try {
        return withTimeout(h.handler(event), timeoutMs);
      } catch (err) {
        return Promise.reject(err);
      }
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'rejected') {
      const error =
        result.reason instanceof Error ? result.reason : new Error(String(result.reason));
      onError?.(error, handlers[i]);
    }
  }
}

async function runSequential(
  handlers: HookEntry[],
  event: HookEvent,
  timeoutMs: number,
  onError?: (error: Error, handler: HookEntry) => void,
): Promise<void> {
  for (const handler of handlers) {
    try {
      await withTimeout(handler.handler(event), timeoutMs);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      onError?.(error, handler);
    }
  }
}

function runSync(
  handlers: HookEntry[],
  event: HookEvent,
  onError?: (error: Error, handler: HookEntry) => void,
): void {
  for (const handler of handlers) {
    try {
      handler.handler(event); // async 결과 무시
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      onError?.(error, handler);
    }
  }
}

function withTimeout<T>(promise: Promise<T> | T, ms: number): Promise<T> {
  if (!(promise instanceof Promise)) {
    return Promise.resolve(promise);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Hook timeout after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
