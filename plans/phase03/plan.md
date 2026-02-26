# Phase 3: 설정 시스템

## 1. 목표

FinClaw의 "single source of truth" 설정 시스템을 구축한다. OpenClaw `src/config/`(134파일, 18.2K LOC)의 11단계 설정 파이프라인을 FinClaw에 적응하여 ~32파일, ~5K LOC 규모로 구현한다.

**설정 파이프라인 11단계:**

1. JSON5 파일 읽기
2. `$include` 합성 (deep merge)
3. `${VAR}` 환경변수 치환
4. Zod 스키마 검증
5. 7단계 defaults 체이닝
6. `~/` 경로 정규화
7. 런타임 오버라이드
8. TTL 캐시 (200ms)
9. 세션 스토어 (파일 기반 + 잠금)
10. 설정 핫 리로드
11. 플러그인 설정 통합

---

## 2. OpenClaw 참조

| 참조 문서                                        | 적용할 패턴                                               |
| ------------------------------------------------ | --------------------------------------------------------- |
| `openclaw_review/docs/02.설정-시스템.md`         | 11단계 파이프라인, TTL 캐시, atomic write, 5단계 백업     |
| `openclaw_review/deep-dive/02-config-state.md`   | createConfigIO() DI 팩토리, ConfigIoDeps, 4계층 모듈 구조 |
| `openclaw_review/docs/02.설정-시스템.md` 보안 절 | 프로토타입 오염 방지, 민감 데이터 마스킹, 환경변수 보안   |

**FinClaw 적응 원칙:**

- OpenClaw 29개 config 서브타입 파일 → FinClaw 단일 `zod-schema.ts`로 통합 (금융 관련만)
- OpenClaw `schema.ts`(990줄, UI용 JSON Schema) → 제외 (Phase 19 웹 패널에서 필요시 구현)
- OpenClaw 레거시 마이그레이션(8파일) → 제외 (신규 프로젝트)
- OpenClaw `plugin-auto-enable.ts`(379줄) → 제외 (Phase 5에서 단순화)
- OpenClaw 43개 테스트 → FinClaw 12개 핵심 테스트로 축소
- OpenClaw `.passthrough()` Zod 모드 → FinClaw `z.strictObject()` 모드 (오타 감지, Zod v4 네이티브)

---

## 3. 생성/수정할 파일

### 패키지 인프라 (기존 스텁 업데이트)

| 파일 경로                       | 작업                   | 변경 사항                                      |
| ------------------------------- | ---------------------- | ---------------------------------------------- |
| `packages/config/package.json`  | **기존 스텁 업데이트** | deps 추가: `@finclaw/infra`, `zod@^4`, `json5` |
| `packages/config/tsconfig.json` | **기존 스텁 업데이트** | references에 `{ "path": "../infra" }` 추가     |
| `packages/config/src/index.ts`  | **기존 스텁 교체**     | barrel export로 교체                           |

### 소스 파일 (18개)

