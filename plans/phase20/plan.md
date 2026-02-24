# Phase 20: 확장 모듈 & 배포

## 1. 목표

FinClaw 플랫폼의 확장성과 프로덕션 강화를 구축한다. 구체적으로:

1. **플러그인 확장 시스템**: 서드파티 개발자가 새로운 채널 어댑터나 금융 스킬을 독립적으로 개발하고 FinClaw에 연결할 수 있는 플러그인 SDK와 템플릿을 제공한다.
2. **릴리즈 CI/CD**: GitHub Actions 기반 릴리즈 워크플로우(release.yml)로 시맨틱 버전 태그, 체인지로그, GitHub Release를 자동화한다.
3. **프로덕션 강화**: 헬스 모니터링, 구조화 로깅, Graceful Shutdown, 리소스 제한 및 정리를 통해 프로덕션 환경에서 안정적으로 운영 가능하게 한다.
4. **스킬 빌드 시스템**: 금융 스킬을 독립적으로 번들링하여 배포할 수 있는 빌드 스크립트를 구현한다.

이 Phase는 Phase 1-19의 모든 기능이 완성된 후 실행되며, FinClaw를 개발 프로젝트에서 프로덕션 시스템으로 전환하는 마지막 단계이다.

> **참고:** Docker 배포 인프라(Dockerfile, docker-compose.yml, .dockerignore, deploy.yml, build-docker.sh)는 Phase 0에서 스캐폴딩으로 구축됨.

---

## 2. OpenClaw 참조

| 참조 문서             | 경로                                                       | 적용할 패턴                                                                                   |
| --------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 스킬/빌드/배포 인프라 | `openclaw_review/docs/20.스킬-빌드-배포-인프라.md`         | pnpm 모노레포 빌드 구조, CI/CD 6개 워크플로우, Docker 단일 스테이지 빌드                      |
| 빌드/배포 Deep Dive   | `openclaw_review/deep-dive/20-skills-docs-scripts.md`      | mtime 증분 빌드, SHA256 해시 캐싱, Vitest 3분할 테스트 오케스트레이션, Dockerfile 레이어 캐싱 |
| 채널/플러그인 시스템  | `openclaw_review/docs/08.채널-추상화와-플러그인-시스템.md` | `openclaw.plugin.json` 매니페스트, `workspace:*` 의존성, 플러그인 발견/로딩 패턴              |
| 플러그인 확장 예시    | `openclaw/extensions/discord/`                             | package.json `openclaw.extensions`, `openclaw.plugin.json` configSchema                       |
| 데몬/프로세스 관리    | `openclaw_review/deep-dive/13-daemon-cron-hooks.md`        | Graceful Shutdown, 시그널 핸들링, 프로세스 감시                                               |
| 인프라 기반           | `openclaw_review/docs/12.인프라-런타임-기반-레이어.md`     | 구조화 로깅, 에러 복구, 리소스 정리                                                           |

**핵심 적용 패턴:**

1. **플러그인 매니페스트**: OpenClaw의 `openclaw.plugin.json` 패턴을 `finclaw.plugin.json`으로 적용. 플러그인의 채널/스킬 등록 정보, 설정 스키마를 선언적으로 정의.
2. **Docker 레이어 캐싱**: package.json + lockfile 먼저 COPY -> `pnpm install` -> 소스 COPY -> `pnpm build` 순서로 의존성 캐시를 극대화.
3. **멀티 플랫폼 빌드**: OpenClaw의 `docker-release.yml` 패턴 -- amd64/arm64 병렬 빌드 후 `docker buildx imagetools create`로 멀티 플랫폼 매니페스트 생성.
4. **Graceful Shutdown**: `SIGTERM`/`SIGINT` 시그널 수신 시 진행 중인 요청 완료 대기, WebSocket 연결 정리, 크론 작업 정지, DB 연결 종료의 순서화된 셧다운.
5. **Calendar Versioning**: OpenClaw의 `YYYY.M.D` 버전 체계를 적용하여 릴리즈 시점을 즉시 파악 가능하게 한다.

---

## 3. 생성할 파일

