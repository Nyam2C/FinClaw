# Phase 5 todo-b: 플러그인 로더 — 매니페스트 + 보안 + 5-Stage 파이프라인 (세션 3)

> **소스 3 + 테스트 4 = 7파일**

## 선행조건

```bash
# todo-a 완료 확인
pnpm typecheck                                                   # 에러 0
pnpm vitest run packages/server/test/plugins/registry.test.ts    # 통과
pnpm vitest run packages/server/test/plugins/hooks.test.ts       # 통과
pnpm vitest run packages/server/test/plugins/hooks-typed.test.ts # 통과
```

---

# 세션 3: Step 4 — 매니페스트 검증 + Discovery + 5-Stage 로더 (소스 3 + 테스트 4 = 7파일)

## 4-1. packages/server/src/plugins/manifest.ts 생성

**의존:** `zod` (v4)

> Zod v4 strictObject로 매니페스트 검증 + toJSONSchema 자동 생성.

```typescript
// packages/server/src/plugins/manifest.ts
import { z } from 'zod/v4';
import type { PluginManifest } from '@finclaw/types';

/** 플러그인 매니페스트 Zod v4 스키마 */
export const PluginManifestSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  description: z.string().optional(),
  author: z.string().optional(),
  main: z.string().min(1),
  type: z.enum(['channel', 'skill', 'tool', 'service']),
  dependencies: z.array(z.string()).optional(),
  slots: z.array(z.string()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  configSchema: z.unknown().optional(),
});

/** Zod v4 매니페스트 파싱 — 성공 시 PluginManifest 반환 */
export function parseManifest(
  raw: unknown,
): { ok: true; manifest: PluginManifest } | { ok: false; error: string } {
  const result = PluginManifestSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, manifest: result.data as PluginManifest };
  }
  const tree = z.treeifyError(result.error);
  return { ok: false, error: formatTreeErrors(tree) };
}

/** JSON Schema 자동 생성 (Phase 7 Tool System 활용) */
export const manifestJsonSchema = z.toJSONSchema(PluginManifestSchema, {
  target: 'draft-2020-12',
});

/** z.treeifyError 결과를 단일 문자열로 평탄화 */
function formatTreeErrors(tree: z.ZodErrorTree<unknown>, path = ''): string {
  const messages: string[] = [];

  if (tree.errors && tree.errors.length > 0) {
    for (const msg of tree.errors) {
      messages.push(path ? `${path}: ${msg}` : msg);
    }
  }

  if (tree.properties) {
    for (const [key, subtree] of Object.entries(tree.properties)) {
      const childPath = path ? `${path}.${key}` : key;
      messages.push(formatTreeErrors(subtree as z.ZodErrorTree<unknown>, childPath));
    }
  }

  return messages.filter(Boolean).join('; ');
}
```

## 4-2. packages/server/src/plugins/discovery.ts 생성

**의존:** `./errors.js` (PluginSecurityError), `node:fs`, `node:path`

> 3단계 보안 검증: path traversal → 확장자 → world-writable.
> discoverPlugins(): 검색 경로를 스캔하여 매니페스트 후보를 반환.

```typescript
// packages/server/src/plugins/discovery.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PluginSecurityError } from './errors.js';

const ALLOWED_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs']);
const MANIFEST_FILENAME = 'finclaw-plugin.json';

/** 검색된 플러그인 후보 */
export interface DiscoveredPlugin {
  dir: string;
  manifestPath: string;
}

/**
 * 플러그인 디렉터리 스캔 — searchPaths 내 finclaw-plugin.json을 가진 디렉터리를 반환
 *
 * 존재하지 않는 searchPath는 조용히 건너뛴다.
 */
export function discoverPlugins(searchPaths: string[]): DiscoveredPlugin[] {
  const discovered: DiscoveredPlugin[] = [];

  for (const searchPath of searchPaths) {
    if (!fs.existsSync(searchPath)) continue;

    const stat = fs.statSync(searchPath);
    if (!stat.isDirectory()) continue;

    const entries = fs.readdirSync(searchPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginDir = path.join(searchPath, entry.name);
      const manifestPath = path.join(pluginDir, MANIFEST_FILENAME);
      if (fs.existsSync(manifestPath)) {
        discovered.push({ dir: pluginDir, manifestPath });
      }
    }
  }

  return discovered;
}

/**
 * 3단계 보안 검증
 *
 * 1. Path traversal 방지 — realpath로 심볼릭 링크 해석 후 allowedRoots 검증
 * 2. 확장자 필터 — .ts, .mts, .js, .mjs만 허용
 * 3. World-writable 검사 — Unix only (Windows/WSL은 skip)
 */
export function validatePluginPath(pluginPath: string, allowedRoots: string[]): void {
  const resolved = path.resolve(pluginPath);

  // 1. Path traversal 방지
  const realPath = fs.realpathSync(resolved);
  const isAllowed = allowedRoots.some((root) => realPath.startsWith(path.resolve(root)));
  if (!isAllowed) {
    throw new PluginSecurityError(`Path outside allowed roots: ${resolved}`);
  }

  // 2. 확장자 필터
  const ext = path.extname(resolved);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new PluginSecurityError(`Invalid extension: ${ext}`);
  }

  // 3. World-writable 검사 (Unix only)
  if (process.platform !== 'win32') {
    const stat = fs.statSync(resolved);
    if ((stat.mode & 0o002) !== 0) {
      throw new PluginSecurityError(`World-writable plugin file: ${pluginPath}`);
    }
  }
}

/** 확장자 허용 여부 (테스트 보조) */
export function isAllowedExtension(ext: string): boolean {
  return ALLOWED_EXTENSIONS.has(ext);
}
```