| 파일 경로                                     | 역할                                                     | 예상 LOC |
| --------------------------------------------- | -------------------------------------------------------- | -------- |
| **진입점**                                    |                                                          |          |
| `packages/config/src/index.ts`                | Barrel export -- 공개 API 진입점                         | ~30      |
| `packages/config/src/io.ts`                   | createConfigIO() DI 팩토리, loadConfig, writeConfigFile  | ~350     |
| **핵심 엔진**                                 |                                                          |          |
| `packages/config/src/paths.ts`                | 설정 파일 경로 해석 (JSON5, 자체 구현)                   | ~120     |
| `packages/config/src/defaults.ts`             | 7단계 불변 기본값 적용                                   | ~200     |
| `packages/config/src/validation.ts`           | Zod 기반 2단계 검증                                      | ~150     |
| `packages/config/src/zod-schema.ts`           | FinClawConfig Zod v4 스키마 정의                         | ~300     |
| **기능 해석기**                               |                                                          |          |
| `packages/config/src/includes.ts`             | `$include` 재귀 해석, 순환 감지, deep merge              | ~180     |
| `packages/config/src/env-substitution.ts`     | `${VAR}` 환경변수 치환 (대문자만, 재귀 없음)             | ~100     |
| `packages/config/src/normalize-paths.ts`      | `~/` 경로 확장                                           | ~40      |
| `packages/config/src/runtime-overrides.ts`    | 인메모리 런타임 오버라이드 (set/unset/apply/reset)       | ~60      |
| `packages/config/src/merge-config.ts`         | 섹션 단위 shallow merge + deep merge                     | ~80      |
| `packages/config/src/cache-utils.ts`          | TTL 캐시 활성화, mtime 조회                              | ~50      |
| **세션**                                      |                                                          |          |
| `packages/config/src/sessions/store.ts`       | 파일 기반 세션 영속화 + 파일 잠금 + TTL 캐시             | ~250     |
| `packages/config/src/sessions/session-key.ts` | 세션 키 도출 (channel + account + chat)                  | ~60      |
| `packages/config/src/sessions/types.ts`       | SessionEntry, SessionScope, mergeSessionEntry            | ~50      |
| **타입/에러**                                 |                                                          |          |
| `packages/config/src/types.ts`                | ConfigDeps, ConfigCache, ConfigChangeEvent 내부 타입     | ~80      |
| `packages/config/src/errors.ts`               | ConfigError, MissingEnvVarError, CircularIncludeError 등 | ~60      |
| **유틸**                                      |                                                          |          |
| `packages/config/src/test-helpers.ts`         | withTempHome, withEnvOverride 테스트 헬퍼                | ~60      |

> **설정 파일 경로 결정:**
> Phase 2 `packages/infra/src/paths.ts:43`은 `finclaw.json`을 반환한다.
> Phase 3 config 패키지는 JSON5 포맷(`finclaw.json5`)을 사용하며,
> `packages/config/src/paths.ts`에서 자체 경로 해석을 구현한다.
> infra의 `getConfigFilePath()`는 사용하지 않고, config 패키지가 자체적으로
> `FINCLAW_CONFIG` 환경변수 → `~/.finclaw/config/finclaw.json5` → `./finclaw.json5` 순서로 탐색한다.

> **ConfigDeps 이름 결정:**
> Phase 1 `@finclaw/types`에 이미 `ConfigIoDeps`(async 메서드)가 정의되어 있다.
> Phase 3 config 패키지의 DI 인터페이스는 sync 메서드를 사용하므로,
> 이름 충돌을 피하기 위해 `packages/config/src/types.ts`에 **`ConfigDeps`**로 정의한다.

### 설정 예시 파일 (2개)

| 파일 경로              | 역할                   | 예상 LOC |
| ---------------------- | ---------------------- | -------- |
| `config.example.json5` | FinClaw 설정 파일 예시 | ~50      |
| `.env.example`         | 환경변수 예시          | ~20      |

### 테스트 파일 (12개)

| 파일 경로                                        | 검증 대상                                  | 예상 LOC |
| ------------------------------------------------ | ------------------------------------------ | -------- |
| `packages/config/test/io.test.ts`                | 파이프라인 통합, DI 팩토리, 캐시 TTL       | ~150     |
| `packages/config/test/validation.test.ts`        | Zod 검증 통과/실패, strict 모드 오타 감지  | ~100     |
| `packages/config/test/defaults.test.ts`          | 7단계 체이닝 순서, 불변 업데이트           | ~100     |
| `packages/config/test/includes.test.ts`          | $include 해석, 순환 감지, deep merge       | ~100     |
| `packages/config/test/env-substitution.test.ts`  | ${VAR} 치환, 대문자만, escape, 미설정 에러 | ~80      |
| `packages/config/test/normalize-paths.test.ts`   | ~/ 확장, Windows 경로                      | ~40      |
| `packages/config/test/runtime-overrides.test.ts` | set/unset/apply/reset                      | ~50      |
| `packages/config/test/paths.test.ts`             | 경로 해석, 환경변수 우선순위               | ~60      |
| `packages/config/test/merge-config.test.ts`      | 배열 연결, 객체 재귀 병합, 원시값 우선     | ~60      |
| `packages/config/test/sessions.test.ts`          | 세션 읽기/쓰기/잠금/캐시                   | ~120     |
| `packages/config/test/sessions-key.test.ts`      | 세션 키 도출 정규화                        | ~40      |
| `packages/config/test/zod-schema.test.ts`        | 스키마 호환성, 필수/선택 필드              | ~60      |

