# FinClaw 20-Phase 개발 로드맵

## 프로젝트 개요

**FinClaw**는 [OpenClaw](https://github.com/openclaw/openclaw)의 금융 특화 버전이다. OpenClaw가 범용 멀티 채널 AI 플랫폼(3,300+ 파일, 256K LOC)인 반면, FinClaw는 **금융 시장 데이터, 뉴스 분석, 포트폴리오 모니터링, 알림 시스템**에 집중하는 경량 AI 에이전트 플랫폼이다.

- **규모:** 425 TS 파일, ~42K LOC (OpenClaw 대비 ~16%)
- **아키텍처:** pnpm monorepo (`packages/` 아래 10개 패키지), ESM, TypeScript strict, Node.js 22+
- **빌드:** `tsc --build` (project references), `tsgo --noEmit` (타입 체크)
- **테스트:** vitest 4-tier (unit / storage / e2e / live)
- **채널:** Discord, CLI, TUI (Ink), Web (Lit)
- **AI 프로바이더:** Anthropic Claude (1차), OpenAI (2차)
- **데이터:** 시장 데이터 API, 뉴스 피드, 실시간 알림

---

## OpenClaw → FinClaw Phase 매핑

OpenClaw의 12-Phase 아키텍처를 FinClaw 20-Phase로 재구성한다. 핵심 원칙: **XL 복잡도 모듈을 2분할하고, 금융 도메인 스킬을 3단계로 세분화한다.**

| OpenClaw Phase                         | FinClaw Phase                                        | 비고                                                    |
| -------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| Phase 0: 스캐폴딩                      | 완료 (현재 상태)                                     | 빌드/테스트/린트/Docker 세팅됨                          |
| Phase 1: 인프라 기반                   | Phase 1 (타입) + Phase 2 (인프라)                    | `@finclaw/types` + `@finclaw/infra` 패키지로 분리       |
| Phase 2: 설정 시스템                   | Phase 3 (설정 + CI)                                  | `@finclaw/config` 패키지, CI 기초 함께 세팅             |
| Phase 3: 프로세스/라우팅/채널/플러그인 | Phase 4 (프로세스/라우팅) + Phase 5 (채널/플러그인)  | `packages/server` 내 모듈로 구현                        |
| Phase 4: 에이전트 코어                 | Phase 6 (모델/인증) + Phase 7 (도구/세션)            | `@finclaw/agent` 패키지로 분리                          |
| Phase 5: 자동 응답 파이프라인          | Phase 8                                              | 6단계 파이프라인 (8→6 축소)                             |
| Phase 6: 실행 엔진                     | Phase 9                                              | `@finclaw/agent` 내 execution 모듈                      |
| Phase 7: 게이트웨이 서버               | Phase 10 (코어) + Phase 11 (고급)                    | JSON-RPC 2.0 기반, `packages/server` gateway 모듈       |
| Phase 8: 채널 어댑터 + CLI             | Phase 12 (Discord) + Phase 13 (CLI)                  | Discord→`@finclaw/channel-discord`, CLI→server cli 모듈 |
| Phase 9: 지원 서비스                   | Phase 14 (스토리지/메모리) + Phase 15 (크론/훅/보안) | `@finclaw/storage` 패키지 + server services 모듈        |
| Phase 10: 확장 모듈                    | Phase 20 (플러그인 릴리즈 인프라)                    | 플러그인 템플릿 + CalVer CI/CD                          |
| Phase 11: TUI + 웹 패널                | Phase 19                                             | `@finclaw/tui` (Ink) + `@finclaw/web` (Lit) 별도 패키지 |
| Phase 12: 스킬 + 빌드/배포             | Phase 16-18 (금융 스킬 3단계) + Phase 20 (배포)      | `@finclaw/skills-finance` 패키지                        |

---

## 20-Phase 요약 테이블

| Phase | 제목                          | OpenClaw 참조             | 복잡도 | 핵심 산출물                                                                                                           | 패키지                         |
| ----- | ----------------------------- | ------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 0     | 개발환경 스캐폴딩             | ARCHITECTURE.md Phase 0   | S      | 빌드/테스트/린트 인프라, 4-tier vitest, 디렉토리 레이아웃, Docker 스캐폴딩                                            | 루트                           |
| 1     | 핵심 타입 & 도메인 모델       | docs/02, deep-dive/02, 08 | M      | 11개 타입 모듈 (common·config·message·agent·channel·skill·storage·plugin·gateway·finance·notification), barrel export | `@finclaw/types`               |
| 2     | 인프라 기반 레이어            | docs/12, deep-dive/12     | L      | 로거, 에러, 재시도/서킷브레이커, SSRF 방지, 이벤트 시스템, 포트 관리                                                  | `@finclaw/infra`               |
| 3     | 설정 시스템 + CI 기초         | docs/02, deep-dive/02     | L      | 8단계 설정 파이프라인, Zod v4 스키마, 핫 리로드, CI 워크플로우                                                        | `@finclaw/config`              |
| 4     | 프로세스 실행 & 메시지 라우팅 | docs/13, deep-dive/07, 12 | M      | 프로세스 관리, 3-Lane 동시성, 4계층 라우팅, 메시지 큐                                                                 | `packages/server`              |
| 5     | 채널 추상화 & 플러그인 시스템 | docs/08, deep-dive/08     | L      | ChannelDock/ChannelPlugin 2계층, PluginRegistry, 5단계 로더, 훅 시스템                                                | `packages/server`              |
| 6     | 모델 통합 & 인증              | docs/06, deep-dive/06     | L      | 모델 카탈로그, 폴백 체인, 6단계 API 키 해석, Anthropic/OpenAI 어댑터                                                  | `@finclaw/agent`               |
| 7     | 도구 시스템 & 세션 관리       | docs/04, deep-dive/04     | L      | 9단계 도구 정책 필터, 도구 그룹, 세션 CRUD, 컨텍스트 윈도우 컴팩션                                                    | `@finclaw/agent`               |
| 8     | 자동 응답 파이프라인          | docs/07, deep-dive/07     | L      | 6단계 파이프라인 (Normalize→Command→ACK→Context→Execute→Deliver), 명령어 레지스트리                                   | `packages/server`              |
| 9     | 실행 엔진 (Execution Engine)  | docs/05, deep-dive/05     | L      | LLM 호출 루프, 스트리밍 상태 머신, 도구 실행기, 토큰 카운팅, 프롬프트 캐싱                                            | `@finclaw/agent`               |
| 10    | 게이트웨이 코어               | docs/03, deep-dive/03     | XL     | HTTP/WS 서버, JSON-RPC 2.0 (25 코어 메서드), Zod v4 검증, 4계층 인증                                                  | `packages/server`              |
| 11    | 게이트웨이 고급 기능          | docs/03, deep-dive/03     | L      | 설정 핫 리로드, OpenAI 호환 API, 헬스 체크, rate limiting, 접근 로깅                                                  | `packages/server`              |
| 12    | Discord 채널 어댑터           | docs/10, deep-dive/10     | L      | discord.js v14 통합, 4개 슬래시 커맨드, 텍스트 청킹, 임베드, 승인 버튼                                                | `@finclaw/channel-discord`     |
| 13    | CLI 진입점 & 명령어 체계      | docs/01, deep-dive/01     | L      | Commander.js CLI, 9개 명령어 그룹, CliDeps DI, Gateway HTTP 클라이언트                                                | `packages/server`              |
| 14    | 스토리지 & 메모리 시스템      | docs/14, deep-dive/14     | XL     | node:sqlite + sqlite-vec, 13개 테이블, FTS5 + 벡터 검색, 하이브리드 검색, TTL 캐시                                    | `@finclaw/storage`             |
| 15    | 지원 서비스 (훅/크론/보안)    | docs/13, deep-dive/13, 14 | L      | 4계층 훅 시스템, croner 스케줄러, 보안 감사, 자격 증명 마스킹, systemd 서비스 생성                                    | `packages/server`              |
| 16    | 금융 스킬: 시장 데이터        | docs/20, deep-dive/20     | L      | 3개 데이터 프로바이더 (Alpha Vantage/CoinGecko/Frankfurter), 4개 에이전트 도구                                        | `@finclaw/skills-finance`      |
| 17    | 금융 스킬: 뉴스 & AI 분석     | docs/20, deep-dive/20     | L      | 뉴스 집계 (NewsAPI/RSS), AI 시장 분석, 감성 분석, 포트폴리오 추적                                                     | `@finclaw/skills-finance`      |
| 18    | 금융 스킬: 알림 시스템        | docs/20, deep-dive/20     | L      | 4종 알림 조건, 지속적 모니터링, 멀티채널 전달, 쿨다운 추적                                                            | `@finclaw/skills-finance`      |
| 19    | TUI & 웹 컨트롤 패널          | docs/15, deep-dive/15     | L      | TUI (Ink 6 + React), Web UI (Lit 3), 스트림 어셈블러, 자동 재연결                                                     | `@finclaw/tui`, `@finclaw/web` |
| 20    | 플러그인 릴리즈 인프라        | docs/20, deep-dive/20     | L      | 플러그인 템플릿, CalVer 빌드 스크립트, release.yml CI/CD, 스킬 빌드 시스템                                            | 루트, CI/CD, `extensions/`     |

---

## 의존성 그래프

### 패키지 의존성

```
@finclaw/types (순수 인터페이스)
│
├── @finclaw/infra ─────────── @finclaw/config
│        │                          │
│        ├── @finclaw/agent ────────┘  (infra + types)
│        │        │
│        │        └── @finclaw/skills-finance  (agent + infra + storage + types)
│        │                   │
│        └── @finclaw/channel-discord  (infra + types)
│                    │
├── @finclaw/storage ┘  (types)
│
└── @finclaw/server  (모든 패키지 통합)
         │
         ├── @finclaw/tui  (types)
         └── @finclaw/web  (types)
```

### Phase 의존성

```
Phase 0 (스캐폴딩, 완료)
│
Phase 1 (타입)
│
├── Phase 2 (인프라) ──── Phase 3 (설정+CI)
│                              │
│                    ┌─────────┼─────────┐
│                    │         │         │
│              Phase 4      Phase 5    Phase 6
│            (프로세스/    (채널/      (모델/
│             라우팅)     플러그인)    인증)
│                    │         │         │
│                    │         │    Phase 7
│                    │         │   (도구/세션)
│                    │         │         │
│                    └────┬────┴────┬────┘
│                         │         │
│                    Phase 8      Phase 9
│                  (응답 파이프    (실행
│                    라인)        엔진)
│                         │         │
│                    ┌────┴─────────┘
│                    │
│              Phase 10 (게이트웨이 코어)
│                    │
│              Phase 11 (게이트웨이 고급)
│                    │
│         ┌──────────┼──────────┐
│         │          │          │
│    Phase 12    Phase 13    Phase 14
│   (Discord)    (CLI)     (스토리지)
│         │          │          │
│         │     Phase 15 (지원 서비스)
│         │          │
│    ┌────┴──────────┤
│    │               │
│  Phase 16      Phase 19
│ (시장 데이터)  (TUI/웹 패널)
│    │               │
│  Phase 17          │
│ (뉴스/분석)        │
│    │               │
│  Phase 18          │
│ (알림 시스템)      │
│    │               │
│    └───────┬───────┘
│            │
│      Phase 20 (플러그인 릴리즈 인프라)
```

### 의존성 요약

| Phase | 선행 Phase     | 비고                    |
| ----- | -------------- | ----------------------- |
| 1     | Phase 0 (완료) | 모든 Phase의 기반       |
| 2     | 1              | 타입 참조               |
| 3     | 1, 2           | 인프라 유틸 + 타입 참조 |
| 4     | 1, 2, 3        | 설정/로깅/에러 사용     |
| 5     | 1, 2, 3        | 설정/로깅/에러 사용     |
| 6     | 1, 2, 3        | 설정/로깅/에러 사용     |
| 7     | 5, 6           | 채널/모델 타입 참조     |
| 8     | 4, 5, 7        | 라우팅 + 채널 + 도구    |
| 9     | 6, 7           | 모델 + 도구             |
| 10    | 8, 9           | 파이프라인 + 실행 엔진  |
| 11    | 10             | 게이트웨이 코어         |
| 12    | 5, 11          | 채널 + 게이트웨이       |
| 13    | 11             | 게이트웨이              |
| 14    | 3, 11          | 설정 + 게이트웨이       |
| 15    | 13, 14         | CLI + 스토리지          |
| 16    | 12, 15         | Discord + 지원 서비스   |
| 17    | 16             | 시장 데이터             |
| 18    | 17             | 뉴스/분석               |
| 19    | 15             | 지원 서비스             |
| 20    | 18, 19         | 플러그인 릴리즈 인프라  |

---

## 패키지별 규모

| 패키지                     | 파일 수 | LOC      | 주요 Phase               |
| -------------------------- | ------- | -------- | ------------------------ |
| `@finclaw/types`           | 12      | 1,087    | Phase 1                  |
| `@finclaw/infra`           | 28      | 2,091    | Phase 2                  |
| `@finclaw/config`          | 18      | 1,164    | Phase 3                  |
| `@finclaw/storage`         | 22      | 2,645    | Phase 14                 |
| `@finclaw/agent`           | 34      | 4,499    | Phase 6, 7, 9            |
| `@finclaw/channel-discord` | 15      | 915      | Phase 12                 |
| `@finclaw/skills-finance`  | 46      | 5,429    | Phase 16, 17, 18         |
| `@finclaw/server`          | 145     | 12,877   | Phase 4, 5, 8, 10-13, 15 |
| `@finclaw/tui`             | 8       | 1,131    | Phase 19                 |
| `@finclaw/web`             | 11      | 1,311    | Phase 19                 |
| **합계**                   | **425** | **~42K** |                          |

---

## CI 전략

### ci.yml — 품질 게이트

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main, feature/*]
  pull_request:
    branches: [main]
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  quality-gate:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .node-version
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint # oxlint
      - run: pnpm format # oxfmt --check
      - run: pnpm typecheck # tsgo --noEmit
      - run: pnpm build # tsc --build
      - run: pnpm test:ci # vitest (unit + storage 병렬)
```

### deploy.yml — Docker 이미지

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    tags: [v*]
  workflow_dispatch:
jobs:
  docker:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      # QEMU + Buildx → ghcr.io 멀티플랫폼 빌드 (linux/amd64, linux/arm64)
```

### release.yml — GitHub Release

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    tags: [v*]
jobs:
  release:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      # 빌드 검증 (typecheck + build + test:ci)
      # → Git log 기반 체인지로그 생성
      # → GitHub Release 생성 (pre-release 자동 감지)
```

---

## 외부 의존성 추가 시점

| Phase | 패키지                           | 용도                                     |
| ----- | -------------------------------- | ---------------------------------------- |
| 2     | `tslog`                          | 구조화 로깅 (파일 JSON + 콘솔 pretty)    |
| 3     | `json5`, `zod`                   | 설정 파일 파싱, 스키마 검증              |
| 6     | `@anthropic-ai/sdk`              | Anthropic Claude API                     |
| 6     | `openai`                         | OpenAI API                               |
| 10    | `ws`                             | WebSocket 서버                           |
| 11    | `chokidar`                       | 설정 파일 핫 리로드 감시                 |
| 12    | `discord.js`                     | Discord 봇 프레임워크                    |
| 13    | `commander`, `picocolors`        | CLI 프레임워크, 터미널 색상              |
| 14    | `sqlite-vec`                     | SQLite 벡터 검색 확장 (node:sqlite 위에) |
| 15    | `croner`, `jiti`                 | 크론 스케줄러, TS 런타임 로더            |
| 17    | `feedsmith`                      | RSS/Atom 뉴스 피드 파싱                  |
| 19    | `ink`, `react`, `ink-text-input` | TUI 프레임워크 (React for CLI)           |
| 19    | `lit`, `marked`, `dompurify`     | 웹 UI 프레임워크, 마크다운 렌더링        |

> **원칙:** 가능한 한 Node.js 22+ 내장 API(`node:sqlite`, `fetch`)를 우선 사용하고, 외부 의존성은 최소화한다.

---

## 디렉토리 구조

```
packages/
├── types/              # Phase 1: 핵심 타입 & 도메인 모델
├── infra/              # Phase 2: 인프라 기반 레이어
├── config/             # Phase 3: 설정 시스템
├── agent/              # Phase 6-7, 9: 모델/인증/도구/세션/실행 엔진
├── storage/            # Phase 14: 스토리지 & 메모리 시스템
├── channel-discord/    # Phase 12: Discord 채널 어댑터
├── skills-finance/     # Phase 16-18: 시장 데이터, 뉴스/분석, 알림
├── server/             # Phase 4-5, 8, 10-11, 13, 15: 핵심 서버
│   └── src/
│       ├── main.ts         # 진입점
│       ├── process/        # 프로세스 실행 & 메시지 라우팅
│       ├── channels/       # 채널 추상화
│       ├── plugins/        # 플러그인 시스템
│       ├── auto-reply/     # 자동 응답 파이프라인
│       ├── gateway/        # 게이트웨이 서버
│       ├── cli/            # CLI 진입점 & 명령어
│       └── services/       # 지원 서비스 (훅/크론/보안)
├── tui/                # Phase 19: TUI (Ink + React)
└── web/                # Phase 19: 웹 컨트롤 패널 (Lit)

extensions/
└── plugin-template/    # Phase 20: 플러그인 템플릿
```