### 플러그인 시스템 (3개)

| #   | 파일 경로                                        | 설명                                                      | 예상 LOC |
| --- | ------------------------------------------------ | --------------------------------------------------------- | -------- |
| 1   | `src/plugins/sdk.ts`                             | 플러그인 SDK: 타입 export, 플러그인 등록 API, 생명주기 훅 | ~120     |
| 2   | `extensions/plugin-template/package.json`        | 예제 플러그인 패키지 정의                                 | ~15      |
| 3   | `extensions/plugin-template/src/index.ts`        | 예제 플러그인 진입점 (스켈레톤)                           | ~50      |
| 4   | `extensions/plugin-template/finclaw.plugin.json` | 플러그인 매니페스트 (채널/스킬 등록 정보)                 | ~15      |

### CI/CD 워크플로우 (1개)

| #   | 파일 경로                       | 설명                                         | 예상 LOC |
| --- | ------------------------------- | -------------------------------------------- | -------- |
| 5   | `.github/workflows/release.yml` | 시맨틱 버전 태그, 체인지로그, GitHub Release | ~60      |

### 빌드 스크립트 (1개)

| #   | 파일 경로                 | 설명                      | 예상 LOC |
| --- | ------------------------- | ------------------------- | -------- |
| 6   | `scripts/build-skills.ts` | 금융 스킬 번들링 스크립트 | ~80      |

### 프로덕션 강화 (2개)

| #   | 파일 경로               | 설명                                     | 예상 LOC |
| --- | ----------------------- | ---------------------------------------- | -------- |
| 7   | `src/infra/health.ts`   | 헬스 체크 엔드포인트 + 프로세스 모니터링 | ~100     |
| 8   | `src/infra/shutdown.ts` | Graceful Shutdown 오케스트레이터         | ~90      |

### 테스트 파일 (3개)

| #   | 파일 경로                              | 테스트 대상                   | 예상 LOC |
| --- | -------------------------------------- | ----------------------------- | -------- |
| 9   | `src/plugins/__tests__/sdk.test.ts`    | 플러그인 SDK (등록, 생명주기) | ~100     |
| 10  | `src/infra/__tests__/health.test.ts`   | 헬스 체크 응답 형식           | ~80      |
| 11  | `src/infra/__tests__/shutdown.test.ts` | Graceful Shutdown 순서        | ~90      |

**합계: 소스 8개 + 테스트 3개 = 11개 파일, 예상 ~860 LOC**

---

## 4. 핵심 인터페이스/타입

### 4.1 플러그인 SDK 타입

