import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { writeFileAtomic, readFileSafe, ensureDir, unlinkSafe } from '../src/fs-safe.js';
import { readJsonFile, writeJsonFile, readJsonFileSync } from '../src/json-file.js';
import { withTempDir } from './helpers.js';

describe('writeFileAtomic', () => {
  it('파일을 원자적으로 쓴다', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'test.txt');
      await writeFileAtomic(filePath, 'hello world');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('hello world');
    });
  });

  it('임시 파일이 남지 않는다', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'test.txt');
      await writeFileAtomic(filePath, 'data');
      const files = await fs.readdir(dir);
      expect(files).toEqual(['test.txt']);
    });
  });

  it('기존 파일을 덮어쓴다', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'test.txt');
      await writeFileAtomic(filePath, 'first');
      await writeFileAtomic(filePath, 'second');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('second');
    });
  });
});

describe('readFileSafe', () => {
  it('파일을 읽는다', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'test.txt');
      await fs.writeFile(filePath, 'hello');
      const content = await readFileSafe(filePath);
      expect(content).toBe('hello');
    });
  });

  it('존재하지 않는 파일에 에러를 던진다', async () => {
    await expect(readFileSafe('/nonexistent/file')).rejects.toThrow();
  });
});

describe('ensureDir', () => {
  it('중첩 디렉토리를 생성한다', async () => {
    await withTempDir(async (dir) => {
      const nested = path.join(dir, 'a', 'b', 'c');
      await ensureDir(nested);
      const stat = await fs.stat(nested);
      expect(stat.isDirectory()).toBe(true);
    });
  });
});

describe('unlinkSafe', () => {
  it('파일을 삭제한다', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'test.txt');
      await fs.writeFile(filePath, 'data');
      await unlinkSafe(filePath);
      await expect(fs.access(filePath)).rejects.toThrow();
    });
  });

  it('없는 파일 삭제 시 에러 없이 통과한다', async () => {
    await expect(unlinkSafe('/nonexistent/file')).resolves.toBeUndefined();
  });
});

describe('JSON file operations', () => {
  it('writeJsonFile + readJsonFile로 데이터를 왕복한다', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'data.json');
      const data = { key: 'value', num: 42, nested: { arr: [1, 2] } };
      await writeJsonFile(filePath, data);
      const result = await readJsonFile(filePath);
      expect(result).toEqual(data);
    });
  });

  it('존재하지 않는 JSON 파일 → undefined', async () => {
    const result = await readJsonFile('/nonexistent/data.json');
    expect(result).toBeUndefined();
  });

  it('디렉토리를 자동 생성한다', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'sub', 'dir', 'data.json');
      await writeJsonFile(filePath, { ok: true });
      const result = await readJsonFile(filePath);
      expect(result).toEqual({ ok: true });
    });
  });

  it('readJsonFileSync로 동기 읽기한다', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'sync.json');
      await writeJsonFile(filePath, { sync: true });
      const result = readJsonFileSync(filePath);
      expect(result).toEqual({ sync: true });
    });
  });
});
