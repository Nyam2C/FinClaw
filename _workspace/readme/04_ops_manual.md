# Ops Manual

## 요구사항

| 항목     | 버전        | 출처                                                               |
| -------- | ----------- | ------------------------------------------------------------------ |
| Node.js  | `>=22.0.0`  | `package.json:37-39` (`engines.node`), `.node-version` (`22.21.1`) |
| pnpm     | `10.4.1`    | `package.json:40` (`packageManager`)                               |
| corepack | (Node 동봉) | `Dockerfile:6,38` (`RUN corepack enable`)                          |
| Docker   | (선택)      | `scripts/dev-all.sh:13-16` (`docker compose up`)                   |

추가 사항:

- 22+ 가 필수인 이유: SQLite 가 `node:sqlite` 내장 모듈을 사용하고 (`README.md:6`), `.env` 로딩을 `process.loadEnvFile()` 으로 처리한다 (`packages/infra/src/dotenv.ts:7-13`).
- WSL/Windows 환경에서 OS 의존: 없음. 단, 보안 감사(`packages/server/src/services/security/audit.ts:124`)는 WSL/win32 에서 POSIX 퍼미션 검사를 건너뛴다.

## 설치 & 첫 실행

`scripts/setup.sh` 가 표준 부트스트랩이다 (`package.json:15` → `setup`).

```bash
pnpm run setup        # scripts/setup.sh
# 1) .env 가 없으면 .env.example 에서 복사 (scripts/setup.sh:7-14)
# 2) pnpm install (scripts/setup.sh:16-17)
# 3) ~/.finclaw/ 디렉토리 생성 (scripts/setup.sh:19-21)
```

수동 단계가 필요한 시점:

| 단계             | 명령                                                                             | 검증                                                                                      |
| ---------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| pnpm 활성화      | `corepack enable && corepack prepare pnpm@10.4.1 --activate`                     | `pnpm --version` → `10.4.1` (`README.md:11-13`)                                           |
| API 키 입력      | `.env` 편집 (`ANTHROPIC_API_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`) | `pnpm dev` 가 `MissingEnvError` 없이 부팅 (`packages/server/src/main.ts:97-114, 141-143`) |
| 빌드             | `pnpm build` (`package.json:7`)                                                  | `packages/*/dist/` 생성, `tsc --build` exit 0                                             |
| 첫 실행 (로컬)   | `pnpm dev` (`package.json:9` → `tsx packages/server/src/main.ts`)                | 로그 `Gateway listening on …` (`packages/server/src/main.ts:501`)                         |
| 첫 실행 (Docker) | `pnpm run dev:all` (`scripts/dev-all.sh`)                                        | `docker compose up --build` (`scripts/dev-all.sh:19`)                                     |

함정 — `.env` 가 없으면 `dev:all` 이 즉시 종료한다 (`scripts/dev-all.sh:7-11`).

## 환경변수 (전수 조사)

`grep -rn "process\.env\." packages/ --include="*.ts"` (제외: `node_modules`, `dist`, `*.test.ts`) 결과를 `.env.example` / `Dockerfile` / `docker-compose.yml` 와 교차 검증.

### 필수 (Required) — `requireEnv()` 가 throw

| 변수                     | 설명                    | 코드 위치                         |
| ------------------------ | ----------------------- | --------------------------------- |
| `ANTHROPIC_API_KEY`      | Anthropic Claude SDK 키 | `packages/server/src/main.ts:141` |
| `DISCORD_BOT_TOKEN`      | Discord 봇 로그인 토큰  | `packages/server/src/main.ts:142` |
| `DISCORD_APPLICATION_ID` | Discord 애플리케이션 ID | `packages/server/src/main.ts:143` |

미설정 시: `MissingEnvError` → `[fatal] Missing required env: <NAME>` 후 `process.exit(1)` (`packages/server/src/main.ts:507-520`).

### 선택 — 금융 데이터