**총 파일 수:** 32개 (소스 18 + 설정예시 2 + 테스트 12)

### CI 관련

- `.github/workflows/ci.yml` — **이미 존재** (lint, format, typecheck, build, test:ci). 변경 불필요.
- `.github/workflows/deploy.yml` — **이미 존재** (Docker build & push). 변경 불필요.
- lefthook — **이미 구성됨**. 변경 불필요.

---

## 4. 핵심 인터페이스/타입

### 4.1 DI 팩토리 (`io.ts`)

```typescript
// packages/config/src/io.ts
import type { FinClawConfig, ConfigFileSnapshot } from '@finclaw/types';
import type { FinClawLogger } from '@finclaw/infra';

// Phase 1 @finclaw/types의 ConfigIoDeps(async)와 충돌 방지를 위해
// config 패키지 내부 타입으로 분리 → packages/config/src/types.ts의 ConfigDeps
import type { ConfigDeps } from './types.js';

/**
 * ConfigDeps -- createConfigIO()에 주입하는 의존성 인터페이스
 *
 * OpenClaw 패턴: fs, json5, env, homedir, configPath, logger 6개 주입
 * FinClaw: 동일 구조이나 sync 메서드 사용 (Phase 1 ConfigIoDeps는 async)
 *
 * 정의 위치: packages/config/src/types.ts
 */
// interface ConfigDeps {
//   fs?: typeof import('node:fs');
//   json5?: typeof import('json5');
//   env?: NodeJS.ProcessEnv;
//   homedir?: () => string;
//   configPath?: string;
//   logger?: Pick<FinClawLogger, 'error' | 'warn' | 'info' | 'debug'>;
// }

export interface ConfigIO {
  configPath: string;
  loadConfig(): FinClawConfig;
  readConfigFileSnapshot(): ConfigFileSnapshot;
  writeConfigFile(config: FinClawConfig): void;
}

/**
 * 설정 I/O 팩토리
 *
 * OpenClaw createConfigIO(overrides?) 패턴:
 * - DI로 테스트에서 파일시스템/환경변수 완전 격리
 * - 200ms TTL 캐시 적용
 * - 11단계 파이프라인 선형 실행
 */
export function createConfigIO(overrides: ConfigDeps = {}): ConfigIO {
  const deps = normalizeDeps(overrides);
  const cache = createConfigCache();

  function loadConfig(): FinClawConfig {
    // 캐시 히트
    if (cache.isValid()) {
      return cache.get()!;
    }

    // 11단계 파이프라인
    let raw = readConfigFile(deps); // 1. 파일 읽기 + JSON5 파싱
    raw = resolveIncludes(raw, deps); // 2. $include 합성
    raw = applyEnvVars(raw, deps); // 3. ${VAR} 치환
    const validated = validateConfig(raw); // 4. Zod 검증
    let config = applyDefaults(validated); // 5. 7단계 defaults
    config = normalizePaths(config, deps); // 6. ~/ 정규화
    config = applyOverrides(config); // 7. 런타임 오버라이드

    cache.set(config); // 8. 200ms TTL 캐시
    return config;
  }

  return {
    configPath: deps.configPath!,
    loadConfig,
    readConfigFileSnapshot: () => createSnapshot(deps, loadConfig),
    writeConfigFile: (cfg) => writeConfig(cfg, deps),
  };
}

// ── 모듈 레벨 래퍼 (싱글턴 캐시) ──

let defaultIO: ConfigIO | undefined;

export function loadConfig(): FinClawConfig {
  if (!defaultIO) defaultIO = createConfigIO();
  return defaultIO.loadConfig();
}

export function clearConfigCache(): void {
  defaultIO = undefined;
}
```

