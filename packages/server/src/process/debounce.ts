// packages/server/src/process/debounce.ts

export interface DebounceConfig {
  /** 디바운스 윈도우 (ms, 기본: 1000) */
  windowMs?: number;
  /** 최대 대기 시간 (ms, 기본: 5000) */
  maxWaitMs?: number;
  /** handler rejection 콜백 (미제공 시 무시) */
  onError?: (err: unknown) => void;
}

/**
 * 인바운드 메시지 디바운서
 *
 * - 키별 독립 타이머
 * - 윈도우 내 마지막 메시지만 처리
 * - maxWait로 무한 지연 방지
 */
export function createDebouncer<T>(
  handler: (key: string, value: T) => Promise<void>,
  config: DebounceConfig = {},
): {
  push(key: string, value: T): void;
  flush(key: string): void;
  destroy(): void;
} {
  const windowMs = config.windowMs ?? 1000;
  const maxWaitMs = config.maxWaitMs ?? 5000;
  const onError = config.onError ?? (() => {});

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const maxTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<string, T>();

  function fire(key: string): void {
    const value = pending.get(key);
    if (value === undefined) {
      return;
    }

    pending.delete(key);
    clearTimeout(timers.get(key));
    clearTimeout(maxTimers.get(key));
    timers.delete(key);
    maxTimers.delete(key);

    handler(key, value).catch(onError);
  }

  return {
    push(key, value) {
      pending.set(key, value);

      // 윈도우 타이머 리셋
      clearTimeout(timers.get(key));
      timers.set(
        key,
        setTimeout(() => fire(key), windowMs),
      );

      // maxWait 타이머 (최초 1회만)
      if (!maxTimers.has(key)) {
        maxTimers.set(
          key,
          setTimeout(() => fire(key), maxWaitMs),
        );
      }
    },
    flush(key) {
      fire(key);
    },
    destroy() {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      for (const timer of maxTimers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      maxTimers.clear();
      pending.clear();
    },
  };
}
