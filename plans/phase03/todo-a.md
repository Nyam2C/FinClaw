# Phase 3 todo-a: 기초 + 해석기 (세션 1-2)

> **소스 11 + 테스트 8 = 19파일**

## 선행조건

```bash
# Phase 2 완료 확인
pnpm typecheck   # 에러 0
pnpm test        # 전체 통과
```

---

# 세션 1: Step 1-2 — 패키지 인프라 + Zod 스키마 (소스 4 + 테스트 2 = 6파일)

## 1-1. packages/config/package.json 스텁 업데이트

**의존:** 없음

```jsonc
{
  "name": "@finclaw/config",
  "version": "0.1.0",
  "private": true,
  "files": ["dist"],
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
    },
  },
  "dependencies": {
    "@finclaw/types": "workspace:*",
    "@finclaw/infra": "workspace:*",
    "json5": "^2.2.3",
    "zod": "^4.0.0",
  },
}
```

```bash
# 검증
cd packages/config && pnpm install
```

## 1-2. packages/config/tsconfig.json 스텁 업데이트

**의존:** 없음

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "references": [{ "path": "../types" }, { "path": "../infra" }]
}
```

## 1-3. packages/config/src/errors.ts 생성

**의존:** `@finclaw/infra` (FinClawError)

```typescript
// packages/config/src/errors.ts
import { FinClawError } from '@finclaw/infra';

/** 설정 시스템 기본 에러 */
export class ConfigError extends FinClawError {
  constructor(message: string, opts?: { cause?: Error; details?: Record<string, unknown> }) {
    super(message, 'CONFIG_ERROR', opts);
    this.name = 'ConfigError';
  }
}

/** 필수 환경변수 누락 */
export class MissingEnvVarError extends ConfigError {
  readonly variable: string;
  constructor(variable: string) {
    super(`Environment variable not set: ${variable}`, {
      details: { variable },
    });
    this.name = 'MissingEnvVarError';
    this.variable = variable;
  }
}

/** $include 순환 참조 */
export class CircularIncludeError extends ConfigError {
  constructor(chain: string[]) {
    super(`Circular $include detected: ${chain.join(' -> ')}`, {
      details: { chain },
    });
    this.name = 'CircularIncludeError';
  }
}

/** Zod 검증 실패 */
export class ConfigValidationError extends ConfigError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { details });
    this.name = 'ConfigValidationError';
  }
}
```

## 1-4. packages/config/src/types.ts 생성

**의존:** `@finclaw/types` (FinClawConfig), `@finclaw/infra` (FinClawLogger)

```typescript
// packages/config/src/types.ts
import type { FinClawConfig } from '@finclaw/types';
import type { FinClawLogger } from '@finclaw/infra';

/**
 * ConfigDeps -- createConfigIO()에 주입하는 의존성 인터페이스
 *
 * Phase 1 @finclaw/types의 ConfigIoDeps(async)와 이름 충돌 방지를 위해
 * config 패키지 내부 타입으로 분리. 이 인터페이스는 sync 메서드 사용.
 */
export interface ConfigDeps {
  fs?: typeof import('node:fs');
  json5?: { parse(text: string): unknown };
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  configPath?: string;
  logger?: Pick<FinClawLogger, 'error' | 'warn' | 'info' | 'debug'>;
}

/** TTL 캐시 내부 상태 */
export interface ConfigCache {
  config: FinClawConfig | null;
  expireAt: number;
  mtime: number;
  isValid(): boolean;
  get(): FinClawConfig | null;
  set(config: FinClawConfig): void;
  invalidate(): void;
}
```

```bash
# Step 1 검증
pnpm typecheck  # 에러 0
```

## 1-5. packages/config/src/zod-schema.ts 생성

**의존:** `zod` (v4)

```typescript
// packages/config/src/zod-schema.ts
import { z } from 'zod/v4';

/** 게이트웨이 설정 스키마 */
const GatewaySchema = z.strictObject({
  port: z.number().int().min(1).max(65535),
  host: z.string(),
  tls: z.boolean(),
  corsOrigins: z.array(z.string()),
});

/** 에이전트 기본값 스키마 */
const AgentDefaultsSchema = z.strictObject({
  model: z.string(),
  provider: z.string(),
  maxConcurrent: z.number().int().min(1).max(10),
  maxTokens: z.number().int().min(1),
  temperature: z.number().min(0).max(2),
});

/** 에이전트 엔트리 스키마 */
const AgentEntrySchema = z.strictObject({
  agentDir: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  maxConcurrent: z.number().int().optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(z.string()).optional(),
});

