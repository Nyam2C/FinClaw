# Phase 0 구현 TODO

## 현황

| 상태       | 항목 수                                                    |
| ---------- | ---------------------------------------------------------- |
| 완료       | 20+ 파일 (tsconfig, vitest, oxlint, 패키지 scaffolding 등) |
| **미완료** | **11개 작업** (이 문서의 범위)                             |

---

## 작업 목록 (11개)

### Part A: 기존 파일 수정 (3개)

#### 작업 1. `.node-version` 신규 생성

**목적:** fnm, nvm, GitHub Actions `setup-node`가 자동으로 Node.js 버전을 감지하도록 고정.

**파일:** `.node-version`

```
22.21.1
```

> 단일 줄, 줄바꿈으로 끝남. `.node-version`은 메이저.마이너.패치 전체를 명시한다.

**검증:**

```bash
cat .node-version
# 출력: 22.21.1

node -v
# 출력: v22.21.1 (로컬 환경과 일치해야 함)
```

---

#### 작업 2. `pnpm-workspace.yaml` 수정 — `minimumReleaseAge` 추가

**목적:** Zero-day 공급망 공격 방어. 릴리스 후 7일 미만인 패키지 설치를 차단한다 (pnpm 10.16+).

**파일:** `pnpm-workspace.yaml`

**현재:**

```yaml
packages:
  - 'packages/*'
```

**변경 후:**

```yaml
packages:
  - 'packages/*'

# pnpm 10.16+: 최소 릴리스 경과 시간 미달 패키지 설치 차단
# Zero-day 공급망 공격 방어 (10080분 = 7일)
minimumReleaseAge: 10080
```

**검증:**

```bash
# pnpm install이 기존과 동일하게 성공해야 함 (이미 설치된 패키지에는 영향 없음)
pnpm install
```

---

#### 작업 3. `.gitignore` 수정 — 3개 항목 추가

**목적:** coverage 리포트, lcov 파일, lefthook 로컬 설정을 git 추적에서 제외.

**파일:** `.gitignore`

**추가할 내용 (파일 끝에 append):**

```gitignore

# Coverage
coverage/
*.lcov

# Lefthook
.lefthook-local/
```

**검증:**

```bash
# .gitignore에 coverage/, *.lcov, .lefthook-local/ 존재 확인
grep -E 'coverage/|\.lcov|\.lefthook-local/' .gitignore
```

---

#### 작업 4. `package.json` (root) 수정 — `prepare` 스크립트 + `lefthook` devDep

**목적:** `pnpm install` 시 lefthook Git hooks를 자동 설치.

**파일:** `package.json`

**변경 사항:**

1. `scripts`에 `"prepare": "lefthook install"` 추가
2. `devDependencies`에 `"lefthook": "^2.1.0"` 추가

**변경 후 해당 부분:**

```jsonc
{
  "scripts": {
    "build": "tsc --build",
    "clean": "tsc --build --clean",
    "dev": "tsx packages/server/src/main.ts",
    "format": "oxfmt --check .",
    "format:fix": "oxfmt --write .",
    "lint": "oxlint --config oxlintrc.json .",
    "prepare": "lefthook install",
    "test": "vitest run",
    "test:all": "node scripts/test-parallel.mjs --all",
    "test:ci": "node scripts/test-parallel.mjs",
    "test:coverage": "vitest run --coverage",
    "test:e2e": "vitest run --config vitest.e2e.config.ts",
    "test:live": "vitest run --config vitest.live.config.ts",
    "test:storage": "vitest run --config vitest.storage.config.ts",
    "test:watch": "vitest",
    "typecheck": "tsgo --noEmit",
  },
  "devDependencies": {
    "@types/node": "^25.2.2",
    "@typescript/native-preview": "7.0.0-dev.20260209.1",
    "lefthook": "^2.1.0",
    "oxfmt": "^0.28.0",
    "oxlint": "^1.43.0",
    "tsx": "^4.21.0",
    "typescript": "^5.9.3",
    "vitest": "^4.0.18",
  },
}
```

> oxfmt가 package.json 키 순서를 재정렬하므로, 수정 후 반드시 `pnpm format:fix`를 실행하고 결과를 확인한다.

**검증:**

```bash
# prepare 스크립트 확인
node -e "const p = JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log(p.scripts.prepare)"
# 출력: lefthook install

# lefthook devDep 확인
node -e "const p = JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log(p.devDependencies.lefthook)"
# 출력: ^2.1.0
```

---

### Part B: 신규 파일 생성 (7개)

#### 작업 5. `lefthook.yml` 신규 생성