## 4-3. packages/server/src/plugins/loader.ts 생성

**의존:** `./registry.js`, `./errors.js`, `./manifest.js`, `./discovery.js`, `@finclaw/infra`, `@finclaw/types`, `jiti`, `node:url`, `node:path`, `node:fs`

> 5-Stage 파이프라인: Discovery → Security → Manifest → Load → Register
> 3-Tier Fallback: ESM → Node24 네이티브 TS → jiti
> createPluginBuildApi(): 격리된 등록 API
> register/activate 양쪽 alias 지원

```typescript
// packages/server/src/plugins/loader.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';
import type {
  PluginManifest,
  PluginDiagnostic,
  PluginHookName,
  PluginService,
  PluginCommand,
  RouteRegistration,
  ChannelPlugin,
} from '@finclaw/types';
import { getNodeMajorVersion } from '@finclaw/infra';
import { registerToSlot } from './registry.js';
import { PluginLoadError } from './errors.js';
import { parseManifest } from './manifest.js';
import { discoverPlugins, validatePluginPath } from './discovery.js';

// ─── 타입 ───

/** 플러그인 모듈 exports (register || activate) */
export interface PluginExports {
  readonly register?: (api: PluginBuildApi) => void;
  readonly activate?: (api: PluginBuildApi) => void;
  readonly deactivate?: () => Promise<void>;
}

/** 플러그인 등록 API — register() 콜백에 주입 */
export interface PluginBuildApi {
  readonly pluginName: string;
  registerChannel(channel: ChannelPlugin): void;
  registerHook(
    hookName: PluginHookName,
    handler: (...args: unknown[]) => Promise<unknown>,
    opts?: { priority?: number },
  ): void;
  registerService(service: PluginService): void;
  registerCommand(command: Omit<PluginCommand, 'pluginName'>): void;
  registerRoute(route: Omit<RouteRegistration, 'pluginName'>): void;
  addDiagnostic(diagnostic: Omit<PluginDiagnostic, 'pluginName'>): void;
}

/** 로드 결과 */
export interface LoadResult {
  loaded: string[];
  failed: Array<{ pluginName: string; phase: string; error: string }>;
}

// ─── jiti Lazy 싱글턴 ───

let jitiLoader: ReturnType<typeof createJiti> | null = null;

function getOrCreateJiti(): ReturnType<typeof createJiti> {
  if (jitiLoader) return jitiLoader;
  jitiLoader = createJiti(import.meta.url, {
    interopDefault: true,
    extensions: ['.ts', '.mts', '.js', '.mjs', '.json'],
  });
  return jitiLoader;
}

/** 테스트용 jiti 리셋 */
export function resetJiti(): void {
  jitiLoader = null;
}

// ─── 3-Tier 모듈 로더 ───

async function loadPluginModule(entryPath: string): Promise<Record<string, unknown>> {
  const ext = path.extname(entryPath);

  // Tier 1: ESM 네이티브 import (.js/.mjs — 제로 오버헤드)
  if (ext === '.js' || ext === '.mjs') {
    return await import(pathToFileURL(entryPath).href);
  }

  // Tier 2: Node.js 24+ 네이티브 TS strip (stable)
  if (getNodeMajorVersion() >= 24) {
    try {
      return await import(pathToFileURL(entryPath).href);
    } catch {
      /* fallthrough to jiti */
    }
  }

  // Tier 3: jiti 동적 로딩 (최후 수단)
  const jiti = getOrCreateJiti();
  return (await jiti.import(entryPath)) as Record<string, unknown>;
}

// ─── createPluginBuildApi ───

function createPluginBuildApi(pluginName: string): PluginBuildApi {
  return {
    pluginName,
    registerChannel(ch) {
      registerToSlot('channels', ch);
    },
    registerHook(hookName, handler, opts) {
      registerToSlot('hooks', {
        name: hookName,
        handler,
        pluginName,
        priority: opts?.priority ?? 0,
      });
    },
    registerService(svc) {
      registerToSlot('services', svc);
    },
    registerCommand(cmd) {
      registerToSlot('commands', { ...cmd, pluginName });
    },
    registerRoute(route) {
      registerToSlot('routes', { ...route, pluginName });
    },
    addDiagnostic(diag) {
      registerToSlot('diagnostics', { ...diag, pluginName });
    },
  };
}

// ─── 진단 기록 헬퍼 ───

function recordDiagnostic(
  pluginName: string,
  severity: PluginDiagnostic['severity'],
  phase: PluginDiagnostic['phase'],
  message: string,
  error?: Error,
): void {
  registerToSlot('diagnostics', {
    pluginName,
    timestamp: Date.now(),
    severity,
    phase,
    message,
    ...(error
      ? { error: { code: (error as Record<string, string>).code ?? 'UNKNOWN', stack: error.stack } }
      : {}),
  });
}

// ─── 5-Stage 파이프라인 ───

/**
 * 플러그인 로딩 파이프라인
 *
 * Stage 1: Discovery — searchPaths 스캔
 * Stage 2: Security  — 3단계 보안 검증 (validatePluginPath)
 * Stage 3: Manifest  — Zod v4 파싱/검증
 * Stage 4: Load      — 3-tier fallback 모듈 로딩
 * Stage 5: Register  — createPluginBuildApi + register()/activate() 호출
 */
export async function loadPlugins(
  searchPaths: string[],
  allowedRoots: string[],
): Promise<LoadResult> {
  const result: LoadResult = { loaded: [], failed: [] };

  // Stage 1: Discovery
  const discovered = discoverPlugins(searchPaths);

  for (const { dir, manifestPath } of discovered) {
    let pluginName = path.basename(dir);

    try {
      // Stage 2: Manifest Parse
      const rawManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const parsed = parseManifest(rawManifest);
      if (!parsed.ok) {
        recordDiagnostic(pluginName, 'error', 'manifest', parsed.error);
        result.failed.push({ pluginName, phase: 'manifest', error: parsed.error });
        continue;
      }

      const manifest = parsed.manifest;
      pluginName = manifest.name;

      // Stage 3: Security — entry 파일 검증
      const entryPath = path.resolve(dir, manifest.main);
      validatePluginPath(entryPath, allowedRoots);

      // Stage 4: Load
      const mod = await loadPluginModule(entryPath);

      // Stage 5: Register
      const api = createPluginBuildApi(pluginName);
      const registerFn = (mod.register ?? mod.activate) as
        | ((api: PluginBuildApi) => void)
        | undefined;

      if (registerFn) {
        const registerResult = registerFn(api);

        // register()가 Promise를 반환하면 경고
        if (
          registerResult &&
          typeof (registerResult as Record<string, unknown>).then === 'function'
        ) {
          recordDiagnostic(
            pluginName,
            'warn',
            'register',
            'register() returned a Promise; async registration is ignored',
          );
        }
      }

      // 등록 완료
      registerToSlot('plugins', {
        manifest,
        status: 'active',
        loadedAt: Date.now(),
      });

      result.loaded.push(pluginName);
    } catch (err) {
      const phase =
        err instanceof Error &&
        'code' in err &&
        (err as Record<string, string>).code === 'PLUGIN_SECURITY_ERROR'
          ? 'security'
          : 'load';

      const error = err instanceof Error ? err : new Error(String(err));
      recordDiagnostic(
        pluginName,
        'error',
        phase as PluginDiagnostic['phase'],
        error.message,
        error,
      );

      result.failed.push({
        pluginName,
        phase,
        error: error.message,
      });

      // 실패한 플러그인도 plugins 슬롯에 에러 상태로 기록
      registerToSlot('plugins', {
        manifest: { name: pluginName, version: '0.0.0', main: '', type: 'service' },
        status: 'error',
        error: error.message,
        loadedAt: Date.now(),
      });
    }
  }

  return result;
}

export { createPluginBuildApi, loadPluginModule };
```

