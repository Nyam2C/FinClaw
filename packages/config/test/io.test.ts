import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// packages/config/test/io.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createConfigIO, loadConfig, clearConfigCache } from '../src/io.js';

describe('createConfigIO', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finclaw-io-test-'));
    clearConfigCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearConfigCache();
  });

  function writeJson5(filename: string, content: string): string {
    const filePath = path.join(tmpDir, filename);
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  it('설정 파일이 없으면 빈 설정을 반환한다', () => {
    const io = createConfigIO({
      configPath: path.join(tmpDir, 'nonexistent.json5'),
    });
    expect(io.loadConfig()).toEqual({});
  });

  it('설정 파일에서 값을 읽는다', () => {
    const cfgPath = writeJson5('test.json5', '{ accessLog: { retentionDays: 9090 } }');
    const io = createConfigIO({ configPath: cfgPath });
    const config = io.loadConfig();
    expect(config.accessLog?.retentionDays).toBe(9090);
  });

  it('환경변수를 치환한다', () => {
    const cfgPath = writeJson5(
      'test.json5',
      '{ gateway: { auth: { token: "${TEST_BOT_TOKEN}" } } }',
    );
    const io = createConfigIO({
      configPath: cfgPath,
      env: { ...process.env, TEST_BOT_TOKEN: 'my-token' },
    });
    const config = io.loadConfig();
    expect(config.gateway?.auth?.token).toBe('my-token');
  });

  it('캐시가 작동한다', () => {
    const cfgPath = writeJson5('test.json5', '{ accessLog: { retentionDays: 7777 } }');
    const io = createConfigIO({ configPath: cfgPath });

    const first = io.loadConfig();
    const second = io.loadConfig();
    expect(first).toBe(second); // 동일 참조
  });

  it('invalidateCache 후 새로 로드한다', () => {
    const cfgPath = writeJson5('test.json5', '{ accessLog: { retentionDays: 7777 } }');
    const io = createConfigIO({ configPath: cfgPath });

    const first = io.loadConfig();
    io.invalidateCache();
    const second = io.loadConfig();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it('configPath를 노출한다', () => {
    const cfgPath = path.join(tmpDir, 'test.json5');
    const io = createConfigIO({ configPath: cfgPath });
    expect(io.configPath).toBe(cfgPath);
  });
});

describe('loadConfig / clearConfigCache', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finclaw-load-test-'));
    clearConfigCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearConfigCache();
  });

  it('모듈 레벨 래퍼가 파일 없을 때 빈 설정을 반환한다', () => {
    const config = loadConfig({
      configPath: path.join(tmpDir, 'nonexistent.json5'),
    });
    expect(config).toEqual({});
  });

  it('다른 deps로 호출하면 IO를 재생성한다', () => {
    const cfgA = path.join(tmpDir, 'a.json5');
    const cfgB = path.join(tmpDir, 'b.json5');
    fs.writeFileSync(cfgA, '{ accessLog: { retentionDays: 1111 } }', 'utf-8');
    fs.writeFileSync(cfgB, '{ accessLog: { retentionDays: 2222 } }', 'utf-8');

    const depsA = { configPath: cfgA };
    const depsB = { configPath: cfgB };

    const configA = loadConfig(depsA);
    expect(configA.accessLog?.retentionDays).toBe(1111);

    const configB = loadConfig(depsB);
    expect(configB.accessLog?.retentionDays).toBe(2222);
  });
});
