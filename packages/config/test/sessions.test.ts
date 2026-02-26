// packages/config/test/sessions.test.ts
import { createSessionKey, createTimestamp } from '@finclaw/types';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SessionEntry } from '../src/sessions/types.js';
import { createSessionStore } from '../src/sessions/store.js';
import { mergeSessionEntry } from '../src/sessions/types.js';

function makeEntry(id: string, data: Record<string, unknown> = {}): SessionEntry {
  return {
    key: createSessionKey(`global:${id}`),
    scope: 'global',
    createdAt: createTimestamp(1000),
    lastAccessedAt: createTimestamp(2000),
    data,
  };
}

describe('mergeSessionEntry', () => {
  it('data를 shallow merge한다', () => {
    const existing = makeEntry('test', { a: 1, b: 2 });
    const merged = mergeSessionEntry(existing, { data: { b: 3, c: 4 } });
    expect(merged.data).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('lastAccessedAt을 업데이트한다', () => {
    const existing = makeEntry('test');
    const ts = createTimestamp(9999);
    const merged = mergeSessionEntry(existing, { lastAccessedAt: ts });
    expect(merged.lastAccessedAt).toBe(ts);
  });

  it('patch가 비어있으면 원본을 유지한다', () => {
    const existing = makeEntry('test', { x: 1 });
    const merged = mergeSessionEntry(existing, {});
    expect(merged.data).toEqual({ x: 1 });
    expect(merged.lastAccessedAt).toBe(existing.lastAccessedAt);
  });
});

describe('SessionStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finclaw-session-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('set → get 라운드트립', async () => {
    const store = createSessionStore(path.join(tmpDir, 'sessions'));
    const entry = makeEntry('round');
    await store.set(entry);
    const loaded = await store.get(entry.key);
    expect(loaded).toEqual(entry);
  });

  it('존재하지 않는 키에 null을 반환한다', async () => {
    const store = createSessionStore(path.join(tmpDir, 'sessions'));
    const result = await store.get(createSessionKey('global:missing'));
    expect(result).toBeNull();
  });

  it('delete는 기존 키에 true를 반환한다', async () => {
    const store = createSessionStore(path.join(tmpDir, 'sessions'));
    const entry = makeEntry('del');
    await store.set(entry);
    expect(await store.delete(entry.key)).toBe(true);
    expect(await store.get(entry.key)).toBeNull();
  });

  it('delete는 없는 키에 false를 반환한다', async () => {
    const store = createSessionStore(path.join(tmpDir, 'sessions'));
    expect(await store.delete(createSessionKey('global:nope'))).toBe(false);
  });

  it('list는 모든 엔트리를 반환한다', async () => {
    const store = createSessionStore(path.join(tmpDir, 'sessions'));
    await store.set(makeEntry('a'));
    await store.set(makeEntry('b'));
    const entries = await store.list();
    expect(entries).toHaveLength(2);
  });

  it('clear는 모든 엔트리를 삭제한다', async () => {
    const store = createSessionStore(path.join(tmpDir, 'sessions'));
    await store.set(makeEntry('x'));
    await store.set(makeEntry('y'));
    await store.clear();
    const entries = await store.list();
    expect(entries).toHaveLength(0);
  });

  it('캐시에서 반복 get을 서빙한다', async () => {
    const store = createSessionStore(path.join(tmpDir, 'sessions'));
    const entry = makeEntry('cached');
    await store.set(entry);

    // 파일을 삭제해도 캐시에서 반환
    const sessionDir = path.join(tmpDir, 'sessions');
    const files = fs.readdirSync(sessionDir);
    for (const f of files) {
      fs.unlinkSync(path.join(sessionDir, f));
    }

    const cached = await store.get(entry.key);
    expect(cached).toEqual(entry);
  });
});