```typescript
// src/plugins/sdk.ts

/** 플러그인 매니페스트 (finclaw.plugin.json) */
export interface PluginManifest {
  readonly id: string; // 플러그인 고유 식별자
  readonly name: string; // 표시 이름
  readonly version: string; // 플러그인 버전
  readonly description?: string;
  readonly author?: string;
  readonly homepage?: string;

  // 제공하는 기능
  readonly channels?: readonly string[]; // 제공하는 채널 ID 목록
  readonly skills?: readonly PluginSkillRef[]; // 제공하는 스킬 참조
  readonly tools?: readonly PluginToolRef[]; // 제공하는 에이전트 도구 참조

  // 설정 스키마
  readonly configSchema?: JsonSchema; // JSON Schema (설정 UI 자동 생성용)

  // 요구 사항
  readonly requires?: {
    readonly finclawVersion?: string; // 최소 FinClaw 버전
    readonly env?: readonly string[]; // 필수 환경변수
  };
}

/** 플러그인 스킬 참조 */
export interface PluginSkillRef {
  readonly name: string;
  readonly description: string;
  readonly entryPoint: string; // 상대 경로 (예: "./skills/my-skill.js")
}

/** 플러그인 도구 참조 */
export interface PluginToolRef {
  readonly name: string;
  readonly description: string;
  readonly entryPoint: string;
}

/** 플러그인 생명주기 인터페이스 */
export interface PluginLifecycle {
  /** 플러그인 초기화 (서버 시작 시 호출) */
  onInit?(context: PluginContext): Promise<void>;

  /** 플러그인 정리 (서버 종료 시 호출) */
  onShutdown?(): Promise<void>;

  /** 설정 변경 시 호출 */
  onConfigChange?(config: Record<string, unknown>): Promise<void>;
}

/** 플러그인에 주입되는 컨텍스트 */
export interface PluginContext {
  readonly config: Record<string, unknown>; // 플러그인별 설정값
  readonly logger: Logger; // 스코프된 로거
  readonly registerTool: (tool: ToolDefinition) => void;
  readonly registerChannel: (channel: ChannelAdapter) => void;
  readonly getService: <T>(name: string) => T; // 서비스 로케이터
}

/** 플러그인 진입점 함수 시그니처 */
export type PluginEntryPoint = (context: PluginContext) => PluginLifecycle;

// ─── 플러그인 레지스트리 ───

/** 로드된 플러그인 인스턴스 */
export interface LoadedPlugin {
  readonly manifest: PluginManifest;
  readonly lifecycle: PluginLifecycle;
  readonly path: string; // 플러그인 디렉토리 경로
}

/** 플러그인 레지스트리 인터페이스 */
export interface PluginRegistry {
  /** 디렉토리에서 플러그인 발견 및 로드 */
  discoverPlugins(dirs: readonly string[]): Promise<void>;

  /** 특정 플러그인 로드 */
  loadPlugin(pluginPath: string): Promise<LoadedPlugin>;

  /** 로드된 플러그인 목록 */
  listPlugins(): readonly LoadedPlugin[];

  /** 특정 플러그인 조회 */
  getPlugin(id: string): LoadedPlugin | undefined;

  /** 모든 플러그인 초기화 */
  initAll(context: PluginContext): Promise<void>;

  /** 모든 플러그인 정리 (역순) */
  shutdownAll(): Promise<void>;
}
```

### 4.2 헬스 체크 타입

```typescript
// src/infra/health.ts

/** 헬스 체크 응답 */
export interface HealthCheckResponse {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly version: string;
  readonly uptime: number; // 초
  readonly timestamp: string; // ISO 8601
  readonly checks: Record<string, ComponentHealth>;
}

/** 개별 컴포넌트 헬스 */
export interface ComponentHealth {
  readonly status: 'up' | 'down' | 'degraded';
  readonly latencyMs?: number;
  readonly message?: string;
  readonly lastChecked: string;
}

/** 헬스 체크 가능한 컴포넌트 인터페이스 */
export interface HealthCheckable {
  readonly name: string;
  checkHealth(): Promise<ComponentHealth>;
}
```

### 4.3 Graceful Shutdown 타입

```typescript
// src/infra/shutdown.ts

/** 셧다운 단계 */
export type ShutdownPhase =
  | 'stop-accepting' // 새 요청 수신 중단
  | 'drain-requests' // 진행 중 요청 완료 대기
  | 'stop-cron' // 크론 작업 정지
  | 'close-websockets' // WebSocket 연결 정리
  | 'stop-plugins' // 플러그인 셧다운
  | 'close-database' // DB 연결 종료
  | 'cleanup'; // 임시 파일 정리

/** 셧다운 훅 */
export interface ShutdownHook {
  readonly phase: ShutdownPhase;
  readonly name: string;
  readonly timeoutMs: number; // 개별 훅 타임아웃
  execute(): Promise<void>;
}

/** Graceful Shutdown 오케스트레이터 인터페이스 */
export interface ShutdownOrchestrator {
  register(hook: ShutdownHook): void;
  shutdown(reason: string): Promise<void>;
  readonly isShuttingDown: boolean;
}
```

---

## 5. 구현 상세

### 5.1 플러그인 발견 및 로딩