| 변수                | 동작                                                                               | 코드 위치                                         |
| ------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------- |
| `ALPHA_VANTAGE_KEY` | 미설정 시 market/news 도구 등록 자체를 건너뛴다 (`registerMarketTools` 호출 안 함) | `packages/server/src/main.ts:239,245-254,256-272` |
| `COINGECKO_API_KEY` | 미설정 시 crypto 시세만 비활성 (market 등록은 둘 중 하나만 있어도 진행)            | `packages/server/src/main.ts:240,245`             |
| `NEWSAPI_KEY`       | 코드 상에서는 `optionalEnv` 메타로만 선언 — 현재 read 지점 없음 (예약)             | `packages/skills-finance/src/news/index.ts:116`   |

> 함정 — `audit.ts` 가 보고하는 키 이름은 `ALPHA_VANTAGE_API_KEY` (라인 83) 인데, 실제 코드 read 는 `ALPHA_VANTAGE_KEY` (`main.ts:239`). 보안 감사 결과의 키 이름과 실제 환경변수 이름이 불일치한다.

### 선택 — Gateway / Web UI 인증

| 변수                                  | 기본값                        | 비고                                                             | 코드 위치                             |
| ------------------------------------- | ----------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| `FINCLAW_API_KEY`                     | `[]` (인증 비활성)            | 설정 시 `X-API-Key` 헤더 검증 활성. 단일 키만 지원 (배열 1원소). | `packages/server/src/main.ts:379`     |
| `GATEWAY_JWT_SECRET`                  | `'dev-secret'`                | `??` fallback. 빈 문자열은 fallback 안 됨 (아래 함정 참조).      | `packages/server/src/main.ts:74`      |
| `GATEWAY_PORT`                        | `3000` (`defaultConfig.port`) | `Number()` 변환 후 `validateConfigStrict` 검증.                  | `packages/server/src/main.ts:146-150` |
| `AUTOMATION_MAX_CONSECUTIVE_FAILURES` | `3`                           | `SchedulerService` 가 N회 연속 실패 시 schedule 자동 비활성.     | `packages/server/src/main.ts:417-418` |

### 선택 — 저장소 / 파일

| 변수                | 기본값                                                   | 코드 위치                                                  |
| ------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| `FINCLAW_DB_PATH`   | `~/.finclaw/db.sqlite` (Docker 에서는 `/data/db.sqlite`) | `packages/server/src/main.ts:189`, `docker-compose.yml:18` |
| `FINCLAW_FILE_ROOT` | `~/.finclaw/workspace`                                   | `packages/skills-general/src/index.ts:55`                  |
| `FINCLAW_CONFIG`    | (없음 — fallback chain)                                  | `packages/config/src/paths.ts:17-27`                       |

### 선택 — 임베딩 (Phase 26 RAG)

| 변수             | 동작                                                                                              | 코드 위치                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `VOYAGE_API_KEY` | 둘 중 하나라도 있으면 `createEmbeddingProvider('auto')` 호출. 없으면 `memory.search` 는 FTS-only. | `packages/server/src/main.ts:199-212`, `packages/storage/src/embeddings/voyage.ts:18` |
| `OPENAI_API_KEY` | Voyage fallback. 단 vec0 DDL 이 1024D 이라 OpenAI 1536D 는 schema mismatch (코드 주석 경고).      | `packages/storage/src/embeddings/openai.ts:11-15,24`                                  |

### Docker / Infra (compose 와 Dockerfile 만 읽음)