/** 세션 설정 스키마 */
const SessionSchema = z.strictObject({
  mainKey: z.string(),
  resetPolicy: z.enum(['daily', 'idle', 'never']),
  idleTimeoutMs: z.number().int().min(0),
});

/** 로깅 설정 스키마 */
const LoggingSchema = z.strictObject({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
  file: z.boolean(),
  redactSensitive: z.boolean(),
});

/** 모델 정의 스키마 */
const ModelDefinitionSchema = z.strictObject({
  provider: z.string(),
  model: z.string(),
  contextWindow: z.number().int().optional(),
  maxOutputTokens: z.number().int().optional(),
  costPer1kInput: z.number().optional(),
  costPer1kOutput: z.number().optional(),
});

/** Discord 채널 설정 스키마 */
const DiscordChannelSchema = z.strictObject({
  botToken: z.string(),
  applicationId: z.string(),
  guildIds: z.array(z.string()).optional(),
});

/** 데이터 프로바이더 스키마 */
const DataProviderSchema = z.strictObject({
  name: z.string(),
  apiKey: z.string().optional(),
  baseUrl: z.url().optional(),
  rateLimit: z.number().int().optional(),
});

/** 알림 기본값 스키마 */
const AlertDefaultsSchema = z.strictObject({
  cooldownMs: z.number().int(),
  maxActiveAlerts: z.number().int(),
});

/** 보유 종목 스키마 */
const HoldingSchema = z.strictObject({
  symbol: z.string(),
  quantity: z.number(),
  avgCost: z.number().optional(),
  currency: z.string().optional(),
});

/** 포트폴리오 스키마 */
const PortfolioSchema = z.strictObject({
  name: z.string(),
  holdings: z.array(HoldingSchema),
});

/** 금융 설정 스키마 */
const FinanceSchema = z.strictObject({
  dataProviders: z.array(DataProviderSchema).optional(),
  newsFeeds: z
    .array(
      z.strictObject({
        name: z.string(),
        url: z.url(),
        refreshIntervalMs: z.number().int().optional(),
      }),
    )
    .optional(),
  alertDefaults: AlertDefaultsSchema.optional(),
  portfolios: z.record(z.string(), PortfolioSchema).optional(),
});

/**
 * FinClawConfig 루트 스키마
 *
 * - z.strictObject() 사용: 알 수 없는 키 감지 (오타 방지)
 * - 모든 최상위 섹션은 optional (빈 {} 허용)
 * - .default()는 사용하지 않음 — 7단계 defaults.ts에서 별도 적용
 */
