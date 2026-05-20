// packages/agent/src/providers/claude-cli/queue.ts

const CLI_RUN_QUEUE = new Map<string, Promise<unknown>>();

/**
 * 같은 key (= backend + cliSessionId 조합) 의 동시 실행 직렬화.
 * 큰 효용: --session-id 가 같은 세션의 동시 실행 시 충돌 방지.
 */
export function enqueueCliRun<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prior = CLI_RUN_QUEUE.get(key) ?? Promise.resolve();
  const chained = prior.catch(() => undefined).then(task);
  // queue 연속성 유지 — 실패해도 unhandled rejection 방출 안 함
  const tracked = chained
    .catch(() => undefined)
    .finally(() => {
      if (CLI_RUN_QUEUE.get(key) === tracked) {
        CLI_RUN_QUEUE.delete(key);
      }
    });
  CLI_RUN_QUEUE.set(key, tracked);
  return chained;
}

export function buildCliQueueKey(params: { backendId: string; cliSessionId?: string }): string {
  return params.cliSessionId ? `${params.backendId}:${params.cliSessionId}` : params.backendId;
}
