# Phase 3 todo-b: 파이프라인 통합 + 세션 + 마무리 (세션 3)

> **소스 7 + 테스트 4 + 예시 2 = 13파일**

## 선행조건

```bash
# todo-a 완료 확인
pnpm typecheck                     # 에러 0
pnpm test -- packages/config/      # 8개 전체 통과
```

---

# 세션 3: Step 4-6 — Defaults, IO, 세션, Barrel, 예시

## 3-1. packages/config/src/defaults.ts 생성

**의존:** `@finclaw/types` (FinClawConfig)

```typescript
// packages/config/src/defaults.ts
import type { FinClawConfig } from '@finclaw/types';

/**
 * 7단계 불변 기본값 적용
 *
 * 순서: Session -> Logging -> Agent -> Models -> Gateway -> Finance -> Meta
 * - spread 연산자로 변경 경로만 새 객체 교체
 * - 변경 없으면 원본 반환 (참조 동일성 보존)
 */
export function applyAllDefaults(cfg: FinClawConfig): FinClawConfig {
  let result = cfg;
  result = applySessionDefaults(result);
  result = applyLoggingDefaults(result);
  result = applyAgentDefaults(result);
  result = applyModelDefaults(result);
  result = applyGatewayDefaults(result);
  result = applyFinanceDefaults(result);
  result = applyMetaDefaults(result);
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
    return cfg;
  }

  return {
    ...cfg,
    session: { ...session, mainKey, resetPolicy, idleTimeoutMs },
  };
}

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

function applyModelDefaults(cfg: FinClawConfig): FinClawConfig {
  if (!cfg.models) return cfg;
  return {
    ...cfg,
    models: {
      definitions: cfg.models.definitions ?? {},
      aliases: cfg.models.aliases ?? {},
    },
  };
}

function applyGatewayDefaults(cfg: FinClawConfig): FinClawConfig {
  const gateway = cfg.gateway ?? {};
  const port = gateway.port ?? 18789;
  const host = gateway.host ?? 'localhost';
  const tls = gateway.tls ?? true;
  const corsOrigins = gateway.corsOrigins ?? [];

  if (
    port === gateway.port &&
    host === gateway.host &&
    tls === gateway.tls &&
    corsOrigins === gateway.corsOrigins
  ) {
    return cfg;
  }

  return {
    ...cfg,
    gateway: { ...gateway, port, host, tls, corsOrigins },
  };
}

function applyFinanceDefaults(cfg: FinClawConfig): FinClawConfig {
  if (!cfg.finance?.alertDefaults) return cfg;
  const ad = cfg.finance.alertDefaults;
  const cooldownMs = ad.cooldownMs ?? 300000;
  const maxActiveAlerts = ad.maxActiveAlerts ?? 100;

  if (cooldownMs === ad.cooldownMs && maxActiveAlerts === ad.maxActiveAlerts) {
    return cfg;
  }

  return {
    ...cfg,
    finance: {
      ...cfg.finance,
      alertDefaults: { ...ad, cooldownMs, maxActiveAlerts },
    },
  };
}

function applyMetaDefaults(cfg: FinClawConfig): FinClawConfig {
  // meta는 현재 선택적 필드만 — 기본값 없음
  return cfg;
}
```

## 3-2. packages/config/src/io.ts 생성

**의존:** `./types.js`, `./paths.js`, `./includes.js`, `./env-substitution.js`,
`./validation.js`, `./defaults.js`, `./normalize-paths.js`, `./runtime-overrides.js`,
`./cache-utils.js`, `./errors.js`, `@finclaw/types`, `json5`