export const FinClawConfigSchema = z.strictObject({
  gateway: GatewaySchema.partial().optional(),
  agents: z
    .strictObject({
      defaults: AgentDefaultsSchema.partial().optional(),
      entries: z.record(z.string(), AgentEntrySchema).optional(),
    })
    .optional(),
  channels: z
    .strictObject({
      discord: DiscordChannelSchema.optional(),
      cli: z.strictObject({ enabled: z.boolean() }).partial().optional(),
      web: z
        .strictObject({
          enabled: z.boolean(),
          port: z.number().int().optional(),
        })
        .partial()
        .optional(),
    })
    .optional(),
  session: SessionSchema.partial().optional(),
  logging: LoggingSchema.partial().optional(),
  models: z
    .strictObject({
      definitions: z.record(z.string(), ModelDefinitionSchema).optional(),
      aliases: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  plugins: z
    .strictObject({
      enabled: z.array(z.string()).optional(),
      disabled: z.array(z.string()).optional(),
    })
    .optional(),
  finance: FinanceSchema.optional(),
  meta: z
    .strictObject({
      lastTouchedVersion: z.string().optional(),
      lastTouchedAt: z.string().optional(),
    })
    .optional(),
});

export type ValidatedFinClawConfig = z.infer<typeof FinClawConfigSchema>;
```

> **설계 결정:** plan.md §4.2는 각 필드에 `.default()`를 사용했으나,
> Zod v4에서 `.default()`는 output type을 변경하여 `FinClawConfig` 타입과
> 불일치를 일으킨다. 대신 `.partial()`로 모든 필드를 optional로 만들고,
> 기본값 적용은 `defaults.ts`(Step 4)에서 수행한다.

## 1-6. packages/config/src/validation.ts 생성

**의존:** `./zod-schema.js`, `./errors.js`, `@finclaw/types`

```typescript
// packages/config/src/validation.ts
import { z } from 'zod/v4';
import type { FinClawConfig, ConfigValidationIssue } from '@finclaw/types';
import { FinClawConfigSchema } from './zod-schema.js';
import { ConfigValidationError } from './errors.js';

export interface ValidationResult {
  valid: boolean;
  config: FinClawConfig;
  issues: ConfigValidationIssue[];
}

/**
 * Zod 기반 2단계 검증
 *
 * 1. safeParse로 스키마 검증
 * 2. 실패 시 z.treeifyError()로 이슈 수집, 빈 {} 반환
 * 3. 성공 시 validated config 반환
 */
export function validateConfig(raw: unknown): ValidationResult {
  const result = FinClawConfigSchema.safeParse(raw);

  if (result.success) {
    return {
      valid: true,
      config: result.data as FinClawConfig,
      issues: [],
    };
  }

  const tree = z.treeifyError(result.error);
  const issues = collectIssues(tree);

  return {
    valid: false,
    config: {} as FinClawConfig,
    issues,
  };
}

/**
 * 검증 실패 시 에러를 throw하는 strict 버전
 */
export function validateConfigStrict(raw: unknown): FinClawConfig {
  const { valid, config, issues } = validateConfig(raw);
  if (!valid) {
    throw new ConfigValidationError(
      `Config validation failed: ${issues.map((i) => i.message).join('; ')}`,
      { issues },
    );
  }
  return config;
}

/** z.treeifyError 결과를 ConfigValidationIssue[]로 평탄화 */
function collectIssues(tree: z.ZodErrorTree<unknown>, path = ''): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];

  if (tree.errors && tree.errors.length > 0) {
    for (const msg of tree.errors) {
      issues.push({
        path: path || '(root)',
        message: msg,
        severity: 'error',
      });
    }
  }

  if (tree.properties) {
    for (const [key, subtree] of Object.entries(tree.properties)) {
      const childPath = path ? `${path}.${key}` : key;
      issues.push(...collectIssues(subtree as z.ZodErrorTree<unknown>, childPath));
    }
  }

  return issues;
}
```

## 1-7. packages/config/test/zod-schema.test.ts 생성

**의존:** `../src/zod-schema.js`

```typescript
// packages/config/test/zod-schema.test.ts
import { describe, it, expect } from 'vitest';
import { FinClawConfigSchema } from '../src/zod-schema.js';