| 변수               | 사용 위치                                   | 동작                                                                  |
| ------------------ | ------------------------------------------- | --------------------------------------------------------------------- |
| `FINCLAW_HOST`     | `Dockerfile:57`, `docker-compose.yml:16`    | 컨테이너 ENV 로 주입. **단 main.ts 가 읽지 않음** (아래 불일치 참조). |
| `FINCLAW_PORT`     | `Dockerfile:58`, `docker-compose.yml:17,20` | compose 의 호스트 포트 매핑 (`${FINCLAW_PORT:-3000}:3000`).           |
| `FINCLAW_WEB_PORT` | `docker-compose.yml:33`                     | web 서비스 호스트 포트 (`${FINCLAW_WEB_PORT:-5173}:5173`).            |
| `NODE_ENV`         | `Dockerfile:56`, `docker-compose.yml:15`    | `production`. audit 에서 미설정 시 warn (`audit.ts:168`).             |

### 테스트 전용 / 진단

| 변수                      | 코드 위치                                                                             | 동작                                                |
| ------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `VITEST`                  | `packages/server/src/main.ts:506`                                                     | 설정되면 `main()` 자동 실행 안 함.                  |
| `CI`, `GITHUB_ACTIONS`    | `vitest.config.ts:4`, `vitest.e2e.config.ts:4`                                        | CI 워커 수 축소.                                    |
| `FINCLAW_TEST_WORKERS`    | `scripts/test-parallel.mjs:46-48`                                                     | `--pool.forks.maxForks` 강제 지정.                  |
| `WSL_DISTRO_NAME`         | `packages/server/src/services/security/audit.ts:124`, `services/daemon/systemd.ts:14` | 분기 처리 (POSIX 퍼미션 / systemd 비활성).          |
| `DB_PATH`                 | `packages/server/src/services/security/audit.ts:178`                                  | **audit 전용** — main 의 `FINCLAW_DB_PATH` 와 별개. |
| `ALERT_CHECK_INTERVAL_MS` | `packages/server/src/services/security/audit.ts:189`                                  | audit 전용 임계값.                                  |

### `.env.example` 과 코드의 불일치 (보고)

1. **`.env.example` 에 없지만 코드가 읽는 키:**
   - `GATEWAY_PORT`, `GATEWAY_JWT_SECRET` — README 에는 있으나 `.env.example` 에 없음 (`README.md:96-99` vs `.env.example:1-26`).
   - `AUTOMATION_MAX_CONSECUTIVE_FAILURES` (Phase 28).
   - `FINCLAW_FILE_ROOT`, `FINCLAW_CONFIG`.

2. **audit.ts 가 검사하는 키 이름이 실제 코드와 다름:**
   - `audit.ts:67` → `DISCORD_TOKEN` / 실제 main 은 `DISCORD_BOT_TOKEN`.
   - `audit.ts:83` → `ALPHA_VANTAGE_API_KEY` / 실제 main 은 `ALPHA_VANTAGE_KEY`.
   - `audit.ts:178` → `DB_PATH` / 실제 main 은 `FINCLAW_DB_PATH`.

3. **Dockerfile/compose 가 설정하지만 main 이 읽지 않는 키:**
   - `FINCLAW_HOST`, `FINCLAW_PORT` — main 은 `GATEWAY_PORT` / `defaultConfig.host`(`'0.0.0.0'`) 사용. compose env block 의 `FINCLAW_HOST=0.0.0.0` 는 효과 없음.
   - 단, `packages/server/src/cli/commands/start.ts:25,37-38` 의 `start` CLI 명령은 `FINCLAW_PORT`/`FINCLAW_HOST` 를 쓴다 (CLI 경로 한정).

4. **`.env` 자동 로드 미구현:**
   - `loadDotenv` 가 `infra/src/dotenv.ts` 에 정의되어 있으나 (`index.ts:33` 에서 export), `main.ts` 는 호출하지 않는다. Docker 는 compose `env_file: .env` (`docker-compose.yml:12-13`) 로 처리, 로컬 `pnpm dev` 는 사용자가 직접 export 하거나 `node --env-file=.env` 사용 필요.

## 설정 파일 — `config.example.json5`

`config.example.json5` 를 `finclaw.json5` 로 복사. 해석 우선순위 (`packages/config/src/paths.ts:16-27`):

