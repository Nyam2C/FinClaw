# FinClaw

OpenClaw 아키텍처 기반의 금융 특화 AI 어시스턴트.

## 요구사항

- **Node.js** >= 22.0.0 (`node:sqlite` 내장 모듈 사용)
- **pnpm** >= 10.4.1

```bash
corepack enable
corepack prepare pnpm@10.4.1 --activate
```

## 시작하기

```bash
# 의존성 설치
pnpm install

# 환경변수 설정
cp .env.example .env
# .env 파일을 편집하여 API 키 입력

# 개발 서버
pnpm dev

# 빌드
pnpm build
```

## 명령어

| 명령어            | 설명                             |
| ----------------- | -------------------------------- |
| `pnpm build`      | TypeScript 컴파일 (project refs) |
| `pnpm clean`      | 빌드 산출물 삭제                 |
| `pnpm dev`        | 개발 서버 (tsx)                  |
| `pnpm typecheck`  | 타입체크 (tsgo)                  |
| `pnpm lint`       | 린트 (oxlint)                    |
| `pnpm format`     | 포매팅 검사 (oxfmt)              |
| `pnpm format:fix` | 포매팅 자동 수정                 |

## 테스트

4-tier 테스트 구조:

```bash
pnpm test              # 유닛 테스트
pnpm test:storage      # 스토리지/DB 테스트
pnpm test:e2e          # E2E 테스트
pnpm test:live         # 라이브 API 테스트 (실제 자격증명 필요)
pnpm test:ci           # CI용 (unit + storage 병렬)
pnpm test:all          # 전체 (unit + storage + e2e)
pnpm test:coverage     # 커버리지 리포트
pnpm test:watch        # 파일 변경 감시
```

## 프로젝트 구조

pnpm 모노레포 (workspace) 구조:

```
packages/
├── types/            @finclaw/types — 공유 타입 정의
├── config/           @finclaw/config — 설정 시스템
├── storage/          @finclaw/storage — 스토리지 & 메모리
├── agent/            @finclaw/agent — 에이전트 코어
├── channel-discord/  @finclaw/channel-discord — Discord 채널 어댑터
├── skills-finance/   @finclaw/skills-finance — 금융 스킬
└── server/           @finclaw/server — 애플리케이션 진입점
```

## 환경변수

`.env.example` 참조. 주요 변수:

| 변수                | 설명                                       |
| ------------------- | ------------------------------------------ |
| `CLAUDE_API_KEY`    | Anthropic Claude API 키                    |
| `DISCORD_TOKEN`     | Discord 봇 토큰                            |
| `ALPHA_VANTAGE_KEY` | 주식/외환 데이터 API                       |
| `COINGECKO_API_KEY` | 암호화폐 데이터 API                        |
| `NEWS_API_KEY`      | 뉴스 데이터 API                            |
| `DB_PATH`           | SQLite DB 경로 (기본: `./data/finclaw.db`) |

## 기술 스택

- **런타임**: Node.js 22+ (ESM)
- **언어**: TypeScript 5.9 (strict mode)
- **테스트**: Vitest 4.0
- **린트**: oxlint (Rust 기반)
- **포매팅**: oxfmt (Rust 기반)
- **DB**: SQLite (`node:sqlite` 내장)
- **AI**: Anthropic Claude SDK