### 4.2 Zod v4 스키마 (`zod-schema.ts`)

FinClaw는 Zod 미설치 상태이므로 처음부터 Zod v4 네이티브 API를 사용한다.

**Zod v4 주요 변경점:**

| v3 (deprecated)           | v4 권장                 |
| ------------------------- | ----------------------- |
| `.object({...}).strict()` | `z.strictObject({...})` |
| `z.string().url()`        | `z.url()`               |
| `error.flatten()`         | `z.treeifyError(error)` |
| `{ message: "..." }`      | `{ error: "..." }`      |

> **`.default()` 동작 변경 주의:** v4에서 `.default()`는 output type에 영향을 준다.
> 7단계 defaults 체이닝과의 상호작용을 검증하는 테스트를 반드시 추가할 것.

```typescript
// packages/config/src/zod-schema.ts
import { z } from 'zod/v4';

/** 게이트웨이 설정 스키마 */
const GatewaySchema = z.strictObject({
  port: z.number().int().min(1).max(65535).default(18789),
  host: z.string().default('localhost'),
  tls: z.boolean().default(true),
  corsOrigins: z.array(z.string()).default([]),
});

/** 에이전트 기본값 스키마 */
const AgentDefaultsSchema = z.strictObject({
  model: z.string().default('claude-sonnet-4-20250514'),
  provider: z.string().default('anthropic'),
  maxConcurrent: z.number().int().min(1).max(10).default(3),
  maxTokens: z.number().int().min(1).default(4096),
  temperature: z.number().min(0).max(2).default(0.7),
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
  mainKey: z.string().default('main'),
  resetPolicy: z.enum(['daily', 'idle', 'never']).default('idle'),
  idleTimeoutMs: z.number().int().min(0).default(1800000),
});

/** 로깅 설정 스키마 */
const LoggingSchema = z.strictObject({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  file: z.boolean().default(true),
  redactSensitive: z.boolean().default(true),
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
  cooldownMs: z.number().int().default(300000), // 5분
  maxActiveAlerts: z.number().int().default(100),
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
 * OpenClaw과 차이:
 * - .passthrough() 대신 z.strictObject() 사용 (오타 감지, Zod v4)
 * - superRefine 교차 검증 포함
 */
export const FinClawConfigSchema = z.strictObject({
  gateway: GatewaySchema.optional(),
  agents: z
    .strictObject({
      defaults: AgentDefaultsSchema.optional(),
      entries: z.record(z.string(), AgentEntrySchema).optional(),
    })
    .optional(),
  channels: z
    .strictObject({
      discord: DiscordChannelSchema.optional(),
      cli: z.strictObject({ enabled: z.boolean().default(true) }).optional(),
      web: z
        .strictObject({
          enabled: z.boolean().default(false),
          port: z.number().int().optional(),
        })
        .optional(),
    })
    .optional(),
  session: SessionSchema.optional(),
  logging: LoggingSchema.optional(),
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

### 4.3 환경변수 치환 (`env-substitution.ts`)

```typescript
// packages/config/src/env-substitution.ts
import { MissingEnvVarError } from './errors.js';

/**
 * 환경변수 치환 엔진
 *
 * OpenClaw env-substitution.ts(134줄) 패턴:
 * - 대문자만: [A-Z_][A-Z0-9_]* (소문자 차단)
 * - 1회 치환: 재귀 치환 없음 (injection 방지)
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
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveEnvVars(v, env);
    }
    return result;
  }
  return value;
}

function substituteString(str: string, env: NodeJS.ProcessEnv): string {
  // $ 없으면 O(1) 조기 반환
  if (!str.includes('$')) return str;

  // escape 처리: $${VAR} -> 임시 플레이스홀더
  let result = str.replace(ESCAPED_PATTERN, '\x00ESC_ENV\x00$1\x00');

  // 치환: ${VAR} -> process.env[VAR]
  result = result.replace(ENV_VAR_PATTERN, (_, varName: string) => {
    const value = env[varName];
    if (value === undefined || value === '') {
      throw new MissingEnvVarError(varName);
    }
    return value;
  });

  // escape 복원: 플레이스홀더 -> ${VAR}
  result = result.replace(/\x00ESC_ENV\x00([A-Z_][A-Z0-9_]*)\x00/g, '${$1}');

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}
```

### 4.4 7단계 Defaults 체이닝 (`defaults.ts`)

```typescript
// packages/config/src/defaults.ts
import type { FinClawConfig } from '@finclaw/types';

/**
 * 7단계 불변 기본값 적용
 *
 * OpenClaw defaults.ts(395줄) 패턴:
 * - spread 연산자로 변경 경로만 새 객체 교체
 * - 변경 없으면 원본 반환 (if (!mutated) return cfg)
 * - 순서: Session -> Logging -> Agent -> Models -> Gateway -> Finance -> Meta
 */
