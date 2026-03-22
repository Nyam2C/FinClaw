# Phase 20: 플러그인 템플릿 & 배포 인프라 — Todo

## 개요

FinClaw 플랫폼의 확장성과 프로덕션 강화. 플러그인 SDK(Phase 5, 이미 구현)를 기반으로 서드파티 개발자용 템플릿, 빌드 자동화, 릴리즈 CI/CD, 버전 하드코딩 해소를 수행한다.

**신규 9개 + 수정 4개 = 13개 파일, ~410 LOC**

### 실행 순서

```
Todo 1 (플러그인 템플릿)     — 독립
Todo 2 (빌드 스크립트 3개)   — 독립
Todo 3 (버전 하드코딩 해소)  — Todo 2 이후 (build-info.json 의존)
Todo 4 (Dockerfile)          — 독립
Todo 5 (CI/CD + dependabot)  — 독립
Todo 6 (스킬 빌드 + zod)    — 독립
```

권장: Todo 1 → 2 → 3 → 4 → 5 → 6

---

## Todo 1: 플러그인 템플릿

### 파일 목록

| 작업 | 파일 경로                                        | LOC |
| ---- | ------------------------------------------------ | --- |
| 신규 | `extensions/plugin-template/finclaw-plugin.json` | ~8  |
| 신규 | `extensions/plugin-template/package.json`        | ~9  |
| 신규 | `extensions/plugin-template/src/index.ts`        | ~40 |

### 주의사항

- `extensions/` 디렉토리는 현재 존재하지 않음 → 생성 필요
- `pnpm-workspace.yaml`에 `packages/*`만 있으므로 `extensions/`는 워크스페이스 외부 → `workspace:*` 의존성 미사용
- `@finclaw/server`에 `exports` 필드가 없어 서브패스 import 불가 → `PluginBuildApi` 타입을 인라인 정의
- `PluginCommand.handler` 시그니처: `(args: string[]) => Promise<string>` (plan.md의 `execute`와 다름, 실제 코드 기준)
- `registerCommand`의 파라미터: `Omit<PluginCommand, 'pluginName'>` → `{ name, description, handler }`

### 구현 코드

#### `extensions/plugin-template/finclaw-plugin.json`

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

- `name`: 플러그인 고유 이름 (manifest.ts의 `PluginManifestSchema` 검증 대상)
- `type`: `'channel' | 'skill' | 'tool' | 'service'` 중 택 1
- `main`: 진입점 — discovery.ts가 `finclaw-plugin.json`을 찾고 이 경로를 로드
- `config` / `configSchema`: 플러그인 설정 (빈 객체 = 설정 없음)

#### `extensions/plugin-template/package.json`

```json
{
  "name": "@finclaw/plugin-template",
  "version": "0.1.0",
  "private": true,
  "description": "FinClaw plugin template — skeleton for custom plugins",
  "type": "module",
  "main": "src/index.ts"
}
```

- 워크스페이스 외부이므로 `workspace:*` 의존성 없음
- `private: true` — npm 배포 방지

#### `extensions/plugin-template/src/index.ts`

```typescript
/**
 * FinClaw 플러그인 템플릿
 *
 * register()로 채널, 훅, 서비스, 커맨드, 라우트를 등록한다.
 * PluginBuildApi를 통해 FinClaw의 슬롯 시스템에 접근할 수 있다.
 *
 * @see packages/server/src/plugins/loader.ts — PluginBuildApi 인터페이스 정의
 */

/** PluginBuildApi 축약 타입 (원본: packages/server/src/plugins/loader.ts) */
interface PluginApi {
  readonly pluginName: string;
  registerHook(
    hookName: string,
    handler: (...args: unknown[]) => Promise<unknown>,
    opts?: { priority?: number },
  ): void;
  registerCommand(command: {
    name: string;
    description: string;
    handler: (args: string[]) => Promise<string>;
  }): void;
}

export function register(api: PluginApi): void {
  // 훅 등록 예시: 에이전트 실행 완료 후 로깅
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
    handler: async (_args) => 'Command executed successfully',
  });
}

export async function deactivate(): Promise<void> {
  // 플러그인 해제 시 리소스 정리
}
```