1. `FINCLAW_CONFIG` 환경변수 경로
2. `~/.finclaw/config/finclaw.json5`
3. `./finclaw.json5` (cwd)

주요 필드 (출처: `config.example.json5:1-64`, 검증: `packages/config/src/zod-schema.ts`):

| 섹션       | 키                                                                         | 비고                                                                        |
| ---------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------ | -------------- |
| `gateway`  | `port`, `host`, `tls`, `corsOrigins`                                       | port 1-65535 strict (`zod-schema.ts:5-10`)                                  |
| `agents`   | `defaults.{model,provider,maxConcurrent,maxTokens,temperature}`, `entries` | maxConcurrent 1-10                                                          |
| `channels` | `discord.{botToken,applicationId,…}`, `cli.enabled`, `web.{enabled,port}`  | `${ENV}` 치환 지원 (`env-substitution.ts`)                                  |
| `session`  | `mainKey`, `resetPolicy`(`daily                                            | idle                                                                        | never`), `idleTimeoutMs` | 기본 idle 30분 |
| `logging`  | `level`(`trace..fatal`), `file`, `redactSensitive`                         | strict object (`zod-schema.ts:39-43`)                                       |
| `models`   | `definitions`, `aliases`, `defaultModel`, `fallbacks`                      | optional                                                                    |
| `finance`  | `dataProviders[]`, `newsFeeds[]`, `alertDefaults`, `portfolios`            | provider 별 `apiKey` 는 `${ENV}` 치환                                       |
| `routing`  | `roles.{fetch,chat,analysis,summarize}`, `automation`, `override`          | Phase 24 모델 라우팅 (`zod-schema.ts:96-129`, `config.example.json5:48-63`) |
| `plugins`  | `enabled[]`, `disabled[]`                                                  |                                                                             |

스키마는 모두 `z.strictObject()` — 알 수 없는 키가 있으면 부팅이 차단된다 (`packages/server/src/main.ts:158, 510-516`).

## 명령어 매트릭스

| 명령어               | 정의                                                               | 언제 쓰나                                                 |
| -------------------- | ------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------- | -------------------------------- |
| `pnpm setup`         | `bash scripts/setup.sh` (`package.json:15`)                        | 최초 1회 환경 부트스트랩                                  |
| `pnpm dev`           | `tsx packages/server/src/main.ts` (`package.json:9`)               | 로컬 단독 server 실행                                     |
| `pnpm dev:all`       | `bash scripts/dev-all.sh` (`package.json:10`)                      | Docker 위 server + web 동시 기동                          |
| `pnpm build`         | `tsc --build` (`package.json:7`)                                   | TypeScript project references 빌드                        |
| `pnpm clean`         | `tsc --build --clean` (`package.json:8`)                           | dist + tsbuildinfo 제거                                   |
| `pnpm typecheck`     | `tsgo --noEmit` (`package.json:24`)                                | 빠른 타입 검사 (TypeScript-Go)                            |
| `pnpm lint`          | `oxlint --config oxlintrc.json .` (`package.json:13`)              | Rust 기반 린트                                            |
| `pnpm format`        | `oxfmt --check .` (`package.json:11`)                              | 포매팅 검사                                               |
| `pnpm format:fix`    | `oxfmt --write .` (`package.json:12`)                              | 포매팅 자동 수정                                          |
| `pnpm test`          | `vitest run` (`package.json:16`)                                   | unit 만                                                   |
| `pnpm test:storage`  | `vitest run --config vitest.storage.config.ts` (`package.json:22`) | DB 격리 (maxWorkers=1)                                    |
| `pnpm test:e2e`      | `vitest run --config vitest.e2e.config.ts` (`package.json:20`)     | 종단 시나리오 (timeout 120s)                              |
| `pnpm test:live`     | `vitest run --config vitest.live.config.ts` (`package.json:21`)    | 실제 외부 API 호출 (수동)                                 |
| `pnpm test:ci`       | `node scripts/test-parallel.mjs` (`package.json:18`)               | CI: unit + storage 병렬                                   |
| `pnpm test:all`      | `node scripts/test-parallel.mjs --all` (`package.json:17`)         | unit + storage + e2e 모두                                 |
| `pnpm test:coverage` | `vitest run --coverage` (`package.json:19`)                        | v8 커버리지 (임계: 70/70/70/55, `vitest.config.ts:28-32`) |
| `pnpm test:watch`    | `vitest` (`package.json:23`)                                       | 변경 감시 모드                                            |
| `pnpm prepare`       | `lefthook install                                                  |                                                           | true` (`package.json:14`) | git hook 설치 (자동, install 후) |