**목적:** pre-commit (lint, format-check, typecheck 병렬) + commit-msg (Conventional Commits regex 검증) 훅 설정.

**파일:** `lefthook.yml`

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
        MSG=$(head -1 .git/COMMIT_EDITMSG)
        if ! echo "$MSG" | grep -qE '^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?: .{1,}'; then
          echo "ERROR: Commit message must follow Conventional Commits format"
          echo "  e.g., feat(agent): add tool registration"
          echo "  e.g., fix: resolve sqlite connection leak"
          exit 1
        fi
```

**검증:**

```bash
# lefthook 설치 확인 (pnpm install 후)
npx lefthook install

# pre-commit 훅 동작 테스트
# 1) 의도적 린트 에러가 있는 파일 스테이지 → 커밋 → 거부 확인
# 2) 정상 파일 스테이지 → 커밋 → 성공 확인

# commit-msg 훅 동작 테스트
git commit --allow-empty -m "bad message"
# 기대: ERROR: Commit message must follow Conventional Commits format

git commit --allow-empty -m "chore: test conventional commit"
# 기대: 성공
```

---

#### 작업 6. `.github/workflows/ci.yml` 신규 생성

**목적:** push/PR 시 lint → format → typecheck → build → test 파이프라인 자동 실행.

**파일:** `.github/workflows/ci.yml`

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

**검증:**

```bash
# YAML 문법 확인 (actionlint 설치 시)
actionlint .github/workflows/ci.yml

# 또는 수동: GitHub에 push 후 Actions 탭에서 실행 확인
```

---

#### 작업 7. `Dockerfile` 신규 생성

**목적:** `node:22-bookworm-slim` 멀티 스테이지 빌드. 의존성 캐싱 최적화 + non-root 실행.

**파일:** `Dockerfile`

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

**검증:**

```bash
docker build -t finclaw:dev .
# 기대: 이미지 빌드 성공

docker run --rm finclaw:dev
# 기대: 컨테이너 시작 (서버 스텁이므로 즉시 종료 가능)
```

---

#### 작업 8. `docker-compose.yml` 신규 생성

**목적:** core app 서비스 정의. 볼륨 마운트 + 환경변수 스캐폴딩.

**파일:** `docker-compose.yml`

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

**검증:**

```bash
docker compose config
# 기대: YAML 파싱 성공, 서비스 정의 출력

docker compose up --build -d
# 기대: 컨테이너 생성 및 실행
docker compose down
```

---

#### 작업 9. `.dockerignore` 신규 생성

**목적:** Docker 빌드 컨텍스트에서 불필요한 파일 제외. 빌드 속도 향상 + 이미지 크기 최소화.

**파일:** `.dockerignore`

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

**검증:**

```bash
# .dockerignore 존재 확인
test -f .dockerignore && echo "OK" || echo "MISSING"

# Docker 빌드 시 node_modules/가 컨텍스트에 포함되지 않는지 확인
# (빌드 로그에서 "Sending build context" 크기가 작아야 함)
```

---

#### 작업 10. `.github/workflows/deploy.yml` 신규 생성

**목적:** amd64/arm64 멀티 플랫폼 Docker 이미지 빌드 후 ghcr.io에 push.

**파일:** `.github/workflows/deploy.yml`

```yaml
name: Deploy

on:
  push:
    tags: ['v*']
  workflow_dispatch:

permissions:
  contents: read
  packages: write

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build-and-push:
    name: Build & Push Docker Image
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - uses: actions/checkout@v4

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to ghcr.io
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=sha,prefix=

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

**검증:**

```bash
# YAML 문법 확인 (actionlint 설치 시)
actionlint .github/workflows/deploy.yml

# 또는 수동: v* 태그 push 후 Actions 탭에서 실행 확인
```

---

#### 작업 11. `scripts/build-docker.sh` 신규 생성

**목적:** 로컬 Docker 빌드를 간편하게 수행하는 래퍼 스크립트.

**파일:** `scripts/build-docker.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${1:-finclaw}"
TAG="${2:-dev}"

echo "Building ${IMAGE_NAME}:${TAG} ..."
docker build -t "${IMAGE_NAME}:${TAG}" .
echo "Done. Run with: docker run -p 3000:3000 ${IMAGE_NAME}:${TAG}"
```

> 파일 생성 후 `chmod +x scripts/build-docker.sh` 실행 필요.

**검증:**

```bash
# 실행 권한 확인
test -x scripts/build-docker.sh && echo "OK" || echo "NOT EXECUTABLE"

# 스크립트 실행 (Docker 설치 시)
./scripts/build-docker.sh
# 기대: "Building finclaw:dev ..." 출력 후 빌드 성공
```