describe('FinClawConfigSchema', () => {
  it('빈 객체를 허용한다', () => {
    const result = FinClawConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('유효한 전체 설정을 허용한다', () => {
    const config = {
      gateway: { port: 18789, host: 'localhost' },
      agents: {
        defaults: { model: 'claude-sonnet-4-20250514', provider: 'anthropic' },
        entries: { main: { model: 'claude-sonnet-4-20250514' } },
      },
      channels: {
        discord: { botToken: 'token', applicationId: 'app-id' },
        cli: { enabled: true },
      },
      session: { mainKey: 'main', resetPolicy: 'idle' as const },
      logging: { level: 'info' as const, file: true },
      models: {
        definitions: {
          sonnet: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
        },
        aliases: { default: 'sonnet' },
      },
      plugins: { enabled: ['finance'] },
      finance: {
        dataProviders: [{ name: 'yahoo' }],
        alertDefaults: { cooldownMs: 300000, maxActiveAlerts: 100 },
      },
      meta: { lastTouchedVersion: '0.1.0' },
    };
    const result = FinClawConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('알 수 없는 키를 거부한다 (strictObject)', () => {
    const result = FinClawConfigSchema.safeParse({ gatway: {} });
    expect(result.success).toBe(false);
  });

  it('잘못된 포트 범위를 거부한다', () => {
    const result = FinClawConfigSchema.safeParse({
      gateway: { port: 99999 },
    });
    expect(result.success).toBe(false);
  });

  it('잘못된 resetPolicy를 거부한다', () => {
    const result = FinClawConfigSchema.safeParse({
      session: { resetPolicy: 'weekly' },
    });
    expect(result.success).toBe(false);
  });

  it('잘못된 URL을 거부한다', () => {
    const result = FinClawConfigSchema.safeParse({
      finance: {
        dataProviders: [{ name: 'test', baseUrl: 'not-a-url' }],
      },
    });
    expect(result.success).toBe(false);
  });

  it('유효한 URL을 허용한다', () => {
    const result = FinClawConfigSchema.safeParse({
      finance: {
        dataProviders: [{ name: 'yahoo', baseUrl: 'https://api.yahoo.com' }],
      },
    });
    expect(result.success).toBe(true);
  });
});
```

## 1-8. packages/config/test/validation.test.ts 생성

**의존:** `../src/validation.js`, `../src/errors.js`

```typescript
// packages/config/test/validation.test.ts
import { describe, it, expect } from 'vitest';
import { validateConfig, validateConfigStrict } from '../src/validation.js';
import { ConfigValidationError } from '../src/errors.js';

describe('validateConfig', () => {
  it('유효한 설정에 valid: true를 반환한다', () => {
    const result = validateConfig({ gateway: { port: 8080 } });
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.config).toEqual({ gateway: { port: 8080 } });
  });

  it('빈 객체에 valid: true를 반환한다', () => {
    const result = validateConfig({});
    expect(result.valid).toBe(true);
  });

  it('잘못된 설정에 valid: false와 issues를 반환한다', () => {
    const result = validateConfig({ gatway: {} });
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0].severity).toBe('error');
  });

  it('중첩된 에러의 경로를 포함한다', () => {
    const result = validateConfig({ gateway: { port: -1 } });
    expect(result.valid).toBe(false);
    const portIssue = result.issues.find((i) => i.path.includes('port'));
    expect(portIssue).toBeDefined();
  });
});

describe('validateConfigStrict', () => {
  it('유효한 설정에 config를 반환한다', () => {
    const config = validateConfigStrict({ logging: { level: 'debug' } });
    expect(config).toEqual({ logging: { level: 'debug' } });
  });

  it('잘못된 설정에 ConfigValidationError를 throw한다', () => {
    expect(() => validateConfigStrict({ unknown_key: true })).toThrow(ConfigValidationError);
  });
});
```

### 세션 1 완료 검증

```bash
pnpm typecheck                                          # 에러 0
pnpm test -- packages/config/test/zod-schema.test.ts    # 통과
pnpm test -- packages/config/test/validation.test.ts    # 통과
```

---

# 세션 2: Step 3 — 기능 해석기 (소스 7 + 테스트 6 = 13파일)

## 2-1. packages/config/src/includes.ts 생성

**의존:** `./errors.js` (CircularIncludeError)

```typescript
// packages/config/src/includes.ts
import { CircularIncludeError } from './errors.js';

const MAX_INCLUDE_DEPTH = 10;

/**
 * $include 재귀 해석
 *
 * - $include 키가 있으면 해당 파일을 읽어 deepMerge
 * - 순환 참조 감지 (chain 배열로 추적)
 * - MAX_INCLUDE_DEPTH(10) 제한
 */
export function resolveIncludes(
  raw: Record<string, unknown>,
  readFile: (filePath: string) => Record<string, unknown>,
  basePath: string,
  chain: string[] = [],
): Record<string, unknown> {
  if (chain.length > MAX_INCLUDE_DEPTH) {
    throw new CircularIncludeError(chain);
  }

  const includePath = raw.$include;
  if (typeof includePath !== 'string') {
    return raw;
  }

  const resolvedPath = resolvePath(includePath, basePath);

  if (chain.includes(resolvedPath)) {
    throw new CircularIncludeError([...chain, resolvedPath]);
  }

  const included = readFile(resolvedPath);
  const resolvedIncluded = resolveIncludes(included, readFile, resolvedPath, [
    ...chain,
    resolvedPath,
  ]);

  const { $include: _, ...rest } = raw;
  return deepMerge(resolvedIncluded, rest) as Record<string, unknown>;
}

/** Deep merge: 배열=연결, 객체=재귀, 원시값=source 우선 */
export function deepMerge(target: unknown, source: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(source)) {
    return [...target, ...source];
  }
  if (isPlainObject(target) && isPlainObject(source)) {
    const result: Record<string, unknown> = { ...target };
    for (const key of Object.keys(source)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      result[key] = key in result ? deepMerge(result[key], source[key]) : source[key];
    }
    return result;
  }
  return source;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

function resolvePath(includePath: string, basePath: string): string {
  if (includePath.startsWith('/')) return includePath;
  const dir = basePath.replace(/[/\\][^/\\]*$/, '');
  return `${dir}/${includePath}`;
}
```

## 2-2. packages/config/src/env-substitution.ts 생성

**의존:** `./errors.js` (MissingEnvVarError)

```typescript
// packages/config/src/env-substitution.ts
import { MissingEnvVarError } from './errors.js';

/**
 * 환경변수 치환 엔진
 *
 * - 대문자만: [A-Z_][A-Z0-9_]*
 * - 1회 치환 (재귀 없음 — injection 방지)
 * - $${VAR} escape: 리터럴 ${VAR} 출력
 * - 미설정/빈 문자열: MissingEnvVarError throw
 */

const ENV_VAR_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
const ESCAPED_PATTERN = /\$\$\{([A-Z_][A-Z0-9_]*)\}/g;

export function resolveEnvVars(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === 'string') {
    return substituteString(value, env);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveEnvVars(item, env));
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = resolveEnvVars(v, env);
    }
    return result;
  }
  return value;
}

