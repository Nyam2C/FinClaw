# Phase 20: 확장 모듈 & 배포

## 1. 목표

FinClaw 플랫폼의 확장성과 프로덕션 강화를 구축한다. 구체적으로:

1. **플러그인 템플릿**: 서드파티 개발자가 실제 `register(api: PluginBuildApi)` 패턴으로 플러그인을 개발할 수 있는 예제 템플릿을 제공한다.
2. **릴리즈 CI/CD**: GitHub Actions 기반 릴리즈 워크플로우(release.yml)로 CalVer 태그, 체인지로그, GitHub Release를 자동화한다.
3. **빌드 메타데이터 & 자동화 스크립트**: CalVer 버전 생성, 빌드 정보 생성, 의존성 버전 검증 스크립트를 구현한다.
4. **스킬 빌드 시스템**: 금융 스킬을 독립적으로 번들링하여 배포할 수 있는 빌드 스크립트를 구현한다.
5. **기존 코드 보강**: health.ts 버전 하드코딩 해소, Dockerfile HEALTHCHECK 활성화, dependabot 설정.

> **이미 구현된 영역 (본 Phase에서 신규 구현하지 않음):**
>
> - **플러그인 SDK**: `packages/server/src/plugins/` 9개 파일 (discovery, loader, manifest, registry, hooks, hook-types, event-bridge, errors, index)
> - **헬스 모니터링**: `packages/server/src/gateway/health.ts` (liveness/readiness, 체커 팩토리, TTL 캐시)
> - **Graceful Shutdown**: `packages/server/src/process/lifecycle.ts` + `signal-handler.ts` (LIFO cleanup, 30초 타임아웃, SIGINT/SIGTERM)

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

1. **플러그인 매니페스트**: OpenClaw의 `openclaw.plugin.json` 패턴을 `finclaw-plugin.json`으로 적용. 플러그인의 타입/슬롯 정보를 선언적으로 정의. (실제 구현: `packages/server/src/plugins/discovery.ts`의 `MANIFEST_FILENAME`)
2. **Docker 레이어 캐싱**: package.json + lockfile 먼저 COPY -> `pnpm install` -> 소스 COPY -> `pnpm build` 순서로 의존성 캐시를 극대화.
3. **멀티 플랫폼 빌드**: OpenClaw의 `docker-release.yml` 패턴 -- amd64/arm64 병렬 빌드 후 `docker buildx imagetools create`로 멀티 플랫폼 매니페스트 생성.
4. **Graceful Shutdown**: `SIGTERM`/`SIGINT` 시그널 수신 시 진행 중인 요청 완료 대기, WebSocket 연결 정리, 크론 작업 정지, DB 연결 종료의 순서화된 셧다운.
5. **Calendar Versioning**: OpenClaw의 `YYYY.M.D` 버전 체계를 적용하여 릴리즈 시점을 즉시 파악 가능하게 한다.

---

## 3. 생성/수정할 파일

### 신규 파일 (7개)

#### 플러그인 템플릿 (3개)

| #   | 파일 경로                                        | 설명                                        | 예상 LOC |
| --- | ------------------------------------------------ | ------------------------------------------- | -------- |
| 1   | `extensions/plugin-template/package.json`        | 예제 플러그인 패키지 정의                   | ~15      |
| 2   | `extensions/plugin-template/src/index.ts`        | 예제 플러그인 진입점 (`register(api)` 패턴) | ~40      |
| 3   | `extensions/plugin-template/finclaw-plugin.json` | 플러그인 매니페스트 (실제 스키마 준수)      | ~12      |

#### 빌드/릴리즈 스크립트 (3개)

| #   | 파일 경로                       | 설명                                | 예상 LOC |
| --- | ------------------------------- | ----------------------------------- | -------- |
| 4   | `scripts/write-build-info.ts`   | 빌드 메타데이터(버전, git SHA) 생성 | ~35      |
| 5   | `scripts/calver.ts`             | CalVer(`YYYY.M.D`) 자동 생성        | ~50      |
| 6   | `scripts/check-dep-versions.ts` | 워크스페이스 의존성 버전 일치 검증  | ~30      |