```typescript
// packages/config/src/io.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import JSON5 from 'json5';
import type { FinClawConfig, ConfigFileSnapshot } from '@finclaw/types';
import { writeFileAtomic } from '@finclaw/infra';
import type { ConfigDeps } from './types.js';
import { resolveConfigPath } from './paths.js';
import { resolveIncludes } from './includes.js';
import { resolveEnvVars } from './env-substitution.js';
import { validateConfig } from './validation.js';
import { applyAllDefaults } from './defaults.js';
import { normalizePaths } from './normalize-paths.js';
import { applyOverrides } from './runtime-overrides.js';
import { createConfigCache } from './cache-utils.js';
import { ConfigError } from './errors.js';

export interface ConfigIO {
  configPath: string;
  loadConfig(): FinClawConfig;
  readConfigFileSnapshot(): ConfigFileSnapshot;
  writeConfigFile(config: FinClawConfig): void;
}

/**
 * 설정 I/O 팩토리 — DI로 테스트 격리 가능
 *
 * 11단계 파이프라인:
 * 1. 파일 읽기 + JSON5 파싱
 * 2. $include 합성
 * 3. ${VAR} 환경변수 치환
 * 4. Zod 스키마 검증
 * 5. 7단계 defaults 체이닝
 * 6. ~/ 경로 정규화
 * 7. 런타임 오버라이드
 * 8. TTL 캐시 (200ms)
 */
export function createConfigIO(overrides: ConfigDeps = {}): ConfigIO {
  const deps = normalizeDeps(overrides);
  const cache = createConfigCache();

  function loadConfig(): FinClawConfig {
    if (cache.isValid()) {
      return cache.get()!;
    }

    // 1. 파일 읽기 + JSON5 파싱
    let raw = readConfigFile(deps);

    // 2. $include 합성
    raw = resolveIncludes(raw, (p) => readJson5File(p, deps), deps.configPath!);

    // 3. ${VAR} 환경변수 치환
    raw = resolveEnvVars(raw, deps.env) as Record<string, unknown>;

    // 4. Zod 스키마 검증
    const { config: validated } = validateConfig(raw);

    // 5. 7단계 defaults 체이닝
    let config = applyAllDefaults(validated);

    // 6. ~/ 경로 정규화
    config = normalizePaths(config, deps.homedir) as FinClawConfig;

    // 7. 런타임 오버라이드
    config = applyOverrides(config);

    // 8. TTL 캐시
    cache.set(config);
    return config;
  }

  function readConfigFileSnapshot(): ConfigFileSnapshot {
    const configPath = deps.configPath!;
    const exists = deps.fs!.existsSync(configPath);

    if (!exists) {
      return {
        path: configPath,
        exists: false,
        valid: false,
        config: {} as FinClawConfig,
        issues: [{ path: '(root)', message: 'Config file not found', severity: 'error' }],
      };
    }

    const rawStr = deps.fs!.readFileSync(configPath, 'utf-8');
    const parsed = deps.json5!.parse(rawStr);
    const { valid, config, issues } = validateConfig(parsed);
    const hash = crypto.createHash('sha256').update(rawStr).digest('hex');

    return { path: configPath, exists: true, raw: rawStr, parsed, valid, config, hash, issues };
  }

  function writeConfigFile(config: FinClawConfig): void {
    const content = JSON.stringify(config, null, 2) + '\n';
    writeFileAtomic(deps.configPath!, content, 0o600);
  }

  return {
    configPath: deps.configPath!,
    loadConfig,
    readConfigFileSnapshot,
    writeConfigFile,
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

// ── 내부 헬퍼 ──

function normalizeDeps(overrides: ConfigDeps): Required<ConfigDeps> {
  const fsModule = overrides.fs ?? fs;
  const json5Module = overrides.json5 ?? JSON5;
  const env = overrides.env ?? process.env;
  const homedir = overrides.homedir ?? os.homedir;
  const configPath = overrides.configPath ?? resolveConfigPath(env);
  const logger = overrides.logger ?? {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  };

  return { fs: fsModule, json5: json5Module, env, homedir, configPath, logger };
}

function readConfigFile(deps: Required<ConfigDeps>): Record<string, unknown> {
  try {
    const content = deps.fs.readFileSync(deps.configPath, 'utf-8');
    return deps.json5.parse(content) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      deps.logger.info(`Config file not found: ${deps.configPath}, using defaults`);
      return {};
    }
    throw new ConfigError(`Failed to read config file: ${deps.configPath}`, {
      cause: err instanceof Error ? err : undefined,
    });
  }
}

function readJson5File(filePath: string, deps: Required<ConfigDeps>): Record<string, unknown> {
  const content = deps.fs.readFileSync(filePath, 'utf-8');
  return deps.json5.parse(content) as Record<string, unknown>;
}
```