**왜 `PluginApi`로 축약했는가:** `PluginBuildApi`의 전체 인터페이스(6개 메서드)를 복사하면 원본과 동기화 부담이 생긴다. 템플릿에서 실제 사용하는 메서드(`registerHook`, `registerCommand`)만 축약 타입으로 정의. 실제 로딩 시 loader.ts가 주입하는 `PluginBuildApi`와 구조적 호환(structural typing).

### 검증

```bash
# 1. 디렉토리 생성 확인
ls extensions/plugin-template/src/index.ts

# 2. 매니페스트 스키마 검증 (기존 parseManifest 사용)
# test에서: parseManifest(JSON.parse(fs.readFileSync('extensions/plugin-template/finclaw-plugin.json', 'utf-8')))
# → { ok: true, manifest: { name: 'my-plugin', ... } }

# 3. register() 호출 에러 없음 (기존 createPluginBuildApi 사용)
# test에서: register(createPluginBuildApi('test-plugin')) → 에러 없이 완료
```

---

## Todo 2: 빌드 메타데이터 스크립트 (3개)

### 파일 목록

| 작업 | 파일 경로                       | LOC |
| ---- | ------------------------------- | --- |
| 신규 | `scripts/write-build-info.ts`   | ~30 |
| 신규 | `scripts/calver.ts`             | ~45 |
| 신규 | `scripts/check-dep-versions.ts` | ~50 |

### 공통 사항

- `tsx scripts/xxx.ts`로 실행
- Node.js 22+ 내장 API만 사용 (외부 의존성 없음)
- `scripts/` 디렉토리에 기존 파일: `build-docker.sh`, `test-parallel.mjs`

### 구현 코드

#### `scripts/write-build-info.ts`

```typescript
#!/usr/bin/env tsx
/**
 * 빌드 메타데이터 생성
 *
 * git describe + git rev-parse로 버전/SHA를 추출하여
 * packages/server/build-info.json에 기록한다.
 *
 * 사용법: tsx scripts/write-build-info.ts
 * CI에서: release.yml의 빌드 단계에서 실행
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

const version = exec('git describe --tags --always') || '0.0.0-dev';
const gitSha = exec('git rev-parse --short HEAD') || 'unknown';
const builtAt = new Date().toISOString();

const buildInfo = { version, gitSha, builtAt };

const outPath = resolve('packages/server/build-info.json');
writeFileSync(outPath, JSON.stringify(buildInfo, null, 2) + '\n');

console.log(`build-info.json written to ${outPath}`);
console.log(JSON.stringify(buildInfo, null, 2));
```

**출력 위치:** `packages/server/build-info.json` — Todo 3의 `version.ts`가 이 파일을 읽는다.

**출력 예시:**

```json
{
  "version": "v2026.3.22",
  "gitSha": "215aa2c",
  "builtAt": "2026-03-22T10:30:00.000Z"
}
```

#### `scripts/calver.ts`

```typescript
#!/usr/bin/env tsx
/**
 * CalVer 버전 자동 생성
 *
 * YYYY.M.D 형식 (예: 2026.3.22)
 * 같은 날 복수 릴리즈 시 suffix 추가 (예: 2026.3.22.1)
 *
 * 사용법:
 *   tsx scripts/calver.ts          # 버전 태그명 출력만
 *   tsx scripts/calver.ts --tag    # git tag -a 생성
 */
import { execSync } from 'node:child_process';

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function generateCalVer(): string {
  const now = new Date();
  const base = `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}`;

  // 같은 날 기존 태그 확인
  const existingTags = exec(`git tag -l "v${base}*"`).split('\n').filter(Boolean);

  if (existingTags.length === 0) {
    return base;
  }

  // suffix 계산: v2026.3.22 → v2026.3.22.1 → v2026.3.22.2
  let maxSuffix = 0;
  for (const tag of existingTags) {
    const parts = tag.replace('v', '').split('.');
    if (parts.length === 4) {
      const suffix = parseInt(parts[3]!, 10);
      if (suffix > maxSuffix) {
        maxSuffix = suffix;
      }
    }
  }

  return `${base}.${maxSuffix + 1}`;
}

const version = generateCalVer();
const tagName = `v${version}`;

console.log(tagName);

if (process.argv.includes('--tag')) {
  execSync(`git tag -a ${tagName} -m "Release ${version}"`, { stdio: 'inherit' });
  console.log(`Tag ${tagName} created.`);
}
```

**출력 예시:**