---

## 설치 및 검증 절차

### 실행 순서

```
1. 파일 수정 (작업 1~4)
   ├── .node-version 생성
   ├── pnpm-workspace.yaml 수정
   ├── .gitignore 수정
   └── package.json 수정

2. 신규 파일 생성 (작업 5~11)
   ├── lefthook.yml
   ├── .github/workflows/ci.yml
   ├── .github/workflows/deploy.yml
   ├── Dockerfile
   ├── docker-compose.yml
   ├── .dockerignore
   └── scripts/build-docker.sh

3. 의존성 설치 + lefthook 설치
   └── pnpm install  (prepare 스크립트가 lefthook install 자동 실행)

4. 포매팅 정리
   └── pnpm format:fix  (oxfmt가 package.json 키 순서 재정렬)

5. 검증
   ├── pnpm install        → 에러 없이 완료
   ├── pnpm build          → dist/ 생성, 에러 없음
   ├── pnpm typecheck      → 에러 없음
   ├── pnpm lint           → 에러 없음
   ├── pnpm format         → 위반 없음
   ├── pnpm test           → sample.test.ts 통과
   ├── pnpm test:ci        → PASS
   └── (선택) docker build -t finclaw:dev .  → 이미지 빌드 성공
```

---

## 최종 체크리스트

| #   | 항목                                        | 검증 명령어                                                    | 기대 결과                  | 완료 |
| --- | ------------------------------------------- | -------------------------------------------------------------- | -------------------------- | ---- |
| 1   | `.node-version` 존재                        | `cat .node-version`                                            | `22.21.1`                  | [ ]  |
| 2   | `pnpm-workspace.yaml`에 `minimumReleaseAge` | `grep minimumReleaseAge pnpm-workspace.yaml`                   | `minimumReleaseAge: 10080` | [ ]  |
| 3   | `.gitignore`에 coverage/lcov/lefthook       | `grep -c 'coverage/\|\.lcov\|\.lefthook' .gitignore`           | `3`                        | [ ]  |
| 4   | `package.json` prepare 스크립트             | `node -p "require('./package.json').scripts.prepare"`          | `lefthook install`         | [ ]  |
| 5   | `package.json` lefthook devDep              | `node -p "require('./package.json').devDependencies.lefthook"` | `^2.1.0`                   | [ ]  |
| 6   | `lefthook.yml` 존재                         | `test -f lefthook.yml`                                         | exit 0                     | [ ]  |
| 7   | `.github/workflows/ci.yml` 존재             | `test -f .github/workflows/ci.yml`                             | exit 0                     | [ ]  |
| 8   | `Dockerfile` 존재                           | `test -f Dockerfile`                                           | exit 0                     | [ ]  |
| 9   | `docker-compose.yml` 존재                   | `test -f docker-compose.yml`                                   | exit 0                     | [ ]  |
| 10  | `.dockerignore` 존재                        | `test -f .dockerignore`                                        | exit 0                     | [ ]  |
| 11  | `.github/workflows/deploy.yml` 존재         | `test -f .github/workflows/deploy.yml`                         | exit 0                     | [ ]  |
| 12  | `scripts/build-docker.sh` 실행 가능         | `test -x scripts/build-docker.sh`                              | exit 0                     | [ ]  |
| 13  | `pnpm install` 성공                         | `pnpm install`                                                 | 에러 없음                  | [ ]  |
| 14  | `pnpm build` 성공                           | `pnpm build`                                                   | 에러 없음                  | [ ]  |
| 15  | `pnpm typecheck` 성공                       | `pnpm typecheck`                                               | 에러 없음                  | [ ]  |
| 16  | `pnpm lint` 성공                            | `pnpm lint`                                                    | 에러 없음                  | [ ]  |
| 17  | `pnpm format` 성공                          | `pnpm format`                                                  | 위반 없음                  | [ ]  |
| 18  | `pnpm test` 성공                            | `pnpm test`                                                    | 통과                       | [ ]  |
| 19  | `pnpm test:ci` 성공                         | `pnpm test:ci`                                                 | PASS                       | [ ]  |
| 20  | lefthook pre-commit 동작                    | 린트 에러 커밋 시도                                            | 거부                       | [ ]  |
| 21  | lefthook commit-msg 동작                    | `git commit -m "bad"`                                          | 거부                       | [ ]  |
| 22  | (선택) Docker 빌드                          | `docker build -t finclaw:dev .`                                | 성공                       | [ ]  |