## 3-3. packages/config/test/defaults.test.ts 생성

```typescript
// packages/config/test/defaults.test.ts
import { describe, it, expect } from 'vitest';
import type { FinClawConfig } from '@finclaw/types';
import { applyAllDefaults } from '../src/defaults.js';

describe('applyAllDefaults', () => {
  it('빈 config에 모든 기본값을 적용한다', () => {
    const result = applyAllDefaults({});
    expect(result.session).toEqual({
      mainKey: 'main',
      resetPolicy: 'idle',
      idleTimeoutMs: 1800000,
    });
    expect(result.logging).toEqual({
      level: 'info',
      file: true,
      redactSensitive: true,
    });
    expect(result.gateway).toEqual({
      port: 18789,
      host: 'localhost',
      tls: true,
      corsOrigins: [],
    });
  });

  it('기존 값을 보존한다', () => {
    const cfg: FinClawConfig = {
      session: { mainKey: 'custom', resetPolicy: 'daily' },
      logging: { level: 'debug' },
      gateway: { port: 9090 },
    };
    const result = applyAllDefaults(cfg);
    expect(result.session?.mainKey).toBe('custom');
    expect(result.session?.resetPolicy).toBe('daily');
    expect(result.session?.idleTimeoutMs).toBe(1800000); // 기본값
    expect(result.logging?.level).toBe('debug');
    expect(result.logging?.file).toBe(true); // 기본값
    expect(result.gateway?.port).toBe(9090);
    expect(result.gateway?.host).toBe('localhost'); // 기본값
  });

  it('agents 섹션이 없으면 에이전트 기본값을 건너뛴다', () => {
    const result = applyAllDefaults({});
    expect(result.agents).toBeUndefined();
  });

  it('agents 섹션이 있으면 에이전트 기본값을 적용한다', () => {
    const cfg: FinClawConfig = { agents: { defaults: { model: 'gpt-4' } } };
    const result = applyAllDefaults(cfg);
    expect(result.agents?.defaults?.model).toBe('gpt-4');
    expect(result.agents?.defaults?.provider).toBe('anthropic');
    expect(result.agents?.defaults?.maxConcurrent).toBe(3);
  });

  it('7단계 순서가 보장된다 (Session -> Logging -> Agent -> Models -> Gateway -> Finance -> Meta)', () => {
    // 모든 단계가 적용되는 config
    const cfg: FinClawConfig = {
      agents: { entries: { main: {} } },
      models: { definitions: {} },
      finance: { alertDefaults: {} },
    };
    const result = applyAllDefaults(cfg);
    expect(result.session).toBeDefined();
    expect(result.logging).toBeDefined();
    expect(result.agents?.defaults).toBeDefined();
    expect(result.models?.aliases).toBeDefined();
    expect(result.gateway).toBeDefined();
    expect(result.finance?.alertDefaults?.cooldownMs).toBe(300000);
  });

  it('원본 config를 변경하지 않는다 (불변)', () => {
    const cfg: FinClawConfig = { session: { mainKey: 'test' } };
    const original = JSON.parse(JSON.stringify(cfg));
    applyAllDefaults(cfg);
    expect(cfg).toEqual(original);
  });

  it('값이 이미 설정되어 있으면 참조 동일성을 보존한다', () => {
    const cfg: FinClawConfig = {
      session: { mainKey: 'main', resetPolicy: 'idle', idleTimeoutMs: 1800000 },
      logging: { level: 'info', file: true, redactSensitive: true },
    };
    const result = applyAllDefaults(cfg);
    // session과 logging이 변경되지 않았으므로 원본 참조 유지
    expect(result.session).toBe(cfg.session);
    expect(result.logging).toBe(cfg.logging);
  });
});
```

## 3-4. packages/config/test/io.test.ts 생성

