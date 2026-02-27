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
    if (!fs.existsSync(searchPath)) {
      continue;
    }

    const stat = fs.statSync(searchPath);
    if (!stat.isDirectory()) {
      continue;
    }

    const entries = fs.readdirSync(searchPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
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