#### 인프라 설정 (1개)

| #   | 파일 경로                | 설명                              | 예상 LOC |
| --- | ------------------------ | --------------------------------- | -------- |
| 7   | `.github/dependabot.yml` | GitHub Actions 자동 업데이트 설정 | ~10      |

#### CI/CD 워크플로우 (1개)

| #   | 파일 경로                       | 설명                                           | 예상 LOC |
| --- | ------------------------------- | ---------------------------------------------- | -------- |
| 8   | `.github/workflows/release.yml` | CalVer 태그, 체인지로그, GitHub Release 자동화 | ~70      |

#### 빌드 스크립트 (1개)

| #   | 파일 경로                 | 설명                      | 예상 LOC |
| --- | ------------------------- | ------------------------- | -------- |
| 9   | `scripts/build-skills.ts` | 금융 스킬 번들링 스크립트 | ~80      |

### 기존 파일 수정 (3개)

| #   | 파일 경로                               | 수정 내용                                          |
| --- | --------------------------------------- | -------------------------------------------------- |
| M1  | `packages/server/src/gateway/health.ts` | `'0.1.0'` 하드코딩 → `build-info.json` 로드        |
| M2  | `Dockerfile`                            | HEALTHCHECK 주석 해제 + `/healthz` 엔드포인트 사용 |
| M3  | `packages/channel-discord/package.json` | zod `^3.25.0` → `^4.0.0` 업그레이드                |

**합계: 신규 9개 + 수정 3개 = 12개 파일, 예상 ~410 LOC (신규)**

---

## 4. 핵심 인터페이스/타입

> 플러그인 SDK, 헬스, 셧다운은 이미 구현 완료. 아래는 실제 코드의 핵심 시그니처 참조이다.

### 4.1 플러그인 시스템 (구현 완료 — 참조용)

**매니페스트 스키마** — `packages/server/src/plugins/manifest.ts`:

```typescript
// Zod v4 strictObject — finclaw-plugin.json의 유효성 검증
PluginManifestSchema = z.strictObject({
  name, version, description?, author?, main, type,
  dependencies?, slots?, config?, configSchema?
})
```

**플러그인 등록 API** — `packages/server/src/plugins/loader.ts`:

```typescript
// 플러그인 모듈이 export하는 함수
interface PluginExports {
  readonly register?: (api: PluginBuildApi) => void;
  readonly activate?: (api: PluginBuildApi) => void;
  readonly deactivate?: () => Promise<void>;
}

// register() 콜백에 주입되는 API
interface PluginBuildApi {
  readonly pluginName: string;
  registerChannel(channel: ChannelPlugin): void;
  registerHook(hookName, handler, opts?: { priority?: number }): void;
  registerService(service: PluginService): void;
  registerCommand(command: Omit<PluginCommand, 'pluginName'>): void;
  registerRoute(route: Omit<RouteRegistration, 'pluginName'>): void;
  addDiagnostic(diagnostic: Omit<PluginDiagnostic, 'pluginName'>): void;
}
```

**5단계 로딩 파이프라인**: Discovery → Manifest(Zod v4) → Security(경로 검증) → Load(ESM/TS strip/jiti) → Register(콜백 실행)

### 4.2 헬스 체크 (구현 완료 — 참조용)

**파일**: `packages/server/src/gateway/health.ts`

- `checkLiveness()` → `{ status: 'ok', uptime }` (항상 200)
- `checkReadiness(activeSessions, connections)` → `SystemHealth` (ok/degraded/error + components + memory)
- `createProviderHealthChecker(name, checkFn)` — 60초 TTL 캐시
- `createDbHealthChecker(checkFn)` — 즉시 체크

### 4.3 Graceful Shutdown (구현 완료 — 참조용)

**파일**: `packages/server/src/process/lifecycle.ts` + `signal-handler.ts`

- `ProcessLifecycle` 클래스: `register(fn)` → LIFO 순서 실행
- `setupGracefulShutdown(logger, getCleanupFns)`: SIGINT/SIGTERM → 30초 타임아웃 → cleanup 순차 실행
- 두 번째 시그널 시 강제 종료