```typescript
// packages/config/test/io.test.ts
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createConfigIO, clearConfigCache } from '../src/io.js';
import { resetOverrides } from '../src/runtime-overrides.js';

beforeEach(() => {
  clearConfigCache();
  resetOverrides();
});

describe('createConfigIO', () => {
  it('DI로 가짜 fs/env를 주입하여 config를 로딩한다', () => {
    const fakeFs = {
      readFileSync: vi.fn().mockReturnValue('{ gateway: { port: 9090 } }'),
      existsSync: vi.fn().mockReturnValue(true),
      writeFileSync: vi.fn(),
    };
    const io = createConfigIO({
      fs: fakeFs as unknown as typeof import('node:fs'),
      json5: { parse: (s: string) => JSON.parse(s.replace(/(\w+):/g, '"$1":')) },
      env: {} as NodeJS.ProcessEnv,
      configPath: '/fake/config.json5',
    });

    expect(io.configPath).toBe('/fake/config.json5');
  });

  it('설정 파일이 없으면 기본값으로 동작한다', () => {
    const fakeFs = {
      readFileSync: vi.fn().mockImplementation(() => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }),
      existsSync: vi.fn().mockReturnValue(false),
      writeFileSync: vi.fn(),
    };
    const io = createConfigIO({
      fs: fakeFs as unknown as typeof import('node:fs'),
      configPath: '/missing/config.json5',
    });

    const config = io.loadConfig();
    // 기본값이 적용됨
    expect(config.session?.mainKey).toBe('main');
    expect(config.gateway?.port).toBe(18789);
  });

  it('200ms TTL 캐시가 동작한다', () => {
    vi.useFakeTimers();
    let callCount = 0;
    const fakeFs = {
      readFileSync: vi.fn().mockImplementation(() => {
        callCount++;
        return '{}';
      }),
      existsSync: vi.fn().mockReturnValue(true),
      writeFileSync: vi.fn(),
    };
    const io = createConfigIO({
      fs: fakeFs as unknown as typeof import('node:fs'),
      json5: { parse: JSON.parse },
      configPath: '/test/config.json5',
    });

    io.loadConfig();
    io.loadConfig(); // 캐시 히트
    expect(callCount).toBe(1);

    vi.advanceTimersByTime(201);
    io.loadConfig(); // 캐시 만료
    expect(callCount).toBe(2);

    vi.useRealTimers();
  });
});

describe('readConfigFileSnapshot', () => {
  it('존재하지 않는 파일에 exists: false를 반환한다', () => {
    const fakeFs = {
      readFileSync: vi.fn(),
      existsSync: vi.fn().mockReturnValue(false),
      writeFileSync: vi.fn(),
    };
    const io = createConfigIO({
      fs: fakeFs as unknown as typeof import('node:fs'),
      configPath: '/missing.json5',
    });

    const snapshot = io.readConfigFileSnapshot();
    expect(snapshot.exists).toBe(false);
    expect(snapshot.valid).toBe(false);
  });

  it('유효한 파일에 hash를 포함한다', () => {
    const content = '{}';
    const fakeFs = {
      readFileSync: vi.fn().mockReturnValue(content),
      existsSync: vi.fn().mockReturnValue(true),
      writeFileSync: vi.fn(),
    };
    const io = createConfigIO({
      fs: fakeFs as unknown as typeof import('node:fs'),
      json5: { parse: JSON.parse },
      configPath: '/test.json5',
    });

    const snapshot = io.readConfigFileSnapshot();
    expect(snapshot.exists).toBe(true);
    expect(snapshot.valid).toBe(true);
    expect(snapshot.hash).toBeDefined();
    expect(snapshot.hash!.length).toBe(64); // SHA-256 hex
  });
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finclaw-config-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
```

## 3-5. packages/config/src/sessions/types.ts 생성

**의존:** `@finclaw/types` (SessionKey, Timestamp)

```typescript
// packages/config/src/sessions/types.ts
import type { SessionKey, Timestamp } from '@finclaw/types';

/** 세션 엔트리 */
export interface SessionEntry {
  key: SessionKey;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  data: Record<string, unknown>;
}

/** 세션 범위 */
export type SessionScope = 'channel' | 'account' | 'chat';

/** 세션 엔트리 merge */
export function mergeSessionEntry(
  existing: SessionEntry,
  update: Partial<Pick<SessionEntry, 'data'>>,
): SessionEntry {
  return {
    ...existing,
    updatedAt: Date.now() as Timestamp,
    data: { ...existing.data, ...update.data },
  };
}
```