추가 스크립트 (npm script 미등록):

| 스크립트                                                            | 용도                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------ |
| `scripts/build-docker.sh [name] [tag]`                              | `docker build -t <name>:<tag> .` (기본 `finclaw:dev`)  |
| `scripts/build-skills.ts`                                           | `dist/skills/` 에 스킬별 번들 + `skill.meta.json` 생성 |
| `scripts/verify-pack-includes-prompts.sh`                           | `pnpm pack` 산출물에 `prompts/*.md` 포함 여부 검증     |
| `scripts/calver.ts`, `write-build-info.ts`, `check-dep-versions.ts` | 릴리스/버전 보조 (CI 또는 수동)                        |

## 테스트 (4-tier)

`scripts/test-parallel.mjs` 가 phase1(unit+storage 병렬) → phase2(e2e 순차, `--all` 시) 로 구동.

| Tier        | Config                          | 파일 패턴                              | 격리 / 워커                                      | 외부 의존                                              | 실행                |
| ----------- | ------------------------------- | -------------------------------------- | ------------------------------------------------ | ------------------------------------------------------ | ------------------- |
| **unit**    | `vitest.config.ts:8-35`         | `**/*.test.ts` (storage/e2e/live 제외) | local: `max(4, min(16, cpus))` / CI: 3 (win32 2) | mock 만, env isolated (`test/setup.ts`, `test-env.ts`) | `pnpm test`         |
| **storage** | `vitest.storage.config.ts:1-19` | `**/*.storage.test.ts`                 | `maxWorkers=1` (DB 충돌 방지), 30s timeout       | tmp SQLite DB                                          | `pnpm test:storage` |
| **e2e**     | `vitest.e2e.config.ts:1-24`     | `**/*.e2e.test.ts`                     | local: cpu\*0.25 (최대 4) / CI: 2, 120s timeout  | localhost gateway + tmp DB                             | `pnpm test:e2e`     |
| **live**    | `vitest.live.config.ts:1-19`    | `**/*.live.test.ts`                    | `maxWorkers=1`, 60s timeout                      | **실제 API 키** (Anthropic, Voyage 등)                 | `pnpm test:live`    |

`test/setup.ts` + `test/test-env.ts:5-12,21-39`:

- `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `CLAUDE_API_KEY`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, `NODE_OPTIONS` 를 `beforeAll` 에 삭제 (sensitive isolation).
- `HOME`, `DB_PATH`, `NODE_ENV=test` 를 tmpdir 로 강제 설정 → 테스트가 사용자 DB 를 건드리지 않음.
- `afterAll` 에서 원본 복원 + tmpdir 정리.

CI (`.github/workflows/ci.yml`):

- Quality gate: `pnpm install --frozen-lockfile` → `lint` → `format` → `typecheck` → `build` → `test:ci`.
- `pnpm/action-setup@v6` 가 `package.json#packageManager` 에서 pnpm 버전을 자동 감지.
- Node 버전은 `.node-version` 파일 (`actions/setup-node@v4` `node-version-file`).

## 배포

### Docker (server + web 동시)

```bash
pnpm run dev:all       # = docker compose up --build (scripts/dev-all.sh:19)
```

