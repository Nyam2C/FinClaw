// packages/server/test/plugins/discovery.test.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  validatePluginPath,
  discoverPlugins,
  isAllowedExtension,
} from '../../src/plugins/discovery.js';
import { PluginSecurityError } from '../../src/plugins/errors.js';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finclaw-discovery-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('validatePluginPath — 확장자 필터', () => {
  it('.ts 확장자를 허용한다', () => {
    const filePath = path.join(tmpDir, 'plugin.ts');
    fs.writeFileSync(filePath, 'export {}');
    expect(() => validatePluginPath(filePath, [tmpDir])).not.toThrow();
  });

  it('.mts 확장자를 허용한다', () => {
    const filePath = path.join(tmpDir, 'plugin.mts');
    fs.writeFileSync(filePath, 'export {}');
    expect(() => validatePluginPath(filePath, [tmpDir])).not.toThrow();
  });

  it('.js 확장자를 허용한다', () => {
    const filePath = path.join(tmpDir, 'plugin.js');
    fs.writeFileSync(filePath, 'export {}');
    expect(() => validatePluginPath(filePath, [tmpDir])).not.toThrow();
  });

  it('.mjs 확장자를 허용한다', () => {
    const filePath = path.join(tmpDir, 'plugin.mjs');
    fs.writeFileSync(filePath, 'export {}');
    expect(() => validatePluginPath(filePath, [tmpDir])).not.toThrow();
  });

  it('.json 확장자를 거부한다', () => {
    const filePath = path.join(tmpDir, 'plugin.json');
    fs.writeFileSync(filePath, '{}');
    expect(() => validatePluginPath(filePath, [tmpDir])).toThrow(PluginSecurityError);
  });

  it('.sh 확장자를 거부한다', () => {
    const filePath = path.join(tmpDir, 'plugin.sh');
    fs.writeFileSync(filePath, '#!/bin/bash');
    expect(() => validatePluginPath(filePath, [tmpDir])).toThrow(PluginSecurityError);
  });
});

describe('validatePluginPath — path traversal 방지', () => {
  it('allowedRoots 바깥 경로를 차단한다', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finclaw-outside-'));
    const filePath = path.join(outsideDir, 'evil.ts');
    fs.writeFileSync(filePath, 'export {}');

    expect(() => validatePluginPath(filePath, [tmpDir])).toThrow(PluginSecurityError);

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('allowedRoots 내부 경로를 허용한다', () => {
    const subDir = path.join(tmpDir, 'sub');
    fs.mkdirSync(subDir, { recursive: true });
    const filePath = path.join(subDir, 'plugin.ts');
    fs.writeFileSync(filePath, 'export {}');

    expect(() => validatePluginPath(filePath, [tmpDir])).not.toThrow();
  });
});

describe('validatePluginPath — world-writable (Unix only)', () => {
  it.skipIf(process.platform === 'win32')('world-writable 파일을 거부한다', () => {
    const filePath = path.join(tmpDir, 'writable.ts');
    fs.writeFileSync(filePath, 'export {}');
    fs.chmodSync(filePath, 0o666); // world-writable

    expect(() => validatePluginPath(filePath, [tmpDir])).toThrow(PluginSecurityError);

    // 정리: 권한 복원
    fs.chmodSync(filePath, 0o644);
  });
});

describe('isAllowedExtension', () => {
  it('.ts를 허용한다', () => expect(isAllowedExtension('.ts')).toBe(true));
  it('.mts를 허용한다', () => expect(isAllowedExtension('.mts')).toBe(true));
  it('.js를 허용한다', () => expect(isAllowedExtension('.js')).toBe(true));
  it('.mjs를 허용한다', () => expect(isAllowedExtension('.mjs')).toBe(true));
  it('.json을 거부한다', () => expect(isAllowedExtension('.json')).toBe(false));
  it('.py를 거부한다', () => expect(isAllowedExtension('.py')).toBe(false));
});

describe('discoverPlugins', () => {
  it('finclaw-plugin.json이 있는 디렉터리를 발견한다', () => {
    const pluginDir = path.join(tmpDir, 'my-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'finclaw-plugin.json'),
      JSON.stringify({ name: 'my-plugin', version: '1.0.0', main: 'index.ts', type: 'service' }),
    );

    const result = discoverPlugins([tmpDir]);
    expect(result).toHaveLength(1);
    expect(result[0].dir).toBe(pluginDir);
  });

  it('매니페스트 없는 디렉터리는 건너뛴다', () => {
    const emptyDir = path.join(tmpDir, 'no-manifest');
    fs.mkdirSync(emptyDir, { recursive: true });

    const result = discoverPlugins([tmpDir]);
    // my-plugin만 발견 (이전 테스트에서 생성)
    const names = result.map((r) => path.basename(r.dir));
    expect(names).not.toContain('no-manifest');
  });

  it('존재하지 않는 searchPath를 조용히 건너뛴다', () => {
    const result = discoverPlugins(['/non/existent/path']);
    expect(result).toEqual([]);
  });
});
