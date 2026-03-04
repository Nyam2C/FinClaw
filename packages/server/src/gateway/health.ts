// packages/server/src/gateway/health.ts
import type { ComponentHealth, SystemHealth, LivenessResponse } from './rpc/types.js';

type HealthChecker = () => Promise<ComponentHealth>;

const checkers: HealthChecker[] = [];

export function registerHealthChecker(checker: HealthChecker): void {
  checkers.push(checker);
}

/** 테스트용: checkers 배열 초기화 */
export function resetHealthCheckers(): void {
  checkers.length = 0;
}

/** GET /healthz — liveness (프로세스 생존 여부만, 항상 200) */
export function checkLiveness(): LivenessResponse {
  return { status: 'ok', uptime: process.uptime() };
}

/** GET /readyz — readiness (전체 시스템 상태) */
export async function checkReadiness(
  activeSessions: number,
  connections: number,
): Promise<SystemHealth> {
  const components = await Promise.all(
    checkers.map(async (checker) => {
      try {
        return await checker();
      } catch (error) {
        return {
          name: 'unknown',
          status: 'unhealthy' as const,
          message: (error as Error).message,
          lastCheckedAt: Date.now(),
        };
      }
    }),
  );

  const hasUnhealthy = components.some((c) => c.status === 'unhealthy');
  const hasDegraded = components.some((c) => c.status === 'degraded');
  const status = hasUnhealthy ? 'error' : hasDegraded ? 'degraded' : 'ok';

  const mem = process.memoryUsage();

  return {
    status,
    uptime: process.uptime(),
    version: '0.1.0',
    components,
    memory: {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
    },
    activeSessions,
    connections,
    timestamp: Date.now(),
  };
}

/** Provider 헬스 체커 팩토리 (TTL 60초 캐시) */
export function createProviderHealthChecker(
  providerName: string,
  checkFn: () => Promise<void>,
): HealthChecker {
  let cache: ComponentHealth | null = null;
  const TTL_MS = 60_000;

  return async () => {
    if (cache && Date.now() - cache.lastCheckedAt < TTL_MS) {
      return cache;
    }

    const start = Date.now();
    try {
      await checkFn();
      cache = {
        name: `provider:${providerName}`,
        status: 'healthy',
        latencyMs: Date.now() - start,
        lastCheckedAt: Date.now(),
      };
    } catch (error) {
      cache = {
        name: `provider:${providerName}`,
        status: 'degraded',
        message: (error as Error).message,
        latencyMs: Date.now() - start,
        lastCheckedAt: Date.now(),
      };
    }
    return cache;
  };
}

/** DB 헬스 체커 팩토리 */
export function createDbHealthChecker(checkFn: () => Promise<void>): HealthChecker {
  return async () => {
    const start = Date.now();
    try {
      await checkFn();
      return {
        name: 'database',
        status: 'healthy',
        latencyMs: Date.now() - start,
        lastCheckedAt: Date.now(),
      };
    } catch (error) {
      return {
        name: 'database',
        status: 'unhealthy',
        message: (error as Error).message,
        latencyMs: Date.now() - start,
        lastCheckedAt: Date.now(),
      };
    }
  };
}
