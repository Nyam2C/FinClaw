// packages/server/src/plugins/hooks.ts

export type HookMode = 'void' | 'modifying' | 'sync';

export interface HookTapOptions {
  priority?: number;
  pluginName?: string;
}

interface HookEntry<T> {
  handler: (payload: T) => unknown;
  priority: number;
  registeredAt: number;
  pluginName: string;
}

export interface VoidHookRunner<T> {
  tap(handler: (payload: T) => unknown, opts?: HookTapOptions): void;
  fire(payload: T): Promise<PromiseSettledResult<unknown>[]>;
}

export interface ModifyingHookRunner<T> {
  tap(handler: (payload: T) => T | Promise<T>, opts?: HookTapOptions): void;
  fire(payload: T): Promise<T>;
}

export interface SyncHookRunner<T> {
  tap(handler: (payload: T) => unknown, opts?: HookTapOptions): void;
  fire(payload: T): unknown[];
}

function sortEntries<T>(entries: HookEntry<T>[]): HookEntry<T>[] {
  return entries.toSorted((a, b) => {
    const diff = b.priority - a.priority; // 높은 priority 우선
    return diff !== 0 ? diff : a.registeredAt - b.registeredAt; // 동점 시 FIFO
  });
}

export function createHookRunner<T>(name: string, mode: 'void'): VoidHookRunner<T>;
export function createHookRunner<T>(name: string, mode: 'modifying'): ModifyingHookRunner<T>;
export function createHookRunner<T>(name: string, mode: 'sync'): SyncHookRunner<T>;
export function createHookRunner<T>(
  name: string,
  mode: HookMode,
): VoidHookRunner<T> | ModifyingHookRunner<T> | SyncHookRunner<T> {
  const entries: HookEntry<T>[] = [];
  let counter = 0;

  function tap(handler: (payload: T) => unknown, opts?: HookTapOptions): void {
    entries.push({
      handler,
      priority: opts?.priority ?? 0,
      registeredAt: counter++,
      pluginName: opts?.pluginName ?? 'unknown',
    });
  }

  switch (mode) {
    case 'void':
      // TODO(review): async wrapper + Promise.allSettled 대신 Promise.resolve()로 감싸는 스타일 검토.
      // 의미적 동치이나 추가 마이크로태스크 1회 발생. 실측 영향 없으면 유지.
      return {
        tap,
        async fire(payload: T): Promise<PromiseSettledResult<unknown>[]> {
          const sorted = sortEntries(entries);
          return Promise.allSettled(sorted.map(async (e) => e.handler(payload)));
        },
      };

    case 'modifying':
      return {
        tap: tap as ModifyingHookRunner<T>['tap'],
        async fire(payload: T): Promise<T> {
          const sorted = sortEntries(entries);
          let current = payload;
          for (const e of sorted) {
            try {
              current = (await e.handler(current)) as T;
            } catch (err) {
              console.error(
                `[Hook:${name}] modifying handler error, keeping previous payload:`,
                err,
              );
            }
          }
          return current;
        },
      };

    case 'sync':
      return {
        tap,
        fire(payload: T): unknown[] {
          const sorted = sortEntries(entries);
          return sorted.map((e) => {
            const result = e.handler(payload);
            if (result && typeof (result as Record<string, unknown>).then === 'function') {
              console.warn(`[Hook:${name}] sync handler returned Promise — ignored`);
            }
            return result;
          });
        },
      };
  }
}
