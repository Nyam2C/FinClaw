import type {
  PluginDiagnostic,
  PluginHookName,
  PluginService,
  PluginCommand,
  RouteRegistration,
  ChannelPlugin,
} from '@finclaw/types';
import { getNodeMajorVersion } from '@finclaw/infra';
import { createJiti } from 'jiti';
// packages/server/src/plugins/loader.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverPlugins, validatePluginPath } from './discovery.js';
import { parseManifest } from './manifest.js';
import { registerToSlot } from './registry.js';

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
  if (jitiLoader) {
    return jitiLoader;
  }
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