```typescript
// src/plugins/sdk.ts

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Logger } from '../infra/logger/types.js';

export function createPluginRegistry(deps: { logger: Logger }): PluginRegistry {
  const { logger } = deps;
  const plugins = new Map<string, LoadedPlugin>();

  return {
    /**
     * 디렉토리에서 플러그인 자동 발견
     * OpenClaw의 loadSkills() 5개 디렉토리 순회 패턴 참조
     */
    async discoverPlugins(dirs: readonly string[]): Promise<void> {
      for (const dir of dirs) {
        if (!existsSync(dir)) {
          logger.debug('Plugin directory not found, skipping', { dir });
          continue;
        }

        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;

          const pluginPath = join(dir, entry.name);
          const manifestPath = join(pluginPath, 'finclaw.plugin.json');

          if (!existsSync(manifestPath)) {
            logger.debug('No manifest found, skipping', { path: pluginPath });
            continue;
          }

          try {
            await this.loadPlugin(pluginPath);
          } catch (error) {
            // 개별 플러그인 로드 실패가 전체를 중단하지 않음 (Graceful Degradation)
            logger.error('Failed to load plugin', {
              path: pluginPath,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      logger.info('Plugin discovery complete', { loaded: plugins.size });
    },

    async loadPlugin(pluginPath: string): Promise<LoadedPlugin> {
      const absPath = resolve(pluginPath);
      const manifestPath = join(absPath, 'finclaw.plugin.json');

      // 매니페스트 파싱
      const manifestRaw = readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestRaw) as PluginManifest;

      // 요구 사항 검증
      if (manifest.requires?.env) {
        for (const envVar of manifest.requires.env) {
          if (!process.env[envVar]) {
            throw new Error(`Missing required env: ${envVar}`);
          }
        }
      }

      // 진입점 로드 (ESM dynamic import)
      const entryPath = join(absPath, 'src', 'index.js');
      const module = await import(entryPath);
      const entryFn = module.default as PluginEntryPoint;

      if (typeof entryFn !== 'function') {
        throw new Error(`Plugin ${manifest.id}: default export is not a function`);
      }

      // 임시 컨텍스트로 플러그인 인스턴스 생성 (initAll에서 실제 컨텍스트 주입)
      const lifecycle = entryFn({} as PluginContext);

      const loaded: LoadedPlugin = { manifest, lifecycle, path: absPath };
      plugins.set(manifest.id, loaded);

      logger.info('Plugin loaded', { id: manifest.id, version: manifest.version });
      return loaded;
    },

    listPlugins(): readonly LoadedPlugin[] {
      return [...plugins.values()];
    },

    getPlugin(id: string): LoadedPlugin | undefined {
      return plugins.get(id);
    },

    async initAll(context: PluginContext): Promise<void> {
      for (const [id, plugin] of plugins) {
        try {
          await plugin.lifecycle.onInit?.(context);
          logger.info('Plugin initialized', { id });
        } catch (error) {
          logger.error('Plugin init failed', {
            id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },

    /** 역순 셧다운 -- 나중에 로드된 플러그인을 먼저 종료 */
    async shutdownAll(): Promise<void> {
      const entries = [...plugins.entries()].reverse();
      for (const [id, plugin] of entries) {
        try {
          await plugin.lifecycle.onShutdown?.();
          logger.info('Plugin shutdown', { id });
        } catch (error) {
          logger.error('Plugin shutdown failed', {
            id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
  };
}
```

### 5.2 플러그인 템플릿

**package.json (`extensions/plugin-template/package.json`)**:

```json
{
  "name": "@finclaw/plugin-template",
  "version": "0.1.0",
  "description": "FinClaw plugin template - skeleton for custom channel/skill plugins",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "finclaw": "workspace:*"
  },
  "finclaw": {
    "extensions": ["./src/index.ts"]
  }
}
```

**매니페스트 (`extensions/plugin-template/finclaw.plugin.json`)**:

```json
{
  "id": "my-plugin",
  "name": "My Custom Plugin",
  "version": "0.1.0",
  "description": "A template for creating FinClaw plugins",
  "channels": [],
  "skills": [
    {
      "name": "my-skill",
      "description": "Example skill provided by this plugin",
      "entryPoint": "./skills/my-skill.js"
    }
  ],
  "tools": [
    {
      "name": "my_tool",
      "description": "Example agent tool",
      "entryPoint": "./tools/my-tool.js"
    }
  ],
  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": {
        "type": "string",
        "description": "API key for the plugin service"
      }
    }
  },
  "requires": {
    "env": []
  }
}
```