---

## 5. 구현 상세

### 5.1 플러그인 템플릿

> 기존 plan.md의 팩토리 패턴 `(ctx: PluginContext) => PluginLifecycle` 대신,
> 실제 구현된 `register(api: PluginBuildApi)` 패턴을 사용한다.

**매니페스트 (`extensions/plugin-template/finclaw-plugin.json`)**:

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "A template for creating FinClaw plugins",
  "main": "src/index.ts",
  "type": "skill",
  "config": {},
  "configSchema": {}
}
```

**package.json (`extensions/plugin-template/package.json`)**:

```json
{
  "name": "@finclaw/plugin-template",
  "version": "0.1.0",
  "private": true,
  "description": "FinClaw plugin template — skeleton for custom plugins",
  "type": "module",
  "main": "src/index.ts",
  "devDependencies": {
    "@finclaw/types": "workspace:*"
  }
}
```

**진입점 (`extensions/plugin-template/src/index.ts`)**:

```typescript
import type { PluginBuildApi } from '@finclaw/server/plugins';

/**
 * FinClaw 플러그인 템플릿
 *
 * register()로 채널, 훅, 서비스, 커맨드, 라우트를 등록한다.
 * PluginBuildApi를 통해 FinClaw의 슬롯 시스템에 접근할 수 있다.
 */
export function register(api: PluginBuildApi): void {
  // 훅 등록 예시
  api.registerHook(
    'afterAgentRun',
    async (payload) => {
      console.log(`[${api.pluginName}] Agent run completed`, payload);
    },
    { priority: 100 },
  );

  // 커맨드 등록 예시
  api.registerCommand({
    name: 'my-command',
    description: 'An example command provided by this plugin',
    execute: async () => ({ success: true }),
  });
}