function substituteString(str: string, env: NodeJS.ProcessEnv): string {
  if (!str.includes('$')) return str;

  let result = str.replace(ESCAPED_PATTERN, '\x00ESC_ENV\x00$1\x00');

  result = result.replace(ENV_VAR_PATTERN, (_, varName: string) => {
    const value = env[varName];
    if (value === undefined || value === '') {
      throw new MissingEnvVarError(varName);
    }
    return value;
  });

  result = result.replace(/\x00ESC_ENV\x00([A-Z_][A-Z0-9_]*)\x00/g, '${$1}');

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}
```

## 2-3. packages/config/src/paths.ts 생성

**의존:** 없음 (Node.js 내장만 사용)

```typescript
// packages/config/src/paths.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 설정 파일 경로 해석 (JSON5, 자체 구현)
 *
 * 우선순위:
 *   1. FINCLAW_CONFIG 환경변수
 *   2. ~/.finclaw/config/finclaw.json5
 *   3. ./finclaw.json5
 *
 * infra의 getConfigFilePath()는 finclaw.json을 반환하므로 사용하지 않음.
 */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const envPath = env.FINCLAW_CONFIG;
  if (envPath) return path.resolve(envPath);

  const homePath = path.join(os.homedir(), '.finclaw', 'config', 'finclaw.json5');
  if (fs.existsSync(homePath)) return homePath;

  return path.resolve('finclaw.json5');
}
```

## 2-4. packages/config/src/merge-config.ts 생성

**의존:** 없음 (자체 유틸)

```typescript
// packages/config/src/merge-config.ts

/**
 * 섹션 단위 shallow merge + deep merge
 *
 * - 배열: 연결 (concat)
 * - 객체: 재귀 병합
 * - 원시값: source 우선
 * - 프로토타입 오염 방지
 */
export function mergeConfig(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }

    const tVal = result[key];
    const sVal = source[key];

    if (Array.isArray(tVal) && Array.isArray(sVal)) {
      result[key] = [...tVal, ...sVal];
    } else if (isPlainObject(tVal) && isPlainObject(sVal)) {
      result[key] = mergeConfig(tVal, sVal);
    } else {
      result[key] = sVal;
    }
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}
```

## 2-5. packages/config/src/normalize-paths.ts 생성

**의존:** 없음

```typescript
// packages/config/src/normalize-paths.ts
import * as os from 'node:os';

/**
 * ~/ 경로 확장
 *
 * 문자열 값에서 ~/ 접두사를 homedir()로 치환.
 * 재귀적으로 객체/배열을 탐색.
 */
export function normalizePaths(value: unknown, homedir: () => string = os.homedir): unknown {
  if (typeof value === 'string') {
    return expandTilde(value, homedir);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizePaths(item, homedir));
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = normalizePaths(v, homedir);
    }
    return result;
  }
  return value;
}

function expandTilde(str: string, homedir: () => string): string {
  if (str === '~') return homedir();
  if (str.startsWith('~/')) return homedir() + str.slice(1);
  return str;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}
```

## 2-6. packages/config/src/runtime-overrides.ts 생성

**의존:** 없음

```typescript
// packages/config/src/runtime-overrides.ts
import type { FinClawConfig } from '@finclaw/types';

/**
 * 인메모리 런타임 오버라이드
 *
 * - set(path, value): 오버라이드 등록
 * - unset(path): 오버라이드 제거
 * - apply(config): 오버라이드를 config에 적용 (shallow merge)
 * - reset(): 모든 오버라이드 초기화
 */

const overrides = new Map<string, unknown>();

export function setOverride(path: string, value: unknown): void {
  overrides.set(path, value);
}

export function unsetOverride(path: string): void {
  overrides.delete(path);
}

export function applyOverrides(config: FinClawConfig): FinClawConfig {
  if (overrides.size === 0) return config;

  let result: Record<string, unknown> = { ...config };
  for (const [dotPath, value] of overrides) {
    result = setNestedValue(result, dotPath.split('.'), value);
  }
  return result as FinClawConfig;
}

export function resetOverrides(): void {
  overrides.clear();
}

export function getOverrideCount(): number {
  return overrides.size;
}

