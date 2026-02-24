# Phase 0: 개발환경 스캐폴딩

## 1. 목표

FinClaw 프로젝트의 개발환경을 구축한다. 빌드, 테스트, 린트, 포매팅 인프라를 세팅하고, 이후 Phase 1~20이 의존하는 기반을 확립한다.

Phase 0의 핵심 원칙:

- **코드 없이 인프라만**: `src/` 디렉토리는 빈 스캐폴딩, 비즈니스 로직 없음
- **4-tier 테스트**: unit / storage / e2e / live 분리
- **Rust 기반 도구**: oxlint(린트) + oxfmt(포매팅) -- ESLint/Prettier 대비 10~100x 빠름
- **Node.js 22+ 전용**: `node:sqlite` 내장 모듈 활용, 네이티브 애드온 불필요
- **Docker 스캐폴딩**: Dockerfile, docker-compose.yml, .dockerignore, CI/CD 배포 워크플로우,
  빌드 헬퍼 스크립트를 초기에 구성하여 개발 초기부터 컨테이너 기반 개발/배포 가능

## 2. OpenClaw 참조

| 참조 문서                                             | 적용 내용                                            |
| ----------------------------------------------------- | ---------------------------------------------------- |
| `openclaw/ARCHITECTURE.md` Phase 0                    | 스캐폴딩 구조, 디렉토리 레이아웃, vitest 4-tier 패턴 |
| `openclaw_review/deep-dive/20-skills-docs-scripts.md` | 빌드 스크립트, 테스트 오케스트레이션, CI 구조        |

**OpenClaw Phase 0과의 차이:**

| 항목        | OpenClaw                | FinClaw                   | 이유                            |
| ----------- | ----------------------- | ------------------------- | ------------------------------- |
| 패키지 구조 | pnpm 모노레포 7+ 패키지 | 단일 패키지 + extensions/ | 초기 복잡도 최소화              |
| 린트        | ESLint + Prettier       | oxlint + oxfmt            | 속도 우선, 설정 간결            |
| 타입체크    | tsc --noEmit            | tsgo --noEmit             | @typescript/native-preview 활용 |
| 포매터      | Prettier                | oxfmt                     | Rust 기반, 빠른 포매팅          |

## 3. 생성할 파일

### 완료된 파일 (현재 상태)

```
프로젝트 루트/
├── package.json                    -- ESM, Node 22+, pnpm 10.4.1, 18개 스크립트
├── tsconfig.json                   -- ES2023, NodeNext, strict, declaration maps
├── pnpm-workspace.yaml             -- extensions/* 워크스페이스
├── pnpm-lock.yaml                  -- 의존성 잠금 (v9.0)
├── .npmrc                          -- shamefully-hoist=false
├── .gitignore                      -- node_modules, dist, .env, data/, *.db, *.log
├── .env.example                    -- 환경변수 템플릿 (7개 키)
├── oxlintrc.json                   -- 린트 규칙 (correctness/perf/suspicious = error)
├── .oxfmtrc.json                   -- 포매팅 (single quote, sorted imports)
├── CLAUDE.md                       -- AI 코딩 가이드라인 (Karpathy 4원칙)
├── README.md                       -- (빈 파일 → 보강 대상)
│
├── vitest.config.ts                -- 메인 유닛 테스트 (forks 풀, V8 커버리지 70%)
├── vitest.storage.config.ts        -- 스토리지 테스트 (단일 워커, 30s 타임아웃)
├── vitest.e2e.config.ts            -- E2E 테스트 (2~4 워커, 120s 타임아웃)
├── vitest.live.config.ts           -- 라이브 API 테스트 (단일 워커, 60s)
│
├── scripts/
│   └── test-parallel.mjs           -- 2-phase 테스트 오케스트레이터
│
├── src/
│   ├── index.ts                    -- 메인 exports (스텁)
│   ├── entry.ts                    -- 진입점 (스텁)
│   ├── agents/                     -- (빈 디렉토리)
│   ├── channels/                   -- (빈 디렉토리)
│   ├── config/                     -- (빈 디렉토리)
│   ├── plugins/                    -- (빈 디렉토리)
│   ├── skills/                     -- (빈 디렉토리)
│   ├── storage/                    -- (빈 디렉토리)
│   └── types/                      -- (빈 디렉토리)
│
└── test/
    ├── setup.ts                    -- 글로벌 셋업 (환경 격리 + mock 리셋)
    ├── test-env.ts                 -- 민감 환경변수 격리 (6개 키 샌드박싱)
    ├── sample.test.ts              -- 검증용 샘플 테스트 (1+1=2)
    └── helpers/
        ├── test-db.ts              -- 임시 SQLite DB 생성/정리
        └── poll.ts                 -- 비동기 폴링 유틸리티 (5s 타임아웃)
```