export async function deactivate(): Promise<void> {
  // 리소스 정리
}
```

### 5.2 빌드 메타데이터 스크립트

**`scripts/write-build-info.ts`** (~35 LOC):

- `git describe --tags --always` + `git rev-parse --short HEAD`로 버전/SHA 추출
- `{ version, gitSha, builtAt }` 객체를 `packages/server/build-info.json`에 기록
- CI의 빌드 단계에서 `tsx scripts/write-build-info.ts` 실행

**`scripts/calver.ts`** (~50 LOC):

- `YYYY.M.D` 형식 CalVer 생성 (예: `2026.3.22`)
- 같은 날 복수 릴리즈 시 suffix 추가 (예: `2026.3.22.1`)
- `git tag -a vYYYY.M.D -m "Release YYYY.M.D"` 실행 옵션

**`scripts/check-dep-versions.ts`** (~30 LOC):

- 워크스페이스 내 공통 의존성(zod, typescript 등)의 버전 불일치 검출
- CI에서 `tsx scripts/check-dep-versions.ts` 실행하여 불일치 시 실패

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
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      # ── 빌드 검증 (CI와 동일 파이프라인) ──
      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version-file: '.node-version'
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile

      - name: Type Check
        run: pnpm typecheck

      - name: Build
        run: pnpm build

      - name: Test
        run: pnpm test:ci

      # ── 릴리즈 ──
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

> **deploy.yml과의 관계**: 둘 다 `tags: ['v*']`로 트리거되어 병렬 실행된다.
>
> - `release.yml`: 빌드 검증 → GitHub Release + 체인지로그 생성 (역할: 릴리즈 메타데이터)
> - `deploy.yml`: Docker 이미지 빌드 → ghcr.io 푸시 (역할: 컨테이너 배포)

### 5.4 health.ts 버전 수정

`packages/server/src/gateway/health.ts`의 `version: '0.1.0'` 하드코딩을 `build-info.json` 로드로 교체:

```typescript
// health.ts 상단에 추가
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadVersion(): string {
  try {
    const info = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../build-info.json'), 'utf-8'),
    );
    return info.version ?? '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}
```

### 5.5 Dockerfile HEALTHCHECK 활성화

```dockerfile
# 기존 주석을 실제 코드로 교체 — /healthz (liveness) 엔드포인트 사용
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/healthz').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"
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

| #   | 검증 항목                                                      | 테스트 방법                             | 테스트 tier |
| --- | -------------------------------------------------------------- | --------------------------------------- | ----------- |
| 1   | 플러그인 템플릿 매니페스트가 `PluginManifestSchema` 검증 통과  | unit test: parseManifest(template json) | unit        |
| 2   | 플러그인 템플릿 `register(api)` 함수가 정상 실행               | unit test: createPluginBuildApi로 검증  | unit        |
| 3   | `write-build-info.ts`가 build-info.json 생성                   | unit test: 스크립트 실행 후 파일 확인   | unit        |
| 4   | `calver.ts`가 `YYYY.M.D` 형식 생성                             | unit test: 날짜 기반 출력 검증          | unit        |
| 5   | `check-dep-versions.ts`가 불일치 검출                          | unit test: 의도적 불일치 시나리오       | unit        |
| 6   | health.ts가 build-info.json에서 버전 로드                      | unit test: mock build-info.json         | unit        |
| 7   | health.ts fallback: build-info.json 없을 때 `'0.0.0-dev'` 반환 | unit test: 파일 없는 환경               | unit        |
| 8   | release.yml YAML 문법 유효성                                   | `actionlint` 또는 수동 검증             | manual      |
| 9   | dependabot.yml이 올바른 ecosystem/directory 설정               | 수동 검증                               | manual      |
| 10  | Dockerfile HEALTHCHECK 지시자가 유효                           | `docker build` 후 `docker inspect`      | manual      |
| 11  | 스킬 빌드: `tsx scripts/build-skills.ts` 성공                  | 수동 검증                               | manual      |

### vitest 실행 기대 결과

```bash
# 플러그인 템플릿 검증 + 빌드 스크립트 테스트
pnpm vitest run --filter "phase20"
# 예상: ~10 tests passed
```

---

## 8. 의도적 제외 목록

> RSA 분석에서 식별된 과잉 엔지니어링 방지 항목. 현 단계에서 구현하지 않는다.

| 제외 항목                       | 사유                                                 |
| ------------------------------- | ---------------------------------------------------- |
| 플러그인 핫 리로드              | 프로덕션에서 불필요, 개발 시 `tsx --watch`로 충분    |
| 플러그인 의존성 그래프 해석     | 현재 플러그인 간 의존성 없음, 향후 필요 시 추가      |
| 플러그인 샌드박스 (VM/Worker)   | 현재 내부 플러그인만 사용, 서드파티 격리는 향후 과제 |
| 별도 ShutdownOrchestrator       | `ProcessLifecycle`의 LIFO 패턴으로 충분              |
| 별도 HealthCheckable 인터페이스 | `HealthChecker` 함수 타입 + 팩토리 패턴으로 충분     |
| 멀티 레지스트리 (환경별)        | 단일 글로벌 레지스트리로 충분                        |
| Bun/Deno 호환성                 | Node.js 22+ 전용                                     |
| Mintlify 문서 사이트            | README + 인라인 JSDoc으로 대체                       |
| Chrome Extension / 모바일 앱    | 서버 + Discord + 웹으로 충분                         |

---

## 9. 복잡도 및 예상 파일 수

| 항목                | 값                                  |
| ------------------- | ----------------------------------- |
| **복잡도**          | **S** (Small)                       |
| **신규 파일**       | 9개                                 |
| **수정 파일**       | 3개                                 |
| **총 파일 수**      | **12개**                            |
| **예상 LOC (신규)** | ~410                                |
| **새 외부 의존성**  | 없음 (GitHub Actions는 인프라 도구) |
| **인프라 파일**     | 2 (release.yml, dependabot.yml)     |

### 복잡도 근거 (S 판정)

- 플러그인 SDK, 헬스, 셧다운은 **이미 구현 완료** — 신규 구현 불필요
- 남은 작업은 템플릿 + 스크립트 + CI 설정 + 소규모 기존 파일 수정
- 기존 Phase 20 plan의 핵심 3개 영역(sdk.ts ~120 LOC, health.ts ~100 LOC, shutdown.ts ~90 LOC)이 제거됨

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
