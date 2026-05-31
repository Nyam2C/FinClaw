// @finclaw/config — barrel export

// 타입
export type { ConfigDeps, ConfigCache } from './types.js';
export type { ValidationResult } from './validation.js';
export type { ConfigIO } from './io.js';

// 에러
export {
  ConfigError,
  MissingEnvVarError,
  CircularIncludeError,
  ConfigValidationError,
} from './errors.js';

// 스키마
export { FinClawConfigSchema } from './zod-schema.js';

// 검증
export { validateConfig, validateConfigStrict } from './validation.js';

// 파이프라인 개별 단계
export { resolveConfigPath } from './paths.js';
export { resolveEnvVars } from './env-substitution.js';
export { normalizePaths } from './normalize-paths.js';
export { resolveIncludes } from './includes.js';
export { mergeConfig } from './merge-config.js';
export { applyDefaults, getDefaults } from './defaults.js';
export {
  setOverride,
  unsetOverride,
  applyOverrides,
  resetOverrides,
  getOverrideCount,
} from './runtime-overrides.js';

// 캐시
export { createConfigCache } from './cache-utils.js';

// IO (파이프라인 통합)
export { createConfigIO, loadConfig, clearConfigCache } from './io.js';