function setNestedValue(
  obj: Record<string, unknown>,
  keys: string[],
  value: unknown,
): Record<string, unknown> {
  if (keys.length === 0) return obj;
  if (keys.length === 1) {
    return { ...obj, [keys[0]]: value };
  }

  const [head, ...rest] = keys;
  const child = (obj[head] ?? {}) as Record<string, unknown>;
  return {
    ...obj,
    [head]: setNestedValue({ ...child }, rest, value),
  };
}
```

## 2-7. packages/config/src/cache-utils.ts 생성

**의존:** `./types.js` (ConfigCache), `@finclaw/types` (FinClawConfig)

```typescript
// packages/config/src/cache-utils.ts
import type { FinClawConfig } from '@finclaw/types';
import type { ConfigCache } from './types.js';

const DEFAULT_TTL_MS = 200;

/** TTL 캐시 생성 */
export function createConfigCache(ttlMs = DEFAULT_TTL_MS): ConfigCache {
  let config: FinClawConfig | null = null;
  let expireAt = 0;
  let mtime = 0;

  return {
    get config() {
      return config;
    },
    get expireAt() {
      return expireAt;
    },
    get mtime() {
      return mtime;
    },

    isValid(): boolean {
      return config !== null && Date.now() < expireAt;
    },

    get(): FinClawConfig | null {
      if (this.isValid()) return config;
      return null;
    },

    set(newConfig: FinClawConfig): void {
      config = newConfig;
      expireAt = Date.now() + ttlMs;
      mtime = Date.now();
    },

    invalidate(): void {
      config = null;
      expireAt = 0;
    },
  };
}
```

## 2-8. packages/config/test/includes.test.ts 생성

```typescript
// packages/config/test/includes.test.ts
import { describe, it, expect } from 'vitest';
import { resolveIncludes, deepMerge } from '../src/includes.js';
import { CircularIncludeError } from '../src/errors.js';