**진입점 (`extensions/plugin-template/src/index.ts`)**:

```typescript
import type { PluginContext, PluginLifecycle } from 'finclaw/plugins/sdk';

/**
 * FinClaw 플러그인 템플릿
 *
 * 이 파일은 플러그인의 진입점입니다. default export로 팩토리 함수를 내보내세요.
 * PluginContext를 통해 FinClaw의 서비스(로거, 도구 등록, 채널 등록 등)에 접근할 수 있습니다.
 */
export default function myPlugin(context: PluginContext): PluginLifecycle {
  return {
    async onInit(ctx) {
      ctx.logger.info('My plugin initialized');

      // 에이전트 도구 등록 예시
      ctx.registerTool({
        name: 'my_tool',
        description: 'An example tool that echoes input',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Message to echo' },
          },
          required: ['message'],
        },
        execute: async (params) => {
          return { success: true, data: { echo: params.message } };
        },
      });
    },

    async onShutdown() {
      // 리소스 정리
    },

    async onConfigChange(config) {
      // 설정 변경 대응
    },
  };
}
```

### 5.3 릴리즈 워크플로우

````yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # 전체 이력 (changelog 생성용)

      - name: Generate changelog
        id: changelog
        run: |
          PREV_TAG=$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null || echo "")
          if [ -n "$PREV_TAG" ]; then
            CHANGELOG=$(git log ${PREV_TAG}..HEAD --pretty=format:"- %s (%h)" --no-merges)
          else
            CHANGELOG=$(git log --pretty=format:"- %s (%h)" --no-merges -20)
          fi
          echo "changelog<<EOF" >> $GITHUB_OUTPUT
          echo "$CHANGELOG" >> $GITHUB_OUTPUT
          echo "EOF" >> $GITHUB_OUTPUT

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          body: |
            ## Changes

            ${{ steps.changelog.outputs.changelog }}

            ## Docker Image

            ```bash
            docker pull ghcr.io/${{ github.repository }}:${{ github.ref_name }}
            ```
          draft: false
          prerelease: ${{ contains(github.ref_name, '-rc') || contains(github.ref_name, '-beta') }}
````

### 5.4 Graceful Shutdown 오케스트레이터

```typescript
// src/infra/shutdown.ts

import type { Logger } from './logger/types.js';

const PHASE_ORDER: ShutdownPhase[] = [
  'stop-accepting',
  'drain-requests',
  'stop-cron',
  'close-websockets',
  'stop-plugins',
  'close-database',
  'cleanup',
];

const TOTAL_TIMEOUT_MS = 30_000; // 전체 셧다운 최대 30초

export function createShutdownOrchestrator(deps: { logger: Logger }): ShutdownOrchestrator {
  const { logger } = deps;
  const hooks: ShutdownHook[] = [];
  let shuttingDown = false;

  function register(hook: ShutdownHook): void {
    hooks.push(hook);
    logger.debug('Shutdown hook registered', { name: hook.name, phase: hook.phase });
  }

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) {
      logger.warn('Shutdown already in progress');
      return;
    }
    shuttingDown = true;
    logger.info('Graceful shutdown initiated', { reason });

    const startTime = Date.now();

    for (const phase of PHASE_ORDER) {
      const phaseHooks = hooks.filter((h) => h.phase === phase);
      if (phaseHooks.length === 0) continue;

      logger.info(`Shutdown phase: ${phase}`, { hookCount: phaseHooks.length });

      for (const hook of phaseHooks) {
        // 전체 타임아웃 체크
        if (Date.now() - startTime > TOTAL_TIMEOUT_MS) {
          logger.error('Shutdown timeout exceeded, forcing exit');
          process.exit(1);
        }

        try {
          await Promise.race([
            hook.execute(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Hook timeout: ${hook.name}`)), hook.timeoutMs),
            ),
          ]);
          logger.debug(`Hook completed: ${hook.name}`);
        } catch (error) {
          // 개별 훅 실패가 셧다운을 중단하지 않음
          logger.error(`Hook failed: ${hook.name}`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const elapsed = Date.now() - startTime;
    logger.info('Graceful shutdown complete', { elapsedMs: elapsed });
    process.exit(0);
  }

  return {
    register,
    shutdown,
    get isShuttingDown() {
      return shuttingDown;
    },
  };
}