## 4-4. packages/server/test/plugins/manifest.test.ts 생성

**의존:** `../../src/plugins/manifest.js`

```typescript
// packages/server/test/plugins/manifest.test.ts
import { describe, it, expect } from 'vitest';
import {
  parseManifest,
  PluginManifestSchema,
  manifestJsonSchema,
} from '../../src/plugins/manifest.js';

const validManifest = {
  name: 'test-plugin',
  version: '1.0.0',
  description: 'A test plugin',
  author: 'tester',
  main: 'src/index.ts',
  type: 'channel' as const,
  dependencies: ['other-plugin'],
  slots: ['channels', 'hooks'],
  config: { key: 'value' },
};

describe('parseManifest', () => {
  it('유효한 매니페스트를 파싱한다', () => {
    const result = parseManifest(validManifest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.name).toBe('test-plugin');
      expect(result.manifest.version).toBe('1.0.0');
      expect(result.manifest.type).toBe('channel');
    }
  });

  it('최소 필드만으로 유효하다', () => {
    const result = parseManifest({
      name: 'minimal',
      version: '0.1.0',
      main: 'index.js',
      type: 'service',
    });
    expect(result.ok).toBe(true);
  });

  it('name이 빈 문자열이면 거부한다', () => {
    const result = parseManifest({ ...validManifest, name: '' });
    expect(result.ok).toBe(false);
  });

  it('version이 semver 형식이 아니면 거부한다', () => {
    const result = parseManifest({ ...validManifest, version: 'latest' });
    expect(result.ok).toBe(false);
  });

  it('main이 없으면 거부한다', () => {
    const { main: _, ...noMain } = validManifest;
    const result = parseManifest(noMain);
    expect(result.ok).toBe(false);
  });

  it('잘못된 type을 거부한다', () => {
    const result = parseManifest({ ...validManifest, type: 'unknown' });
    expect(result.ok).toBe(false);
  });

  it('알 수 없는 키를 거부한다 (strictObject)', () => {
    const result = parseManifest({ ...validManifest, unknownKey: true });
    expect(result.ok).toBe(false);
  });

  it('실패 시 에러 메시지를 포함한다', () => {
    const result = parseManifest({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});

describe('PluginManifestSchema', () => {
  it('4가지 type을 모두 허용한다', () => {
    for (const type of ['channel', 'skill', 'tool', 'service']) {
      const result = PluginManifestSchema.safeParse({
        name: 'test',
        version: '1.0.0',
        main: 'index.js',
        type,
      });
      expect(result.success).toBe(true);
    }
  });

  it('config는 임의의 Record를 허용한다', () => {
    const result = PluginManifestSchema.safeParse({
      name: 'test',
      version: '1.0.0',
      main: 'index.js',
      type: 'service',
      config: { nested: { deep: true }, arr: [1, 2, 3] },
    });
    expect(result.success).toBe(true);
  });
});

describe('manifestJsonSchema', () => {
  it('JSON Schema 객체를 반환한다', () => {
    expect(manifestJsonSchema).toBeDefined();
    expect(typeof manifestJsonSchema).toBe('object');
  });

  it('필수 필드 정보를 포함한다', () => {
    const schema = manifestJsonSchema as Record<string, unknown>;
    expect(schema).toHaveProperty('type', 'object');
  });
});
```

