// packages/server/test/plugins/loader.test.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { loadPlugins, createPluginBuildApi } from '../../src/plugins/loader.js';
import { setPluginRegistry, createEmptyRegistry, getSlot } from '../../src/plugins/registry.js';

let tmpDir: string;

beforeEach(() => {
  setPluginRegistry(createEmptyRegistry());
});

// tmpDir는 한 번만 생성
tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finclaw-loader-'));

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
  it('유효한 플러그인을 로드하고 plugins 슬롯에 등록한다', async () => {
    createMockPlugin('valid-plugin', {
      code: 'export function register(api) { api.registerService({ name: "svc", start: async () => {}, stop: async () => {} }); }',
    });

    const result = await loadPlugins([tmpDir], [tmpDir]);
    expect(result.loaded).toContain('valid-plugin');
    expect(result.failed).toHaveLength(0);

    const plugins = getSlot('plugins');
    const active = plugins.find((p) => p.manifest.name === 'valid-plugin');
    expect(active?.status).toBe('active');
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

describe('register / activate alias', () => {
  it('activate를 register의 fallback으로 사용한다', async () => {
    createMockPlugin('activate-plugin', {
      code: 'export function activate(api) { api.registerService({ name: "act-svc", start: async () => {}, stop: async () => {} }); }',
    });

    const result = await loadPlugins([tmpDir], [tmpDir]);
    expect(result.loaded).toContain('activate-plugin');
    expect(getSlot('services').some((s) => s.name === 'act-svc')).toBe(true);
  });

  it('register가 있으면 activate보다 우선한다', async () => {
    createMockPlugin('both-plugin', {
      code: `
        export function register(api) { api.registerService({ name: "both-reg-svc", start: async () => {}, stop: async () => {} }); }
        export function activate(api) { api.registerService({ name: "both-act-svc", start: async () => {}, stop: async () => {} }); }
      `,
    });

    const result = await loadPlugins([tmpDir], [tmpDir]);
    expect(result.loaded).toContain('both-plugin');
    // register가 우선 → both-reg-svc만 등록
    expect(getSlot('services').some((s) => s.name === 'both-reg-svc')).toBe(true);
    expect(getSlot('services').some((s) => s.name === 'both-act-svc')).toBe(false);
  });
});

describe('createPluginBuildApi', () => {
  it('pluginName을 자동 주입한다', () => {
    const api = createPluginBuildApi('my-plugin');
    expect(api.pluginName).toBe('my-plugin');
  });

  it('registerHook에 priority 기본값 0을 적용한다', () => {
    const api = createPluginBuildApi('my-plugin');
    api.registerHook('onGatewayStart', async () => {});

    const hooks = getSlot('hooks');
    expect(hooks).toHaveLength(1);
    expect(hooks[0].priority).toBe(0);
    expect(hooks[0].pluginName).toBe('my-plugin');
  });

  it('addDiagnostic에 pluginName을 주입한다', () => {
    const api = createPluginBuildApi('my-plugin');
    api.addDiagnostic({
      timestamp: Date.now(),
      severity: 'info',
      phase: 'runtime',
      message: 'test',
    });

    const diags = getSlot('diagnostics');
    expect(diags).toHaveLength(1);
    expect(diags[0].pluginName).toBe('my-plugin');
  });
});
