// packages/config/test/io.test.ts
import type { FinClawConfig } from '@finclaw/types';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createConfigIO, loadConfig, clearConfigCache } from '../src/io.js';
import { resetOverrides } from '../src/runtime-overrides.js';

describe('createConfigIO', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finclaw-io-test-'));
    resetOverrides();
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

  it('설정 파일이 없으면 기본값을 반환한다', () => {
    const io = createConfigIO({
      configPath: path.join(tmpDir, 'nonexistent.json5'),
    });
    const config = io.loadConfig();
    expect(config.gateway?.port).toBe(3000);
    expect(config.logging?.level).toBe('info');
  });

  it('설정 파일에서 값을 읽는다', () => {
    const cfgPath = writeJson5('test.json5', '{ gateway: { port: 9090 } }');
    const io = createConfigIO({ configPath: cfgPath });
    const config = io.loadConfig();
    expect(config.gateway?.port).toBe(9090);
  });

  it('환경변수를 치환한다', () => {
    const cfgPath = writeJson5(
      'test.json5',
      '{ channels: { discord: { botToken: "${TEST_BOT_TOKEN}", applicationId: "app1" } } }',
    );
    const io = createConfigIO({
      configPath: cfgPath,
      env: { ...process.env, TEST_BOT_TOKEN: 'my-token' },
    });
    const config = io.loadConfig();
    expect(config.channels?.discord?.botToken).toBe('my-token');
  });

  it('캐시가 작동한다', () => {
    const cfgPath = writeJson5('test.json5', '{ gateway: { port: 7777 } }');
    const io = createConfigIO({ configPath: cfgPath });

    const first = io.loadConfig();
    const second = io.loadConfig();
    expect(first).toBe(second); // 동일 참조
  });

  it('invalidateCache 후 새로 로드한다', () => {
    const cfgPath = writeJson5('test.json5', '{ gateway: { port: 7777 } }');
    const io = createConfigIO({ configPath: cfgPath });

    const first = io.loadConfig();
    io.invalidateCache();
    const second = io.loadConfig();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it('writeConfigFile로 파일을 쓰고 캐시를 무효화한다', async () => {
    const cfgPath = path.join(tmpDir, 'write-test.json5');
    const io = createConfigIO({ configPath: cfgPath });

    const config: FinClawConfig = { gateway: { port: 5555 } };
    await io.writeConfigFile(config);

    const raw = fs.readFileSync(cfgPath, 'utf-8');
    expect(JSON.parse(raw)).toEqual(config);
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
    resetOverrides();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearConfigCache();
  });

  it('모듈 레벨 래퍼가 기본값을 반환한다', () => {
    const config = loadConfig({
      configPath: path.join(tmpDir, 'nonexistent.json5'),
    });
    expect(config.gateway?.port).toBe(3000);
  });
});
