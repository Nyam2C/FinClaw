import { ensureDir, writeFileAtomic } from '@finclaw/infra';
// packages/config/src/sessions/store.ts
import { createTimestamp, type SessionKey } from '@finclaw/types';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionEntry } from './types.js';

/**
 * 파일 기반 세션 스토어
 *
 * - 세션 디렉토리 아래에 `<key>.json` 파일로 저장
 * - writeFileAtomic으로 원자적 쓰기
 * - 인메모리 캐시로 반복 읽기 최적화
 */
export interface SessionStore {
  get(key: SessionKey): Promise<SessionEntry | null>;
  set(entry: SessionEntry): Promise<void>;
  delete(key: SessionKey): Promise<boolean>;
  list(): Promise<SessionEntry[]>;
  clear(): Promise<void>;
}

export function createSessionStore(sessionDir: string): SessionStore {
  const cache = new Map<string, SessionEntry>();
  let initialized = false;

  async function init(): Promise<void> {
    if (initialized) {
      return;
    }
    await ensureDir(sessionDir);
    initialized = true;
  }

  function filePath(key: SessionKey): string {
    // key 형식: "scope:id" → 파일명에서 : 를 _ 로 치환
    const safeName = (key as string).replace(/:/g, '_');
    return path.join(sessionDir, `${safeName}.json`);
  }

  return {
    async get(key) {
      const cached = cache.get(key as string);
      if (cached) {
        return cached;
      }

      await init();
      try {
        const raw = await fs.readFile(filePath(key), 'utf-8');
        const entry = JSON.parse(raw) as SessionEntry;
        cache.set(key as string, entry);
        return entry;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        throw err;
      }
    },

    async set(entry) {
      await init();
      const data = JSON.stringify(entry, null, 2);
      await writeFileAtomic(filePath(entry.key), data);
      cache.set(entry.key as string, entry);
    },

    async delete(key) {
      await init();
      cache.delete(key as string);
      try {
        await fs.unlink(filePath(key));
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return false;
        }
        throw err;
      }
    },

    async list() {
      await init();
      try {
        const files = await fs.readdir(sessionDir);
        const entries: SessionEntry[] = [];
        for (const file of files) {
          if (!file.endsWith('.json')) {
            continue;
          }
          const raw = await fs.readFile(path.join(sessionDir, file), 'utf-8');
          const entry = JSON.parse(raw) as SessionEntry;
          entries.push(entry);
          cache.set(entry.key as string, entry);
        }
        return entries;
      } catch {
        return [];
      }
    },

    async clear() {
      await init();
      cache.clear();
      try {
        const files = await fs.readdir(sessionDir);
        await Promise.all(
          files.filter((f) => f.endsWith('.json')).map((f) => fs.unlink(path.join(sessionDir, f))),
        );
      } catch {
        // 디렉토리 자체가 없으면 무시
      }
    },
  };
}

/** 현재 타임스탬프 생성 헬퍼 */
export function now(): ReturnType<typeof createTimestamp> {
  return createTimestamp(Date.now());
}