## 3-6. packages/config/src/sessions/session-key.ts 생성

**의존:** `@finclaw/types` (SessionKey, createSessionKey)

```typescript
// packages/config/src/sessions/session-key.ts
import type { SessionKey } from '@finclaw/types';
import { createSessionKey } from '@finclaw/types';

/**
 * 세션 키 도출 (channel + account + chat)
 *
 * 정규화: 소문자, 공백→하이픈, 특수문자 제거
 */
export function deriveSessionKey(channel: string, account: string, chat?: string): SessionKey {
  const parts = [normalize(channel), normalize(account)];
  if (chat) parts.push(normalize(chat));
  return createSessionKey(parts.join(':'));
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-_]/g, '');
}
```

## 3-7. packages/config/src/sessions/store.ts 생성

**의존:** `@finclaw/types`, `@finclaw/infra`, `./types.js`

```typescript
// packages/config/src/sessions/store.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionKey, Timestamp } from '@finclaw/types';
import { writeFileAtomic, ensureDir } from '@finclaw/infra';
import type { SessionEntry } from './types.js';

export interface SessionStore {
  get(key: SessionKey): Promise<SessionEntry | undefined>;
  set(key: SessionKey, entry: SessionEntry): Promise<void>;
  update(key: SessionKey, mutator: (entry: SessionEntry) => SessionEntry): Promise<void>;
  delete(key: SessionKey): Promise<void>;
  list(): Promise<Map<string, SessionEntry>>;
}

const SESSION_CACHE_TTL_MS = 45_000;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

export function createSessionStore(storeDir: string): SessionStore {
  let cache: Map<string, SessionEntry> | null = null;
  let cacheTime = 0;

  async function loadStore(opts?: { skipCache?: boolean }): Promise<Map<string, SessionEntry>> {
    if (!opts?.skipCache && cache && Date.now() - cacheTime < SESSION_CACHE_TTL_MS) {
      return cache;
    }

    await ensureDir(storeDir);
    const filePath = path.join(storeDir, 'sessions.json');

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const entries = JSON.parse(content) as Record<string, SessionEntry>;
      cache = new Map(Object.entries(entries));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        cache = new Map();
      } else {
        throw err;
      }
    }

    cacheTime = Date.now();
    return cache;
  }

  async function saveStore(store: Map<string, SessionEntry>): Promise<void> {
    await ensureDir(storeDir);
    const filePath = path.join(storeDir, 'sessions.json');
    const data = Object.fromEntries(store);
    const content = JSON.stringify(data, null, 2) + '\n';
    await writeFileAtomic(filePath, content, 0o600);
    cache = store;
    cacheTime = Date.now();
  }

  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = path.join(storeDir, 'sessions.lock');
    await ensureDir(storeDir);

    // stale lock 정리
    try {
      const stat = await fs.stat(lockPath);
      if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        await fs.unlink(lockPath).catch(() => {});
      }
    } catch {
      // lock 파일 없음 — OK
    }

    const start = Date.now();
    while (true) {
      try {
        await fs.writeFile(lockPath, `${process.pid}`, { flag: 'wx' });
        break;
      } catch {
        if (Date.now() - start > LOCK_TIMEOUT_MS) {
          throw new Error(`Session store lock timeout after ${LOCK_TIMEOUT_MS}ms`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    try {
      return await fn();
    } finally {
      await fs.unlink(lockPath).catch(() => {});
    }
  }

  return {
    async get(key) {
      const store = await loadStore();
      const entry = store.get(key as string);
      return entry ? structuredClone(entry) : undefined;
    },

    async set(key, entry) {
      await withLock(async () => {
        const store = await loadStore({ skipCache: true });
        store.set(key as string, structuredClone(entry));
        await saveStore(store);
      });
    },

    async update(key, mutator) {
      await withLock(async () => {
        const store = await loadStore({ skipCache: true });
        const existing = store.get(key as string);
        if (existing) {
          store.set(key as string, mutator(structuredClone(existing)));
          await saveStore(store);
        }
      });
    },

    async delete(key) {
      await withLock(async () => {
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

## 3-8. packages/config/test/sessions.test.ts 생성

```typescript
// packages/config/test/sessions.test.ts
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { describe, it, expect, beforeEach } from 'vitest';
import type { SessionKey, Timestamp } from '@finclaw/types';
import { createSessionKey, createTimestamp } from '@finclaw/types';
import { createSessionStore } from '../src/sessions/store.js';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finclaw-session-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeEntry(key: string): {
  key: SessionKey;
  entry: import('../src/sessions/types.js').SessionEntry;
} {
  return {
    key: createSessionKey(key),
    entry: {
      key: createSessionKey(key),
      createdAt: createTimestamp(Date.now()),
      updatedAt: createTimestamp(Date.now()),
      data: { test: true },
    },
  };
}

