import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { acquireGatewayLock, readLockInfo, GatewayLockError } from '../src/gateway-lock.js';
import { withTempDir } from './helpers.js';

describe('acquireGatewayLock', () => {
  it('잠금을 획득하고 해제한다', async () => {
    await withTempDir(async (dir) => {
      const handle = await acquireGatewayLock({ lockDir: dir });
      expect(handle.pid).toBe(process.pid);
      expect(handle.lockPath).toBe(path.join(dir, 'gateway.lock'));

      // 잠금 파일 존재 확인
      const stat = await fs.stat(handle.lockPath);
      expect(stat.isFile()).toBe(true);

      // 해제
      await handle.release();
      await expect(fs.access(handle.lockPath)).rejects.toThrow();
    });
  });

  it('포트 정보를 잠금 파일에 기록한다', async () => {
    await withTempDir(async (dir) => {
      const handle = await acquireGatewayLock({ lockDir: dir, port: 8080 });
      const info = await readLockInfo(handle.lockPath);
      expect(info?.port).toBe(8080);
      expect(info?.pid).toBe(process.pid);
      await handle.release();
    });
  });

  it('이미 잠긴 상태에서 타임아웃된다', async () => {
    await withTempDir(async (dir) => {
      const handle = await acquireGatewayLock({ lockDir: dir });

      await expect(
        acquireGatewayLock({ lockDir: dir, timeoutMs: 200, pollIntervalMs: 50 }),
      ).rejects.toThrow(GatewayLockError);

      await handle.release();
    });
  });

  it('signal abort 시 즉시 에러를 던진다', async () => {
    await withTempDir(async (dir) => {
      const handle = await acquireGatewayLock({ lockDir: dir });
      const controller = new AbortController();
      controller.abort();

      await expect(
        acquireGatewayLock({
          lockDir: dir,
          timeoutMs: 5000,
          signal: controller.signal,
        }),
      ).rejects.toThrow('Lock acquisition aborted');

      await handle.release();
    });
  });

  it('stale 잠금을 자동 삭제하고 재획득한다', async () => {
    await withTempDir(async (dir) => {
      const lockPath = path.join(dir, 'gateway.lock');

      // 가짜 stale 잠금 파일 생성 (존재하지 않는 PID)
      const staleLock = JSON.stringify({
        pid: 999999999,
        acquiredAt: Date.now() - 100000,
      });
      await fs.writeFile(lockPath, staleLock);

      // mtime을 과거로 설정하여 stale로 판단되게 함
      const pastTime = new Date(Date.now() - 100000);
      await fs.utimes(lockPath, pastTime, pastTime);

      // stale이므로 획득 가능
      const handle = await acquireGatewayLock({
        lockDir: dir,
        staleThresholdMs: 1000,
        timeoutMs: 2000,
      });
      expect(handle.pid).toBe(process.pid);
      await handle.release();
    });
  });

  it('lockDir이 없으면 자동 생성한다', async () => {
    await withTempDir(async (dir) => {
      const lockDir = path.join(dir, 'nested', 'locks');
      const handle = await acquireGatewayLock({ lockDir });
      expect(handle.lockPath).toBe(path.join(lockDir, 'gateway.lock'));
      await handle.release();
    });
  });
});