export function applyAllDefaults(cfg: FinClawConfig): FinClawConfig {
  let result = cfg;
  result = applySessionDefaults(result); // 1. 세션
  result = applyLoggingDefaults(result); // 2. 로깅
  result = applyAgentDefaults(result); // 3. 에이전트
  result = applyModelDefaults(result); // 4. 모델
  result = applyGatewayDefaults(result); // 5. 게이트웨이
  result = applyFinanceDefaults(result); // 6. 금융
  result = applyMetaDefaults(result); // 7. 메타
  return result;
}

function applySessionDefaults(cfg: FinClawConfig): FinClawConfig {
  const session = cfg.session ?? {};
  const mainKey = session.mainKey ?? 'main';
  const resetPolicy = session.resetPolicy ?? 'idle';
  const idleTimeoutMs = session.idleTimeoutMs ?? 1800000;

  if (
    mainKey === session.mainKey &&
    resetPolicy === session.resetPolicy &&
    idleTimeoutMs === session.idleTimeoutMs
  ) {
    return cfg; // 변경 없음 -> 원본 반환
  }

  return {
    ...cfg,
    session: { ...session, mainKey, resetPolicy, idleTimeoutMs },
  };
}

// ✅ 수정됨: applySessionDefaults와 동일한 불변 업데이트 패턴 적용
// 이전 코드는 `...logging` spread가 앞의 `??` 기본값을 덮어쓰는 버그가 있었음
function applyLoggingDefaults(cfg: FinClawConfig): FinClawConfig {
  const logging = cfg.logging ?? {};
  const level = logging.level ?? 'info';
  const file = logging.file ?? true;
  const redactSensitive = logging.redactSensitive ?? true;

  if (
    level === logging.level &&
    file === logging.file &&
    redactSensitive === logging.redactSensitive
  ) {
    return cfg;
  }

  return {
    ...cfg,
    logging: { ...logging, level, file, redactSensitive },
  };
}

function applyAgentDefaults(cfg: FinClawConfig): FinClawConfig {
  if (!cfg.agents?.defaults && !cfg.agents?.entries) return cfg;
  return {
    ...cfg,
    agents: {
      defaults: {
        model: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        maxConcurrent: 3,
        maxTokens: 4096,
        temperature: 0.7,
        ...(cfg.agents?.defaults ?? {}),
      },
      entries: cfg.agents?.entries ?? {},
    },
  };
}

// ... applyModelDefaults, applyGatewayDefaults, applyFinanceDefaults, applyMetaDefaults
```

### 4.5 세션 스토어 (`sessions/store.ts`)

```typescript
// packages/config/src/sessions/store.ts
import type { SessionKey, Timestamp } from '@finclaw/types';
import type { SessionEntry } from './types.js';
import { writeFileAtomic } from '@finclaw/infra';

/**
 * 파일 기반 세션 스토어
 *
 * OpenClaw sessions/store.ts(440줄) 패턴:
 * - withSessionStoreLock()으로 동시 접근 직렬화
 * - TTL 캐시(45초) + mtime 무효화
 * - structuredClone으로 캐시 mutation 방지
 * - read-modify-write 패턴
 */