### 보강 대상 파일

```
프로젝트 루트/
├── .editorconfig                   -- 신규: 에디터 설정 통일
├── .node-version                   -- 신규: Node.js 버전 고정 (fnm/nvm/GitHub Actions 자동 감지)
├── lefthook.yml                    -- 신규: Git Hooks (pre-commit, commit-msg)
├── .github/workflows/ci.yml       -- 신규: CI 파이프라인
├── README.md                       -- 보강: 프로젝트 소개 + 개발환경 가이드
└── .gitignore                      -- 보강: IDE/OS 파일 + coverage/, *.lcov, .lefthook-local/
```

### Docker & CI/CD 배포 파일 (5개)

| #   | 파일 경로                    | 설명                                                   | 예상 LOC |
| --- | ---------------------------- | ------------------------------------------------------ | -------- |
| 1   | Dockerfile                   | 멀티 스테이지 빌드 스캐폴드 (이후 Phase에서 점진 보강) | ~45      |
| 2   | docker-compose.yml           | FinClaw 서비스 구성 (최소 scaffold)                    | ~25      |
| 3   | .dockerignore                | Docker 빌드 제외 파일 목록                             | ~20      |
| 4   | .github/workflows/deploy.yml | Docker 이미지 빌드 + ghcr.io push (amd64/arm64)        | ~80      |
| 5   | scripts/build-docker.sh      | 로컬 Docker 빌드 헬퍼 스크립트                         | ~15      |

## 4. 핵심 인터페이스/타입

Phase 0에는 비즈니스 타입이 없다. 테스트 인프라 타입만 존재:

```typescript
// test/test-env.ts -- 환경 격리
interface EnvSnapshot {
  vars: Record<string, string | undefined>;
  tmpDir: string;
}

// 격리 대상 환경변수 (6개)
const SENSITIVE_KEYS = [
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'CLAUDE_API_KEY',
  'ANTHROPIC_API_KEY',
  'DATABASE_URL',
  'NODE_OPTIONS',
] as const;

// test/helpers/test-db.ts -- 임시 DB
interface TestDb {
  db: DatabaseSync; // node:sqlite (Node.js 22+)
  path: string;
  cleanup: () => void;
}

// test/helpers/poll.ts -- 비동기 폴링
interface PollOptions {
  timeout?: number; // 기본 5,000ms
  interval?: number; // 기본 100ms
}
```

## 5. 구현 상세

### 5.1 패키지 매니저 & 모듈 시스템

```jsonc
// package.json 핵심 설정
{
  "type": "module", // ESM 전용
  "engines": { "node": ">=22.0.0" }, // node:sqlite 내장
  "packageManager": "pnpm@10.4.1", // corepack 호환
  "pnpm": {
    "onlyBuiltDependencies": ["esbuild"], // 네이티브 빌드 허용 목록
  },
}
```

`shamefully-hoist=false` (.npmrc) -- pnpm의 엄격한 node_modules 구조 유지. 유령 의존성(phantom dependency) 방지.

**버전 고정 전략:**

| 메커니즘              | 대상           | 효과                                            |
| --------------------- | -------------- | ----------------------------------------------- |
| `.node-version`       | Node.js 런타임 | fnm, nvm, GitHub Actions `setup-node` 자동 감지 |
| `packageManager` 필드 | pnpm           | corepack이 정확한 pnpm 버전 보장                |
| `pnpm-lock.yaml`      | 전체 의존성    | 재현 가능한 빌드                                |

**공급망 보안 — `minimumReleaseAge`:**

```yaml
# pnpm-workspace.yaml (기존 설정에 추가)
packages:
  - 'packages/*'

# pnpm 10.16+: 최소 릴리스 경과 시간 미달 패키지 설치 차단
# Zero-day 공급망 공격 방어 (10080분 = 7일)
minimumReleaseAge: 10080
```

- 값은 **분 단위 정수** (`.npmrc`의 문자열 형식이 아님)
- 패키지별 예외: `minimumReleaseAgeExclude` 사용

