// packages/config/src/io.ts
import type { FinClawConfig } from '@finclaw/types';
import { writeFileAtomic } from '@finclaw/infra';
import * as JSON5 from 'json5';
import * as fs from 'node:fs';
import type { ConfigCache, ConfigDeps } from './types.js';
import { createConfigCache } from './cache-utils.js';
import { applyDefaults } from './defaults.js';
import { resolveEnvVars } from './env-substitution.js';
import { ConfigError } from './errors.js';
import { resolveIncludes } from './includes.js';
import { normalizePaths } from './normalize-paths.js';
import { resolveConfigPath } from './paths.js';
import { applyOverrides } from './runtime-overrides.js';
import { validateConfig } from './validation.js';

/** ConfigIO — 설정 읽기/쓰기 파사드 */
export interface ConfigIO {
  /** 8단계 파이프라인으로 설정 로드 */
  loadConfig(): FinClawConfig;
  /** 설정 파일 원자적 쓰기 (async — writeFileAtomic 사용) */
  writeConfigFile(config: FinClawConfig): Promise<void>;
  /** 캐시 무효화 */
  invalidateCache(): void;
  /** 현재 설정 파일 경로 */
  readonly configPath: string;
}

/**
 * ConfigIO 팩토리
 *
 * 8단계 파이프라인:
 *   1. 파일 읽기 (JSON5)
 *   2. $include 해석
 *   3. 환경변수 치환
 *   4. 경로 정규화 (~/)
 *   5. Zod 검증
 *   6. 병합 (includes)
 *   7. 기본값 적용
 *   8. 런타임 오버라이드
 */
export function createConfigIO(deps: ConfigDeps = {}): ConfigIO {
  const fsModule = deps.fs ?? fs;
  const json5Module = deps.json5 ?? JSON5;
  const env = deps.env ?? process.env;
  const homedir = deps.homedir ?? (() => require('node:os').homedir());
  const configPath = deps.configPath ?? resolveConfigPath(env);
  const logger = deps.logger;
  const cache: ConfigCache = createConfigCache();

  function readJsonFile(filePath: string): Record<string, unknown> {
    const content = fsModule.readFileSync(filePath, 'utf-8');
    return json5Module.parse(content) as Record<string, unknown>;
  }

  function loadConfig(): FinClawConfig {
    // 캐시 히트
    const cached = cache.get();
    if (cached) {
      return cached;
    }

    let raw: Record<string, unknown>;

    // 1. 파일 읽기
    try {
      raw = readJsonFile(configPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger?.debug?.(`Config file not found: ${configPath}, using defaults`);
        raw = {};
      } else {
        throw new ConfigError(`Failed to read config: ${configPath}`, {
          cause: err as Error,
        });
      }
    }

    // 2. $include 해석
    raw = resolveIncludes(raw, readJsonFile, configPath);

    // 3. 환경변수 치환
    raw = resolveEnvVars(raw, env) as Record<string, unknown>;

    // 4. 경로 정규화
    raw = normalizePaths(raw, homedir) as Record<string, unknown>;

    // 5. Zod 검증
    const { valid, config: validated, issues } = validateConfig(raw);
    if (!valid) {
      for (const issue of issues) {
        logger?.warn?.(`Config issue [${issue.path}]: ${issue.message}`);
      }
    }

    // 6. 유저 설정 (검증 통과 시 validated, 실패 시 raw를 그대로 사용)
    const userConfig = valid ? validated : (raw as unknown as FinClawConfig);

    // 7. 기본값 적용
    const withDefaults = applyDefaults(userConfig);

    // 8. 런타임 오버라이드
    const final = applyOverrides(withDefaults);

    cache.set(final);
    return final;
  }

  async function writeConfigFile(config: FinClawConfig): Promise<void> {
    const content = JSON.stringify(config, null, 2);
    await writeFileAtomic(configPath, content);
    cache.invalidate();
  }

  return {
    loadConfig,
    writeConfigFile,
    invalidateCache: () => cache.invalidate(),
    get configPath() {
      return configPath;
    },
  };
}

// ─── 모듈 레벨 래퍼 (편의) ───

let defaultIO: ConfigIO | null = null;
let defaultDeps: ConfigDeps | undefined;

/**
 * 기본 ConfigIO로 설정 로드 (싱글턴).
 * deps가 이전 호출과 다르면 내부 IO를 재생성한다.
 * deps 없이 반복 호출하면 캐시된 IO를 재사용한다.
 */
export function loadConfig(deps?: ConfigDeps): FinClawConfig {
  if (!defaultIO || (deps && deps !== defaultDeps)) {
    defaultDeps = deps;
    defaultIO = createConfigIO(deps);
  }
  return defaultIO.loadConfig();
}

/** 기본 ConfigIO 캐시 초기화 */
export function clearConfigCache(): void {
  if (defaultIO) {
    defaultIO.invalidateCache();
  }
  defaultIO = null;
  defaultDeps = undefined;
}