export interface SessionStore {
  get(key: SessionKey): Promise<SessionEntry | undefined>;
  set(key: SessionKey, entry: SessionEntry): Promise<void>;
  update(key: SessionKey, mutator: (entry: SessionEntry) => SessionEntry): Promise<void>;
  delete(key: SessionKey): Promise<void>;
  list(): Promise<Map<string, SessionEntry>>;
}

const SESSION_CACHE_TTL_MS = 45_000;
const SESSION_LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_THRESHOLD_MS = 30_000;

export function createSessionStore(storeDir: string): SessionStore {
  let cache: Map<string, SessionEntry> | null = null;
  let cacheTime = 0;
  let cacheMtime = 0;

  return {
    async get(key) {
      const store = await loadStore();
      return store.get(key as string);
    },
    async set(key, entry) {
      await withSessionStoreLock(storeDir, async () => {
        const store = await loadStore({ skipCache: true });
        store.set(key as string, structuredClone(entry));
        await saveStore(store);
      });
    },
    async update(key, mutator) {
      await withSessionStoreLock(storeDir, async () => {
        const store = await loadStore({ skipCache: true });
        const existing = store.get(key as string);
        if (existing) {
          store.set(key as string, mutator(structuredClone(existing)));
          await saveStore(store);
        }
      });
    },
    async delete(key) {
      await withSessionStoreLock(storeDir, async () => {
        const store = await loadStore({ skipCache: true });
        store.delete(key as string);
        await saveStore(store);
      });
    },
    async list() {
      return structuredClone(await loadStore());
    },
  };
}
```

### 4.6 에러 클래스 (`errors.ts`)

```typescript
// packages/config/src/errors.ts
import { FinClawError } from '@finclaw/infra';

/**
 * 설정 관련 에러 클래스 (Phase 2 co-location 원칙)
 * packages/infra/src/errors.ts:51-56 참조
 */

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

---

## 5. 구현 상세

### 5.1 설정 파이프라인 전체 흐름

```
[loadConfig() 호출]
    │
    ├── 캐시 히트? ──Yes──> 캐시된 config 반환
    │     No
    ├── 1. resolveConfigPath() → 파일 경로 결정
    │     (FINCLAW_CONFIG > ~/.finclaw/config/finclaw.json5 > ./finclaw.json5)
    │     ※ Phase 2 infra의 getConfigFilePath()는 finclaw.json → 사용하지 않음
    │
    ├── 2. readFileSync + JSON5.parse
    │
    ├── 3. resolveConfigIncludes()
    │     ├── $include 지시자 재귀 해석
    │     ├── deepMerge (배열=연결, 객체=재귀, 원시=source우선)
    │     └── MAX_INCLUDE_DEPTH=10, CircularIncludeError
    │
    ├── 4. resolveConfigEnvVars()
    │     ├── ${VAR} → process.env[VAR]
    │     ├── 대문자만 [A-Z_][A-Z0-9_]*
    │     └── 재귀 치환 없음 (injection 방지)
    │
    ├── 5. FinClawConfigSchema.safeParse()
    │     ├── 성공 → validated config
    │     └── 실패 → z.treeifyError()로 이슈 수집, 빈 {} 반환
    │
    ├── 6. applyAllDefaults() (7단계 체이닝)
    │     Session → Logging → Agent → Models → Gateway → Finance → Meta
    │
    ├── 7. normalizePaths() (~/→ homedir)
    │
    ├── 8. applyOverrides() (인메모리 오버라이드)
    │
    └── 9. cache.set(config, 200ms TTL) → config 반환
```

### 5.2 $include Deep Merge 알고리즘

```typescript
// packages/config/src/includes.ts
import { CircularIncludeError } from './errors.js';

const MAX_INCLUDE_DEPTH = 10;

export function deepMerge(target: unknown, source: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(source)) {
    return [...target, ...source]; // 배열: 연결
  }
  if (isPlainObject(target) && isPlainObject(source)) {
    const result: Record<string, unknown> = { ...target };
    for (const key of Object.keys(source)) {
      // 프로토타입 오염 방지
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      result[key] = key in result ? deepMerge(result[key], source[key]) : source[key];
    }
    return result; // 객체: 재귀 병합
  }
  return source; // 원시값: 소스 우선
}
```

