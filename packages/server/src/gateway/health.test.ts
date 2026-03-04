// packages/server/src/gateway/health.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  checkLiveness,
  checkReadiness,
  registerHealthChecker,
  resetHealthCheckers,
  createProviderHealthChecker,
  createDbHealthChecker,
} from './health.js';

describe('Health Check', () => {
  beforeEach(() => {
    resetHealthCheckers();
  });

  describe('checkLiveness', () => {
    it('항상 status ok + uptime 반환', () => {
      const result = checkLiveness();
      expect(result.status).toBe('ok');
      expect(typeof result.uptime).toBe('number');
    });
  });

  describe('checkReadiness', () => {
    it('checker 없으면 ok', async () => {
      const result = await checkReadiness(0, 5);
      expect(result.status).toBe('ok');
      expect(result.components).toHaveLength(0);
      expect(result.connections).toBe(5);
      expect(result.activeSessions).toBe(0);
      expect(result.memory).toBeDefined();
      expect(result.version).toBe('0.1.0');
    });

    it('모든 컴포넌트 healthy → ok', async () => {
      registerHealthChecker(async () => ({
        name: 'test',
        status: 'healthy',
        lastCheckedAt: Date.now(),
      }));

      const result = await checkReadiness(1, 2);
      expect(result.status).toBe('ok');
    });

    it('degraded 컴포넌트 → degraded', async () => {
      registerHealthChecker(async () => ({
        name: 'slow-provider',
        status: 'degraded',
        message: 'High latency',
        lastCheckedAt: Date.now(),
      }));

      const result = await checkReadiness(0, 0);
      expect(result.status).toBe('degraded');
    });

    it('unhealthy 컴포넌트 → error', async () => {
      registerHealthChecker(async () => ({
        name: 'db',
        status: 'unhealthy',
        message: 'Connection refused',
        lastCheckedAt: Date.now(),
      }));

      const result = await checkReadiness(0, 0);
      expect(result.status).toBe('error');
    });

    it('checker 에러 → unhealthy로 처리', async () => {
      registerHealthChecker(async () => {
        throw new Error('Check failed');
      });

      const result = await checkReadiness(0, 0);
      expect(result.status).toBe('error');
      expect(result.components[0].status).toBe('unhealthy');
      expect(result.components[0].message).toBe('Check failed');
    });
  });

  describe('createProviderHealthChecker', () => {
    it('healthy 시 캐시', async () => {
      const checkFn = vi.fn().mockResolvedValue(undefined);
      const checker = createProviderHealthChecker('anthropic', checkFn);

      await checker();
      await checker(); // 캐시 히트

      expect(checkFn).toHaveBeenCalledTimes(1);
    });

    it('TTL 경과 후 재확인', async () => {
      vi.useFakeTimers();
      const checkFn = vi.fn().mockResolvedValue(undefined);
      const checker = createProviderHealthChecker('openai', checkFn);

      await checker();
      vi.advanceTimersByTime(60_001);
      await checker();

      expect(checkFn).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('에러 시 degraded', async () => {
      const checkFn = vi.fn().mockRejectedValue(new Error('Timeout'));
      const checker = createProviderHealthChecker('provider-x', checkFn);

      const result = await checker();
      expect(result.status).toBe('degraded');
      expect(result.name).toBe('provider:provider-x');
    });
  });

  describe('createDbHealthChecker', () => {
    it('성공 → healthy', async () => {
      const checker = createDbHealthChecker(async () => {});
      const result = await checker();
      expect(result.status).toBe('healthy');
      expect(result.name).toBe('database');
    });

    it('실패 → unhealthy', async () => {
      const checker = createDbHealthChecker(async () => {
        throw new Error('SQLITE_BUSY');
      });
      const result = await checker();
      expect(result.status).toBe('unhealthy');
      expect(result.message).toBe('SQLITE_BUSY');
    });
  });
});