## 4-5. packages/server/test/plugins/discovery.test.ts 생성

**의존:** `../../src/plugins/discovery.js`, `../../src/plugins/errors.js`

> 보안 검증 3단계를 직접 테스트. 파일시스템 의존 테스트는 tmp 디렉터리 사용.

```typescript
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
```

## 4-6. packages/server/test/plugins/loader.test.ts 생성

**의존:** `../../src/plugins/loader.js`, `../../src/plugins/registry.js`, `../../src/plugins/errors.js`

> 5-stage 파이프라인 통합 테스트 + register/activate alias 테스트.
> 실제 파일시스템에 mock 플러그인을 생성하여 end-to-end 검증.

```typescript
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
        export function register(api) { api.registerService({ name: "reg-svc", start: async () => {}, stop: async () => {} }); }
        export function activate(api) { api.registerService({ name: "act-svc", start: async () => {}, stop: async () => {} }); }
      `,
    });

    const result = await loadPlugins([tmpDir], [tmpDir]);
    expect(result.loaded).toContain('both-plugin');
    // register가 우선 → reg-svc만 등록
    expect(getSlot('services').some((s) => s.name === 'reg-svc')).toBe(true);
    expect(getSlot('services').some((s) => s.name === 'act-svc')).toBe(false);
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
```

## 4-7. packages/server/test/plugins/diagnostics.test.ts 생성

**의존:** `../../src/plugins/registry.js`

> Diagnostics 슬롯: 실패 기록 누적, severity 필터링 테스트.

```typescript
// packages/server/test/plugins/diagnostics.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { PluginDiagnostic } from '@finclaw/types';
import {
  setPluginRegistry,
  createEmptyRegistry,
  registerToSlot,
  getSlot,
} from '../../src/plugins/registry.js';