### 5.3 설정 파일 예시

```json5
// config.example.json5
{
  // FinClaw 설정 예시
  gateway: {
    port: 18789,
    host: 'localhost',
  },

  agents: {
    defaults: {
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      temperature: 0.7,
    },
  },

  channels: {
    discord: {
      botToken: '${DISCORD_BOT_TOKEN}',
      applicationId: '${DISCORD_APP_ID}',
    },
  },

  logging: {
    level: 'info',
    file: true,
  },

  finance: {
    dataProviders: [{ name: 'yahoo', baseUrl: 'https://query1.finance.yahoo.com' }],
    alertDefaults: {
      cooldownMs: 300000,
      maxActiveAlerts: 100,
    },
  },
}
```

---

## 6. 선행 조건

| 조건                    | 산출물                          | Phase   |
| ----------------------- | ------------------------------- | ------- |
| FinClawConfig 타입 정의 | `packages/types/src/config.ts`  | Phase 1 |
| 로깅 인프라             | `packages/infra/src/logger.ts`  | Phase 2 |
| 에러 클래스 계층        | `packages/infra/src/errors.ts`  | Phase 2 |
| 원자적 파일 쓰기        | `packages/infra/src/fs-safe.ts` | Phase 2 |
| 경로 해석               | `packages/infra/src/paths.ts`   | Phase 2 |

**신규 외부 의존성:** `zod@^4`, `json5` (2개)

- `dotenv` 불필요 — `packages/infra/src/dotenv.ts`에서 `process.loadEnvFile()` 사용 (Node.js 22+ 내장)

```bash
cd packages/config && pnpm add zod@^4 json5
```

---

## 7. 산출물 및 검증

### 산출물 목록

| #   | 산출물                       | 검증 방법                              |
| --- | ---------------------------- | -------------------------------------- |
| 1   | 설정 파이프라인 (11단계)     | io.test.ts 통합 테스트                 |
| 2   | createConfigIO() DI 팩토리   | 가짜 fs/env로 격리 테스트              |
| 3   | Zod v4 스키마 (strictObject) | 유효/무효 설정 파일 검증               |
| 4   | 7단계 defaults 체이닝        | 순서 보장 + 불변 업데이트 검증         |
| 5   | $include 합성                | 순환 감지, 깊이 10 제한, deep merge    |
| 6   | ${VAR} 환경변수 치환         | 대문자만, escape, 미설정 에러          |
| 7   | 세션 스토어                  | 파일 잠금, TTL 캐시, read-modify-write |
| 8   | 설정 예시 파일               | config.example.json5 파싱 성공         |
| 9   | 테스트 (12개)                | `pnpm test` 전체 통과                  |

### 검증 기준

```bash
# 1. 설정 로딩 통합 테스트
pnpm test -- packages/config/test/io.test.ts

# 2. Zod v4 strictObject 모드로 오타 감지
# { "gatway": {} } -> ZodError (unknown key "gatway")

# 3. $include 순환 감지
# a.json5 -> $include: "b.json5" -> $include: "a.json5"
# -> CircularIncludeError

# 4. 전체 테스트 스위트
pnpm test            # 12개 파일 전체 통과
pnpm typecheck       # 에러 0
pnpm lint            # 에러 0
```

---

## 8. 복잡도 및 예상 파일 수

| 항목              | 값                                         |
| ----------------- | ------------------------------------------ |
| **복잡도**        | **L (Large)**                              |
| 소스 파일         | 18개                                       |
| 설정 예시         | 2개                                        |
| CI 파일           | 0개 (이미 존재)                            |
| 테스트 파일       | 12개                                       |
| **총 파일 수**    | **32개**                                   |
| 예상 LOC (소스)   | ~2,200줄                                   |
| 예상 LOC (테스트) | ~960줄                                     |
| 신규 의존성       | 2개 (`zod@^4`, `json5`)                    |
| 난이도            | 중상 (DI 팩토리, Zod v4 스키마, 파일 잠금) |

**위험 요소:**