```
$ tsx scripts/calver.ts
v2026.3.22

$ tsx scripts/calver.ts  # 같은 날 두 번째
v2026.3.22.1
```

#### `scripts/check-dep-versions.ts`

```typescript
#!/usr/bin/env tsx
/**
 * 워크스페이스 의존성 버전 일치 검증
 *
 * 모든 패키지에서 공통 의존성(zod, typescript 등)의 버전이 일치하는지 확인.
 * 불일치 발견 시 exit 1.
 *
 * 사용법: tsx scripts/check-dep-versions.ts
 * CI에서: ci.yml 또는 release.yml에 추가 가능
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES_DIR = 'packages';

interface PkgJson {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

// 모든 패키지의 package.json 수집
const pkgDirs = readdirSync(PACKAGES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());

const depMap = new Map<string, Array<{ pkg: string; version: string }>>();

for (const dir of pkgDirs) {
  const pkgPath = join(PACKAGES_DIR, dir.name, 'package.json');
  let pkg: PkgJson;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PkgJson;
  } catch {
    continue;
  }

  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const [dep, ver] of Object.entries(allDeps)) {
    if (ver.startsWith('workspace:')) continue;
    if (!depMap.has(dep)) depMap.set(dep, []);
    depMap.get(dep)!.push({ pkg: pkg.name, version: ver });
  }
}

// 불일치 검출
let hasConflict = false;

for (const [dep, entries] of depMap) {
  const versions = new Set(entries.map((e) => e.version));
  if (versions.size > 1) {
    hasConflict = true;
    console.error(`[CONFLICT] ${dep}:`);
    for (const entry of entries) {
      console.error(`  ${entry.pkg}: ${entry.version}`);
    }
  }
}

if (hasConflict) {
  console.error('\nDependency version conflicts detected.');
  process.exit(1);
} else {
  console.log('All dependency versions are consistent.');
}
```

**현재 실행 시 예상 결과 (Todo 6 전):**

```
[CONFLICT] zod:
  @finclaw/channel-discord: ^3.25.0
  @finclaw/skills-finance: ^4.0.0
  @finclaw/server: ^4.0.0

Dependency version conflicts detected.
```

### 검증

```bash
# 1. build-info.json 생성
tsx scripts/write-build-info.ts
cat packages/server/build-info.json

# 2. CalVer 출력
tsx scripts/calver.ts   # → vYYYY.M.D

# 3. 의존성 검증 (zod 불일치 검출)
tsx scripts/check-dep-versions.ts  # → exit 1 (Todo 6에서 해소 후 exit 0)
```

---

## Todo 3: 버전 하드코딩 해소 (3곳)

### 파일 목록

| 작업 | 파일 경로                                           | 수정 내용                        |
| ---- | --------------------------------------------------- | -------------------------------- |
| 신규 | `packages/server/src/gateway/version.ts`            | `loadVersion()` 유틸리티         |
| 수정 | `packages/server/src/gateway/health.ts`             | L51 `'0.1.0'` → `loadVersion()`  |
| 수정 | `packages/server/src/gateway/router.ts`             | L139 `'0.1.0'` → `loadVersion()` |
| 수정 | `packages/server/src/gateway/rpc/methods/system.ts` | L47 `'0.1.0'` → `loadVersion()`  |

### 설계 결정

- `packages/server/build-info.json`을 `readFileSync`로 읽음 (sync — 서버 시작 시 1회)
- 한 번 로드 후 모듈 스코프에 캐시 (매 요청마다 파일 I/O 방지)
- `build-info.json`이 없으면 (개발 환경) fallback `'0.0.0-dev'`
- `import.meta.dirname` 사용 (Node.js 21.2+, 프로젝트는 22+ 필수)

**경로 계산:**

- `version.ts` 위치: `packages/server/src/gateway/version.ts`
- 빌드 후 위치: `packages/server/dist/gateway/version.js`
- `import.meta.dirname` → `packages/server/dist/gateway/` (빌드) 또는 `packages/server/src/gateway/` (tsx)
- `../../../build-info.json` → 두 경우 모두 `packages/server/build-info.json` 도달

### 구현 코드

#### `packages/server/src/gateway/version.ts` (신규)

