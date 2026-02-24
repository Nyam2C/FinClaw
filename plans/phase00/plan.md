# Phase 0: 개발환경 스캐폴딩

## 1. 목표

FinClaw 프로젝트의 개발환경을 구축한다. 빌드, 테스트, 린트, 포매팅 인프라를 세팅하고, 이후 Phase 1~20이 의존하는 기반을 확립한다.

Phase 0의 핵심 원칙:

- **코드 없이 인프라만**: `src/` 디렉토리는 빈 스캐폴딩, 비즈니스 로직 없음
- **4-tier 테스트**: unit / storage / e2e / live 분리
- **Rust 기반 도구**: oxlint(린트) + oxfmt(포매팅) -- ESLint/Prettier 대비 10~100x 빠름
- **Node.js 22+ 전용**: `node:sqlite` 내장 모듈 활용, 네이티브 애드온 불필요

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
├── README.md                       -- 보강: 프로젝트 소개 + 개발환경 가이드
└── .gitignore                      -- 보강: IDE/OS 파일 추가
```

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

- `pnpm build` = `tsc` -- 실제 빌드 (dist/ 출력)
- `pnpm typecheck` = `tsgo --noEmit` -- 빠른 타입체크 전용 (@typescript/native-preview)

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

## 6. 선행 조건

없음. Phase 0는 최초 단계.

**전제 조건 (개발자 환경):**

- Node.js >= 22.0.0
- pnpm >= 10.4.1 (corepack enable로 활성화)
- Git

## 7. 산출물 및 검증

### 완료 기준 체크리스트

| #   | 검증 항목       | 명령어              | 기대 결과               |
| --- | --------------- | ------------------- | ----------------------- |
| 1   | 의존성 설치     | `pnpm install`      | 에러 없이 완료          |
| 2   | 빌드            | `pnpm build`        | `dist/` 생성, 에러 없음 |
| 3   | 타입체크        | `pnpm typecheck`    | 에러 없음               |
| 4   | 린트            | `pnpm lint`         | 에러 없음               |
| 5   | 포매팅          | `pnpm format`       | 위반 없음               |
| 6   | 유닛 테스트     | `pnpm test`         | sample.test.ts 통과     |
| 7   | 스토리지 테스트 | `pnpm test:storage` | 통과 (테스트 없어도 OK) |
| 8   | E2E 테스트      | `pnpm test:e2e`     | 통과 (테스트 없어도 OK) |
| 9   | CI 테스트       | `pnpm test:ci`      | Phase 1+2 모두 PASS     |
| 10  | 개발 서버       | `pnpm dev`          | 에러 없이 시작          |

### 보강 산출물

| #   | 파일              | 검증 방법                                  |
| --- | ----------------- | ------------------------------------------ |
| 1   | `.editorconfig`   | 에디터에서 탭/스페이스/줄끝 자동 적용 확인 |
| 2   | `README.md`       | 새 개발자가 README만 보고 환경 세팅 가능   |
| 3   | `.gitignore` 보강 | `.vscode/`, `.DS_Store` 등 무시 확인       |

## 8. 복잡도 및 예상 파일 수

| 항목                  | 값                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------- |
| 복잡도                | S (스캐폴딩, 비즈니스 로직 없음)                                                      |
| 완료된 파일           | 설정 8 + vitest 4 + 스크립트 1 + 소스 스텁 2 + 테스트 5 = **20 파일**                 |
| 보강 파일             | .editorconfig + README.md + .gitignore 보강 = **3 파일**                              |
| devDependencies       | 7개 (typescript, tsx, vitest, oxlint, oxfmt, @types/node, @typescript/native-preview) |
| 프로덕션 dependencies | 0개 (Phase 0에서는 런타임 의존성 없음)                                                |

---

## 부록: 설정 파일 상세 레퍼런스

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
