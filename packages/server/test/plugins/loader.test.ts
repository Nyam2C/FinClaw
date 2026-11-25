// packages/server/test/plugins/loader.test.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { loadPlugins } from '../../src/plugins/loader.js';

// tmpDir는 한 번만 생성. realpath: macOS /tmp → /private/tmp 심볼릭 링크 (validatePluginPath 가 realpath 비교)
const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'finclaw-loader-')));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** mock 플러그인 디렉터리 생성 헬퍼 */
function createMockPlugin(
  name: string,
  opts: {
    manifest?: Record<string, unknown>;
    code?: string;
    ext?: string;
  } = {},
): string {
  const pluginDir = path.join(tmpDir, name);
  fs.mkdirSync(pluginDir, { recursive: true });

  const ext = opts.ext ?? '.mjs';
  const mainFile = `index${ext}`;

  fs.writeFileSync(
    path.join(pluginDir, 'finclaw-plugin.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      main: mainFile,
      type: 'service',
      ...opts.manifest,
    }),
  );

  fs.writeFileSync(
    path.join(pluginDir, mainFile),
    opts.code ?? 'export function register(api) { /* noop */ }',
  );

  return pluginDir;
}

describe('loadPlugins — 5-stage 파이프라인', () => {
  it('유효한 플러그인을 로드한다', async () => {
    createMockPlugin('valid-plugin');

    const result = await loadPlugins([tmpDir], [tmpDir]);
    expect(result.loaded).toContain('valid-plugin');
    expect(result.failed).toHaveLength(0);
  });

  it('잘못된 매니페스트는 failed에 기록한다', async () => {
    const pluginDir = path.join(tmpDir, 'bad-manifest');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'finclaw-plugin.json'),
      JSON.stringify({ name: '', version: 'invalid' }),
    );

    const result = await loadPlugins([tmpDir], [tmpDir]);
    const fail = result.failed.find((f) => f.pluginName === 'bad-manifest');
    expect(fail?.phase).toBe('manifest');
  });
});

function diag(name: string): string {
  return `export function NAME(api) { api.addDiagnostic({ timestamp: 0, severity: "info", phase: "runtime", message: "${name}" }); }`;
}

describe('register / activate alias', () => {
  it('activate를 register의 fallback으로 사용한다', async () => {
    createMockPlugin('activate-plugin', { code: diag('act').replace('NAME', 'activate') });

    const result = await loadPlugins([tmpDir], [tmpDir]);
    expect(result.loaded).toContain('activate-plugin');
    expect(result.diagnostics.some((d) => d.message === 'act')).toBe(true);
  });

  it('register가 있으면 activate보다 우선한다', async () => {
    createMockPlugin('both-plugin', {
      code: `${diag('both-reg').replace('NAME', 'register')}\n${diag('both-act').replace('NAME', 'activate')}`,
    });

    const result = await loadPlugins([tmpDir], [tmpDir]);
    expect(result.loaded).toContain('both-plugin');
    expect(result.diagnostics.some((d) => d.message === 'both-reg')).toBe(true);
    expect(result.diagnostics.some((d) => d.message === 'both-act')).toBe(false);
  });

  it('addDiagnostic에 pluginName을 주입한다', async () => {
    createMockPlugin('diag-plugin', { code: diag('hello').replace('NAME', 'register') });

    const result = await loadPlugins([tmpDir], [tmpDir]);
    const d = result.diagnostics.find((x) => x.message === 'hello');
    expect(d?.pluginName).toBe('diag-plugin');
  });
});