`docker-compose.yml` 구조:

| 서비스   | 이미지                   | 포트 (host:container)            | 마운트                              | 헬스체크                                               |
| -------- | ------------------------ | -------------------------------- | ----------------------------------- | ------------------------------------------------------ |
| `server` | `finclaw:local`          | `${FINCLAW_PORT:-3000}:3000`     | `finclaw-data:/data` (named volume) | `Dockerfile:62-63` `GET /healthz` 매 30s               |
| `web`    | `finclaw:local` (재사용) | `${FINCLAW_WEB_PORT:-5173}:5173` | -                                   | disabled (`docker-compose.yml:34-36`, `/healthz` 없음) |

빌드 흐름 (`Dockerfile`):

1. **builder** (`node:22-bookworm-slim`): `corepack enable` → 패키지별 `package.json` COPY → `pnpm install --frozen-lockfile` → 소스 COPY → `pnpm build` + `pnpm --filter @finclaw/web build` (devDeps 보존 — web 이 `vite preview` 사용).
2. **runner**: `/data` 디렉토리를 `node:node` 소유로 생성 → non-root `USER node` → builder 산출물만 복사 → ENV `NODE_ENV=production`, `FINCLAW_HOST=0.0.0.0`, `FINCLAW_PORT=3000` (단 `FINCLAW_PORT` 는 main.ts 가 직접 읽지 않음 — 위 불일치 참조).
3. CMD: `node packages/server/dist/main.js`. web 컨테이너는 compose 가 override 해 `pnpm exec vite preview --host 0.0.0.0 --port 5173` 실행 (`docker-compose.yml:38-48`).

Compose 는 `env_file: .env` (`docker-compose.yml:12-13`) 로 호스트 `.env` 를 자동 주입한다. DB 는 `finclaw-data` named volume 에 영속 (`docker-compose.yml:50-52`).

이미지만 빌드: `bash scripts/build-docker.sh [name] [tag]` (기본 `finclaw:dev`).

### Extensions / 플러그인

`extensions/plugin-template/` 가 유일한 템플릿 (`extensions/plugin-template/finclaw-plugin.json:1-9`):

- `name`, `version`, `description`, `main`, `type`(`skill`), `config`, `configSchema`.
- 진입점: `src/index.ts` 의 `register(api: PluginApi)` — 훅/커맨드 등록 후 `deactivate()` 로 정리.
- `PluginBuildApi` 의 정식 타입은 아직 `@finclaw/server` 에서 export 되지 않음 (소스 주석 TODO, `extensions/plugin-template/src/index.ts:8-10`).
- 활성화: `finclaw.json5` 의 `plugins.enabled` 배열에 plugin 이름 추가 (`zod-schema.ts:185-190`).

배포 자동화 스크립트 / loader 는 별도 명세 없음 — 현재 템플릿만 존재.

스킬 번들링: `tsx scripts/build-skills.ts [--skill=market|news|alerts] [--outdir=<path>]` (`scripts/build-skills.ts:101-105`). `pnpm build` 선행 필요.

## 트러블슈팅 (실측)