```typescript
// packages/server/src/gateway/version.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let cached: string | null = null;

/**
 * build-info.json에서 버전을 로드한다.
 * 파일이 없으면(개발 환경) '0.0.0-dev' 반환.
 * 한 번 로드 후 캐시.
 */
export function loadVersion(): string {
  if (cached !== null) return cached;

  try {
    const infoPath = resolve(import.meta.dirname, '../../../build-info.json');
    const info = JSON.parse(readFileSync(infoPath, 'utf-8')) as { version?: string };
    cached = info.version ?? '0.0.0-dev';
  } catch {
    cached = '0.0.0-dev';
  }

  return cached;
}

/** 테스트용: 캐시 초기화 */
export function resetVersionCache(): void {
  cached = null;
}
```

#### `packages/server/src/gateway/health.ts` (수정)

**변경 1: import 추가 (L2 다음)**

```typescript
// 기존:
import type { ComponentHealth, SystemHealth, LivenessResponse } from './rpc/types.js';

// 변경 후:
import type { ComponentHealth, SystemHealth, LivenessResponse } from './rpc/types.js';
import { loadVersion } from './version.js';
```

**변경 2: L51 버전 교체**

```typescript
// 기존 (L51):
    version: '0.1.0',

// 변경 후:
    version: loadVersion(),
```

#### `packages/server/src/gateway/router.ts` (수정)

**변경 1: import 추가 (L5 다음)**

```typescript
// 기존:
import { checkLiveness, checkReadiness } from './health.js';

// 변경 후:
import { checkLiveness, checkReadiness } from './health.js';
import { loadVersion } from './version.js';
```

**변경 2: L139 버전 교체**

```typescript
// 기존 (handleInfoRequest 내, L139):
      version: '0.1.0',

// 변경 후:
      version: loadVersion(),
```

#### `packages/server/src/gateway/rpc/methods/system.ts` (수정)

**변경 1: import 추가 (L3 다음)**

```typescript
// 기존:
import { registerMethod, getRegisteredMethods } from '../index.js';

// 변경 후:
import { registerMethod, getRegisteredMethods } from '../index.js';
import { loadVersion } from '../../version.js';
```

**변경 2: L47 버전 교체**

```typescript
// 기존 (system.info execute 내, L47):
      version: '0.1.0',

// 변경 후:
      version: loadVersion(),
```

### 검증

```bash
# 1. 컴파일 확인
pnpm build

# 2. 타입 체크
pnpm typecheck

# 3. 하드코딩 잔존 확인
grep -rn "'0.1.0'" packages/server/src/gateway/
# → 결과 없어야 함

# 4. build-info.json 없는 상태 (개발 환경)
# loadVersion() → '0.0.0-dev'

# 5. build-info.json 있는 상태
tsx scripts/write-build-info.ts
# loadVersion() → git describe 결과
```

---

## Todo 4: Dockerfile HEALTHCHECK 활성화

### 파일 목록

| 작업 | 파일 경로    | 수정 내용                                |
| ---- | ------------ | ---------------------------------------- |
| 수정 | `Dockerfile` | L58-60 주석 해제 + `/healthz` 엔드포인트 |

### 구현 코드

**기존 (L58-60):**

```dockerfile
# TODO (Phase 11): /health 엔드포인트 구현 후 활성화
# HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
#   CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"
```

**변경 후:**

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/healthz').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"
```

**왜 `/healthz`인가:**

- `/health` (router.ts L112-127): 연결 수/세션 정보만 반환, 200 고정
- `/healthz` (router.ts L145-153): liveness 체크, `checkLiveness()` 호출, 항상 200
- `/readyz` (router.ts L155-168): readiness 체크, 503 가능 — Docker HEALTHCHECK에 부적합 (일시적 degraded로 컨테이너 재시작 유발)
- HEALTHCHECK는 "프로세스가 살아있는가"만 확인 → `/healthz` (liveness) 적합

### 검증

```bash
# 1. Docker 빌드 성공
docker build -t finclaw:test .

# 2. HEALTHCHECK 설정 확인
docker inspect finclaw:test --format='{{json .Config.Healthcheck}}'
# → {"Test":["CMD-SHELL","node -e \"fetch(...)\""], "Interval":30000000000, ...}
```

---

## Todo 5: 릴리즈 CI/CD + dependabot

### 파일 목록

| 작업 | 파일 경로                       | LOC |
| ---- | ------------------------------- | --- |
| 신규 | `.github/workflows/release.yml` | ~65 |
| 신규 | `.github/dependabot.yml`        | ~12 |

### 기존 워크플로우와의 관계

```
트리거: tags: ['v*'] → 병렬 실행
├── release.yml (신규): 빌드 검증 → GitHub Release + 체인지로그
└── deploy.yml  (기존): Docker 이미지 빌드 → ghcr.io 푸시

