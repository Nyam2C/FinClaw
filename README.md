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

`.env.example` 을 복사해서 `.env` 로 사용 (`cp .env.example .env`). 실제 코드 기준 전체 목록.

### 필수 (Required)

| 변수                     | 설명                                   | 예시         |
| ------------------------ | -------------------------------------- | ------------ |
| `ANTHROPIC_API_KEY`      | Anthropic Claude API 키 (AI 호출용)    | `sk-ant-...` |
| `DISCORD_BOT_TOKEN`      | Discord 봇 토큰 (Discord 채널 사용 시) | `MTk4...`    |
| `DISCORD_APPLICATION_ID` | Discord 애플리케이션 ID                | `1234567890` |

### 선택 (Optional) — 금융 데이터

| 변수                | 설명                                    | 비고                                           |
| ------------------- | --------------------------------------- | ---------------------------------------------- |
| `ALPHA_VANTAGE_KEY` | 주가·외환·뉴스 API (단일 키로 3종 커버) | 무료 tier 분당 5회. 미설정 시 market/news 스킵 |
| `COINGECKO_API_KEY` | 암호화폐 시세 API                       | 미설정 시 crypto 조회만 비활성                 |

### 선택 (Optional) — Gateway / Web UI 인증

| 변수                 | 설명                                                | 기본값                        |
| -------------------- | --------------------------------------------------- | ----------------------------- |
| `FINCLAW_API_KEY`    | HTTP/WebSocket 클라이언트용 API 키 (X-API-Key 헤더) | 미설정 시 API key 인증 비활성 |
| `GATEWAY_JWT_SECRET` | JWT 서명 secret (Web UI WebSocket `?token=` 검증)   | `'dev-secret'`                |
| `GATEWAY_PORT`       | HTTP/WS 게이트웨이 포트                             | `3000`                        |

> ⚠️ **함정**: `GATEWAY_JWT_SECRET=` 처럼 **빈 값**으로 라인을 두면 코드의 `??` 연산자가 fallback 하지 않아 secret 이 빈 문자열이 됩니다. 기본값 `dev-secret` 을 쓰려면 **라인 자체를 제거**하거나 명시적 값을 넣으세요.

### 선택 (Optional) — 저장소

| 변수                | 설명                        | 기본값                                                   |
| ------------------- | --------------------------- | -------------------------------------------------------- |
| `FINCLAW_DB_PATH`   | SQLite 파일 경로            | 로컬: `~/.finclaw/db.sqlite` / Docker: `/data/db.sqlite` |
| `FINCLAW_FILE_ROOT` | `read_local_file` 도구 루트 | `~/.finclaw/workspace`                                   |

### 선택 (Optional) — 임베딩 (Phase 25 RAG 용, 현재는 dead code)

| 변수             | 설명                              |
| ---------------- | --------------------------------- |
| `VOYAGE_API_KEY` | Voyage AI 임베딩 (Anthropic 추천) |
| `OPENAI_API_KEY` | OpenAI 임베딩 fallback            |

### Web UI / RPC 클라이언트 인증 가이드

브라우저 Web UI 접속에는 **JWT (HS256)** 가 필요합니다. `?token=` 쿼리 파라미터로 전달:

```bash
# JWT 생성 (secret 은 GATEWAY_JWT_SECRET 또는 미설정 시 'dev-secret')
node -e "
const { createHmac } = require('crypto');
const secret = process.env.GATEWAY_JWT_SECRET || 'dev-secret';
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const h = b64url({ alg: 'HS256', typ: 'JWT' });
const p = b64url({ sub: 'dev', permissions: [] });
const s = createHmac('sha256', secret).update(h + '.' + p).digest('base64url');
console.log(h + '.' + p + '.' + s);
"
```

브라우저 접속:

```
http://localhost:5173?token=<JWT>&gateway=http://localhost:3000
```

curl 로 RPC 호출 (HTTP 도 동일 JWT 사용 가능, Phase 23 post-ship fix 이후):

```
curl -X POST http://localhost:3000/rpc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <JWT>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"finance.portfolio.get","params":{}}'
```

## 기술 스택

- **런타임**: Node.js 22+ (ESM)
- **언어**: TypeScript 5.9 (strict mode)
- **테스트**: Vitest 4.0
- **린트**: oxlint (Rust 기반)
- **포매팅**: oxfmt (Rust 기반)
- **DB**: SQLite (`node:sqlite` 내장)
- **AI**: Anthropic Claude SDK