beforeEach(() => {
  setPluginRegistry(createEmptyRegistry());
});

function addDiag(overrides: Partial<PluginDiagnostic> = {}): PluginDiagnostic {
  const diag: PluginDiagnostic = {
    pluginName: 'test-plugin',
    timestamp: Date.now(),
    severity: 'info',
    phase: 'runtime',
    message: 'test diagnostic',
    ...overrides,
  };
  registerToSlot('diagnostics', diag);
  return diag;
}

describe('diagnostics 슬롯', () => {
  it('진단 정보를 누적 기록한다', () => {
    addDiag({ message: 'first' });
    addDiag({ message: 'second' });
    addDiag({ message: 'third' });

    expect(getSlot('diagnostics')).toHaveLength(3);
  });

  it('severity별 필터링이 가능하다', () => {
    addDiag({ severity: 'info', message: 'info msg' });
    addDiag({ severity: 'warn', message: 'warn msg' });
    addDiag({ severity: 'error', message: 'error msg' });
    addDiag({ severity: 'error', message: 'another error' });

    const all = getSlot('diagnostics');
    const errors = all.filter((d) => d.severity === 'error');
    const warns = all.filter((d) => d.severity === 'warn');

    expect(errors).toHaveLength(2);
    expect(warns).toHaveLength(1);
  });

  it('phase별 필터링이 가능하다', () => {
    addDiag({ phase: 'discovery', message: 'disc' });
    addDiag({ phase: 'manifest', message: 'man' });
    addDiag({ phase: 'load', message: 'load' });
    addDiag({ phase: 'register', message: 'reg' });
    addDiag({ phase: 'runtime', message: 'rt' });

    const all = getSlot('diagnostics');
    expect(all.filter((d) => d.phase === 'load')).toHaveLength(1);
    expect(all.filter((d) => d.phase === 'runtime')).toHaveLength(1);
  });

  it('error 정보를 포함할 수 있다', () => {
    addDiag({
      severity: 'error',
      message: 'load failed',
      error: { code: 'MODULE_NOT_FOUND', stack: 'Error: ...' },
    });

    const diags = getSlot('diagnostics');
    expect(diags[0].error?.code).toBe('MODULE_NOT_FOUND');
  });

  it('pluginName으로 특정 플러그인의 진단을 조회한다', () => {
    addDiag({ pluginName: 'plugin-a', message: 'a1' });
    addDiag({ pluginName: 'plugin-b', message: 'b1' });
    addDiag({ pluginName: 'plugin-a', message: 'a2' });

    const all = getSlot('diagnostics');
    const pluginA = all.filter((d) => d.pluginName === 'plugin-a');
    expect(pluginA).toHaveLength(2);
  });
});
```

### 세션 3 완료 검증

```bash
pnpm typecheck                                                    # 에러 0
pnpm vitest run packages/server/test/plugins/manifest.test.ts     # 통과
pnpm vitest run packages/server/test/plugins/discovery.test.ts    # 통과
pnpm vitest run packages/server/test/plugins/loader.test.ts       # 통과
pnpm vitest run packages/server/test/plugins/diagnostics.test.ts  # 통과
pnpm vitest run packages/server/test/plugins/                     # 전체 통과 (7개)
```

---

## 의존성 그래프

```
todo-a 산출물
  ├── types/plugin.ts (8슬롯, 9훅)
  ├── errors.ts (3개 에러 클래스)
  ├── registry.ts (registerToSlot, getSlot)
  └── hooks.ts (createHookRunner)
       │
       ▼
4-1 manifest.ts ────────────────────────────→ 4-4 manifest.test.ts
       │
4-2 discovery.ts ──────────────────────────→ 4-5 discovery.test.ts
       │
4-3 loader.ts ─────┬──────────────────────→ 4-6 loader.test.ts
  (manifest + discovery + registry 통합)    │
                    └──────────────────────→ 4-7 diagnostics.test.ts
```