트리거: push/PR to main
└── ci.yml (기존): lint, format, typecheck, build, test
```

### 구현 코드

#### `.github/workflows/release.yml`

````yaml
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

      # ── 빌드 검증 (ci.yml과 동일 파이프라인) ──
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

#### `.github/dependabot.yml`

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly

  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      dev-dependencies:
        dependency-type: development
```

- `github-actions`: Actions 버전 자동 업데이트 (checkout, setup-node 등)
- `npm` + `groups`: devDependencies를 하나의 PR로 묶어서 노이즈 감소

### 검증

```bash
# 1. YAML 문법 검증
# actionlint .github/workflows/release.yml (설치되어 있다면)
# 또는 GitHub UI에서 Actions 탭 확인

# 2. dependabot 설정 확인
# GitHub repo Settings > Code security > Dependabot에서 활성화 확인

# 3. release.yml과 deploy.yml 트리거 조건 동일 확인
grep -A2 'on:' .github/workflows/release.yml .github/workflows/deploy.yml
```

---

## Todo 6: 스킬 빌드 스크립트 + zod 업그레이드

### 파일 목록

| 작업 | 파일 경로                               | 수정 내용                  |
| ---- | --------------------------------------- | -------------------------- |
| 신규 | `scripts/build-skills.ts`               | 금융 스킬 번들링 (~70 LOC) |
| 수정 | `packages/channel-discord/package.json` | `zod` `^3.25.0` → `^4.0.0` |

### 스킬 빌드 설계

**스킬 디렉토리 구조:**

```
packages/skills-finance/src/
├── market/    ← 시장 데이터 스킬
├── news/      ← 뉴스 집계 스킬
├── alerts/    ← 가격/볼륨 알림 스킬
└── index.ts   ← barrel export
```

**빌드 흐름:**

1. `pnpm build` → `tsc --build` → `packages/skills-finance/dist/{market,news,alerts}/` 생성
2. `tsx scripts/build-skills.ts` → `dist/skills/{market,news,alerts}/`로 복사 + 메타데이터 생성
3. 각 스킬을 독립적으로 배포/설치 가능

**esbuild 미사용 이유:** tsc 빌드 결과를 그대로 활용 — 단순함 우선 원칙. 번들링이 필요해지면 향후 추가.

### 구현 코드

#### `scripts/build-skills.ts`

```typescript
#!/usr/bin/env tsx
/**
 * 금융 스킬 번들링 스크립트
 *
 * packages/skills-finance/dist/ 의 빌드 결과를 스킬별 독립 번들로 패키징.
 * 각 스킬을 개별적으로 배포/설치할 수 있게 한다.
 *
 * 사전 조건: pnpm build 완료 (tsc --build로 dist/ 생성)
 *
 * 사용법:
 *   tsx scripts/build-skills.ts                  # 전체 빌드
 *   tsx scripts/build-skills.ts --skill=market   # market만
 *   tsx scripts/build-skills.ts --outdir=out     # 출력 디렉토리 변경
 */
import { readdirSync, existsSync, mkdirSync, cpSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SKILLS_DIST_DIR = resolve('packages/skills-finance/dist');
const DEFAULT_OUT_DIR = resolve('dist/skills');

const SKILL_DIRS = ['market', 'news', 'alerts'] as const;

interface SkillBuildResult {
  name: string;
  files: number;
  success: boolean;
  error?: string;
}

function countFiles(dir: string): number {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile())
      .length;
  } catch {
    return 0;
  }
}

function buildSkills(options: { skillFilter?: string; outDir?: string }): void {
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;

  if (!existsSync(SKILLS_DIST_DIR)) {
    console.error(`Error: ${SKILLS_DIST_DIR} does not exist. Run 'pnpm build' first.`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });

  const targets = SKILL_DIRS.filter((d) => !options.skillFilter || d === options.skillFilter);

  if (targets.length === 0) {
    console.error(`No matching skill: ${options.skillFilter}`);
    process.exit(1);
  }

  console.log(`Building ${targets.length} skill(s)...`);

  const results: SkillBuildResult[] = [];

  for (const name of targets) {
    const srcDir = join(SKILLS_DIST_DIR, name);
    const destDir = join(outDir, name);

    try {
      if (!existsSync(srcDir)) {
        throw new Error(`Compiled output not found: ${srcDir}`);
      }

      mkdirSync(destDir, { recursive: true });
      cpSync(srcDir, destDir, { recursive: true });

      // 스킬 메타데이터 생성
      const meta = {
        name,
        builtAt: new Date().toISOString(),
        source: '@finclaw/skills-finance',
      };
      writeFileSync(join(destDir, 'skill.meta.json'), JSON.stringify(meta, null, 2) + '\n');

      const fileCount = countFiles(destDir);
      results.push({ name, files: fileCount, success: true });
      console.log(`  [OK] ${name} (${fileCount} files)`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({ name, files: 0, success: false, error: msg });
      console.error(`  [FAIL] ${name}: ${msg}`);
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  console.log(`\nBuild complete: ${succeeded} succeeded, ${failed} failed`);

  if (failed > 0) process.exit(1);
}

// CLI 파싱
const args = process.argv.slice(2);
const skillFilter = args.find((a) => a.startsWith('--skill='))?.split('=')[1];
const outDir = args.find((a) => a.startsWith('--outdir='))?.split('=')[1];

buildSkills({ skillFilter, outDir });
```