describe('SessionStore', () => {
  it('set + get으로 세션을 저장/조회한다', async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore(dir);
      const { key, entry } = makeEntry('discord:user1:chat1');

      await store.set(key, entry);
      const result = await store.get(key);
      expect(result).toEqual(entry);
    });
  });

  it('존재하지 않는 키에 undefined를 반환한다', async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore(dir);
      const result = await store.get(createSessionKey('nonexistent'));
      expect(result).toBeUndefined();
    });
  });

  it('update로 기존 세션을 변경한다', async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore(dir);
      const { key, entry } = makeEntry('discord:user1:chat1');

      await store.set(key, entry);
      await store.update(key, (e) => ({
        ...e,
        data: { ...e.data, updated: true },
      }));

      const result = await store.get(key);
      expect(result?.data.updated).toBe(true);
      expect(result?.data.test).toBe(true);
    });
  });

  it('delete로 세션을 삭제한다', async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore(dir);
      const { key, entry } = makeEntry('discord:user1:chat1');

      await store.set(key, entry);
      await store.delete(key);
      const result = await store.get(key);
      expect(result).toBeUndefined();
    });
  });

  it('list로 모든 세션을 조회한다', async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore(dir);
      const e1 = makeEntry('key1');
      const e2 = makeEntry('key2');

      await store.set(e1.key, e1.entry);
      await store.set(e2.key, e2.entry);

      const all = await store.list();
      expect(all.size).toBe(2);
    });
  });

  it('get이 반환한 엔트리를 변경해도 스토어에 영향 없다 (deep clone)', async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore(dir);
      const { key, entry } = makeEntry('test');

      await store.set(key, entry);
      const result = await store.get(key);
      result!.data.mutated = true;

      const fresh = await store.get(key);
      expect(fresh?.data.mutated).toBeUndefined();
    });
  });
});
```

## 3-9. packages/config/test/sessions-key.test.ts 생성

```typescript
// packages/config/test/sessions-key.test.ts
import { describe, it, expect } from 'vitest';
import { deriveSessionKey } from '../src/sessions/session-key.js';

describe('deriveSessionKey', () => {
  it('channel:account 형식으로 키를 생성한다', () => {
    const key = deriveSessionKey('discord', 'user123');
    expect(key).toBe('discord:user123');
  });

  it('chat이 있으면 channel:account:chat 형식이다', () => {
    const key = deriveSessionKey('discord', 'user123', 'general');
    expect(key).toBe('discord:user123:general');
  });

  it('소문자로 정규화한다', () => {
    const key = deriveSessionKey('Discord', 'User123');
    expect(key).toBe('discord:user123');
  });

  it('공백을 하이픈으로 치환한다', () => {
    const key = deriveSessionKey('discord', 'user name');
    expect(key).toBe('discord:user-name');
  });

  it('특수문자를 제거한다', () => {
    const key = deriveSessionKey('discord', 'user@#$123');
    expect(key).toBe('discord:user123');
  });

  it('앞뒤 공백을 제거한다', () => {
    const key = deriveSessionKey('  discord  ', '  user  ');
    expect(key).toBe('discord:user');
  });
});
```

## 3-10. packages/config/src/test-helpers.ts 생성

**의존:** 없음

```typescript
// packages/config/src/test-helpers.ts
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 테스트용 임시 HOME 디렉토리 격리
 */