### 5.2 TypeScript 설정

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "es2023", // 최신 JS 문법 (top-level await, Array.at 등)
    "module": "NodeNext", // ESM + .js 확장자 강제
    "moduleResolution": "NodeNext",
    "types": ["node"], // @types/node 전역 등록 (fetch, sqlite, crypto)
    "strict": true, // 전체 strict 모드
    "declaration": true, // .d.ts 생성
    "declarationMap": true, // .d.ts.map (Go-to-definition 지원)
    "sourceMap": true, // .js.map (디버깅)
  },
}
```

**타입체크 이원화:**

- `pnpm build` = `tsc` (TypeScript 5.x) -- 실제 빌드 (dist/ 출력). 안정성 우선.
- `pnpm typecheck` = `tsgo --noEmit` (TypeScript 7.0) -- 빠른 타입체크 전용. 7~10x 빠름.

**TypeScript 7.0 (Project Corsa) 구현 주의사항:**

- `tsgo`는 **`--noEmit` 전용**으로 사용. JS emit 파이프라인 미완성 (downlevel은 es2021까지만, 데코레이터 미지원).
- emit이 안정화되면 `pnpm build`도 전환 검토.

**FinClaw에 영향 없는 Breaking Changes 4개:**

| Breaking Change            | FinClaw 영향 없는 이유 |
| -------------------------- | ---------------------- |
| `strict: true` 기본값 전환 | 이미 strict 사용 중    |
| ES5 target 제거            | ES2023 사용 중         |
| AMD/UMD/SystemJS 제거      | NodeNext 사용 중       |
| classic 모듈 해석 제거     | NodeNext 사용 중       |

### 5.3 4-Tier 테스트 아키텍처

```
┌──────────────────────────────────────────────────┐
│ vitest.config.ts (메인 유닛)                      │
│  include: src/**/*.test.ts, test/**/*.test.ts    │
│  exclude: *.storage.*, *.e2e.*, *.live.*         │
│  pool: forks, workers: 4~16                      │
│  coverage: V8, 70% threshold                     │
├──────────────────────────────────────────────────┤
│ vitest.storage.config.ts (DB 테스트)              │
│  include: **/*.storage.test.ts                   │
│  workers: 1 (순차 실행, DB 충돌 방지)              │
│  timeout: 30s                                    │
├──────────────────────────────────────────────────┤
│ vitest.e2e.config.ts (통합 테스트)                │
│  include: **/*.e2e.test.ts                       │
│  workers: 2~4, timeout: 120s                     │
│  Docker, 실제 API 연동                            │
├──────────────────────────────────────────────────┤
│ vitest.live.config.ts (라이브 API)                │
│  include: **/*.live.test.ts                      │
│  workers: 1 (순차), timeout: 60s                  │
│  실제 자격증명 필요                                │
└──────────────────────────────────────────────────┘
```

**테스트 오케스트레이션** (`scripts/test-parallel.mjs`):

```
pnpm test:ci         →  Phase 1: unit + storage (병렬)
pnpm test:all        →  Phase 1 + Phase 2: e2e (순차 추가)
```

- `FINCLAW_TEST_WORKERS` 환경변수로 워커 수 오버라이드 가능
- SIGINT/SIGTERM 시그널 핸들링으로 자식 프로세스 정리
- 각 단계별 소요 시간 측정 + PASS/FAIL 요약 출력
- `--disable-warning=ExperimentalWarning` 플래그로 `node:sqlite` 실험적 경고 억제

**Vitest 4 구체 설정:**

- `pool: 'forks'` -- 프로세스 격리로 `node:sqlite` 안전 사용
- V8 커버리지 -- Istanbul 대비 빠르고 정확
- `hookTimeout`: Windows 환경 60s / 기타 30s (WSL2 크로스 파일시스템 지연 대응)

### 5.4 테스트 환경 격리

```
beforeAll → isolateEnv()
  ├── 민감 환경변수 6개 스냅샷 후 삭제
  ├── 임시 디렉토리 생성 (/tmp/finclaw-test-xxxx)
  ├── HOME = tmpDir (설정 파일 격리)
  ├── DB_PATH = tmpDir/test.db
  └── NODE_ENV = 'test'

afterEach → vi.useRealTimers() + vi.restoreAllMocks()

afterAll → restoreEnv()
  ├── 원본 환경변수 복원
  └── 임시 디렉토리 삭제 (best-effort)
```

### 5.5 린트 & 포매팅

**oxlint** (Rust 기반, ESLint 호환):

- 플러그인: `typescript`, `unicorn`, `oxc`
- 에러 카테고리: `correctness`, `perf`, `suspicious`
- 커스텀 규칙: `curly: error`, `no-explicit-any: error`, `no-non-null-assertion: error`
- 비활성화: `no-await-in-loop` (의도적 순차 루프), `consistent-function-scoping` (도우미 함수 유연성)

**oxfmt** (Rust 기반, Prettier 호환):

- 작은따옴표 사용 (`singleQuote: true`)
- import 자동 정렬 (`experimentalSortImports`)
- package.json scripts 자동 정렬 (`experimentalSortPackageJson`)

### 5.6 디렉토리 구조 설계 근거

```
src/
├── types/       ← Phase 1에서 채워짐 (전체 타입 계약)
├── config/      ← Phase 3
├── agents/      ← Phase 6~7
├── channels/    ← Phase 5, 12
├── plugins/     ← Phase 5
├── skills/      ← Phase 16~18
└── storage/     ← Phase 14
```

모든 디렉토리를 미리 생성해두어 Phase 순서에 관계없이 파일을 추가할 수 있다. 빈 디렉토리는 git에서 추적되지 않으므로, Phase 1부터 파일이 생기면 자연스럽게 커밋된다.

### 5.7 Dockerfile (스캐폴드)

`node:22-bookworm-slim` 멀티 스테이지 빌드. 7개 워크스페이스 패키지의 package.json을 개별 COPY하여 레이어 캐싱을 최적화한다. 아직 존재하지 않는 기능(웹 UI 빌드, 금융 스킬 복사, /health 엔드포인트)은 `TODO` 주석으로 표시하고, 이후 Phase에서 점진적으로 보강한다.

```dockerfile
# Dockerfile (Phase 0 scaffold)

# ── Stage 1: Builder ──
FROM node:22-bookworm-slim AS builder

RUN corepack enable

WORKDIR /app

# 의존성 캐시 레이어 — 각 패키지 package.json을 개별 COPY
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/types/package.json ./packages/types/
COPY packages/config/package.json ./packages/config/
COPY packages/storage/package.json ./packages/storage/
COPY packages/agent/package.json ./packages/agent/
COPY packages/channel-discord/package.json ./packages/channel-discord/
COPY packages/skills-finance/package.json ./packages/skills-finance/
COPY packages/server/package.json ./packages/server/

RUN pnpm install --frozen-lockfile

# 소스 복사 및 빌드
COPY tsconfig.json tsconfig.base.json ./
COPY packages/ ./packages/

RUN pnpm build

# TODO (Phase 19): 웹 UI 빌드 추가
# RUN pnpm --filter @finclaw/server ui:build

# 프로덕션 의존성만 재설치
RUN pnpm install --frozen-lockfile --prod

# ── Stage 2: Runner ──
FROM node:22-bookworm-slim AS runner

RUN corepack enable

WORKDIR /app

# 보안: non-root 사용자
USER node

# builder에서 필요한 파일만 복사
COPY --from=builder --chown=node:node /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder --chown=node:node /app/node_modules/ ./node_modules/
COPY --from=builder --chown=node:node /app/packages/ ./packages/

# TODO (Phase 16-18): 스킬 파일 복사
# COPY --chown=node:node skills/ ./skills/

ENV NODE_ENV=production
ENV FINCLAW_HOST=0.0.0.0
ENV FINCLAW_PORT=3000

EXPOSE 3000

# TODO (Phase 11): /health 엔드포인트 구현 후 활성화
# HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
#   CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "packages/server/dist/main.js"]
```

### 5.8 docker-compose.yml (스캐폴드)

core app 서비스만 정의. 아직 사용되지 않는 환경변수는 `TODO` 주석으로 표시한다.

```yaml
# docker-compose.yml (Phase 0 scaffold)

services:
  finclaw:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: finclaw
    restart: unless-stopped
    init: true
    ports:
      - '${FINCLAW_PORT:-3000}:3000'
    environment:
      - NODE_ENV=production
      - FINCLAW_HOST=0.0.0.0
      - FINCLAW_PORT=3000
      # TODO (Phase 6): AI 프로바이더
      # - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      # TODO (Phase 12): Discord
      # - DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN:-}
      # TODO (Phase 16): 금융 데이터
      # - ALPHA_VANTAGE_KEY=${ALPHA_VANTAGE_KEY:-}
      - FINCLAW_DATA_DIR=/data
    volumes:
      - finclaw-data:/data

volumes:
  finclaw-data:
    driver: local
```

### 5.9 .dockerignore

제외 규칙은 Phase 무관하게 안정적이므로 최종 버전으로 작성한다.

```
node_modules
dist
.git
.env
.env.*
!.env.example
*.log
data/
*.db
coverage/
.vscode/
.idea/
*.tgz
plans/
test/
**/*.test.ts
**/*.spec.ts
vitest.*.config.ts
CLAUDE.md
README.md
```

### 5.10 deploy.yml

GitHub Actions 배포 워크플로우. 순수 인프라이므로 앱 기능과 무관하게 Phase 0에서 그대로 사용한다. amd64/arm64 멀티 플랫폼 빌드 후 ghcr.io에 push한다. 구현은 Phase 20 plan의 5.4절 deploy.yml과 동일하다.

### 5.11 build-docker.sh

로컬 Docker 빌드를 간편하게 수행하는 래퍼 스크립트.

```bash
#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${1:-finclaw}"
TAG="${2:-dev}"

echo "Building ${IMAGE_NAME}:${TAG} ..."
docker build -t "${IMAGE_NAME}:${TAG}" .
echo "Done. Run with: docker run -p 3000:3000 ${IMAGE_NAME}:${TAG}"
```

### 5.12 Git Hooks — lefthook

lefthook (Go 바이너리)로 pre-commit, commit-msg 훅을 관리한다.

**lefthook vs husky+lint-staged:**

| 비교             | husky + lint-staged               | lefthook                     |
| ---------------- | --------------------------------- | ---------------------------- |
| 런타임           | Node.js 필요                      | Go 바이너리 (런타임 불필요)  |
| 설정             | `.husky/` + `.lintstagedrc` (2곳) | `lefthook.yml` 단일 파일     |
| 병렬 실행        | 불가 (순차)                       | 네이티브 병렬                |
| staged 파일 필터 | lint-staged 별도 필요             | `{staged_files}` 템플릿 내장 |
| npm 의존성       | 2개                               | 1개                          |

**lefthook.yml 전체 명세:**

```yaml
# lefthook.yml
pre-commit:
  parallel: true
  commands:
    lint:
      glob: '*.{ts,mts,js,mjs}'
      run: npx oxlint --config oxlintrc.json {staged_files}
    format-check:
      glob: '*.{ts,mts,js,mjs,json,yaml,yml,md}'
      run: npx oxfmt --check {staged_files}
    typecheck:
      run: npx tsgo --noEmit

commit-msg:
  commands:
    conventional:
      run: |
        MSG=$(head -1 "$1")
        if ! echo "$MSG" | grep -qE '^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?: .{1,}'; then
          echo "ERROR: Commit message must follow Conventional Commits format"
          echo "  e.g., feat(agent): add tool registration"
          echo "  e.g., fix: resolve sqlite connection leak"
          exit 1
        fi
```

**설계 결정:**

- `pre-commit`에서 `oxfmt --check` (검사만, 자동 수정 아님). 부분적으로 staged된 파일이 auto-fix로 의도치 않게 변경될 수 있으므로 개발자가 `pnpm format:fix` 후 re-stage.
- `commit-msg`에서 인라인 regex 사용 (commitlint 미설치). `@commitlint/cli` + `@commitlint/config-conventional` 3개 의존성 절약. 팀 규모 확대 시 commitlint로 전환.

**package.json 변경:**

```jsonc
{
  "scripts": {
    "prepare": "lefthook install", // pnpm install 시 Git hooks 자동 설치
  },
  "devDependencies": {
    "lefthook": "^2.1.0",
  },
}
```

**동작 흐름:**

```
git commit -m "feat(config): add Zod schema"
  │
  ├── pre-commit (parallel)
  │   ├── oxlint → staged .ts/.js 파일 린트 검사
  │   ├── oxfmt --check → staged 파일 포맷 검사
  │   └── tsgo --noEmit → 전체 타입체크
  │   → 하나라도 실패 시 커밋 중단
  │
  └── commit-msg
      └── regex 검증 → Conventional Commits 위반 시 커밋 중단 + 올바른 형식 안내
```

### 5.13 Conventional Commits 규약

**형식:**

```
<type>(<optional scope>): <description>

[optional body]

[optional footer(s)]
```

**허용 타입 (11개):**

| 타입       | 설명                         | 예시                                         |
| ---------- | ---------------------------- | -------------------------------------------- |
| `feat`     | 새 기능                      | `feat(agent): add Claude API integration`    |
| `fix`      | 버그 수정                    | `fix(storage): resolve sqlite WAL lock`      |
| `docs`     | 문서                         | `docs: update README with setup guide`       |
| `style`    | 코드 스타일 (동작 변경 없음) | `style: apply oxfmt formatting`              |
| `refactor` | 리팩토링 (기능 변경 없음)    | `refactor(config): extract validation logic` |
| `perf`     | 성능 개선                    | `perf(query): add index for alert lookup`    |
| `test`     | 테스트 추가/수정             | `test(storage): add WAL mode verification`   |
| `build`    | 빌드 시스템                  | `build: upgrade TypeScript to 5.9.3`         |
| `ci`       | CI 설정                      | `ci: add coverage threshold check`           |
| `chore`    | 기타 유지보수                | `chore: update pnpm to 10.4.1`               |
| `revert`   | 커밋 되돌리기                | `revert: feat(agent): add tool registration` |

**스코프 (선택):** `agent`, `channel`, `config`, `plugin`, `skill`, `storage`, `types`, `ci`, `deps`

### 5.14 GitHub Actions CI

**ci.yml 전체 명세:**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  quality:
    name: Quality Gate
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        # packageManager 필드에서 pnpm 버전 자동 감지

      - uses: actions/setup-node@v4
        with:
          node-version-file: '.node-version'
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile

      - name: Lint
        run: pnpm lint

      - name: Format Check
        run: pnpm format

      - name: Type Check
        run: pnpm typecheck

      - name: Build
        run: pnpm build

      - name: Test (CI)
        run: pnpm test:ci
```

**CI 설계 결정:**

| 결정                                 | 근거                                                              |
| ------------------------------------ | ----------------------------------------------------------------- |
| `pnpm/action-setup@v4` 우선 실행     | pnpm 스토어 감지를 위해 setup-node보다 먼저 설치 (공식 권장 순서) |
| `cache: 'pnpm'`                      | pnpm 스토어 캐싱으로 install 시간 60~80% 단축                     |
| `--frozen-lockfile`                  | CI에서 lockfile 변경 방지 → 재현 가능한 빌드                      |
| `node-version-file`                  | `.node-version` 파일로 로컬/CI 버전 동기화                        |
| `concurrency` + `cancel-in-progress` | 같은 PR에 새 push 시 이전 CI 취소 → 리소스 절약                   |
| `timeout-minutes: 10`                | Phase 0 규모에 충분 (프로젝트 성장 시 조정)                       |
| 단일 워크플로우 / 단일 Job           | 현재 규모에서 Job 분리는 checkout+install 반복으로 비효율적       |

**Phase별 확장 계획:**

- Phase 5+: `pnpm test:e2e` 단계 추가
- Phase 12+: Windows 매트릭스 추가 (`runs-on: windows-latest`)
- 릴리스 단계: Docker 빌드 + 배포 워크플로우 추가

## 6. 선행 조건

없음. Phase 0는 최초 단계.

**전제 조건 (개발자 환경):**

- Node.js >= 22.0.0
- pnpm >= 10.4.1 (corepack enable로 활성화)
- Git
- Docker (선택사항 -- Docker 빌드 검증 시 필요)

## 7. 산출물 및 검증

### 완료 기준 체크리스트

| #   | 검증 항목       | 명령어                          | 기대 결과               |
| --- | --------------- | ------------------------------- | ----------------------- |
| 1   | 의존성 설치     | `pnpm install`                  | 에러 없이 완료          |
| 2   | 빌드            | `pnpm build`                    | `dist/` 생성, 에러 없음 |
| 3   | 타입체크        | `pnpm typecheck`                | 에러 없음               |
| 4   | 린트            | `pnpm lint`                     | 에러 없음               |
| 5   | 포매팅          | `pnpm format`                   | 위반 없음               |
| 6   | 유닛 테스트     | `pnpm test`                     | sample.test.ts 통과     |
| 7   | 스토리지 테스트 | `pnpm test:storage`             | 통과 (테스트 없어도 OK) |
| 8   | E2E 테스트      | `pnpm test:e2e`                 | 통과 (테스트 없어도 OK) |
| 9   | CI 테스트       | `pnpm test:ci`                  | Phase 1+2 모두 PASS     |
| 10  | 개발 서버       | `pnpm dev`                      | 에러 없이 시작          |
| 11  | Docker 빌드     | `docker build -t finclaw:dev .` | 이미지 빌드 성공        |
| 12  | Docker 실행     | `docker run finclaw:dev`        | 컨테이너 시작 확인      |
| 13  | deploy.yml 검증 | actionlint                      | YAML 문법 유효          |

### 보강 산출물

| #   | 파일                | 검증 방법                                   |
| --- | ------------------- | ------------------------------------------- |
| 1   | `.editorconfig`     | 에디터에서 탭/스페이스/줄끝 자동 적용 확인  |
| 2   | `README.md`         | 새 개발자가 README만 보고 환경 세팅 가능    |
| 3   | `.gitignore` 보강   | `.vscode/`, `.DS_Store` 등 무시 확인        |
| 4   | lefthook pre-commit | 린트 에러 파일 스테이지 후 커밋 → 거부 확인 |
| 5   | lefthook commit-msg | `git commit -m "bad"` → 거부 확인           |
| 6   | `.node-version`     | `node -v` 출력과 파일 내용 일치             |
| 7   | `ci.yml`            | GitHub PR 생성 → Actions 실행+통과          |

## 8. 복잡도 및 예상 파일 수

| 항목                  | 값                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| 복잡도                | S (스캐폴딩, 비즈니스 로직 없음)                                                                |
| 완료된 파일           | 설정 8 + vitest 4 + 스크립트 1 + 소스 스텁 2 + 테스트 5 = **20 파일**                           |
| 보강 파일             | .editorconfig + README.md + .gitignore 보강 = **3 파일**                                        |
| devDependencies       | 7개 (typescript, tsx, vitest, oxlint, oxfmt, @types/node, @typescript/native-preview)           |
| 프로덕션 dependencies | 0개 (Phase 0에서는 런타임 의존성 없음)                                                          |
| Docker/CI 파일        | Dockerfile + docker-compose.yml + .dockerignore + deploy.yml + build-docker.sh = 5개 (~185 LOC) |

---

## 부록 A: 설정 파일 상세 레퍼런스

### package.json 스크립트 전체 목록

| 스크립트        | 명령어                                         | 용도                           |
| --------------- | ---------------------------------------------- | ------------------------------ |
| `build`         | `tsc`                                          | TypeScript → JavaScript 컴파일 |
| `dev`           | `tsx src/entry.ts`                             | 개발 서버 (핫 리로드)          |
| `typecheck`     | `tsgo --noEmit`                                | 빠른 타입체크 전용             |
| `lint`          | `oxlint --config oxlintrc.json .`              | 린트 검사                      |
| `format`        | `oxfmt --check .`                              | 포매팅 검사                    |
| `format:fix`    | `oxfmt --write .`                              | 포매팅 자동 수정               |
| `test`          | `vitest run`                                   | 유닛 테스트                    |
| `test:storage`  | `vitest run --config vitest.storage.config.ts` | 스토리지 테스트                |
| `test:e2e`      | `vitest run --config vitest.e2e.config.ts`     | E2E 테스트                     |
| `test:live`     | `vitest run --config vitest.live.config.ts`    | 라이브 API 테스트              |
| `test:all`      | `node scripts/test-parallel.mjs --all`         | 전체 테스트 (unit+storage+e2e) |
| `test:ci`       | `node scripts/test-parallel.mjs`               | CI용 테스트 (unit+storage)     |
| `test:coverage` | `vitest run --coverage`                        | 커버리지 리포트                |
| `test:watch`    | `vitest`                                       | 파일 변경 감시 모드            |

### 환경변수 (.env.example)

| 변수                      | 필수     | Phase                                      | 설명 |
| ------------------------- | -------- | ------------------------------------------ | ---- |
| `DISCORD_TOKEN`           | Phase 12 | Discord 봇 토큰                            |
| `DISCORD_CLIENT_ID`       | Phase 12 | Discord 앱 클라이언트 ID                   |
| `CLAUDE_API_KEY`          | Phase 6  | Anthropic Claude API 키                    |
| `ALPHA_VANTAGE_KEY`       | Phase 16 | 주식/외환 데이터 API                       |
| `COINGECKO_API_KEY`       | Phase 16 | 암호화폐 데이터 API                        |
| `NEWS_API_KEY`            | Phase 17 | 뉴스 데이터 API                            |
| `DB_PATH`                 | Phase 14 | SQLite DB 경로 (기본: `./data/finclaw.db`) |
| `ALERT_CHECK_INTERVAL_MS` | Phase 18 | 알림 체크 주기 (기본: 60000ms)             |

---

## 부록 B: 기술 버전 스냅샷

### 도구 버전 테이블

| 도구       | package.json 범위       | 최신 버전 | 상태                          | 비고                                |
| ---------- | ----------------------- | --------- | ----------------------------- | ----------------------------------- |
| Node.js    | >=22.0.0                | 22.20.0   | Maintenance LTS (EOL 2027.04) | `node:sqlite` experimental 내장     |
| TypeScript | ^5.9.3                  | 5.9.3     | Stable                        | TS 6 beta (2026.02), 마지막 JS 기반 |
| tsgo       | 7.0.0-dev.20260209.1    | 7.0.0     | Stable (2026.01.15)           | npm: `@typescript/native-preview`   |
| pnpm       | 10.4.1 (packageManager) | 10.30+    | Stable                        | minimumReleaseAge (10.16+)          |
| Vitest     | ^4.0.18                 | 4.0.18    | Stable                        | Browser Mode 안정화, V8 커버리지    |
| oxlint     | ^1.43.0                 | 1.49+     | Stable (v1 GA, 2025.06)       | 695+ 규칙, type-aware alpha         |
| oxfmt      | ^0.28.0                 | 0.35.0    | Alpha                         | beta 예상 2026 중반                 |
| lefthook   | ^2.1.0 (추가 예정)      | 2.1.1     | Stable                        | Go 바이너리, 병렬 실행              |
| tsx        | ^4.21.0                 | 4.21+     | Stable                        | dev 서버용                          |

### 기술 결정 로그

| #    | 결정          | 채택                      | 보류 대안         | 근거                                       | 재검토 시점               |
| ---- | ------------- | ------------------------- | ----------------- | ------------------------------------------ | ------------------------- |
| D-01 | 패키지 매니저 | pnpm 10                   | npm, yarn, bun    | 엄격한 deps, 워크스페이스, 보안 기본값     | --                        |
| D-02 | 린터          | oxlint                    | ESLint, Biome     | 50~100x 속도, ESLint 호환, VoidZero 생태계 | --                        |
| D-03 | 포매터        | oxfmt (alpha)             | Prettier, Biome   | 30x 속도, oxlint과 동일 생태계             | **oxfmt beta 릴리스 시**  |
| D-04 | 타입체크      | tsgo (TS 7.0)             | tsc --noEmit      | 7~10x 빠름, 2026.01 stable, emit 미완성    | **emit 안정화 시**        |
| D-05 | 테스트        | Vitest 4                  | Jest              | ESM 네이티브, 빠른 HMR, V8 커버리지        | --                        |
| D-06 | Git hooks     | lefthook                  | husky+lint-staged | Go 바이너리, 병렬 실행, npm 1개 의존성     | --                        |
| D-07 | 커밋 검증     | 인라인 regex              | commitlint        | 의존성 3개 절약, 기본 검증에 충분          | **팀 규모 확대 시**       |
| D-08 | 버전 고정     | .node-version + corepack  | mise (.mise.toml) | 범용, 추가 도구 불필요                     | **팀 규모 확대 시**       |
| D-09 | CI            | GitHub Actions (단일 Job) | CircleCI          | 무료, GitHub 네이티브, 공식 pnpm Action    | **Phase 5+ e2e Job 추가** |
| D-10 | 모노레포 도구 | pnpm 워크스페이스         | Turborepo, Nx     | 7개 패키지 규모에 pnpm 네이티브로 충분     | **패키지 10+ 시**         |

### 업그레이드 감시 대상

- `oxfmt` → beta 전환 시 `experimentalSortImports` → `sortImports` 이름 변경 가능
- `oxlint` → type-aware 린팅이 Stable 되면 Phase 3에서 활성화
- `@typescript/native-preview` → TS 7.0 emit 안정화 시 빌드 경로 전환
- `node:sqlite` → Stability Index 2 (Stable) 시 API 변경 확인

---

## 부록 C: Phase 0 → Phase 1 핸드오프

### Phase 1이 사용할 수 있는 인프라

| 인프라          | 사용 방법                                                     |
| --------------- | ------------------------------------------------------------- |
| TypeScript 빌드 | `pnpm build` → `dist/` 생성                                   |
| 타입체크        | `pnpm typecheck` → tsgo 7~10x 빠른 검사                       |
| 유닛 테스트     | `src/**/*.test.ts` → `pnpm test`                              |
| 스토리지 테스트 | `src/**/*.storage.test.ts` → `pnpm test:storage`              |
| 임시 DB 헬퍼    | `import { createTestDb } from '../test/helpers/test-db.js'`   |
| 비동기 폴링     | `import { poll } from '../test/helpers/poll.js'`              |
| 환경 격리       | `test/setup.ts` 자동 적용 (vitest.config.ts setupFiles)       |
| 린트 + 포매팅   | lefthook이 커밋 전 자동 검증                                  |
| CI              | push/PR 시 lint → format → typecheck → build → test 자동 실행 |
| 커밋 규약       | Conventional Commits 형식 강제 (lefthook commit-msg)          |

### Phase 1에서 추가해야 할 것

| 항목                     | 설명                                        |
| ------------------------ | ------------------------------------------- |
| `packages/types/` 채우기 | 전체 타입 계약 정의 (OpenClaw Phase 1 참조) |
| `test/setup.ts` 확장     | 채널 스텁, 로깅 mock 등 필요 시 추가        |
| `.env.example` 확장      | Phase 1에 필요한 환경변수 추가              |

### Phase 0 완료 조건

| #   | 조건                                | 검증 방법                         |
| --- | ----------------------------------- | --------------------------------- |
| 1   | §7 체크리스트 전체 PASS             | 전수 실행                         |
| 2   | Phase 0 커밋이 `main` 브랜치에 존재 | `git log --oneline -5`            |
| 3   | lefthook 훅 동작                    | 의도적 린트 에러 커밋 → 중단 확인 |
| 4   | Conventional Commits 강제           | `git commit -m "bad"` → 거부 확인 |
| 5   | CI 워크플로우 동작                  | GitHub Actions 탭에서 PASS 확인   |

---

## 부록 D: 미적용 도구 + 도입 시점

| 도구                | 도입 시점             | 도입 조건                              |
| ------------------- | --------------------- | -------------------------------------- |
| oxlint type-aware   | Phase 3 (config + CI) | `tsconfig.json` 통합, 43개 규칙 활성화 |
| Changesets          | Phase 20 (릴리스)     | 패키지 npm 퍼블리싱 시작 시            |
| Renovate/Dependabot | GitHub 레포 생성 후   | 자동 의존성 업데이트                   |
| Docker Compose 확장 | Phase 12+             | 외부 서비스 연동 필요 시               |
| Branch Protection   | 팀 개발 시작 시       | 1+ 리뷰어 필수, CI 통과 필수           |
| commitlint          | 팀 규모 확대 시       | shell regex → commitlint 전환          |
| pnpm catalogs       | 패키지 10+ 시         | 워크스페이스 간 버전 중앙 관리         |