#### `packages/channel-discord/package.json` (수정)

```diff
-    "zod": "^3.25.0"
+    "zod": "^4.0.0"
```

**변경 후 필수 작업:**

1. `pnpm install` → lockfile 갱신
2. channel-discord 코드의 zod import 경로 확인 — Zod v4에서는 `import { z } from 'zod/v4'` 패턴 사용 가능. 기존 코드가 `import { z } from 'zod'`라면 Zod v4의 compat 모드로 동작하므로 대부분 호환됨.

### 검증

```bash
# 1. 스킬 빌드
pnpm build
tsx scripts/build-skills.ts
ls dist/skills/
# → market/ news/ alerts/ 각 디렉토리 존재

# 2. 특정 스킬만 빌드
tsx scripts/build-skills.ts --skill=market
cat dist/skills/market/skill.meta.json

# 3. zod 업그레이드
pnpm install
pnpm typecheck  # channel-discord 타입 에러 없음

# 4. 의존성 일치 확인
tsx scripts/check-dep-versions.ts
# → All dependency versions are consistent.
```

---

## 최종 검증 체크리스트

| #   | 검증 항목                                       | 방법                         | 상태 |
| --- | ----------------------------------------------- | ---------------------------- | ---- |
| 1   | 플러그인 매니페스트 `PluginManifestSchema` 통과 | parseManifest(template json) | ☐    |
| 2   | 플러그인 `register(api)` 정상 실행              | createPluginBuildApi로 검증  | ☐    |
| 3   | `write-build-info.ts` → build-info.json 생성    | 스크립트 실행 후 파일 확인   | ☐    |
| 4   | `calver.ts` → `vYYYY.M.D` 형식 출력             | 날짜 기반 출력 검증          | ☐    |
| 5   | `check-dep-versions.ts` 불일치 검출             | zod 불일치 시나리오          | ☐    |
| 6   | health.ts → build-info.json 버전 로드           | loadVersion() 호출 확인      | ☐    |
| 7   | health.ts fallback → `'0.0.0-dev'`              | 파일 없는 환경               | ☐    |
| 8   | `'0.1.0'` 하드코딩 0건                          | grep 확인                    | ☐    |
| 9   | release.yml YAML 유효                           | actionlint 또는 수동         | ☐    |
| 10  | dependabot.yml 유효                             | GitHub UI 확인               | ☐    |
| 11  | Dockerfile HEALTHCHECK 유효                     | docker build + inspect       | ☐    |
| 12  | 스킬 빌드 성공                                  | tsx scripts/build-skills.ts  | ☐    |
| 13  | zod 버전 일치                                   | check-dep-versions.ts 통과   | ☐    |
| 14  | `pnpm build` 성공                               | 전체 빌드                    | ☐    |
| 15  | `pnpm typecheck` 성공                           | 전체 타입 체크               | ☐    |