/** 시그널 핸들러 설정 */
export function setupSignalHandlers(orchestrator: ShutdownOrchestrator): void {
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

  for (const signal of signals) {
    process.on(signal, () => {
      orchestrator.shutdown(`Received ${signal}`);
    });
  }

  // Uncaught exception 핸들링
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    orchestrator.shutdown(`Uncaught exception: ${error.message}`);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    orchestrator.shutdown(`Unhandled rejection: ${String(reason)}`);
  });
}
```

### 5.5 헬스 체크

```typescript
// src/infra/health.ts

export function createHealthChecker(deps: {
  version: string;
  startTime: Date;
  components: HealthCheckable[];
}): {
  check: () => Promise<HealthCheckResponse>;
  handleRequest: (req: Request) => Promise<Response>;
} {
  const { version, startTime, components } = deps;

  async function check(): Promise<HealthCheckResponse> {
    const checks: Record<string, ComponentHealth> = {};
    let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

    await Promise.allSettled(
      components.map(async (component) => {
        try {
          const health = await component.checkHealth();
          checks[component.name] = health;

          if (health.status === 'down') overallStatus = 'unhealthy';
          else if (health.status === 'degraded' && overallStatus === 'healthy') {
            overallStatus = 'degraded';
          }
        } catch (error) {
          checks[component.name] = {
            status: 'down',
            message: error instanceof Error ? error.message : String(error),
            lastChecked: new Date().toISOString(),
          };
          overallStatus = 'unhealthy';
        }
      }),
    );

    return {
      status: overallStatus,
      version,
      uptime: (Date.now() - startTime.getTime()) / 1000,
      timestamp: new Date().toISOString(),
      checks,
    };
  }

  async function handleRequest(): Promise<Response> {
    const result = await check();
    const statusCode = result.status === 'healthy' ? 200 : result.status === 'degraded' ? 200 : 503;

    return new Response(JSON.stringify(result, null, 2), {
      status: statusCode,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return { check, handleRequest };
}

/** SQLite 헬스 체크 컴포넌트 */
export function createDatabaseHealthCheck(db: DatabaseSync): HealthCheckable {
  return {
    name: 'database',
    async checkHealth(): Promise<ComponentHealth> {
      const start = performance.now();
      try {
        db.prepare('SELECT 1').get();
        return {
          status: 'up',
          latencyMs: Math.round(performance.now() - start),
          lastChecked: new Date().toISOString(),
        };
      } catch (error) {
        return {
          status: 'down',
          message: error instanceof Error ? error.message : String(error),
          lastChecked: new Date().toISOString(),
        };
      }
    },
  };
}

/** Gateway WebSocket 헬스 체크 컴포넌트 */
export function createGatewayHealthCheck(deps: {
  getActiveConnections: () => number;
}): HealthCheckable {
  return {
    name: 'gateway',
    async checkHealth(): Promise<ComponentHealth> {
      return {
        status: 'up',
        message: `${deps.getActiveConnections()} active connections`,
        lastChecked: new Date().toISOString(),
      };
    },
  };
}
```

### 5.6 스킬 빌드 스크립트

```typescript
// scripts/build-skills.ts

/**
 * 금융 스킬 번들링 스크립트
 *
 * 각 스킬 디렉토리를 독립 번들로 패키징한다.
 * 배포 시 스킬을 개별적으로 설치/업데이트할 수 있게 한다.
 *
 * 사용법: tsx scripts/build-skills.ts [--skill=market] [--outdir=dist/skills]
 */

import { readdirSync, existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SKILLS_SRC_DIR = resolve('src/skills');
const DEFAULT_OUT_DIR = resolve('dist/skills');

interface SkillBuildResult {
  name: string;
  files: number;
  success: boolean;
  error?: string;
}

async function buildSkills(options: { skillFilter?: string; outDir?: string }): Promise<void> {
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  mkdirSync(outDir, { recursive: true });

  const skillDirs = readdirSync(SKILLS_SRC_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => !options.skillFilter || d.name === options.skillFilter);

  console.log(`Building ${skillDirs.length} skill(s)...`);

  const results: SkillBuildResult[] = [];

  for (const dir of skillDirs) {
    const skillPath = join(SKILLS_SRC_DIR, dir.name);
    const skillOutDir = join(outDir, dir.name);

    try {
      mkdirSync(skillOutDir, { recursive: true });

      // 컴파일된 JS 파일 복사 (dist/ 에서)
      const distPath = join('dist/skills', dir.name);
      if (existsSync(distPath)) {
        copyDirectorySync(distPath, skillOutDir);
      }

      // 메타데이터 생성
      const meta = {
        name: dir.name,
        builtAt: new Date().toISOString(),
        version: process.env.npm_package_version ?? '0.0.0',
      };
      writeFileSync(join(skillOutDir, 'skill.meta.json'), JSON.stringify(meta, null, 2));

      const fileCount = readdirSync(skillOutDir, { recursive: true }).length;
      results.push({ name: dir.name, files: fileCount, success: true });
      console.log(`  [OK] ${dir.name} (${fileCount} files)`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({ name: dir.name, files: 0, success: false, error: msg });
      console.error(`  [FAIL] ${dir.name}: ${msg}`);
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  console.log(`\nBuild complete: ${succeeded} succeeded, ${failed} failed`);

  if (failed > 0) process.exit(1);
}

// CLI 파싱 및 실행
const args = process.argv.slice(2);
const skillFilter = args.find((a) => a.startsWith('--skill='))?.split('=')[1];
const outDir = args.find((a) => a.startsWith('--outdir='))?.split('=')[1];

buildSkills({ skillFilter, outDir });
```

---

## 6. 선행 조건

| 선행 Phase                   | 산출물                                       | 사용 목적                                      |
| ---------------------------- | -------------------------------------------- | ---------------------------------------------- |
| **Phase 1** (타입)           | 핵심 타입 정의                               | 플러그인 SDK 타입 export                       |
| **Phase 2** (인프라)         | 로거, 에러 클래스                            | 구조화 로깅, Graceful Shutdown 로깅            |
| **Phase 3** (설정+CI)        | CI 워크플로우 기초 (`ci.yml`)                | release.yml이 ci.yml과 연계                    |
| **Phase 5** (채널/플러그인)  | `PluginRegistry`, `ChannelPlugin` 인터페이스 | 플러그인 SDK가 Phase 5의 인터페이스를 확장     |
| **Phase 7** (도구 시스템)    | `ToolDefinition`, `ToolRegistry`             | 플러그인에서 도구 등록                         |
| **Phase 10-11** (게이트웨이) | HTTP 서버, WebSocket 서버                    | 헬스 체크 엔드포인트 마운트, Graceful Shutdown |
| **Phase 14** (스토리지)      | SQLite `DatabaseSync`                        | DB 헬스 체크, Graceful Shutdown 시 DB 닫기     |
| **Phase 15** (크론)          | 크론 스케줄러                                | Graceful Shutdown 시 크론 정지                 |
| **Phase 16-18** (금융 스킬)  | 시장/뉴스/알림 스킬                          | 스킬 빌드 시스템 대상                          |

### 직접 의존 관계

```
핵심 의존:
Phase 5      (플러그인 기반)  ─┐
Phase 10     (게이트웨이)     ├──→ Phase 20
Phase 16-18  (금융 스킬)     ─┘
```

---

## 7. 산출물 및 검증

### 기능 검증 체크리스트

| #   | 검증 항목                                               | 테스트 방법                  | 테스트 tier |
| --- | ------------------------------------------------------- | ---------------------------- | ----------- |
| 1   | 플러그인 매니페스트 파싱 및 검증                        | unit test: 유효/무효 JSON    | unit        |
| 2   | 플러그인 발견: 디렉토리 순회, finclaw.plugin.json 감지  | unit test: mock filesystem   | unit        |
| 3   | 플러그인 로드: ESM dynamic import, 팩토리 함수 호출     | unit test: mock module       | unit        |
| 4   | 플러그인 생명주기: onInit -> onShutdown 순서 보장       | unit test: 호출 순서 검증    | unit        |
| 5   | 플러그인 역순 셧다운: 나중에 로드된 것 먼저 종료        | unit test: 3개 플러그인 순서 | unit        |
| 6   | 헬스 체크: healthy/degraded/unhealthy 상태 판정         | unit test: mock components   | unit        |
| 7   | 헬스 체크: SQLite SELECT 1 성공 -> up                   | unit test: mock db           | unit        |
| 8   | 헬스 체크: HTTP 200 (healthy) / 503 (unhealthy) 응답    | unit test: handleRequest     | unit        |
| 9   | Graceful Shutdown: 단계별 순서 실행                     | unit test: 훅 실행 순서 기록 | unit        |
| 10  | Graceful Shutdown: 개별 훅 실패 시 다음 훅 계속         | unit test: 하나 reject       | unit        |
| 11  | Graceful Shutdown: 전체 30초 타임아웃 초과 시 강제 종료 | unit test: fake timers       | unit        |
| 12  | CI 워크플로우: release.yml YAML 문법 유효성             | `actionlint` 또는 수동 검증  | manual      |
| 13  | 스킬 빌드: `tsx scripts/build-skills.ts` 성공           | 수동 검증                    | manual      |

### vitest 실행 기대 결과

```bash
# 플러그인 SDK 테스트
pnpm vitest run src/plugins/__tests__/
# 예상: 1 파일, ~8 tests passed

# 인프라 (헬스 + 셧다운) 테스트
pnpm vitest run src/infra/__tests__/health.test.ts src/infra/__tests__/shutdown.test.ts
# 예상: 2 파일, ~15 tests passed

# 총 23 tests
```

---

## 8. 복잡도 및 예상 파일 수

| 항목               | 값                                  |
| ------------------ | ----------------------------------- |
| **복잡도**         | **M** (Medium)                      |
| **소스 파일**      | 8개                                 |
| **테스트 파일**    | 3개                                 |
| **총 파일 수**     | **11개**                            |
| **예상 LOC**       | ~860                                |
| **예상 소요 기간** | 2-3일                               |
| **새 외부 의존성** | 없음 (GitHub Actions는 인프라 도구) |
| **인프라 파일**    | 1 GitHub Actions (release.yml)      |

### 복잡도 근거 (M 판정)

- **3개 영역**: 플러그인 시스템, 프로덕션 강화, 스킬 빌드 (Docker는 Phase 0으로 이동)
- **Graceful Shutdown 복잡성**: 7단계 순서화된 셧다운, 개별 타임아웃, 에러 격리
- **전체 시스템 의존**: Phase 1-18 모듈과의 통합 지점 존재

### OpenClaw 대비 축소 범위

| OpenClaw 기능             | FinClaw 포함 여부                | 비고                                       |
| ------------------------- | -------------------------------- | ------------------------------------------ |
| 29개 extensions 패키지    | 1개 템플릿                       | 예제만 제공, 실제 플러그인은 커뮤니티 개발 |
| 6개 GitHub Actions        | 1개 (release) + deploy는 Phase 0 | ci.yml은 Phase 3에서 이미 구축             |
| 4개 Dockerfile            | Phase 0에서 구축                 | sandbox, browser 제외                      |
| 52개 스킬 빌드            | 3개 금융 스킬                    | market, news, alerts                       |
| Bun 호환성                | 제외                             | Node.js 22+ 전용                           |
| Calendar Versioning       | 포함                             | YYYY.M.D 형식                              |
| 패치 시스템 (postinstall) | 제외                             | 단일 패키지이므로 불필요                   |
| Mintlify 문서 사이트      | 제외                             | README + 인라인 JSDoc으로 대체             |
| Chrome Extension          | 제외                             | 웹 UI로 대체                               |
| macOS/iOS/Android 앱      | 제외                             | 서버 + Discord + 웹으로 충분               |
