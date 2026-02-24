# FinClaw 20-Phase 개발 로드맵

## 프로젝트 개요

**FinClaw**는 [OpenClaw](https://github.com/openclaw/openclaw)의 금융 특화 버전이다. OpenClaw가 범용 멀티 채널 AI 플랫폼(3,300+ 파일, 256K LOC)인 반면, FinClaw는 **금융 시장 데이터, 뉴스 분석, 포트폴리오 모니터링, 알림 시스템**에 집중하는 경량 AI 에이전트 플랫폼이다.

- **예상 규모:** ~365 파일, ~60K LOC (OpenClaw 대비 ~15%)
- **아키텍처:** 단일 패키지 (`src/` 아래 모듈별 디렉토리), ESM, TypeScript strict, Node.js 22+
- **채널:** Discord (1차), CLI (2차), 웹 패널 (3차)
- **AI 프로바이더:** Anthropic Claude (1차), OpenAI (2차)
- **데이터:** 시장 데이터 API, 뉴스 피드, 실시간 알림

---

## OpenClaw → FinClaw Phase 매핑

OpenClaw의 12-Phase 아키텍처를 FinClaw 20-Phase로 재구성한다. 핵심 원칙: **XL 복잡도 모듈을 2분할하고, 금융 도메인 스킬을 3단계로 세분화한다.**

| OpenClaw Phase                         | FinClaw Phase                                          | 비고                      |
| -------------------------------------- | ------------------------------------------------------ | ------------------------- |
| Phase 0: 스캐폴딩                      | 완료 (현재 상태)                                       | 빌드/테스트/린트 세팅됨   |
| Phase 1: 인프라 기반                   | Phase 1 (타입) + Phase 2 (인프라)                      | 타입을 별도 분리하여 선행 |
| Phase 2: 설정 시스템                   | Phase 3 (설정 + CI)                                    | CI 기초 함께 세팅         |
| Phase 3: 프로세스/라우팅/채널/플러그인 | Phase 4 (프로세스/라우팅) + Phase 5 (채널/플러그인)    | XL 복잡도를 2분할         |
| Phase 4: 에이전트 코어                 | Phase 6 (모델/인증) + Phase 7 (도구/세션)              | XL 복잡도를 2분할         |
| Phase 5: 자동 응답 파이프라인          | Phase 8                                                | 8단계 파이프라인          |
| Phase 6: 실행 엔진                     | Phase 9                                                | LLM 호출 + 스트리밍       |
| Phase 7: 게이트웨이 서버               | Phase 10 (코어) + Phase 11 (고급)                      | 가장 큰 모듈, 2분할       |
| Phase 8: 채널 어댑터 + CLI             | Phase 12 (Discord) + Phase 13 (CLI)                    | Discord 우선, CLI 별도    |
| Phase 9: 지원 서비스                   | Phase 14 (스토리지/메모리) + Phase 15 (미디어/크론/훅) | XL 복잡도를 2분할         |
| Phase 10: 확장 모듈                    | Phase 20 (확장 + 배포)                                 | 배포와 통합               |
| Phase 11: TUI + 웹 패널                | Phase 19                                               |                           |
| Phase 12: 스킬 + 빌드/배포             | Phase 16-18 (금융 스킬 3단계) + Phase 20 (배포)        | 금융 도메인 특화          |

---

## 20-Phase 요약 테이블

| Phase | 제목                          | OpenClaw 참조             | 복잡도 | 핵심 산출물                                               |
| ----- | ----------------------------- | ------------------------- | ------ | --------------------------------------------------------- |
| 0     | 개발환경 스캐폴딩             | ARCHITECTURE.md Phase 0   | S      | 빌드/테스트/린트 인프라, 4-tier vitest, 디렉토리 레이아웃, Docker 스캐폴딩 |
| 1     | 핵심 타입 & 도메인 모델       | docs/02, deep-dive/02, 08 | M      | 11개 타입 모듈, 금융 도메인 타입                          |
| 2     | 인프라 기반 레이어            | docs/12, deep-dive/12     | L      | 로거, 에러, 재시도, SSRF 방지, 이벤트 큐                  |
| 3     | 설정 시스템 + CI 기초         | docs/02, deep-dive/02     | L      | 11단계 설정 파이프라인, Zod 스키마, CI 워크플로우         |
| 4     | 프로세스 실행 & 메시지 라우팅 | docs/13, deep-dive/07, 12 | M      | 프로세스 관리, 세션 키, 바인딩 매칭, 메시지 큐            |
| 5     | 채널 추상화 & 플러그인 시스템 | docs/08, deep-dive/08     | L      | ChannelPlugin 인터페이스, PluginRegistry, Dock 계층       |
| 6     | 모델 통합 & 인증              | docs/06, deep-dive/06     | L      | 모델 팩토리, 인증 로테이션, Anthropic/OpenAI 어댑터       |
| 7     | 도구 시스템 & 세션 관리       | docs/04, deep-dive/04     | L      | 도구 레지스트리, 정책 필터링, 세션 CRUD                   |
| 8     | 자동 응답 파이프라인          | docs/07, deep-dive/07     | XL     | 8단계 파이프라인, 명령어 시스템, 디렉티브 처리            |
| 9     | 실행 엔진 (Pi Embedded)       | docs/05, deep-dive/05     | L      | LLM 호출, 스트리밍, Lane 큐잉, 컴팩션                     |
| 10    | 게이트웨이 코어               | docs/03, deep-dive/03     | XL     | WebSocket RPC, HTTP API, 인증, 라우팅                     |
| 11    | 게이트웨이 고급 기능          | docs/03, deep-dive/03     | L      | 핫 리로드, 헬스 체크, 메트릭, rate limiting               |
| 12    | Discord 채널 어댑터           | docs/10, deep-dive/10     | L      | discord.js 통합, 슬래시 커맨드, 임베드                    |
| 13    | CLI 인터페이스                | docs/01, deep-dive/01     | M      | Commander.js CLI, 서브커맨드 체계                         |
| 14    | 메모리 & 스토리지             | docs/14, deep-dive/14     | L      | node:sqlite, 벡터 검색, 대화 이력                         |
| 15    | 지원 서비스 (크론/훅/미디어)  | docs/13, deep-dive/13, 14 | M      | 크론 스케줄러, 이벤트 훅, 미디어 처리                     |
| 16    | 금융 스킬: 시장 데이터        | docs/20, deep-dive/20     | L      | 주식/암호화폐 시세, 차트 생성, 기술 분석                  |
| 17    | 금융 스킬: 뉴스 & 분석        | docs/20, deep-dive/20     | M      | 뉴스 피드, 감성 분석, 요약 생성                           |
| 18    | 금융 스킬: 알림 시스템        | docs/20, deep-dive/20     | M      | 가격 알림, 조건부 트리거, 포트폴리오 추적                 |
| 19    | TUI / 웹 컨트롤 패널          | docs/15, deep-dive/15     | L      | 웹 대시보드, 실시간 모니터링                              |
| 20    | 확장 & 배포                   | docs/20, deep-dive/20     | M      | 플러그인 SDK, 프로덕션 강화, 스킬 빌드, 릴리즈 CI/CD     |

---

## 의존성 그래프

```
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
│   (Discord)    (CLI)     (메모리/
│         │          │      스토리지)
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
│      Phase 20 (확장 + 배포)
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
| 20    | 18, 19         | 플러그인 SDK + 프로덕션 강화 |

---

## 규모 예측

| 영역          | OpenClaw                   | FinClaw (예상)          | 비율     |
| ------------- | -------------------------- | ----------------------- | -------- |
| 타입 정의     | ~60 파일, 5K LOC           | ~15 파일, 1.2K LOC      | 24%      |
| 인프라        | ~183 파일, 31K LOC         | ~40 파일, 6K LOC        | 19%      |
| 설정 시스템   | ~134 파일, 18K LOC         | ~35 파일, 5K LOC        | 28%      |
| 채널/플러그인 | ~80 파일, 29K LOC          | ~20 파일, 3K LOC        | 10%      |
| 에이전트/도구 | ~120 파일, 40K LOC         | ~30 파일, 5K LOC        | 13%      |
| 자동 응답     | ~206 파일, 39K LOC         | ~25 파일, 5K LOC        | 13%      |
| 실행 엔진     | ~50 파일, 15K LOC          | ~15 파일, 3K LOC        | 20%      |
| 게이트웨이    | ~90 파일, 25K LOC          | ~25 파일, 5K LOC        | 20%      |
| 채널 어댑터   | ~200 파일, 55K LOC         | ~15 파일, 3K LOC        | 5%       |
| 지원 서비스   | ~80 파일, 20K LOC          | ~20 파일, 3K LOC        | 15%      |
| 금융 스킬     | -                          | ~50 파일, 10K LOC       | 신규     |
| UI/CLI        | ~120 파일, 21K LOC         | ~25 파일, 5K LOC        | 24%      |
| 배포/확장     | ~520 파일, 15K LOC         | ~10 파일, 2K LOC        | 1%       |
| **합계**      | **~3,300+ 파일, 256K LOC** | **~365 파일, ~60K LOC** | **~15%** |

---

## CI 전략 (2단계)

### Stage 1: 기초 CI (Phase 3에서 구축)

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint # oxlint
      - run: pnpm format # oxfmt --check
      - run: pnpm typecheck # tsgo --noEmit
      - run: pnpm test # vitest (unit)
      - run: pnpm test:storage # vitest (storage tier)
```

### Stage 2: 풀 CI (Phase 10 이후)

```yaml
# .github/workflows/ci-full.yml
name: CI Full
on:
  push:
    branches: [main]
  pull_request:
jobs:
  check:
    # Stage 1 동일
  e2e:
    needs: check
    runs-on: ubuntu-latest
    steps:
      -  # ... setup
      - run: pnpm test:e2e # 게이트웨이 + 채널 통합
  coverage:
    needs: check
    runs-on: ubuntu-latest
    steps:
      -  # ... setup
      - run: pnpm test:coverage
      -  # Upload to codecov
```

---

## 외부 의존성 추가 시점

| Phase | 패키지                              | 용도                                    |
| ----- | ----------------------------------- | --------------------------------------- |
| 2     | `tslog`                             | 구조화 로깅 (파일 JSON + 콘솔 pretty)   |
| 3     | `dotenv`, `zod`, `json5`            | 환경 변수, 스키마 검증, 설정 파일 파싱  |
| 6     | `@anthropic-ai/sdk`                 | Anthropic Claude API                    |
| 6     | `openai`                            | OpenAI API                              |
| 10    | `ws`                                | WebSocket 서버                          |
| 12    | `discord.js`                        | Discord 봇 프레임워크                   |
| 13    | `commander`                         | CLI 프레임워크                          |
| 14    | `better-sqlite3` 또는 `node:sqlite` | SQLite 스토리지 (Node.js 22+ 내장 우선) |
| 16    | `undici`                            | HTTP 클라이언트 (시장 데이터 API)       |
| 19    | `lit`                               | 웹 컨트롤 패널 프레임워크               |

> **원칙:** 가능한 한 Node.js 22+ 내장 API(`node:sqlite`, `node:test`, `fetch`)를 우선 사용하고, 외부 의존성은 최소화한다. 현재 devDependencies만 존재하며, 프로덕션 의존성은 Phase 진행에 따라 점진적으로 추가한다.

---

## 디렉토리 구조 (Phase 20 완성 시 예상)

```
src/
├── types/          # Phase 1: 핵심 타입 & 도메인 모델
├── infra/          # Phase 2: 인프라 기반 레이어
├── config/         # Phase 3: 설정 시스템
├── process/        # Phase 4: 프로세스 실행 & 메시지 라우팅
├── channels/       # Phase 5: 채널 추상화 & 플러그인
├── plugins/        # Phase 5: 플러그인 시스템
├── agents/         # Phase 6-7: 모델/인증/도구/세션
├── auto-reply/     # Phase 8: 자동 응답 파이프라인
├── engine/         # Phase 9: 실행 엔진
├── gateway/        # Phase 10-11: 게이트웨이 서버
├── discord/        # Phase 12: Discord 어댑터
├── cli/            # Phase 13: CLI 인터페이스
├── storage/        # Phase 14: 메모리 & 스토리지
├── services/       # Phase 15: 지원 서비스
├── skills/
│   ├── market/     # Phase 16: 시장 데이터
│   ├── news/       # Phase 17: 뉴스 & 분석
│   └── alerts/     # Phase 18: 알림 시스템
├── ui/             # Phase 19: 웹 패널
├── index.ts        # 진입점
└── entry.ts        # 부트스트랩
```