- Zod `z.strictObject()` 모드가 플러그인 설정 확장 시 호환성 문제 유발 가능 → Phase 5에서 플러그인 설정은 `.passthrough()` 허용
- 7단계 defaults 체이닝 순서가 미묘한 버그 유발 가능 → 각 단계의 독립 테스트로 방어
- 세션 스토어의 파일 잠금이 Windows에서 불안정 → atomic write fallback으로 대응
- **Zod v4 `.default()` 동작 변경** → 7단계 defaults와 충돌 가능성 (테스트로 검증 필수)
- **Phase 1 `ConfigIoDeps`(async) vs Phase 3 `ConfigDeps`(sync)** → 이름 분리로 해결, 혼동 주의
- **`.json` (Phase 2 infra) vs `.json5` (Phase 3 config)** → 설정 파일 경로가 다름, 문서화 완료 (§3 참고)

---

## 9. 구현 순서 (6단계)

Phase 2와 일관된 단계별 구현 + 검증 흐름.

### Step 1: 패키지 인프라 + 에러 클래스

```
1. packages/config/package.json 스텁 업데이트 (deps: @finclaw/infra, zod@^4, json5)
2. packages/config/tsconfig.json 스텁 업데이트 (references: ../infra)
3. packages/config/src/errors.ts 생성 (ConfigError, MissingEnvVarError, CircularIncludeError, ConfigValidationError)
4. packages/config/src/types.ts 생성 (ConfigDeps, ConfigCache)
→ 검증: pnpm typecheck (에러 0)
```

### Step 2: Zod v4 스키마 + 검증

```
1. packages/config/src/zod-schema.ts 생성 (z.strictObject, z.url 등 v4 API)
2. packages/config/src/validation.ts 생성 (safeParse + z.treeifyError)
3. packages/config/test/zod-schema.test.ts 생성
4. packages/config/test/validation.test.ts 생성
→ 검증: pnpm test -- packages/config/test/zod-schema.test.ts (통과)
→ 검증: pnpm test -- packages/config/test/validation.test.ts (통과)
```

### Step 3: 기능 해석기 (includes, env, paths, merge, normalize, overrides, cache)

```
1. packages/config/src/includes.ts (deepMerge, CircularIncludeError)
2. packages/config/src/env-substitution.ts (resolveEnvVars, MissingEnvVarError)
3. packages/config/src/paths.ts (resolveConfigPath — 자체 구현)
4. packages/config/src/merge-config.ts
5. packages/config/src/normalize-paths.ts
6. packages/config/src/runtime-overrides.ts
7. packages/config/src/cache-utils.ts
8. 대응 테스트 6개 생성
→ 검증: 각 테스트 파일 개별 통과
```

### Step 4: Defaults + 파이프라인 통합

```
1. packages/config/src/defaults.ts (7단계, applyLoggingDefaults 버그 수정 패턴 적용)
2. packages/config/src/io.ts (createConfigIO, loadConfig)
3. packages/config/test/defaults.test.ts (Zod v4 .default()와 상호작용 검증 포함)
4. packages/config/test/io.test.ts (11단계 파이프라인 통합)
→ 검증: pnpm test -- packages/config/test/defaults.test.ts (통과)
→ 검증: pnpm test -- packages/config/test/io.test.ts (통과)
```

### Step 5: 세션 스토어

```
1. packages/config/src/sessions/types.ts
2. packages/config/src/sessions/session-key.ts
3. packages/config/src/sessions/store.ts
4. packages/config/test/sessions.test.ts
5. packages/config/test/sessions-key.test.ts
→ 검증: pnpm test -- packages/config/test/sessions.test.ts (통과)
```

### Step 6: Barrel export + 설정 예시 + 최종 검증

```
1. packages/config/src/index.ts 스텁 교체 (barrel export)
2. packages/config/src/test-helpers.ts
3. config.example.json5, .env.example 생성
→ 검증: pnpm typecheck (에러 0)
→ 검증: pnpm lint (에러 0)
→ 검증: pnpm test (12개 전체 통과)
→ 검증: pnpm build (성공)
```