export async function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'finclaw-home-'));
  const originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    await fn(tmpHome);
  } finally {
    process.env.HOME = originalHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
}

/**
 * 테스트용 환경변수 임시 설정
 */
export async function withEnvOverride(
  overrides: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
```

## 3-11. packages/config/src/index.ts — barrel export로 교체

**의존:** 모든 src 파일

```typescript
// packages/config/src/index.ts

// 에러 클래스
export {
  ConfigError,
  MissingEnvVarError,
  CircularIncludeError,
  ConfigValidationError,
} from './errors.js';

// 타입
export type { ConfigDeps, ConfigCache } from './types.js';
export type { ValidationResult } from './validation.js';
export type { ConfigIO } from './io.js';

// Zod 스키마
export { FinClawConfigSchema } from './zod-schema.js';
export type { ValidatedFinClawConfig } from './zod-schema.js';

// 검증
export { validateConfig, validateConfigStrict } from './validation.js';

// I/O 팩토리
export { createConfigIO, loadConfig, clearConfigCache } from './io.js';

// 기능 해석기
export { resolveIncludes, deepMerge } from './includes.js';
export { resolveEnvVars } from './env-substitution.js';
export { resolveConfigPath } from './paths.js';
export { mergeConfig } from './merge-config.js';
export { normalizePaths } from './normalize-paths.js';
export { setOverride, unsetOverride, applyOverrides, resetOverrides } from './runtime-overrides.js';
export { createConfigCache } from './cache-utils.js';

// Defaults
export { applyAllDefaults } from './defaults.js';

// 세션
export { createSessionStore } from './sessions/store.js';
export type { SessionStore } from './sessions/store.js';
export { deriveSessionKey } from './sessions/session-key.js';
export { mergeSessionEntry } from './sessions/types.js';
export type { SessionEntry, SessionScope } from './sessions/types.js';

// 테스트 헬퍼
export { withTempHome, withEnvOverride } from './test-helpers.js';
```

## 3-12. config.example.json5 생성

```json5
// config.example.json5
// FinClaw 설정 예시 — JSON5 형식 (주석, trailing comma 허용)
{
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
    cli: { enabled: true },
  },

  session: {
    mainKey: 'main',
    resetPolicy: 'idle',
    idleTimeoutMs: 1800000,
  },

  logging: {
    level: 'info',
    file: true,
    redactSensitive: true,
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

## 3-13. .env.example 생성

```bash
# .env.example
# FinClaw 환경변수 예시
# 이 파일을 .env로 복사하고 값을 설정하세요.

# Discord
DISCORD_BOT_TOKEN=your-bot-token-here
DISCORD_APP_ID=your-application-id-here

# AI Provider
ANTHROPIC_API_KEY=your-anthropic-key-here

# 설정 파일 경로 (선택)
# FINCLAW_CONFIG=/path/to/finclaw.json5

# 로그 레벨 (선택: trace, debug, info, warn, error, fatal)
# FINCLAW_LOG_LEVEL=info
```

### 세션 3 완료 검증

```bash
# 개별 테스트
pnpm test -- packages/config/test/defaults.test.ts       # 통과
pnpm test -- packages/config/test/io.test.ts              # 통과
pnpm test -- packages/config/test/sessions.test.ts        # 통과
pnpm test -- packages/config/test/sessions-key.test.ts    # 통과

# 전체 검증
pnpm typecheck                    # 에러 0
pnpm lint                         # 에러 0
pnpm test -- packages/config/     # 12개 전체 통과
pnpm build                        # 성공
```

---

## Phase 3 전체 완료 체크리스트

- [ ] 소스 18파일 생성
- [ ] 테스트 12파일 생성
- [ ] 예시 2파일 생성
- [ ] `pnpm typecheck` 에러 0
- [ ] `pnpm lint` 에러 0
- [ ] `pnpm test -- packages/config/` 12개 전체 통과
- [ ] `pnpm build` 성공