describe('deepMerge', () => {
  it('객체를 재귀적으로 병합한다', () => {
    const target = { a: { b: 1, c: 2 } };
    const source = { a: { c: 3, d: 4 } };
    expect(deepMerge(target, source)).toEqual({ a: { b: 1, c: 3, d: 4 } });
  });

  it('배열을 연결한다', () => {
    expect(deepMerge([1, 2], [3, 4])).toEqual([1, 2, 3, 4]);
  });

  it('원시값은 source가 우선한다', () => {
    expect(deepMerge('old', 'new')).toBe('new');
    expect(deepMerge(1, 2)).toBe(2);
  });

  it('프로토타입 오염 키를 무시한다', () => {
    const source = JSON.parse('{"__proto__": {"polluted": true}}');
    const result = deepMerge({}, source) as Record<string, unknown>;
    expect(result.__proto__).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('resolveIncludes', () => {
  it('$include 없으면 원본 반환한다', () => {
    const raw = { key: 'value' };
    const result = resolveIncludes(raw, () => ({}), '/base/config.json5');
    expect(result).toEqual({ key: 'value' });
  });

  it('$include를 해석하고 deep merge한다', () => {
    const files: Record<string, Record<string, unknown>> = {
      '/base/common.json5': { shared: { a: 1 } },
    };
    const raw = { $include: 'common.json5', shared: { b: 2 } };
    const result = resolveIncludes(raw, (p) => files[p] ?? {}, '/base/config.json5');
    expect(result).toEqual({ shared: { a: 1, b: 2 } });
  });

  it('순환 참조를 감지한다', () => {
    const files: Record<string, Record<string, unknown>> = {
      '/a.json5': { $include: 'b.json5' },
      '/b.json5': { $include: 'a.json5' },
    };
    expect(() =>
      resolveIncludes({ $include: 'a.json5' }, (p) => files[p] ?? {}, '/config.json5'),
    ).toThrow(CircularIncludeError);
  });

  it('깊이 제한(10)을 초과하면 에러를 던진다', () => {
    const readFile = (p: string): Record<string, unknown> => ({
      $include: `${p}_next`,
    });
    expect(() => resolveIncludes({ $include: 'level0' }, readFile, '/base.json5')).toThrow(
      CircularIncludeError,
    );
  });
});
```

## 2-9. packages/config/test/env-substitution.test.ts 생성

```typescript
// packages/config/test/env-substitution.test.ts
import { describe, it, expect, vi } from 'vitest';
import { resolveEnvVars } from '../src/env-substitution.js';
import { MissingEnvVarError } from '../src/errors.js';

describe('resolveEnvVars', () => {
  const env = {
    API_KEY: 'secret123',
    HOST: 'localhost',
    PORT: '8080',
  } as NodeJS.ProcessEnv;

  it('${VAR}를 치환한다', () => {
    expect(resolveEnvVars('${API_KEY}', env)).toBe('secret123');
  });

  it('문자열 내 여러 변수를 치환한다', () => {
    expect(resolveEnvVars('http://${HOST}:${PORT}', env)).toBe('http://localhost:8080');
  });

  it('$가 없으면 그대로 반환한다', () => {
    expect(resolveEnvVars('no vars here', env)).toBe('no vars here');
  });

  it('소문자 변수를 무시한다', () => {
    expect(resolveEnvVars('${lower}', env)).toBe('${lower}');
  });

  it('미설정 변수에 MissingEnvVarError를 throw한다', () => {
    expect(() => resolveEnvVars('${MISSING_VAR}', env)).toThrow(MissingEnvVarError);
  });

  it('빈 문자열 변수에 MissingEnvVarError를 throw한다', () => {
    const envWithEmpty = { EMPTY: '' } as NodeJS.ProcessEnv;
    expect(() => resolveEnvVars('${EMPTY}', envWithEmpty)).toThrow(MissingEnvVarError);
  });

  it('$${VAR} escape를 리터럴 ${VAR}로 출력한다', () => {
    expect(resolveEnvVars('$${API_KEY}', env)).toBe('${API_KEY}');
  });

  it('객체를 재귀적으로 치환한다', () => {
    const input = { host: '${HOST}', nested: { port: '${PORT}' } };
    expect(resolveEnvVars(input, env)).toEqual({
      host: 'localhost',
      nested: { port: '8080' },
    });
  });

  it('배열을 재귀적으로 치환한다', () => {
    expect(resolveEnvVars(['${HOST}', '${PORT}'], env)).toEqual(['localhost', '8080']);
  });

  it('숫자/불리언 등 비문자열은 그대로 반환한다', () => {
    expect(resolveEnvVars(42, env)).toBe(42);
    expect(resolveEnvVars(true, env)).toBe(true);
    expect(resolveEnvVars(null, env)).toBe(null);
  });
});
```

## 2-10. packages/config/test/paths.test.ts 생성

```typescript
// packages/config/test/paths.test.ts
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import { resolveConfigPath } from '../src/paths.js';

describe('resolveConfigPath', () => {
  it('FINCLAW_CONFIG 환경변수가 최우선이다', () => {
    const env = { FINCLAW_CONFIG: '/custom/config.json5' } as NodeJS.ProcessEnv;
    expect(resolveConfigPath(env)).toBe('/custom/config.json5');
  });

  it('환경변수 없으면 ~/.finclaw/config/finclaw.json5를 탐색한다', async () => {
    const home = os.homedir();
    const homePath = path.join(home, '.finclaw', 'config', 'finclaw.json5');

    // 파일이 존재하면 해당 경로 반환, 없으면 ./finclaw.json5
    const result = resolveConfigPath({} as NodeJS.ProcessEnv);
    const expected = await fs
      .access(homePath)
      .then(() => homePath)
      .catch(() => path.resolve('finclaw.json5'));
    expect(result).toBe(expected);
  });

  it('환경변수도 홈경로도 없으면 ./finclaw.json5를 반환한다', () => {
    const result = resolveConfigPath({} as NodeJS.ProcessEnv);
    // HOME이 tmpDir로 격리되어 있으므로 ./finclaw.json5
    expect(result).toBe(path.resolve('finclaw.json5'));
  });
});
```

## 2-11. packages/config/test/merge-config.test.ts 생성

```typescript
// packages/config/test/merge-config.test.ts
import { describe, it, expect } from 'vitest';
import { mergeConfig } from '../src/merge-config.js';

describe('mergeConfig', () => {
  it('객체를 재귀 병합한다', () => {
    const target = { a: { b: 1, c: 2 }, d: 'keep' };
    const source = { a: { c: 3, e: 4 } };
    expect(mergeConfig(target, source)).toEqual({
      a: { b: 1, c: 3, e: 4 },
      d: 'keep',
    });
  });

  it('배열을 연결한다', () => {
    const target = { arr: [1, 2] };
    const source = { arr: [3, 4] };
    expect(mergeConfig(target, source)).toEqual({ arr: [1, 2, 3, 4] });
  });

  it('원시값은 source가 우선한다', () => {
    const target = { key: 'old' };
    const source = { key: 'new' };
    expect(mergeConfig(target, source)).toEqual({ key: 'new' });
  });

  it('source의 새 키를 추가한다', () => {
    expect(mergeConfig({}, { newKey: 'value' })).toEqual({ newKey: 'value' });
  });

  it('프로토타입 오염 키를 무시한다', () => {
    const source = JSON.parse('{"__proto__": {"x": 1}, "constructor": "bad"}');
    const result = mergeConfig({}, source);
    expect(result.__proto__).toBeUndefined();
    expect(result.constructor).toBeUndefined();
  });

  it('target을 변경하지 않는다 (불변)', () => {
    const target = { a: { b: 1 } };
    const frozen = JSON.parse(JSON.stringify(target));
    mergeConfig(target, { a: { c: 2 } });
    expect(target).toEqual(frozen);
  });
});
```

## 2-12. packages/config/test/normalize-paths.test.ts 생성

```typescript
// packages/config/test/normalize-paths.test.ts
import { describe, it, expect } from 'vitest';
import { normalizePaths } from '../src/normalize-paths.js';

describe('normalizePaths', () => {
  const homedir = () => '/home/user';

  it('~/를 homedir로 확장한다', () => {
    expect(normalizePaths('~/data', homedir)).toBe('/home/user/data');
  });

  it('~만 있으면 homedir로 확장한다', () => {
    expect(normalizePaths('~', homedir)).toBe('/home/user');
  });

  it('~/로 시작하지 않는 문자열은 그대로 반환한다', () => {
    expect(normalizePaths('/absolute/path', homedir)).toBe('/absolute/path');
    expect(normalizePaths('relative/path', homedir)).toBe('relative/path');
  });

  it('객체를 재귀적으로 처리한다', () => {
    const input = { dir: '~/config', nested: { path: '~/logs' } };
    expect(normalizePaths(input, homedir)).toEqual({
      dir: '/home/user/config',
      nested: { path: '/home/user/logs' },
    });
  });

  it('배열을 재귀적으로 처리한다', () => {
    expect(normalizePaths(['~/a', '~/b'], homedir)).toEqual(['/home/user/a', '/home/user/b']);
  });

  it('숫자/불리언 등은 그대로 반환한다', () => {
    expect(normalizePaths(42, homedir)).toBe(42);
    expect(normalizePaths(true, homedir)).toBe(true);
  });
});
```

## 2-13. packages/config/test/runtime-overrides.test.ts 생성

```typescript
// packages/config/test/runtime-overrides.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { FinClawConfig } from '@finclaw/types';
import {
  setOverride,
  unsetOverride,
  applyOverrides,
  resetOverrides,
  getOverrideCount,
} from '../src/runtime-overrides.js';

describe('runtime-overrides', () => {
  beforeEach(() => {
    resetOverrides();
  });

  it('오버라이드가 없으면 원본 config를 반환한다', () => {
    const config = { gateway: { port: 8080 } } as FinClawConfig;
    expect(applyOverrides(config)).toBe(config);
  });

  it('set으로 중첩 경로에 값을 설정한다', () => {
    setOverride('gateway.port', 9090);
    const config = { gateway: { port: 8080, host: 'localhost' } } as FinClawConfig;
    const result = applyOverrides(config);
    expect((result.gateway as Record<string, unknown>).port).toBe(9090);
    expect((result.gateway as Record<string, unknown>).host).toBe('localhost');
  });

  it('unset으로 오버라이드를 제거한다', () => {
    setOverride('gateway.port', 9090);
    unsetOverride('gateway.port');
    const config = { gateway: { port: 8080 } } as FinClawConfig;
    expect(applyOverrides(config)).toBe(config);
  });

  it('reset으로 모든 오버라이드를 초기화한다', () => {
    setOverride('gateway.port', 9090);
    setOverride('logging.level', 'debug');
    resetOverrides();
    expect(getOverrideCount()).toBe(0);
  });

  it('원본 config를 변경하지 않는다', () => {
    setOverride('gateway.port', 9090);
    const config = { gateway: { port: 8080 } } as FinClawConfig;
    applyOverrides(config);
    expect((config.gateway as Record<string, unknown>).port).toBe(8080);
  });
});
```

### 세션 2 완료 검증

```bash
pnpm typecheck                                              # 에러 0
pnpm test -- packages/config/test/includes.test.ts          # 통과
pnpm test -- packages/config/test/env-substitution.test.ts  # 통과
pnpm test -- packages/config/test/paths.test.ts             # 통과
pnpm test -- packages/config/test/merge-config.test.ts      # 통과
pnpm test -- packages/config/test/normalize-paths.test.ts   # 통과
pnpm test -- packages/config/test/runtime-overrides.test.ts # 통과
pnpm test -- packages/config/                               # 8개 전체 통과
```
