import { resetEventBus } from '@finclaw/infra';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { acquireWriteLock, resetHeldLocks } from '../src/agents/session/write-lock.js';

// ── 헬퍼 ──

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finclaw-wl-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('acquireWriteLock', () => {
  afterEach(() => {
    resetHeldLocks();
    resetEventBus();
  });

  it('잠금을 성공적으로 획득한다', async () => {
    await withTempDir(async (dir) => {
      const result = await acquireWriteLock({ sessionDir: dir, sessionId: 'sess-1' });

      expect(result.acquired).toBe(true);
      expect(result.lockPath).toContain('sess-1.lock');

      // 잠금 파일이 존재하는지 확인
      const stat = await fs.stat(result.lockPath);
      expect(stat.isFile()).toBe(true);

      // 잠금 파일 내용 확인
      const content = JSON.parse(await fs.readFile(result.lockPath, 'utf-8'));
      expect(content.pid).toBe(process.pid);
      expect(content.sessionId).toBe('sess-1');

      await result.release();
    });
  });

  it('이중 잠금을 방지한다 (타임아웃)', async () => {
    await withTempDir(async (dir) => {
      const lock1 = await acquireWriteLock({ sessionDir: dir, sessionId: 'sess-1' });
      expect(lock1.acquired).toBe(true);

      // 두 번째 잠금 시도 — 짧은 타임아웃
      const lock2 = await acquireWriteLock({
        sessionDir: dir,
        sessionId: 'sess-1',
        timeoutMs: 200,
        pollIntervalMs: 50,
      });
      expect(lock2.acquired).toBe(false);

      await lock1.release();
    });
  });

  it('release() 후 잠금 파일이 삭제된다', async () => {
    await withTempDir(async (dir) => {
      const result = await acquireWriteLock({ sessionDir: dir, sessionId: 'sess-1' });
      expect(result.acquired).toBe(true);

      await result.release();

      await expect(fs.stat(result.lockPath)).rejects.toThrow();
    });
  });

  it('release() 후 다시 잠금을 획득할 수 있다', async () => {
    await withTempDir(async (dir) => {
      const lock1 = await acquireWriteLock({ sessionDir: dir, sessionId: 'sess-1' });
      await lock1.release();

      const lock2 = await acquireWriteLock({ sessionDir: dir, sessionId: 'sess-1' });
      expect(lock2.acquired).toBe(true);

      await lock2.release();
    });
  });

  it('stale 잠금을 시간 기반으로 감지하고 강제 해제한다', async () => {
    await withTempDir(async (dir) => {
      const lockPath = path.join(dir, 'sess-stale.lock');

      // 수동으로 오래된 잠금 파일 생성
      const lockData = JSON.stringify({
        pid: process.pid,
        timestamp: new Date(Date.now() - 600_000).toISOString(),
        sessionId: 'sess-stale',
      });
      await fs.writeFile(lockPath, lockData);

      // mtime을 과거로 설정
      const past = new Date(Date.now() - 600_000);
      await fs.utimes(lockPath, past, past);

      // staleAfterMs=1000으로 설정하면 즉시 stale 처리
      const result = await acquireWriteLock({
        sessionDir: dir,
        sessionId: 'sess-stale',
        staleAfterMs: 1_000,
      });
      expect(result.acquired).toBe(true);

      await result.release();
    });
  });

  it('죽은 프로세스의 잠금을 PID 확인으로 즉시 해제한다', async () => {
    await withTempDir(async (dir) => {
      const lockPath = path.join(dir, 'sess-dead.lock');

      // 존재하지 않는 PID로 잠금 파일 생성
      const lockData = JSON.stringify({
        pid: 999999,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-dead',
      });
      await fs.writeFile(lockPath, lockData);

      const result = await acquireWriteLock({
        sessionDir: dir,
        sessionId: 'sess-dead',
      });
      expect(result.acquired).toBe(true);

      await result.release();
    });
  });

  it('재진입 잠금을 허용한다 (allowReentrant)', async () => {
    await withTempDir(async (dir) => {
      const lock1 = await acquireWriteLock({
        sessionDir: dir,
        sessionId: 'sess-reentrant',
        allowReentrant: true,
      });
      expect(lock1.acquired).toBe(true);

      const lock2 = await acquireWriteLock({
        sessionDir: dir,
        sessionId: 'sess-reentrant',
        allowReentrant: true,
      });
      expect(lock2.acquired).toBe(true);

      // 첫 번째 release — 파일은 아직 존재해야 함
      await lock2.release();
      const stat = await fs.stat(lock1.lockPath).catch(() => null);
      expect(stat).not.toBeNull();

      // 두 번째 release — 파일 삭제
      await lock1.release();
    });
  });
});