| 증상                                                                                               | 원인                                                                                                              | 대응                                                                                                                        |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `[fatal] Missing required env: ANTHROPIC_API_KEY` / `DISCORD_BOT_TOKEN` / `DISCORD_APPLICATION_ID` | `requireEnv()` 가 throw (`packages/server/src/main.ts:108-114, 141-143`)                                          | `.env` 채우거나 export. 로컬 dev 는 `.env` 자동로드 없음 — `node --env-file=.env` 필요                                      |
| WS 클라이언트 인증 실패 (web UI / token 검증)                                                      | `GATEWAY_JWT_SECRET=` (빈 값) 라인이 있으면 `??` fallback 안 됨 → secret 이 `''` 로 고정                          | 라인을 **제거** 하거나 명시적 값 입력 (`README.md:101`)                                                                     |
| `pnpm dev:all` 즉시 종료 + `[dev:all] ERROR: .env not found.`                                      | `scripts/dev-all.sh:7-11` 의 사전 체크                                                                            | `pnpm run setup` 또는 `cp .env.example .env`                                                                                |
| `[dev:all] ERROR: docker not found in PATH.`                                                       | `scripts/dev-all.sh:13-16`                                                                                        | Docker Desktop / docker engine 설치                                                                                         |
| `Read/Write/Edit ENOENT` (WSL 에서 `/mnt/c/...`)                                                   | WSL2 ↔ Windows 크로스 파일시스템 캐시 (CLAUDE.md MEMORY.md "WSL Notes")                                           | 같은 파일을 다시 Read 하면 해소                                                                                             |
| lefthook hook 이 `node: command not found`                                                         | git hook 은 minimal `sh` 에서 동작, nvm PATH 부재 (`MEMORY.md`)                                                   | `lefthook.yml:2` 의 `rc: ./.lefthookrc` 가 `.node-version` 읽어 PATH 주입 — `./` prefix 필수 (POSIX `.` 가 PATH 검색하므로) |
| `pnpm format:fix` 후 `package.json` 이 다시 reorder                                                | oxfmt 가 `files` 등 키 순서 재정렬 (`MEMORY.md`)                                                                  | edit 직후 `pnpm format:fix` 한 번 더 실행 — 정상 동작                                                                       |
| `commit-msg` hook 이 한글 subject 거부                                                             | `lefthook.yml:18-25` 가 dash + C.UTF-8 grep 으로 conventional 형식 검증 (`MEMORY.md`)                             | subject 는 ASCII conventional commits 로 작성                                                                               |
| Port 충돌 시 `[fatal] Port 3000 is in use by …` 후 종료                                            | `assertPortAvailable` + `inspectPortOccupant` (`packages/server/src/main.ts:382-391`)                             | 점유 프로세스 종료 또는 `GATEWAY_PORT` 변경                                                                                 |
| Embedding `Failed to create embedding provider — memory.search will use FTS-only` warn             | Voyage/OpenAI 키 둘 다 없거나 생성 실패 (`packages/server/src/main.ts:206-211`)                                   | 의도된 graceful fallback. 무시 가능. 키 채우면 hybrid 검색 활성                                                             |
| OpenAI 임베딩 시 schema mismatch                                                                   | vec0 DDL 이 1024D 인데 OpenAI text-embedding-3-small 은 1536D (`packages/storage/src/embeddings/openai.ts:11-15`) | Voyage `voyage-finance-2` 사용 권장                                                                                         |
| `git commit` 이 한국어 subject 로 실패                                                             | conventional 정규식 + locale issue                                                                                | ASCII subject (`feat:`, `fix:` 등)                                                                                          |

## 보안 노트

- **인증 모델 (`packages/server/src/main.ts:373-381`):**
  - `FINCLAW_API_KEY` 설정 → API key 인증 활성 (`X-API-Key` 헤더, 단일 키).
  - JWT (HS256) — WebSocket `?token=`, HTTP `Authorization: Bearer …` 모두 (`README.md:121-147` 의 JWT 생성 스니펫 참조).
  - secret 미설정 시 `'dev-secret'` fallback — 프로덕션 사용 금지.
- **Non-root 컨테이너:** `Dockerfile:46` `USER node`, `/data` 디렉토리 owner = node:node (`Dockerfile:43`).
- **민감 파일 퍼미션 검사:** `audit.ts:134-160` 가 `.env`, `finclaw.db*` 의 0o004(world)/0o040(group) 비트를 검사 (POSIX 한정). WSL/Windows 는 자동 skip.
- **위험 환경변수 감지:** `audit.ts:97-115` — `LD_PRELOAD`, `LD_LIBRARY_PATH`, `NODE_OPTIONS`, `NODE_DEBUG`, `UV_THREADPOOL_SIZE` 가 설정되어 있으면 warn.
- **테스트 격리:** `test/test-env.ts` 가 `ANTHROPIC_API_KEY` 등 sensitive 키를 테스트 시작 시 삭제 — 실수로 외부 API 호출되는 것 방지.
- **Strict config:** `z.strictObject()` 로 알 수 없는 키 거부 (`packages/config/src/zod-schema.ts:154`) — 오타로 인한 silent misconfig 방지.
- **Conventional commits enforced:** `lefthook.yml:16-26` (변경 이력 감사 가능성).

