// packages/skills-general/src/file-read.test.ts
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryToolRegistry } from '@finclaw/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerFileReadTool } from './file-read.js';

function makeCtx() {
  return {
    sessionId: 's1',
    userId: 'u1',
    channelId: 'c1',
    abortSignal: AbortSignal.timeout(2_000),
  };
}

describe('read_local_file', () => {
  let fileRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    fileRoot = await mkdtemp(join(tmpdir(), 'finclaw-fr-'));
    outsideRoot = await mkdtemp(join(tmpdir(), 'finclaw-out-'));
  });

  afterEach(async () => {
    await rm(fileRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  it('루트 하위의 파일을 읽는다', async () => {
    const registry = new InMemoryToolRegistry();
    registerFileReadTool(registry, { fileRoot, maxBytes: 1_000 });
    await writeFile(join(fileRoot, 'note.txt'), 'hello world');

    const result = await registry.execute('read_local_file', { path: 'note.txt' }, makeCtx());

    expect(result.isError).toBe(false);
    expect(result.content).toContain('hello world');
  });

  it('절대 경로를 거부한다', async () => {
    const registry = new InMemoryToolRegistry();
    registerFileReadTool(registry, { fileRoot, maxBytes: 1_000 });

    const result = await registry.execute('read_local_file', { path: '/etc/passwd' }, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/ABSOLUTE_PATH_NOT_ALLOWED/);
  });

  it('상위 디렉토리 트래버설을 거부한다', async () => {
    const registry = new InMemoryToolRegistry();
    registerFileReadTool(registry, { fileRoot, maxBytes: 1_000 });

    const result = await registry.execute(
      'read_local_file',
      { path: '../../etc/passwd' },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/PATH_TRAVERSAL_BLOCKED/);
  });

  it('루트를 벗어나는 심볼릭 링크를 거부한다', async () => {
    const registry = new InMemoryToolRegistry();
    registerFileReadTool(registry, { fileRoot, maxBytes: 1_000 });

    await writeFile(join(outsideRoot, 'secret.txt'), 'top-secret');
    await symlink(join(outsideRoot, 'secret.txt'), join(fileRoot, 'link.txt'));

    const result = await registry.execute('read_local_file', { path: 'link.txt' }, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/SYMLINK_BLOCKED/);
  });

  it('max_bytes를 초과하면 절단 표시', async () => {
    const registry = new InMemoryToolRegistry();
    registerFileReadTool(registry, { fileRoot, maxBytes: 5 });
    await writeFile(join(fileRoot, 'big.txt'), 'abcdefghij');

    const result = await registry.execute('read_local_file', { path: 'big.txt' }, makeCtx());

    expect(result.isError).toBe(false);
    expect(result.content).toContain('abcde');
    expect(result.content).toMatch(/truncated at 5 bytes of 10/);
  });
});