## 메타데이터

### 출처 (파일:라인)

- 명령어: `package.json:6-25`, `scripts/setup.sh`, `scripts/dev-all.sh`, `scripts/build-docker.sh`, `scripts/test-parallel.mjs`, `scripts/build-skills.ts:101-105`, `scripts/verify-pack-includes-prompts.sh`
- 환경변수 read: `packages/server/src/main.ts:74,141-146,189,199,239-240,379,417,506`, `packages/skills-general/src/index.ts:55`, `packages/storage/src/embeddings/voyage.ts:18`, `packages/storage/src/embeddings/openai.ts:24`, `packages/server/src/services/security/audit.ts:66-68,82-86,124,168,178,189`, `packages/server/src/services/daemon/systemd.ts:14`, `packages/server/src/cli/commands/start.ts:25,37-38`, `packages/infra/src/logger.ts:57`, `scripts/test-parallel.mjs:46`
- 환경변수 선언: `.env.example:1-26`, `Dockerfile:56-58`, `docker-compose.yml:14-20,33`
- 설정: `config.example.json5:1-64`, `packages/config/src/zod-schema.ts:1-202`, `packages/config/src/paths.ts:16-27`
- Docker: `Dockerfile:1-65`, `docker-compose.yml:1-52`
- Test: `vitest.config.ts:1-35`, `vitest.storage.config.ts:1-19`, `vitest.e2e.config.ts:1-24`, `vitest.live.config.ts:1-19`, `test/setup.ts:1-15`, `test/test-env.ts:1-61`
- CI: `.github/workflows/ci.yml:1-46`
- Lefthook: `lefthook.yml:1-26`, `.lefthookrc:1-2`
- Plugin: `extensions/plugin-template/finclaw-plugin.json:1-9`, `extensions/plugin-template/package.json:1-8`, `extensions/plugin-template/src/index.ts`
- 메모리: `~/.claude/projects/-mnt-c-Users---Desktop-hi-FinClaw/memory/MEMORY.md` (Lefthook Notes, WSL Notes, Feedback)
- 기존 README 검증된 부분: `README.md:101` (GATEWAY_JWT_SECRET 함정), `README.md:117-147` (JWT 생성 + curl 예시)

### 미확인 / 미검증

- `.github/workflows/deploy.yml`, `release.yml` 의 내부 단계 (CI 만 정독). 운영 매뉴얼 범위 밖.
- `extensions/plugin-template` 외 실제 사용 중인 플러그인 / loader 코드 위치는 미확인 — `packages/server/src/plugins/loader.ts` 라고 주석에 언급되나 실제 파일은 미확인.
- `scripts/calver.ts`, `write-build-info.ts`, `check-dep-versions.ts` 의 호출 시점/cron — npm script 등록 없고 CI 워크플로 미확인.
- `extensions/` 디렉토리에 `README` 없음 — plugin loading mechanism 의 사용자용 안내 부재.
- `Dockerfile` 의 web 빌드 산출물(`packages/web/dist/`) 가 어디로 가는지: compose 의 web 서비스가 `pnpm exec vite preview` 로 서빙하지만 `vite preview` 의 기본 dist 경로 외 별도 설정 없음.
- `loadDotenv()` 가 어디서도 호출되지 않음 — main 엔트리에서 의도적으로 빠진 것인지, 누락인지 미확인.
